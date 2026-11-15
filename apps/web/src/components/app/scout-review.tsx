"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { AiActionDto, ScoutSourceDto } from "@openline/shared";
import { Alert, Badge, Button, Field, Input, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { safeHttpUrl } from "@/lib/inbox";
import { scoutErrorMessage, type ScoutProblem } from "@/lib/scout";

/** A Scout error as an alert, with a settings link where the fix lives. */
export function ScoutProblemAlert({ problem }: { problem: ScoutProblem }) {
  return (
    <Alert tone="error" title={problem.title}>
      <p>{problem.body}</p>
      {problem.settingsLink ? (
        <Link
          href="/app/settings/workspace#scout"
          className="mt-1 inline-block font-medium underline"
        >
          Open Scout settings
        </Link>
      ) : null}
    </Alert>
  );
}

const RESEARCH_TEXT: Record<AiActionDto["research"], string | null> = {
  fetched: "Scout read the company's website for this draft.",
  cached: "Scout used the company's website (read in the last 7 days).",
  failed: "Scout couldn't read the company's website, so it used only the contact's details.",
  off: "Website research is off — Scout used only the contact's details.",
  none: null,
};

function SourceRef({ sourceId, sources }: { sourceId: string; sources: ScoutSourceDto[] }) {
  const source = sources.find((s) => s.id === sourceId);
  const label = source?.label || sourceId;
  const url = source?.kind === "web_page" ? safeHttpUrl(source.id) : null;
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="break-all font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200"
      >
        {label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  const kind =
    source?.kind === "message"
      ? "Their email"
      : source?.kind === "contact_field"
        ? "Contact field"
        : "Source";
  return (
    <span className="text-slate-800 dark:text-slate-200">
      <span className="text-slate-600 dark:text-slate-400">{kind}: </span>
      {label}
    </span>
  );
}

export interface ApprovedDraft {
  subject?: string;
  body: string;
  action: AiActionDto;
}

/**
 * Review panel for a Scout proposal: the draft (editable), each claim with its source, Approve and
 * Reject. Approving only hands the text back to the caller — nothing is sent or saved by Scout.
 */
export function ScoutReview({
  action,
  approveLabel,
  applyHint,
  onApproved,
  onRejected,
  onDiscard,
}: {
  action: AiActionDto;
  /** e.g. "Use in step 1", "Put in reply box". */
  approveLabel: string;
  /** What approving does, shown under the buttons. */
  applyHint: string;
  onApproved: (draft: ApprovedDraft) => void;
  onRejected: (action: AiActionDto) => void;
  /** Leave the proposal undecided (e.g. "Back"). */
  onDiscard?: () => void;
}) {
  const hasSubject = action.kind === "draft_email";
  const [subject, setSubject] = useState(action.proposal.subject ?? "");
  const [body, setBody] = useState(action.proposal.body);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<ScoutProblem | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const citations = action.proposal.citations;

  useEffect(() => {
    // Move focus to the result so keyboard and screen reader users land on it.
    headingRef.current?.focus();
  }, [action.id]);

  const edited =
    body.trim() !== action.proposal.body.trim() ||
    (hasSubject && subject.trim() !== (action.proposal.subject ?? "").trim());

  async function approve() {
    if (!body.trim()) {
      setFieldError("The draft can't be empty");
      return;
    }
    if (hasSubject && (!subject.trim() || /[\r\n]/.test(subject))) {
      setFieldError("Add a one-line subject");
      return;
    }
    setFieldError(null);
    setBusy("approve");
    setProblem(null);
    try {
      const finalText = body.trim() !== action.proposal.body.trim() ? body.trim() : undefined;
      const finalSubject =
        hasSubject && subject.trim() !== (action.proposal.subject ?? "").trim()
          ? subject.trim()
          : undefined;
      const approved = await api<AiActionDto>(`/scout/actions/${action.id}/approve`, {
        method: "POST",
        body: { finalText, finalSubject },
      });
      onApproved({
        action: approved,
        body: approved.finalText ?? finalText ?? action.proposal.body,
        subject: hasSubject
          ? (approved.finalSubject ?? finalSubject ?? action.proposal.subject)
          : undefined,
      });
    } catch (err) {
      setProblem(scoutErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setProblem(null);
    try {
      const rejected = await api<AiActionDto>(`/scout/actions/${action.id}/reject`, {
        method: "POST",
        body: { reason: reason.trim() || undefined },
      });
      onRejected(rejected);
    } catch (err) {
      setProblem(scoutErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const researchNote = RESEARCH_TEXT[action.research];

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-800 dark:bg-indigo-950/30"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">Scout</Badge>
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-semibold text-slate-900 focus:outline-none dark:text-white"
        >
          Drafted by Scout — review before using
        </h3>
      </div>
      <p className="text-xs text-slate-700 dark:text-slate-300">
        Scout can be wrong. Check every claim against its source, edit freely, then approve.
        {researchNote ? ` ${researchNote}` : ""}
      </p>

      {problem ? <ScoutProblemAlert problem={problem} /> : null}

      {hasSubject ? (
        <Field label="Subject" error={fieldError && !subject.trim() ? fieldError : undefined}>
          {(p) => (
            <Input
              {...p}
              value={subject}
              maxLength={200}
              disabled={busy !== null}
              onChange={(e) => setSubject(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Field
        label={hasSubject ? "Email body" : "Reply"}
        hint={edited ? "Edited — your version is what gets used." : undefined}
        error={fieldError && !body.trim() ? fieldError : undefined}
      >
        {(p) => (
          <Textarea
            {...p}
            rows={hasSubject ? 9 : 7}
            value={body}
            maxLength={10_000}
            disabled={busy !== null}
            onChange={(e) => setBody(e.target.value)}
            className="font-mono leading-relaxed"
          />
        )}
      </Field>

      <div>
        <h4 className="text-xs font-semibold tracking-wide text-slate-700 uppercase dark:text-slate-300">
          Sources for the claims in this draft
        </h4>
        {citations.length === 0 ? (
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            This draft makes no specific claims about the prospect.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {citations.map((c, i) => (
              <li
                key={`${c.source}-${i}`}
                className="rounded-md border border-slate-200 bg-white p-2.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <p className="text-slate-900 dark:text-slate-100">“{c.claim}”</p>
                <p className="mt-1 text-xs">
                  <SourceRef sourceId={c.source} sources={action.sources} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rejecting ? (
        <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <Field label="Why are you rejecting it? (optional)" hint="Helps us make Scout better.">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                maxLength={500}
                value={reason}
                disabled={busy !== null}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
              />
            )}
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => setRejecting(false)}
            >
              Keep reviewing
            </Button>
            <Button variant="danger" loading={busy === "reject"} onClick={() => void reject()}>
              Reject draft
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {onDiscard ? (
              <Button variant="ghost" disabled={busy !== null} onClick={onDiscard}>
                Back
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy !== null} onClick={() => setRejecting(true)}>
              Reject
            </Button>
            <Button loading={busy === "approve"} onClick={() => void approve()}>
              {edited ? `Approve edits · ${approveLabel}` : `Approve · ${approveLabel}`}
            </Button>
          </div>
          <p className="text-right text-xs text-slate-600 dark:text-slate-400">{applyHint}</p>
        </div>
      )}
    </section>
  );
}
