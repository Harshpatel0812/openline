"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ContactDto, EnrollResultDto, MailboxDto, SequenceDto } from "@openline/shared";
import { Alert, Button, Dialog, Field, LoadingBlock, Select } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { contactName } from "@/lib/format";
import { SKIP_REASON_LABELS } from "@/lib/labels";
import { useResource } from "@/lib/use-resource";
import { useMe } from "./me-context";

type SkipReason = EnrollResultDto["skipped"][number]["reason"];

function enrollError(err: unknown): React.ReactNode {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "email_not_verified":
        return "Verify your email address first — use “Resend email” in the banner at the top of the page.";
      case "sequence_not_active":
        return "That sequence isn't active any more. Pick another one or activate it first.";
      case "mailbox_not_active":
        return (
          <>
            That mailbox is paused or disconnected. Check it in{" "}
            <Link href="/app/settings/mailboxes" className="font-medium underline">
              Settings → Mailboxes
            </Link>
            .
          </>
        );
    }
    if (err.status === 403) return "You can only send from your own mailboxes.";
  }
  return errorMessage(err);
}

/** "Add to sequence" for the contacts selected on the Contacts page. */
export function EnrollDialog({
  open,
  onClose,
  contacts,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  contacts: ContactDto[];
  onDone: () => void;
}) {
  const { me, can } = useMe();
  const sequences = useResource<SequenceDto[]>(open ? "/sequences" : null);
  const mailboxes = useResource<MailboxDto[]>(open ? "/mailboxes" : null);
  const [sequenceId, setSequenceId] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrollResultDto | null>(null);
  // Snapshot the selection when the dialog opens: the page clears it after enrolling, but the
  // result still needs the names.
  const [picked, setPicked] = useState<ContactDto[]>([]);
  const formId = useId();
  const contactsRef = useRef(contacts);
  contactsRef.current = contacts;

  const active = useMemo(
    () => (sequences.data ?? []).filter((s) => s.status === "active"),
    [sequences.data],
  );
  const usable = useMemo(
    () =>
      (mailboxes.data ?? []).filter(
        (m) =>
          m.status === "active" && (can("owner", "admin", "manager") || m.ownerId === me.user.id),
      ),
    [mailboxes.data, can, me.user.id],
  );

  useEffect(() => {
    if (open) {
      setPicked(contactsRef.current);
      setResult(null);
      setErrors({});
      setFormError(null);
    }
  }, [open]);
  useEffect(() => {
    if (!active.some((s) => s.id === sequenceId)) setSequenceId(active[0]?.id ?? "");
  }, [active, sequenceId]);
  useEffect(() => {
    if (!usable.some((m) => m.id === mailboxId)) {
      setMailboxId((usable.find((m) => m.ownerId === me.user.id) ?? usable[0])?.id ?? "");
    }
  }, [usable, mailboxId, me.user.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: Record<string, string> = {};
    if (!sequenceId) next.sequenceId = "Pick a sequence";
    if (!mailboxId) next.mailboxId = "Pick a mailbox";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSubmitting(true);
    try {
      const r = await api<EnrollResultDto>(`/sequences/${sequenceId}/enroll`, {
        method: "POST",
        body: { contactIds: picked.map((c) => c.id), mailboxId },
      });
      setResult(r);
      onDone();
    } catch (err) {
      setFormError(enrollError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const loading = (sequences.loading && !sequences.data) || (mailboxes.loading && !mailboxes.data);
  const loadError = sequences.error ?? mailboxes.error;
  const count = picked.length;
  const byId = new Map(picked.map((c) => [c.id, c]));

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (result) {
    const groups = new Map<SkipReason, string[]>();
    for (const s of result.skipped) {
      const c = byId.get(s.contactId);
      const list = groups.get(s.reason) ?? [];
      list.push(c ? contactName(c) : "A contact");
      groups.set(s.reason, list);
    }
    body = (
      <div className="space-y-4">
        <Alert tone={result.enrolled > 0 ? "success" : "warning"}>
          <strong>{result.enrolled.toLocaleString()} added</strong> to{" "}
          {active.find((s) => s.id === sequenceId)?.name ?? "the sequence"}.
          {result.enrolled > 0
            ? " The first emails go out during each contact's business hours."
            : null}
        </Alert>
        {groups.size > 0 ? (
          <div>
            <h3 className="text-sm font-semibold">
              {result.skipped.length.toLocaleString()} skipped
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Openline skips anyone it isn&apos;t safe or legal to email.
            </p>
            <ul className="mt-3 space-y-3">
              {[...groups.entries()].map(([reason, names]) => (
                <li key={reason}>
                  <p className="text-sm font-medium">
                    {SKIP_REASON_LABELS[reason] ?? reason}{" "}
                    <span className="font-normal text-slate-600 dark:text-slate-400">
                      ({names.length})
                    </span>
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {names.slice(0, 8).join(", ")}
                    {names.length > 8 ? ` and ${names.length - 8} more` : ""}
                  </p>
                  {reason === "no_consent" ? (
                    <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                      Record consent on each contact&apos;s page, then add them again.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
    footer = <Button onClick={onClose}>Done</Button>;
  } else if (loading) {
    body = <LoadingBlock label="Loading sequences and mailboxes" />;
  } else if (loadError) {
    body = (
      <Alert tone="error" title="Couldn't load sequences or mailboxes">
        {errorMessage(loadError)}
      </Alert>
    );
    footer = (
      <Button
        variant="secondary"
        onClick={() => {
          sequences.reload();
          mailboxes.reload();
        }}
      >
        Try again
      </Button>
    );
  } else if (active.length === 0 || usable.length === 0) {
    body = (
      <div className="space-y-3 text-sm">
        {active.length === 0 ? (
          <Alert tone="info" title="No active sequences">
            Only active sequences accept contacts.{" "}
            <Link href="/app/sequences" className="font-medium underline">
              Go to sequences
            </Link>
          </Alert>
        ) : null}
        {usable.length === 0 ? (
          <Alert tone="info" title="No mailbox to send from">
            {can("owner", "admin", "manager")
              ? "Connect or resume a mailbox first. "
              : "Connect your own mailbox first. "}
            <Link href="/app/settings/mailboxes" className="font-medium underline">
              Go to mailboxes
            </Link>
          </Alert>
        ) : null}
      </div>
    );
    footer = (
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
    );
  } else {
    body = (
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Sequence" error={errors.sequenceId} required>
          {(p) => (
            <Select {...p} value={sequenceId} onChange={(e) => setSequenceId(e.target.value)}>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.steps.length} step{s.steps.length === 1 ? "" : "s"})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Send from"
          error={errors.mailboxId}
          required
          hint={
            can("owner", "admin", "manager")
              ? undefined
              : "You can send from mailboxes you connected yourself."
          }
        >
          {(p) => (
            <Select {...p} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email} — {Math.max(0, m.dailyCap - m.sentToday)} left today
                </option>
              ))}
            </Select>
          )}
        </Field>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Suppressed, unsubscribed and bounced contacts, and anyone who needs consent we don&apos;t
          have on record, are skipped automatically.
        </p>
      </form>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" form={formId} loading={submitting}>
          Add {count.toLocaleString()} contact{count === 1 ? "" : "s"}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to sequence"
      description={
        result ? undefined : `${count.toLocaleString()} contact${count === 1 ? "" : "s"} selected`
      }
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
