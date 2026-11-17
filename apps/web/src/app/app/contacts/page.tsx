"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ContactDto, ContactListDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { CrmBadge } from "@/components/app/crm-badge";
import { EnrollDialog } from "@/components/app/enroll-dialog";
import {
  ContactFields,
  emptyContactValues,
  parseContactValues,
  type ContactFormValues,
} from "@/components/app/contact-form";
import {
  Alert,
  Button,
  buttonClasses,
  Card,
  Dialog,
  EmptyState,
  Input,
  LoadingBlock,
  StatusBadge,
  Table,
  Td,
  Th,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { crmOf } from "@/lib/crm";
import { contactName, formatDate } from "@/lib/format";
import { useDebounced } from "@/lib/use-resource";

const PAGE_SIZE = 50;

function AddContactDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: ContactDto) => void;
}) {
  const [values, setValues] = useState<ContactFormValues>(emptyContactValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setValues(emptyContactValues);
      setErrors({});
      setFormError(null);
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = parseContactValues(values);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const created = await api<ContactDto>("/contacts", { method: "POST", body: parsed.data });
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.code === "contact_exists") {
        setErrors({ email: "A contact with this email already exists in this workspace." });
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add contact"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Add contact
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <ContactFields
          values={values}
          errors={errors}
          onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
          disabled={saving}
        />
      </form>
    </Dialog>
  );
}

function ContactsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const { toast } = useToast();
  const searchId = useId();

  const [search, setSearch] = useState(q);
  const debounced = useDebounced(search, 300);
  const [list, setList] = useState<ContactListDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<Map<string, ContactDto>>(new Map());
  const [enrolling, setEnrolling] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // A new search starts a new selection.
  useEffect(() => setSelected(new Map()), [q]);

  const pageIds = list?.items.map((c) => c.id) ?? [];
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedOnPage > 0 && !allOnPage;
    }
  }, [selectedOnPage, allOnPage]);

  function toggle(c: ContactDto, on: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(c.id, c);
      else next.delete(c.id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const c of list?.items ?? []) {
        if (on) next.set(c.id, c);
        else next.delete(c.id);
      }
      return next;
    });
  }

  // Debounced search box → ?q=
  useEffect(() => {
    const trimmed = debounced.trim();
    if (trimmed === q) return;
    const next = new URLSearchParams(params.toString());
    if (trimmed) next.set("q", trimmed);
    else next.delete("q");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [debounced, q, params, pathname, router]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<ContactListDto>("/contacts", {
      query: { q: q || undefined, limit: PAGE_SIZE },
      signal: controller.signal,
    })
      .then((data) => {
        setList(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [q, nonce]);

  const loadMore = useCallback(async () => {
    if (!list?.nextCursor) return;
    setLoadingMore(true);
    try {
      const more = await api<ContactListDto>("/contacts", {
        query: { q: q || undefined, limit: PAGE_SIZE, cursor: list.nextCursor },
      });
      setList((prev) =>
        prev
          ? {
              items: [...prev.items, ...more.items],
              nextCursor: more.nextCursor,
              total: more.total,
            }
          : more,
      );
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoadingMore(false);
    }
  }, [list, q, toast]);

  const isEmptyWorkspace = list && list.total === 0 && !q;

  return (
    <>
      <PageHeader
        title="Contacts"
        description={
          list
            ? `${list.total.toLocaleString()} contact${list.total === 1 ? "" : "s"}${q ? " match your search" : ""}`
            : undefined
        }
        actions={
          <>
            <Link href="/app/contacts/import" className={buttonClasses("secondary")}>
              Import CSV
            </Link>
            <Button onClick={() => setAdding(true)}>Add contact</Button>
          </>
        }
      />

      <Card>
        <div className="border-b border-slate-200 p-4 dark:border-slate-800">
          <label htmlFor={searchId} className="sr-only">
            Search contacts
          </label>
          <Input
            id={searchId}
            type="search"
            placeholder="Search by name, email or company"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
        </div>
        {selected.size > 0 ? (
          <div
            role="region"
            aria-label="Bulk actions"
            className="flex flex-wrap items-center gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm dark:border-indigo-900 dark:bg-indigo-950"
          >
            <p className="font-medium text-indigo-900 dark:text-indigo-100" aria-live="polite">
              {selected.size.toLocaleString()} selected
            </p>
            <Button size="sm" onClick={() => setEnrolling(true)}>
              Add to sequence
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
              Clear selection
            </Button>
          </div>
        ) : null}

        {loading && !list ? (
          <LoadingBlock label="Loading contacts" />
        ) : error ? (
          <div className="p-4">
            <Alert tone="error" title="Couldn't load contacts">
              {errorMessage(error)}{" "}
              <button
                type="button"
                className="font-medium underline"
                onClick={() => setNonce((n) => n + 1)}
              >
                Try again
              </button>
            </Alert>
          </div>
        ) : isEmptyWorkspace ? (
          <EmptyState
            title="No contacts yet"
            description="Import a CSV from your current CRM or spreadsheet, or add someone by hand."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/app/contacts/import" className={buttonClasses("primary")}>
                  Import contacts
                </Link>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  Add contact
                </Button>
              </div>
            }
          />
        ) : list && list.items.length === 0 ? (
          <EmptyState
            title="No matches"
            description={`No contacts match “${q}”. Try a different search.`}
          />
        ) : list ? (
          <>
            <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
              <Table caption="Contacts">
                <thead>
                  <tr>
                    <Th className="w-10">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        aria-label="Select all contacts on this page"
                        checked={allOnPage}
                        onChange={(e) => toggleAll(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-400 accent-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none"
                      />
                    </Th>
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th>Company</Th>
                    <Th>Title</Th>
                    <Th>Status</Th>
                    <Th>Added</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => router.push(`/app/contacts/${c.id}`)}
                      className={
                        selected.has(c.id)
                          ? "cursor-pointer bg-indigo-50/60 hover:bg-indigo-50 dark:bg-indigo-950/40"
                          : "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      }
                    >
                      <Td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${contactName(c)}`}
                          checked={selected.has(c.id)}
                          onChange={(e) => toggle(c, e.target.checked)}
                          className="h-4 w-4 rounded border-slate-400 accent-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none"
                        />
                      </Td>
                      <Td className="font-medium">
                        <Link
                          href={`/app/contacts/${c.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:text-white"
                        >
                          {contactName(c)}
                        </Link>
                        {crmOf(c) ? (
                          <div className="mt-1">
                            <CrmBadge crm={crmOf(c)} label={contactName(c)} />
                          </div>
                        ) : null}
                      </Td>
                      <Td className="text-slate-600 dark:text-slate-400">{c.email}</Td>
                      <Td>{c.company?.name ?? "—"}</Td>
                      <Td>{c.title ?? "—"}</Td>
                      <Td>
                        <StatusBadge status={c.status} />
                      </Td>
                      <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {formatDate(c.createdAt)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <div className="flex flex-col items-center gap-2 p-4 text-sm text-slate-600 sm:flex-row sm:justify-between dark:text-slate-400">
              <p aria-live="polite">
                Showing {list.items.length.toLocaleString()} of {list.total.toLocaleString()}
              </p>
              {list.nextCursor ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                >
                  Load more
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </Card>

      <EnrollDialog
        open={enrolling}
        onClose={() => setEnrolling(false)}
        contacts={[...selected.values()]}
        onDone={() => setSelected(new Map())}
      />
      <AddContactDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(c) => {
          setAdding(false);
          toast(`Added ${contactName(c)}`);
          setNonce((n) => n + 1);
        }}
      />
    </>
  );
}

export default function ContactsPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading contacts" />}>
      <ContactsView />
    </Suspense>
  );
}
