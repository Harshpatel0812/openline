"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  CONSENT_BASES,
  ConsentInputSchema,
  type ConsentDto,
  type EnrollmentDto,
  type MessageDto,
  type SequenceDto,
} from "@openline/shared";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { formatDate, zodFieldErrors } from "@/lib/format";
import { CONSENT_LABELS, enrollmentStatus, formatDateTime, formatDay } from "@/lib/labels";
import { useResource } from "@/lib/use-resource";
import { EnrollmentActions, EnrollmentStateBadge } from "./enrollments";
import { useMe } from "./me-context";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  );
}

function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="p-4">
      <Alert tone="error">
        {errorMessage(error)}{" "}
        <button type="button" className="font-medium underline" onClick={onRetry}>
          Try again
        </button>
      </Alert>
    </div>
  );
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ consent

function RecordConsentDialog({
  open,
  contactId,
  current,
  onClose,
  onSaved,
}: {
  open: boolean;
  contactId: string;
  current: ConsentDto | null;
  onClose: () => void;
  onSaved: (c: ConsentDto) => void;
}) {
  const [basis, setBasis] = useState<ConsentDto["basis"]>("express");
  const [source, setSource] = useState("");
  const [obtainedAt, setObtainedAt] = useState(todayIso());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setBasis(current && current.basis !== "none" ? current.basis : "express");
      setSource("");
      setObtainedAt(todayIso());
      setErrors({});
      setFormError(null);
    }
  }, [open, current]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = ConsentInputSchema.safeParse({
      basis,
      source: source.trim() || undefined,
      obtainedAt: obtainedAt || undefined,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const saved = await api<ConsentDto>(`/contacts/${contactId}/consent`, {
        method: "PUT",
        body: { ...parsed.data, obtainedAt: obtainedAt || undefined },
      });
      onSaved(saved);
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      setFormError(
        Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record consent"
      description="Note why you may email this person, where it came from and when."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Save consent
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field
          label="Basis"
          error={errors.basis}
          required
          hint="Canada (CASL) needs express or implied consent; implied consent expires. The EU and UK need a lawful basis."
        >
          {(p) => (
            <Select
              {...p}
              value={basis}
              onChange={(e) => setBasis(e.target.value as ConsentDto["basis"])}
            >
              {CONSENT_BASES.map((b) => (
                <option key={b} value={b}>
                  {CONSENT_LABELS[b]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Source"
          error={errors.source}
          required={basis !== "none"}
          hint="For example: “Signed up at trade show booth, Toronto” or “Asked for a quote on our website”."
        >
          {(p) => (
            <Input
              {...p}
              value={source}
              maxLength={300}
              onChange={(e) => setSource(e.target.value)}
            />
          )}
        </Field>
        <Field label="Date obtained" error={errors.obtainedAt} required={basis !== "none"}>
          {(p) => (
            <Input
              {...p}
              type="date"
              max={todayIso()}
              value={obtainedAt}
              onChange={(e) => setObtainedAt(e.target.value)}
              className="max-w-[12rem]"
            />
          )}
        </Field>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Every change is kept in the audit log, so you can prove consent later.
        </p>
      </form>
    </Dialog>
  );
}

export function ConsentCard({
  contactId,
  onChanged,
}: {
  contactId: string;
  onChanged: (basis: ConsentDto["basis"]) => void;
}) {
  const { can } = useMe();
  const { data, error, loading, reload, setData } = useResource<ConsentDto | null>(
    `/contacts/${contactId}/consent`,
  );
  const [open, setOpen] = useState(false);
  const canEdit = can("owner", "admin", "manager");
  const consent = data ?? null;
  const expired = consent?.expiresAt ? new Date(consent.expiresAt).getTime() < Date.now() : false;

  return (
    <Card className="h-fit">
      <CardHeader
        title="Consent"
        actions={
          canEdit ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Record consent
            </Button>
          ) : undefined
        }
      />
      {loading && data === undefined ? (
        <LoadingBlock label="Loading consent" />
      ) : error ? (
        <SectionError error={error} onRetry={reload} />
      ) : !consent || consent.basis === "none" ? (
        <div className="space-y-2 p-5 text-sm">
          <p className="text-slate-800 dark:text-slate-200">No consent recorded.</p>
          <p className="text-slate-600 dark:text-slate-400">
            Contacts in Canada, the EU or the UK are skipped from sequences until you record
            consent.
            {!canEdit ? " Ask a manager or admin to record it." : ""}
          </p>
        </div>
      ) : (
        <dl className="space-y-4 p-5">
          {consent.withdrawnAt ? (
            <Row label="Status">
              <span className="font-medium text-red-700 dark:text-red-400">
                Withdrawn on {formatDate(consent.withdrawnAt)}
              </span>
            </Row>
          ) : null}
          <Row label="Basis">
            {CONSENT_LABELS[consent.basis]}
            {consent.withdrawnAt ? " (no longer valid)" : ""}
          </Row>
          <Row label="Source">{consent.source ?? "—"}</Row>
          <Row label="Obtained">{formatDay(consent.obtainedAt)}</Row>
          <Row label="Expires">
            {consent.withdrawnAt ? (
              "—"
            ) : consent.expiresAt ? (
              <span className={expired ? "font-medium text-red-700 dark:text-red-400" : undefined}>
                {formatDay(consent.expiresAt)}
                {expired ? " (expired)" : ""}
              </span>
            ) : (
              "Doesn't expire"
            )}
          </Row>
          <Row label="Recorded">{formatDate(consent.recordedAt)}</Row>
        </dl>
      )}
      <p className="border-t border-slate-200 px-5 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
        Every change is kept in the audit log.
      </p>
      {canEdit ? (
        <RecordConsentDialog
          open={open}
          contactId={contactId}
          current={consent}
          onClose={() => setOpen(false)}
          onSaved={(c) => {
            setOpen(false);
            setData(() => c);
            onChanged(c.basis);
          }}
        />
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ sequences + messages

function useSequenceNames(): Map<string, string> {
  const { data } = useResource<SequenceDto[]>("/sequences", { includeArchived: "true" });
  return useMemo(() => new Map((data ?? []).map((s) => [s.id, s.name])), [data]);
}

export function ContactSequencesCard({ contactId }: { contactId: string }) {
  const names = useSequenceNames();
  const { data, error, loading, reload, setData } = useResource<EnrollmentDto[]>(
    `/contacts/${contactId}/enrollments`,
  );

  return (
    <Card>
      <CardHeader title="Sequences" description="Times are in your local time zone." />
      {loading && !data ? (
        <LoadingBlock label="Loading sequences" />
      ) : error ? (
        <SectionError error={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          title="Not in any sequence"
          description="Select this contact on the Contacts page and choose “Add to sequence”."
        />
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {data.map((e) => {
            const name = names.get(e.sequenceId) ?? "Sequence";
            const status = enrollmentStatus(e);
            return (
              <li key={e.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/app/sequences/${e.sequenceId}`}
                      className="rounded text-sm font-medium text-slate-900 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-white"
                    >
                      {name}
                    </Link>
                    <EnrollmentStateBadge state={e.state} />
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    From {e.mailbox.email}
                    {e.state === "active" && e.nextRunAt
                      ? ` · Step ${e.nextPosition} ${formatDateTime(e.nextRunAt)}`
                      : ""}
                  </p>
                  {status.label !== "—" ? (
                    <p className="text-sm text-slate-700 dark:text-slate-300">{status.label}</p>
                  ) : null}
                  {status.error ? (
                    <p className="text-xs text-red-700 dark:text-red-400">{status.error}</p>
                  ) : null}
                  {status.compliance ? (
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      Compliance check: {status.compliance.rule}
                      {status.compliance.detail ? ` — ${status.compliance.detail}` : ""}
                    </p>
                  ) : null}
                </div>
                <EnrollmentActions
                  enrollment={e}
                  label={name}
                  onUpdated={(u) => setData((prev) => prev?.map((x) => (x.id === u.id ? u : x)))}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function ContactMessagesCard({ contactId }: { contactId: string }) {
  const names = useSequenceNames();
  const { data, error, loading, reload } = useResource<MessageDto[]>(
    `/contacts/${contactId}/messages`,
  );

  return (
    <Card>
      <CardHeader title="Emails sent" />
      {loading && !data ? (
        <LoadingBlock label="Loading emails" />
      ) : error ? (
        <SectionError error={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No emails sent yet" />
      ) : (
        <Table caption="Emails sent to this contact" className="[&_table]:min-w-[560px]">
          <thead>
            <tr>
              <Th>Subject</Th>
              <Th>Sequence step</Th>
              <Th>Mailbox</Th>
              <Th>Sent</Th>
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id}>
                <Td className="font-medium">{m.subject}</Td>
                <Td className="text-slate-600 dark:text-slate-400">
                  {m.sequenceId ? (names.get(m.sequenceId) ?? "Sequence") : "—"}
                  {m.stepPosition ? ` · Step ${m.stepPosition}` : ""}
                </Td>
                <Td className="text-slate-600 dark:text-slate-400">{m.mailboxEmail ?? "—"}</Td>
                <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                  {formatDateTime(m.sentAt)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
