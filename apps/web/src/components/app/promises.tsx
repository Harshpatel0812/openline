"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  AcceptPromiseInputSchema,
  type AcceptPromiseResultDto,
  type ContactDto,
  type PromiseProposalDto,
} from "@openline/shared";
import { Alert, Badge, Button, Card, Field, Input, Spinner, useToast } from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { contactName, zodFieldErrors } from "@/lib/format";
import {
  formatInZone,
  fromLocalParts,
  notifyTasksChanged,
  promiseHeadline,
  toLocalParts,
  viewerTimeZone,
} from "@/lib/tasks";
import { useResource } from "@/lib/use-resource";

export const SCOUT_SUGGESTION_NOTE = "Suggested by Scout — nothing happens until you accept";

/** Names for the contacts proposals mention (the proposal only carries the id). */
function useContactNames(ids: string[]): Map<string, string> {
  const [names, setNames] = useState(new Map<string, string>());
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void Promise.all(
      key.split(",").map((id) =>
        api<ContactDto>(`/contacts/${id}`, { signal: controller.signal })
          .then((c) => [id, contactName(c)] as const)
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (controller.signal.aborted) return;
      setNames(new Map(pairs.filter((p): p is readonly [string, string] => p !== null)));
    });
    return () => controller.abort();
  }, [key]);
  return names;
}

function PromiseCard({
  p,
  contactLabel,
  onDone,
}: {
  p: PromiseProposalDto;
  /** "Jane Doe", or undefined when unknown. */
  contactLabel: string | undefined;
  onDone: (p: PromiseProposalDto, message: string) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(p.title);
  const initial = toLocalParts(p.dueAt);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const who = contactLabel ?? "this contact";

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    setFormError(null);
    let body: Record<string, string> = {};
    if (editing) {
      const dueAt = fromLocalParts(date, time);
      if (!dueAt) {
        setErrors({ dueAt: "Choose a due date" });
        return;
      }
      if (title.trim() !== p.title) body.title = title;
      if (new Date(dueAt).getTime() !== new Date(p.dueAt).getTime()) body.dueAt = dueAt;
      const parsed = AcceptPromiseInputSchema.safeParse(body);
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error.issues));
        return;
      }
      body = parsed.data as Record<string, string>;
    }
    setErrors({});
    setBusy("accept");
    try {
      const r = await api<AcceptPromiseResultDto>(`/promises/${p.id}/accept`, {
        method: "POST",
        body,
      });
      notifyTasksChanged();
      const when = formatInZone(r.task?.dueAt ?? body.dueAt ?? p.dueAt);
      const msg = `Task created: ${r.task?.title ?? p.title}, due ${when}.`;
      toast(msg);
      onDone(r.promise, msg);
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      if (err instanceof ApiError && err.code === "validation_error" && !Object.keys(fe).length) {
        // A date problem: show it next to the date.
        setEditing(true);
        setErrors({ dueAt: err.message });
      } else {
        setErrors(fe);
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy("dismiss");
    setFormError(null);
    try {
      const r = await api<PromiseProposalDto>(`/promises/${p.id}/dismiss`, {
        method: "POST",
        body: {},
      });
      const msg = "Suggestion dismissed. No task was created.";
      toast(msg, "info");
      onDone(r, msg);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const sourceLink =
    p.messageId && p.direction === "inbound" ? (
      <Link
        href={`/app/inbox?message=${p.messageId}`}
        className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
      >
        their email
      </Link>
    ) : p.contactId ? (
      <Link
        href={`/app/contacts/${p.contactId}`}
        className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
      >
        your reply to {who}
      </Link>
    ) : (
      "your reply"
    );

  return (
    <li className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <article aria-labelledby={headingId} className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">Suggested by Scout</Badge>
          {p.dueDateMissing ? <Badge>No date given</Badge> : null}
        </div>
        <h3 id={headingId} className="font-semibold text-slate-900 dark:text-slate-100">
          {promiseHeadline(p)}
          {contactLabel && p.who === "them" ? ` (${contactLabel})` : ""}
        </h3>
        {/* Text from an email: rendered as plain text only. */}
        <blockquote className="border-l-4 border-slate-300 pl-3 text-slate-800 italic dark:border-slate-600 dark:text-slate-200">
          “{p.what}”
        </blockquote>
        {p.whenPhrase ? (
          <p className="text-slate-700 dark:text-slate-300">
            When they said: <q>{p.whenPhrase}</q>
          </p>
        ) : null}
        <p className="text-slate-800 dark:text-slate-200">
          <strong>If you accept:</strong> a task “{p.title}” due{" "}
          <strong>{formatInZone(p.dueAt)}</strong>
          {p.dueDateMissing ? " (no date was given, so we suggest two business days)" : ""}.
        </p>

        <p className="text-xs text-slate-600 dark:text-slate-400">
          Found in {sourceLink} · {formatInZone(p.createdAt)} ·{" "}
          {p.source === "model" ? "Scout's model" : "a text rule"}
        </p>

        {formError ? <Alert tone="error">{formError}</Alert> : null}

        {editing ? (
          <form
            id={formId}
            onSubmit={accept}
            noValidate
            className="space-y-3 rounded-md bg-slate-50 p-3 dark:bg-slate-950"
          >
            <Field label="Task title" error={errors.title} required>
              {(fp) => (
                <Input
                  {...fp}
                  value={title}
                  maxLength={200}
                  disabled={busy !== null}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Due date" error={errors.dueAt} required>
                {(fp) => (
                  <Input
                    {...fp}
                    type="date"
                    value={date}
                    disabled={busy !== null}
                    onChange={(e) => setDate(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Due time" hint={`Your time zone (${viewerTimeZone()})`}>
                {(fp) => (
                  <Input
                    {...fp}
                    type="time"
                    value={time}
                    disabled={busy !== null}
                    onChange={(e) => setTime(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </form>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          {editing ? (
            <>
              <Button size="sm" type="submit" form={formId} loading={busy === "accept"}>
                Accept with changes
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setEditing(false);
                  setErrors({});
                }}
              >
                Cancel changes
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                loading={busy === "accept"}
                disabled={busy !== null}
                onClick={() => void accept()}
                aria-label={`Accept — ${p.title}`}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => setEditing(true)}
                aria-label={`Edit before accepting — ${p.title}`}
              >
                Edit
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "dismiss"}
            disabled={busy !== null}
            onClick={() => void dismiss()}
            aria-label={`Dismiss suggestion — ${p.title}`}
          >
            Dismiss
          </Button>
        </div>
      </article>
    </li>
  );
}

/**
 * "Promises Scout found": suggested follow-up tasks for a contact or an inbox thread. Each one is
 * a suggestion; only Accept creates the task. Pause proposals (no longer made) are never shown.
 */
export function PromisesPanel({
  contactId,
  messageIds,
  contactLabel,
  limit,
  card = true,
  hideWhenEmpty = false,
}: {
  contactId?: string;
  /** Only proposals from these messages (an inbox thread). */
  messageIds?: string[];
  /** The contact's name, when every proposal is about the same contact. */
  contactLabel?: string;
  limit?: number;
  card?: boolean;
  hideWhenEmpty?: boolean;
}) {
  const headingId = useId();
  const singleMessage = !contactId && messageIds?.length === 1 ? messageIds[0] : undefined;
  const { data, error, loading, reload, setData } = useResource<PromiseProposalDto[]>("/promises", {
    status: "proposed",
    contactId,
    messageId: singleMessage,
  });
  const [live, setLive] = useState("");
  const msgKey = messageIds?.join(",") ?? "";
  const items = useMemo(() => {
    const ids = msgKey ? new Set(msgKey.split(",")) : null;
    const list = (data ?? []).filter(
      (p) => p.kind === "promise_task" && (!ids || (p.messageId && ids.has(p.messageId))),
    );
    return limit ? list.slice(0, limit) : list;
  }, [data, msgKey, limit]);
  const names = useContactNames(
    contactLabel ? [] : items.map((p) => p.contactId).filter((id): id is string => !!id),
  );
  const total = (data ?? []).filter((p) => p.kind === "promise_task").length;

  if (hideWhenEmpty && !loading && !error && items.length === 0 && !live) return null;

  const body = (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h2 id={headingId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Promises Scout found
        </h2>
        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
          When an email makes a promise, Scout suggests a follow-up task.{" "}
          <strong className="font-medium text-slate-800 dark:text-slate-200">
            {SCOUT_SUGGESTION_NOTE}.
          </strong>
        </p>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      {loading && !data ? (
        <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <Spinner size="sm" label="" /> Looking for promises…
        </p>
      ) : error ? (
        <div className="space-y-2">
          <Alert tone="error" title="Couldn't load Scout's suggestions">
            {errorMessage(error)}
          </Alert>
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          No open suggestions. When an email says “I&apos;ll send it Friday” or “try me in March”,
          Scout suggests a follow-up task here.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((p) => (
            <PromiseCard
              key={p.id}
              p={p}
              contactLabel={contactLabel ?? (p.contactId ? names.get(p.contactId) : undefined)}
              onDone={(done, message) => {
                setLive(message);
                setData((prev) => prev?.filter((x) => x.id !== done.id));
              }}
            />
          ))}
        </ul>
      )}
      {limit && total > items.length ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Showing {items.length} of {total}. Open a contact or reply to see the rest.
        </p>
      ) : null}
    </section>
  );

  return card ? <Card className="p-5">{body}</Card> : body;
}
