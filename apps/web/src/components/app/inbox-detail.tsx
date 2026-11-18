"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  InboxReplyInputSchema,
  REPLY_LABELS,
  type AiActionDto,
  type InboxMessageDto,
  type ReplyLabel,
  type ScoutSettingsDto,
} from "@openline/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  LoadingBlock,
  Select,
  Textarea,
  useToast,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import {
  fullDateTime,
  notifyInboxChanged,
  REPLY_LABEL_TEXT,
  relativeTime,
  replySendError,
  safeHttpUrl,
  senderName,
} from "@/lib/inbox";
import { decisionLabel, formatDateTime, titleCase } from "@/lib/labels";
import { scoutErrorMessage, type ScoutProblem } from "@/lib/scout";
import { useResource } from "@/lib/use-resource";
import { ComplianceBadge } from "./compliance";
import { DealDialog } from "./deal-dialog";
import { PromisesPanel } from "./promises";
import { ReplyLabelChip } from "./reply-label";
import { scoutUnavailableReason } from "./scout-first-touch";
import { ScoutProblemAlert, ScoutReview } from "./scout-review";

const sectionTitle =
  "text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400";

// ------------------------------------------------------------------ label editor

function LabelEditor({
  message,
  onSaved,
}: {
  message: InboxMessageDto;
  onSaved: (m: InboxMessageDto) => void;
}) {
  const { toast } = useToast();
  const [value, setValue] = useState<ReplyLabel | "">(message.label ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => setValue(message.label ?? ""), [message.id, message.label]);

  const changed = value !== "" && value !== message.label;

  async function save() {
    if (!changed) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api<InboxMessageDto>(`/inbox/${message.id}`, {
        method: "PATCH",
        body: { label: value },
      });
      onSaved(updated);
      notifyInboxChanged();
      toast(`Labelled “${REPLY_LABEL_TEXT[value as ReplyLabel]}”`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className={sectionTitle}>
        Label
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          id={id}
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value as ReplyLabel)}
          className="sm:max-w-xs"
        >
          {value === "" ? <option value="">Not labelled yet</option> : null}
          {REPLY_LABELS.map((l) => (
            <option key={l} value={l}>
              {REPLY_LABEL_TEXT[l]}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          disabled={!changed}
          loading={saving}
          onClick={() => void save()}
        >
          Change label
        </Button>
      </div>
      {changed && value === "unsubscribe" ? (
        <Alert tone="warning">
          Labelling this “Unsubscribe” adds {message.from.email} to your suppression list and stops
          every sequence for this contact. Changing the label back later won&apos;t undo that.
        </Alert>
      ) : changed && message.label === "unsubscribe" ? (
        <Alert tone="info">
          The suppression stays in place. An admin can remove it in Settings → Suppressions.
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Scout reply draft

function ScoutReplyDraft({
  message,
  onApproved,
}: {
  message: InboxMessageDto;
  onApproved: (body: string) => void;
}) {
  const settings = useResource<ScoutSettingsDto>("/workspace/scout");
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [problem, setProblem] = useState<ScoutProblem | null>(null);
  const [action, setAction] = useState<AiActionDto | null>(null);
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOpen(false);
    setAction(null);
    setProblem(null);
    setInstructions("");
    setStatus("");
  }, [message.id]);

  const unavailable = scoutUnavailableReason(settings.data);

  async function draft(e: FormEvent) {
    e.preventDefault();
    setDrafting(true);
    setProblem(null);
    setStatus("Scout is drafting a reply…");
    try {
      const result = await api<AiActionDto>("/scout/drafts/reply", {
        method: "POST",
        body: { messageId: message.id, instructions: instructions.trim() || undefined },
      });
      setAction(result);
      setStatus("Scout's reply draft is ready for review.");
    } catch (err) {
      setProblem(scoutErrorMessage(err));
      setStatus("Scout couldn't draft a reply.");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {action ? (
        <ScoutReview
          action={action}
          approveLabel="put in reply box"
          applyHint="Puts the text in the reply box below. Nothing is sent until you press Send."
          onApproved={(d) => {
            setAction(null);
            setOpen(false);
            setStatus("");
            onApproved(d.body);
          }}
          onRejected={() => {
            setAction(null);
            setStatus("Draft rejected.");
          }}
          onDiscard={() => setAction(null)}
        />
      ) : !open ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            Ask Scout to draft a reply
          </Button>
          {unavailable ? (
            <p className="text-xs text-slate-600 dark:text-slate-400">{unavailable}</p>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={draft}
          noValidate
          className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
        >
          {unavailable ? <Alert tone="warning">{unavailable}</Alert> : null}
          {problem ? <ScoutProblemAlert problem={problem} /> : null}
          <Field
            label="Instructions for Scout (optional)"
            hint="e.g. “Suggest Tuesday or Wednesday afternoon for a call”."
          >
            {(p) => (
              <Input
                {...p}
                ref={inputRef}
                maxLength={500}
                value={instructions}
                disabled={drafting}
                onChange={(e) => setInstructions(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={drafting} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={drafting}>
              {drafting ? "Drafting…" : "Draft reply"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ composer

function ReplyComposer({
  message,
  text,
  setText,
  textareaRef,
  onSent,
}: {
  message: InboxMessageDto;
  text: string;
  setText: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSent: (m: InboxMessageDto) => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setSent(null);
    setFieldError(null);
  }, [message.id]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    const parsed = InboxReplyInputSchema.safeParse({ body: text });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Write a reply");
      textareaRef.current?.focus();
      return;
    }
    setFieldError(null);
    setSending(true);
    try {
      const updated = await api<InboxMessageDto>(`/inbox/${message.id}/reply`, {
        method: "POST",
        body: parsed.data,
      });
      setText("");
      setSent(`Reply sent from ${message.mailbox.email}. This reply is marked handled.`);
      onSent(updated);
      notifyInboxChanged();
    } catch (err) {
      setError(replySendError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={send} noValidate className="space-y-3">
      <div aria-live="polite">{sent ? <Alert tone="success">{sent}</Alert> : null}</div>
      {error ? (
        <Alert tone="error" title={error.title}>
          {error.body}
        </Alert>
      ) : null}
      <Field
        label="Your reply"
        hint={`Sent from ${message.mailbox.email} in the same thread. Your mailing address and an unsubscribe link are added, as in every email.`}
        error={fieldError ?? undefined}
      >
        {(p) => (
          <Textarea
            {...p}
            ref={textareaRef}
            rows={6}
            maxLength={10_000}
            value={text}
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={sending}>
          {sending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ detail

export function InboxDetail({
  id,
  onUpdated,
  onBack,
}: {
  id: string;
  onUpdated: (m: InboxMessageDto) => void;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const { data, error, loading, reload, setData } = useResource<InboxMessageDto>(`/inbox/${id}`);
  const [handling, setHandling] = useState(false);
  const [creatingDeal, setCreatingDeal] = useState(false);
  const [composer, setComposer] = useState("");
  const [liveNote, setLiveNote] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();

  useEffect(() => {
    setComposer("");
    setLiveNote("");
  }, [id]);

  // Focus the message heading once it has loaded, so keyboard users land in the detail.
  const loadedId = data?.id;
  useEffect(() => {
    if (loadedId) headingRef.current?.focus();
  }, [loadedId]);

  function update(m: InboxMessageDto) {
    setData(() => m);
    onUpdated(m);
  }

  async function setHandled(handled: boolean) {
    if (!data) return;
    setHandling(true);
    try {
      const updated = await api<InboxMessageDto>(`/inbox/${data.id}`, {
        method: "PATCH",
        body: { handled },
      });
      update(updated);
      notifyInboxChanged();
      toast(handled ? "Marked handled" : "Moved back to Needs action");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setHandling(false);
    }
  }

  const backButton = (
    <Button variant="ghost" size="sm" onClick={onBack} className="lg:hidden">
      ← Back to inbox
    </Button>
  );

  if (loading && !data) {
    return (
      <Card>
        <div className="p-3">{backButton}</div>
        <LoadingBlock label="Loading reply" />
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card className="space-y-3 p-4">
        {backButton}
        <Alert tone="error" title="Couldn't load this reply">
          {errorMessage(error)}
        </Alert>
        <Button variant="secondary" onClick={reload}>
          Try again
        </Button>
      </Card>
    );
  }

  const m = data;
  const name = senderName(m);
  const openUrl = safeHttpUrl(m.openUrl);
  const contactLabel = m.contact
    ? [m.contact.firstName, m.contact.lastName].filter(Boolean).join(" ") || m.contact.email
    : null;

  return (
    <Card>
      <article aria-labelledby={headingId}>
        <header className="space-y-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="-mt-1 -ml-2">{backButton}</div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
                className="text-lg font-semibold text-slate-900 focus:outline-none dark:text-white"
              >
                {name}
              </h2>
              <p className="truncate text-sm text-slate-600 dark:text-slate-400">
                {m.from.email}
                {m.company ? ` · ${m.company.name}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <ReplyLabelChip
                label={m.label}
                source={m.labelSource}
                confidence={m.labelConfidence}
              />
              {m.handledAt ? <Badge tone="neutral">Handled</Badge> : null}
            </div>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Received{" "}
            <time dateTime={m.receivedAt} title={fullDateTime(m.receivedAt)}>
              {relativeTime(m.receivedAt)}
            </time>{" "}
            in {m.mailbox.email}
            {m.handledAt ? ` · handled ${formatDateTime(m.handledAt)}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {m.handledAt ? (
              <Button
                size="sm"
                variant="secondary"
                loading={handling}
                onClick={() => void setHandled(false)}
              >
                Move back to Needs action
              </Button>
            ) : (
              <Button size="sm" loading={handling} onClick={() => void setHandled(true)}>
                Mark handled
              </Button>
            )}
            {openUrl ? (
              <a
                href={openUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300 dark:hover:bg-indigo-950"
              >
                Open in mailbox<span className="sr-only"> (opens in a new tab)</span> ↗
              </a>
            ) : null}
            {m.dealPrefill ? (
              <Button size="sm" variant="secondary" onClick={() => setCreatingDeal(true)}>
                Create deal
              </Button>
            ) : null}
          </div>
          {m.dealPrefill?.openDeals.length ? (
            <p className="text-xs text-slate-700 dark:text-slate-300">
              Open deals with {contactLabel ?? name}:{" "}
              {m.dealPrefill.openDeals.map((d, i) => (
                <span key={d.id}>
                  {i ? ", " : ""}
                  <Link
                    href={`/app/deals/${d.id}`}
                    className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                  >
                    {d.name}
                  </Link>{" "}
                  ({d.stageName})
                </span>
              ))}
            </p>
          ) : null}
        </header>

        <div className="space-y-6 px-5 py-5">
          {m.matchedBy === "colleague" && contactLabel ? (
            <Alert tone="info" title="From a colleague">
              {m.from.email} works at the same company as {contactLabel}, so {contactLabel}&apos;s
              sequence was stopped.
            </Alert>
          ) : null}

          <section aria-label="Their reply" className="space-y-2">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{m.subject}</p>
            {/* Untrusted text from outside: rendered as a plain text node, never as HTML. */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-900 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
              {m.text || m.snippet}
            </div>
            {m.summary ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                <span className="font-medium">Scout&apos;s summary:</span> {m.summary}
              </p>
            ) : null}
          </section>

          {m.referral && (m.referral.name || m.referral.email) ? (
            <Alert tone="info" title="They referred you to someone">
              {[m.referral.name, m.referral.email].filter(Boolean).join(" · ")}
            </Alert>
          ) : null}

          <section className="space-y-2" aria-labelledby={`${headingId}-orig`}>
            <h3 id={`${headingId}-orig`} className={sectionTitle}>
              What they replied to
            </h3>
            {m.original ? (
              <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
                <p className="text-slate-900 dark:text-slate-100">
                  {m.original.stepPosition ? `Step ${m.original.stepPosition}: ` : ""}
                  <span className="font-medium">{m.original.subject}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                  Sent {formatDateTime(m.original.sentAt)}
                  {m.sequence ? (
                    <>
                      {" "}
                      from{" "}
                      <Link
                        href={`/app/sequences/${m.sequence.id}`}
                        className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                      >
                        {m.sequence.name}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {m.sequence
                  ? `A step of ${m.sequence.name} (we couldn't tell which one).`
                  : "We couldn't tell which email this answers."}
              </p>
            )}
            {m.enrollment ? (
              <p className="text-xs text-slate-700 dark:text-slate-300">
                Sequence status: <strong>{titleCase(m.enrollment.state)}</strong>
                {m.enrollment.lastDecision ? ` — ${decisionLabel(m.enrollment.lastDecision)}` : ""}
                {m.enrollment.state === "active" && m.enrollment.nextRunAt
                  ? `. Next email ${formatDateTime(m.enrollment.nextRunAt)}.`
                  : ""}
              </p>
            ) : null}
            {m.contact ? (
              <Link
                href={`/app/contacts/${m.contact.id}`}
                className="inline-block text-sm font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
              >
                Open {contactLabel}&apos;s contact page →
              </Link>
            ) : null}
          </section>

          <LabelEditor message={m} onSaved={update} />

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <PromisesPanel
              // Refetch after a reply: Promise Keeper reads your replies too.
              key={m.replies.length}
              card={false}
              contactId={m.contact?.id}
              messageIds={[m.id, ...m.replies.map((r) => r.id)]}
              contactLabel={contactLabel ?? undefined}
            />
          </div>

          {m.replies.length > 0 ? (
            <section className="space-y-2" aria-labelledby={`${headingId}-sent`}>
              <h3 id={`${headingId}-sent`} className={sectionTitle}>
                Your replies
              </h3>
              <ul className="space-y-1.5 text-sm">
                {m.replies.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-2 text-slate-800 dark:text-slate-200"
                  >
                    <span className="font-medium">{r.subject}</span>
                    <span className="text-xs text-slate-600 dark:text-slate-400">
                      {formatDateTime(r.sentAt)}
                    </span>
                    <Badge tone={r.status === "sent" ? "success" : "neutral"}>
                      {titleCase(r.status)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="space-y-4" aria-labelledby={`${headingId}-reply`}>
            <h3 id={`${headingId}-reply`} className={sectionTitle}>
              Reply
            </h3>
            <p className="sr-only" role="status" aria-live="polite">
              {liveNote}
            </p>
            <ScoutReplyDraft
              message={m}
              onApproved={(body) => {
                setComposer(body);
                setLiveNote("Scout's draft is in the reply box. Review it, then press Send reply.");
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
            {m.contact ? (
              <ComplianceBadge contactId={m.contact.id} name={contactLabel ?? m.from.email} />
            ) : null}
            <ReplyComposer
              message={m}
              text={composer}
              setText={setComposer}
              textareaRef={textareaRef}
              onSent={update}
            />
          </section>
        </div>
      </article>
      {m.dealPrefill ? (
        <DealDialog
          open={creatingDeal}
          onClose={() => setCreatingDeal(false)}
          prefill={{
            name: m.dealPrefill.name,
            contact:
              m.contact && m.dealPrefill.contactId
                ? {
                    id: m.dealPrefill.contactId,
                    name: contactLabel ?? m.contact.email,
                    email: m.contact.email,
                  }
                : null,
            company:
              m.company && m.dealPrefill.companyId
                ? { id: m.dealPrefill.companyId, name: m.company.name }
                : null,
          }}
          onCreated={(deal) => {
            toast(`Deal “${deal.name}” created`);
            router.push(`/app/deals/${deal.id}`);
          }}
        />
      ) : null}
    </Card>
  );
}
