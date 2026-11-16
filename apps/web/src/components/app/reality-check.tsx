"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  REALITY_EVIDENCE_LABELS,
  REALITY_EVIDENCE_TYPES,
  REALITY_LIMITS,
  RealityFlagDismissInputSchema,
  type DealDetailDto,
  type PipelineStageDto,
  type RealityCheckDto,
  type RealityCheckResponseDto,
  type RealityEvidenceItemDto,
  type RealityFlagDto,
  type RealityFlagSeverity,
  type RealityPresence,
} from "@openline/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  Field,
  LoadingBlock,
  Textarea,
  useToast,
  type BadgeTone,
} from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { notifyDealsChanged } from "@/lib/deals";
import { fullDateTime, relativeTime } from "@/lib/inbox";
import { useResource } from "@/lib/use-resource";
import { FlagIcon } from "./deal-parts";

const PRESENCE: Record<RealityPresence, { label: string; tone: BadgeTone }> = {
  yes: { label: "Yes", tone: "success" },
  no: { label: "No", tone: "danger" },
  unclear: { label: "Unclear", tone: "neutral" },
};

const SEVERITY: Record<
  RealityFlagSeverity,
  { label: string; box: string; icon: string; tone: BadgeTone }
> = {
  high: {
    label: "High",
    tone: "danger",
    box: "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950",
    icon: "text-red-700 dark:text-red-300",
  },
  medium: {
    label: "Medium",
    tone: "warning",
    box: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950",
    icon: "text-amber-700 dark:text-amber-300",
  },
  low: {
    label: "Low",
    tone: "info",
    box: "border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950",
    icon: "text-sky-700 dark:text-sky-300",
  },
};

const DETERMINISTIC_NOTES: Record<NonNullable<RealityCheckDto["deterministicReason"]>, string> = {
  scout_off:
    "Scout is off for this workspace, so only the date checks ran (next step, close date, stale). Turn Scout on in Settings → Workspace to check the emails too.",
  no_provider:
    "Scout isn't available right now, so only the date checks ran (next step, close date, stale).",
  budget:
    "Scout's monthly budget for Reality Check is used up, so only the date checks ran (next step, close date, stale).",
  no_emails:
    "There are no emails with this deal's contacts in the last 90 days, so only the date checks ran.",
  model_error:
    "Scout couldn't read the emails this time, so only the date checks ran. Try “Check now” again later.",
};

/** Where a quote's email is: the timeline entry on this page. */
function EmailLink({ messageId, children }: { messageId: string; children: ReactNode }) {
  return (
    <a
      href={`#timeline-msg-${messageId}`}
      className="rounded text-xs font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
    >
      {children}
    </a>
  );
}

function Quote({
  item,
}: {
  item: Pick<RealityEvidenceItemDto, "quote" | "messageId" | "quoteHidden">;
}) {
  if (item.quoteHidden) {
    return (
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
        Quote hidden — it&apos;s from a teammate&apos;s mailbox you can&apos;t read.
      </p>
    );
  }
  if (!item.quote) return null;
  return (
    <figure className="mt-1.5">
      {/* Verbatim words from an email: untrusted text, rendered as plain text. */}
      <blockquote className="border-l-2 border-slate-300 pl-3 text-sm break-words whitespace-pre-wrap text-slate-800 italic dark:border-slate-600 dark:text-slate-200">
        “{item.quote}”
      </blockquote>
      {item.messageId ? (
        <figcaption className="mt-0.5 pl-3">
          <EmailLink messageId={item.messageId}>View the email</EmailLink>
        </figcaption>
      ) : null}
    </figure>
  );
}

function DismissFlagDialog({
  flag,
  dealId,
  onClose,
  onDone,
}: {
  flag: RealityFlagDto | null;
  dealId: string;
  onClose: () => void;
  onDone: (c: RealityCheckDto) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  useEffect(() => {
    if (flag) {
      setReason("");
      setError(undefined);
      setFormError(null);
    }
  }, [flag]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!flag) return;
    const parsed = RealityFlagDismissInputSchema.safeParse({ reason });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Say why");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const check = await api<RealityCheckDto>(
        `/deals/${dealId}/reality-check/flags/${flag.id}/dismiss`,
        { method: "POST", body: parsed.data },
      );
      onDone(check);
      onClose();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={flag !== null}
      onClose={onClose}
      size="sm"
      title="Not right?"
      description="Tell Scout why. The flag stays hidden until new activity on the deal, and your answer helps improve the check."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Hide this flag
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-3">
        {flag ? <p className="text-sm text-slate-800 dark:text-slate-200">{flag.message}</p> : null}
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Why isn't it right?" required error={error}>
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={reason}
              maxLength={REALITY_LIMITS.dismissReason}
              disabled={saving}
              autoFocus
              placeholder="We discussed this on a call."
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function FlagItem({
  flag,
  canAct,
  onDismiss,
}: {
  flag: RealityFlagDto;
  canAct: boolean;
  onDismiss: (f: RealityFlagDto) => void;
}) {
  const sev = SEVERITY[flag.severity];
  if (flag.dismissed) {
    return (
      <li className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
        <p className="text-slate-600 line-through decoration-slate-400 dark:text-slate-400">
          {flag.message}
        </p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          Marked not right by {flag.dismissed.by.name}{" "}
          <time dateTime={flag.dismissed.at} title={fullDateTime(flag.dismissed.at)}>
            {relativeTime(flag.dismissed.at)}
          </time>
          : “{flag.dismissed.reason}”
        </p>
      </li>
    );
  }
  return (
    <li className={cx("rounded-lg border p-3 text-sm", sev.box)}>
      <div className="flex items-start gap-2">
        <FlagIcon className={cx("mt-0.5 h-4 w-4 shrink-0", sev.icon)} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={sev.tone}>{sev.label} severity</Badge>
            <span className="font-medium text-slate-900 dark:text-slate-100">{flag.message}</span>
          </p>
          {flag.criterion ? (
            <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">
              {flag.criterion.stageName} needs: {flag.criterion.label}
            </p>
          ) : null}
          <Quote item={flag} />
        </div>
        {canAct ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDismiss(flag)}
            aria-label={`Not right: ${flag.message}`}
          >
            Not right
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function RealityCheckPanel({
  deal,
  stages,
  onDealChanged,
  version,
}: {
  deal: DealDetailDto;
  stages: PipelineStageDto[];
  onDealChanged: (d: DealDetailDto) => void;
  /** Changes when the deal changes, so the latest check is read again. */
  version: string;
}) {
  const { toast } = useToast();
  const { data, error, loading, reload, setData } = useResource<RealityCheckResponseDto>(
    `/deals/${deal.id}/reality-check`,
  );
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<RealityFlagDto | null>(null);
  const [acting, setActing] = useState<"accept" | "dismiss" | null>(null);
  const [live, setLive] = useState("");
  const headingId = useId();
  const canAct = deal.canEdit;

  const firstVersion = useRef(version);
  useEffect(() => {
    if (version !== firstVersion.current) reload();
  }, [version, reload]);

  const check = data?.check ?? null;
  const setCheck = (c: RealityCheckDto) => setData(() => ({ check: c }));

  async function runNow() {
    setRunning(true);
    setRunError(null);
    setLive("Checking the deal…");
    try {
      const c = await api<RealityCheckDto>(`/deals/${deal.id}/reality-check`, { method: "POST" });
      setCheck(c);
      const open = c.flags.filter((f) => !f.dismissed).length;
      setLive(`Reality Check done: ${open} flag${open === 1 ? "" : "s"}.`);
    } catch (err) {
      // 429: today's checks for this deal, or this person's hourly allowance (server says which).
      const msg =
        err instanceof ApiError && err.status === 429
          ? err.message ||
            `You've used today's ${REALITY_LIMITS.runsPerDealPerDay} checks for this deal. Try again tomorrow.`
          : errorMessage(err);
      setRunError(msg);
      setLive(msg);
    } finally {
      setRunning(false);
    }
  }

  async function suggestion(kind: "accept" | "dismiss") {
    setActing(kind);
    try {
      if (kind === "accept") {
        const res = await api<{ deal: DealDetailDto; check: RealityCheckDto }>(
          `/deals/${deal.id}/reality-check/suggestion/accept`,
          { method: "POST" },
        );
        setCheck(res.check);
        onDealChanged(res.deal);
        notifyDealsChanged();
        toast(`Moved to ${res.deal.stage.name}`);
        setLive(`Moved ${res.deal.name} to ${res.deal.stage.name}.`);
      } else {
        const c = await api<RealityCheckDto>(`/deals/${deal.id}/reality-check/suggestion/dismiss`, {
          method: "POST",
          body: {},
        });
        setCheck(c);
        toast("Suggestion dismissed. The deal stays where it is.", "info");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The deal moved since the check: the server closed the suggestion; show the panel as it
        // is now (no stale "Move to" button left behind).
        reload();
        toast(err.message || "The deal has moved since this check. Run it again.", "info");
      } else {
        toast(errorMessage(err), "error");
      }
    } finally {
      setActing(null);
    }
  }

  const notReady = error instanceof ApiError && (error.status === 404 || error.status === 501);
  const evidenceStage = check?.evidenceStageId
    ? stages.find((s) => s.id === check.evidenceStageId)
    : undefined;
  const openFlags = check?.flags.filter((f) => !f.dismissed) ?? [];
  const dismissedFlags = check?.flags.filter((f) => f.dismissed) ?? [];
  const sugg = check?.suggestion?.status === "proposed" ? check.suggestion : undefined;

  return (
    <Card role="region" aria-labelledby={headingId}>
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
        <div>
          <h2 id={headingId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Reality Check
          </h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            {check ? (
              <>
                Last checked{" "}
                <time dateTime={check.ranAt} title={fullDateTime(check.ranAt)}>
                  {relativeTime(check.ranAt)}
                </time>
                {canAct ? ` · ${check.runsLeftToday} checks left today` : ""}
              </>
            ) : (
              "Does the evidence in your emails back up this deal's stage?"
            )}
          </p>
        </div>
        {canAct && !notReady ? (
          <Button
            size="sm"
            variant="secondary"
            loading={running}
            disabled={check?.runsLeftToday === 0}
            onClick={() => void runNow()}
          >
            Check now
          </Button>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      <div className="space-y-5 px-5 py-4">
        {runError ? <Alert tone="error">{runError}</Alert> : null}
        {loading && !data ? (
          <LoadingBlock label="Loading Reality Check" />
        ) : notReady ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Reality Check isn&apos;t available for this deal yet.
          </p>
        ) : error ? (
          <div className="space-y-2">
            <Alert tone="error">{errorMessage(error)}</Alert>
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : !check ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Not checked yet.{" "}
            {canAct
              ? "Press “Check now”, or wait for the daily check after new activity."
              : "It runs daily after new activity."}
          </p>
        ) : (
          <>
            {sugg ? (
              <div className="rounded-lg border border-indigo-300 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
                <p className="text-xs font-medium text-indigo-800 dark:text-indigo-200">
                  Suggested by Scout — nothing moves until you accept
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                  Move to {sugg.toStageName}?
                </p>
                <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">{sugg.reason}</p>
                {canAct ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      loading={acting === "accept"}
                      disabled={acting !== null}
                      onClick={() => void suggestion("accept")}
                    >
                      Accept — move to {sugg.toStageName}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={acting === "dismiss"}
                      disabled={acting !== null}
                      onClick={() => void suggestion("dismiss")}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                    The deal&apos;s owner or a manager can accept it.
                  </p>
                )}
              </div>
            ) : null}

            {check.deterministicOnly ? (
              <Alert tone="info" title="Only the date checks ran">
                {DETERMINISTIC_NOTES[check.deterministicReason ?? "scout_off"]}
              </Alert>
            ) : null}

            <section aria-labelledby={`${headingId}-flags`}>
              <h3
                id={`${headingId}-flags`}
                className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400"
              >
                Flags ({openFlags.length})
              </h3>
              {openFlags.length === 0 ? (
                <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
                  No flags. The evidence backs up {deal.stage.name}.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {openFlags.map((f) => (
                    <FlagItem key={f.id} flag={f} canAct={canAct} onDismiss={setDismissing} />
                  ))}
                </ul>
              )}
              {dismissedFlags.length ? (
                <details className="mt-3">
                  <summary className="cursor-pointer rounded text-sm font-medium text-slate-700 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-slate-300">
                    Marked not right ({dismissedFlags.length})
                  </summary>
                  <ul className="mt-2 space-y-2">
                    {dismissedFlags.map((f) => (
                      <FlagItem key={f.id} flag={f} canAct={false} onDismiss={setDismissing} />
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>

            {!check.deterministicOnly ? (
              <section aria-labelledby={`${headingId}-evidence`}>
                <h3
                  id={`${headingId}-evidence`}
                  className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400"
                >
                  Evidence from your emails
                </h3>
                {evidenceStage ? (
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                    The evidence supports <strong>{evidenceStage.name}</strong>.
                  </p>
                ) : null}
                <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
                  {REALITY_EVIDENCE_TYPES.map((type) => {
                    const item = check.evidence[type];
                    if (!item) return null;
                    const p = PRESENCE[item.present];
                    return (
                      <li key={type} className="py-2.5">
                        <p className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {REALITY_EVIDENCE_LABELS[type]}
                          </span>
                          <Badge tone={p.tone}>{p.label}</Badge>
                        </p>
                        <Quote item={item} />
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                  Scout only counts evidence it can quote word for word from a real email. Scout
                  suggests; you decide.
                </p>
              </section>
            ) : null}
          </>
        )}
      </div>
      <DismissFlagDialog
        flag={dismissing}
        dealId={deal.id}
        onClose={() => setDismissing(null)}
        onDone={(c) => {
          setCheck(c);
          toast("Flag hidden. Thanks — this helps Scout get better.", "info");
        }}
      />
    </Card>
  );
}
