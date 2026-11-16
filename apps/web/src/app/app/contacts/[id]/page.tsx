"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { ContactDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import {
  ContactFields,
  parseContactValues,
  valuesFromContact,
  type ContactFormValues,
} from "@/components/app/contact-form";
import {
  ConsentCard,
  ContactMessagesCard,
  ContactSequencesCard,
} from "@/components/app/contact-sections";
import { CompliancePanel } from "@/components/app/compliance";
import { useMe } from "@/components/app/me-context";
import { PromisesPanel } from "@/components/app/promises";
import { ContactTasksCard } from "@/components/app/task-list";
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  LoadingBlock,
  StatusBadge,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { contactName, formatDate } from "@/lib/format";
import { useResource } from "@/lib/use-resource";

function DeleteContactDialog({
  contact,
  open,
  onClose,
}: {
  contact: ContactDto;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [suppress, setSuppress] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSuppress(false);
      setError(null);
    }
  }, [open]);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api(`/contacts/${contact.id}`, {
        method: "DELETE",
        query: suppress ? { suppress: "true" } : undefined,
      });
      toast(
        suppress
          ? `Deleted ${contactName(contact)} and added ${contact.email} to suppressions`
          : `Deleted ${contactName(contact)}`,
      );
      router.push("/app/contacts");
    } catch (err) {
      setDeleting(false);
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Delete this contact?"
      description={`${contactName(contact)} (${contact.email}) will be permanently removed. This can't be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleting} onClick={() => void onDelete()}>
            Delete contact
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Checkbox
          label="Also add this email to the suppression list"
          description="Nobody in your workspace will be able to email this address again, even if it's re-imported."
          checked={suppress}
          onChange={(e) => setSuppress(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  );
}

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const { toast } = useToast();
  const {
    data: contact,
    error,
    loading,
    setData,
    reload,
  } = useResource<ContactDto>(`/contacts/${id}`);
  const [values, setValues] = useState<ContactFormValues | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (contact) setValues(valuesFromContact(contact));
  }, [contact]);

  if (loading && !contact) return <LoadingBlock label="Loading contact" />;
  if (error || !contact || !values) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="max-w-xl space-y-4">
        <Alert tone="error" title={notFound ? "Contact not found" : "Couldn't load this contact"}>
          {notFound
            ? "It may have been deleted, or it belongs to a different workspace."
            : errorMessage(error)}
        </Alert>
        <div className="flex gap-2">
          <Link
            href="/app/contacts"
            className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
          >
            ← Back to contacts
          </Link>
          {!notFound ? (
            <Button variant="ghost" size="sm" onClick={reload}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const dirty = JSON.stringify(values) !== JSON.stringify(valuesFromContact(contact));

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!values || !contact) return;
    setFormError(null);
    const parsed = parseContactValues(values);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const updated = await api<ContactDto>(`/contacts/${contact.id}`, {
        method: "PATCH",
        body: parsed.data,
      });
      setData(() => updated);
      toast("Contact saved");
    } catch (err) {
      if (err instanceof ApiError && err.code === "contact_exists") {
        setErrors({ email: "Another contact already uses this email." });
      } else {
        const fe = fieldErrorsFrom(err);
        setErrors(fe);
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const name = contactName(contact);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/app/contacts" className="text-slate-600 hover:underline dark:text-slate-400">
          Contacts
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-900 dark:text-slate-100">
          {name}
        </span>
      </nav>
      <PageHeader
        title={name}
        description={
          contact.title && contact.company
            ? `${contact.title} at ${contact.company.name}`
            : contact.email
        }
        actions={
          can("owner", "admin", "manager") ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <PromisesPanel contactId={contact.id} contactLabel={name} />
          <ContactTasksCard contactId={contact.id} contactName={name} />
          <Card>
            <CardHeader title="Details" />
            <form onSubmit={onSave} noValidate className="space-y-4 p-5">
              {formError ? <Alert tone="error">{formError}</Alert> : null}
              <ContactFields
                values={values}
                errors={errors}
                disabled={saving}
                onChange={(k, v) => setValues((prev) => (prev ? { ...prev, [k]: v } : prev))}
              />
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="secondary"
                  disabled={!dirty || saving}
                  onClick={() => {
                    setValues(valuesFromContact(contact));
                    setErrors({});
                    setFormError(null);
                  }}
                >
                  Discard changes
                </Button>
                <Button type="submit" loading={saving} disabled={!dirty}>
                  Save changes
                </Button>
              </div>
            </form>
          </Card>
          <ContactSequencesCard contactId={contact.id} />
          <ContactMessagesCard contactId={contact.id} />
        </div>

        <div className="space-y-6">
          <CompliancePanel
            // Re-check after consent or contact changes on this page.
            key={`${contact.consentBasis}-${contact.status}-${contact.updatedAt}`}
            contactId={contact.id}
            contactName={name}
          />
          <Card className="h-fit">
            <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <Avatar name={name} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                  {contact.email}
                </p>
              </div>
            </div>
            <dl className="space-y-4 p-5">
              <Detail label="Status">
                <StatusBadge status={contact.status} />
              </Detail>
              <Detail label="Company">
                {contact.company ? (
                  <>
                    {contact.company.name}
                    {contact.company.domain ? (
                      <span className="text-slate-500 dark:text-slate-400">
                        {" "}
                        · {contact.company.domain}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </Detail>
              <Detail label="Added">{formatDate(contact.createdAt)}</Detail>
              <Detail label="Last updated">{formatDate(contact.updatedAt)}</Detail>
            </dl>
          </Card>
          <ConsentCard
            contactId={contact.id}
            onChanged={(basis) =>
              setData((prev) => (prev ? { ...prev, consentBasis: basis } : prev))
            }
          />
        </div>
      </div>

      <DeleteContactDialog
        contact={contact}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}
