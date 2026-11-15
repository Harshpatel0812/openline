"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type {
  ComplianceCheckDto,
  ComplianceCheckOutcome,
  ComplianceDecision,
  ComplianceRecordDto,
  ContactComplianceDto,
  SequenceDto,
} from "@openline/shared";
import { Alert, Button, Card, cx, Select, Spinner, useToast } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  DECISION_LABELS,
  JURISDICTION_LABELS,
  NOT_LEGAL_ADVICE,
  OUTCOME_LABELS,
  readableDetail,
  RULE_LABELS,
} from "@/lib/compliance";
import { formatInZone, viewerTimeZone } from "@/lib/tasks";
import { useResource } from "@/lib/use-resource";
import { useMe } from "./me-context";

// ------------------------------------------------------------------ icons

const decisionStyles: Record<ComplianceDecision, string> = {
  allowed:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  not_now:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
  blocked:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
};

/** Check mark, clock or no-entry sign: the decision never relies on colour alone. */
export function DecisionIcon({
  decision,
  className = "h-5 w-5",
}: {
  decision: ComplianceDecision;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="currentColor" aria-hidden="true">
      {decision === "allowed" ? (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.7-9.3a1 1 0 00-1.4-1.4L9 10.58 7.7 9.3a1 1 0 00-1.4 1.4l2 2a1 1 0 001.4 0l4-4z"
          clipRule="evenodd"
        />
      ) : decision === "not_now" ? (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4c0 .27.1.52.3.7l2.5 2.5a1 1 0 001.4-1.4L11 9.58V6z"
          clipRule="evenodd"
        />
      ) : (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM6 9a1 1 0 000 2h8a1 1 0 100-2H6z"
          clipRule="evenodd"
        />
      )}
    </svg>
  );
}

const outcomeStyles: Record<ComplianceCheckOutcome, string> = {
  pass: "text-emerald-700 dark:text-emerald-400",
  fail: "text-red-700 dark:text-red-400",
  wait: "text-amber-800 dark:text-amber-300",
  not_applicable: "text-slate-500 dark:text-slate-400",
};

function OutcomeIcon({ outcome, warning }: { outcome: ComplianceCheckOutcome; warning?: boolean }) {
  const d: ComplianceDecision | null =
    outcome === "pass"
      ? "allowed"
      : outcome === "fail"
        ? "blocked"
        : outcome === "wait"
          ? "not_now"
          : null;
  return (
    <span className={cx("mt-0.5 shrink-0", warning ? outcomeStyles.wait : outcomeStyles[outcome])}>
      {d ? (
        <DecisionIcon decision={warning ? "not_now" : d} className="h-4 w-4" />
      ) : (
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
          <circle cx="10" cy="10" r="3" />
        </svg>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ check list

export function ComplianceCheckList({
  checks,
  timeZone,
}: {
  checks: ComplianceCheckDto[];
  timeZone?: string;
}) {
  return (
    <ul className="divide-y divide-slate-200 dark:divide-slate-800">
      {checks.map((c) => (
        <li key={c.rule} className="flex gap-3 py-3">
          <OutcomeIcon outcome={c.outcome} warning={c.warning} />
          <div className="min-w-0 flex-1 text-sm">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {RULE_LABELS[c.rule] ?? c.rule}
              </span>
              <span className={cx("text-xs font-semibold", outcomeStyles[c.outcome])}>
                {c.warning ? "Passed — needs attention soon" : OUTCOME_LABELS[c.outcome]}
              </span>
            </p>
            <p className="mt-0.5 text-slate-700 dark:text-slate-300">
              {readableDetail(c.detail, timeZone)}
            </p>
            <details className="mt-1 group">
              <summary className="cursor-pointer rounded text-xs font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300">
                Where this rule comes from
              </summary>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{c.citation}</p>
            </details>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ contact page panel

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** "Can I email them?" on the contact page: the evaluation now, with every check and citation. */
export function CompliancePanel({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const { can } = useMe();
  const { toast } = useToast();
  const [sequenceId, setSequenceId] = useState("");
  const sequences = useResource<SequenceDto[]>("/sequences");
  const { data, error, loading, reload } = useResource<ContactComplianceDto>(
    `/contacts/${contactId}/compliance`,
    { channel: "email", sequenceId: sequenceId || undefined },
  );
  const [downloading, setDownloading] = useState(false);
  const [live, setLive] = useState("");
  const selectId = useId();
  const headingId = useId();
  const myZone = viewerTimeZone();

  useEffect(() => {
    if (data) setLive(`Can I email ${contactName}? ${DECISION_LABELS[data.decision]}.`);
  }, [data, contactName]);

  async function download() {
    setDownloading(true);
    try {
      const record = await api<ComplianceRecordDto>(`/contacts/${contactId}/compliance/record`);
      downloadJson(`openline-compliance-record-${contactId}.json`, record);
      toast("Compliance record downloaded");
    } catch (err) {
      toast(
        err instanceof ApiError && err.status === 403
          ? "Only owners, admins and managers can download compliance records."
          : errorMessage(err),
        "error",
      );
    } finally {
      setDownloading(false);
    }
  }

  const failing = data?.checks.filter((c) => c.outcome === "fail") ?? [];
  const waiting = data?.checks.filter((c) => c.outcome === "wait") ?? [];
  const warnings = data?.checks.filter((c) => c.warning) ?? [];
  const usableSequences = (sequences.data ?? []).filter((s) => s.status !== "archived");

  return (
    <Card>
      <section aria-labelledby={headingId}>
        <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <h2 id={headingId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Can I email them?
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Openline checks these rules before every email and keeps a record of every check.
          </p>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {live}
        </p>
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <label
              htmlFor={selectId}
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Business hours to check against
            </label>
            <Select
              id={selectId}
              value={sequenceId}
              onChange={(e) => setSequenceId(e.target.value)}
              className="h-9"
            >
              <option value="">Default (Mon–Fri, 9 a.m.–6 p.m. their time)</option>
              {usableSequences.map((s) => (
                <option key={s.id} value={s.id}>
                  Sequence: {s.name}
                </option>
              ))}
            </Select>
          </div>

          {loading && !data ? (
            <div className="flex items-center gap-2 py-4 text-sm text-slate-600 dark:text-slate-400">
              <Spinner size="sm" label="" /> Checking the rules…
            </div>
          ) : error ? (
            <div className="space-y-2">
              <Alert tone="error" title="Couldn't check this contact">
                {errorMessage(error)}
              </Alert>
              <Button size="sm" variant="secondary" onClick={reload}>
                Try again
              </Button>
            </div>
          ) : data ? (
            <div className={cx("space-y-4", loading && "opacity-60")} aria-busy={loading}>
              <div
                className={cx(
                  "flex items-start gap-3 rounded-lg border px-4 py-3",
                  decisionStyles[data.decision],
                )}
                data-testid="compliance-decision"
              >
                <DecisionIcon decision={data.decision} className="mt-0.5 h-7 w-7 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xl font-semibold">{DECISION_LABELS[data.decision]}</p>
                  <p className="mt-0.5 text-sm">
                    {data.decision === "allowed"
                      ? "Every rule passed for an email right now."
                      : data.decision === "blocked"
                        ? `${failing.length === 1 ? "One rule blocks" : `${failing.length} rules block`} email to this contact: ${failing.map((c) => RULE_LABELS[c.rule]).join(", ")}.`
                        : `Nothing blocks this contact, but wait for: ${waiting.map((c) => RULE_LABELS[c.rule]).join(", ")}. Sequences hold their emails until then.`}
                  </p>
                </div>
              </div>

              {data.nextAllowedAt ? (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">
                      Next allowed — their time ({data.settings.timeZone}
                      {data.settings.timeZoneSource === "workspace" ? ", workspace default" : ""})
                    </dt>
                    <dd className="font-medium text-slate-900 dark:text-slate-100">
                      {formatInZone(data.nextAllowedAt, data.settings.timeZone)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">
                      Next allowed — your time ({myZone})
                    </dt>
                    <dd className="font-medium text-slate-900 dark:text-slate-100">
                      {formatInZone(data.nextAllowedAt, myZone)}
                    </dd>
                  </div>
                </dl>
              ) : null}

              {warnings.length > 0 ? (
                <Alert tone="warning" title="Needs attention soon">
                  {warnings.map((c) => readableDetail(c.detail, data.settings.timeZone)).join(" ")}
                </Alert>
              ) : null}

              {!data.settings.mailingAddressOnFile ? (
                <p className="text-sm text-slate-700 dark:text-slate-300">
                  Add your postal address in{" "}
                  <Link
                    href="/app/settings/workspace"
                    className="font-medium text-indigo-700 underline dark:text-indigo-300"
                  >
                    Settings → Workspace
                  </Link>
                  .
                </p>
              ) : null}

              <div>
                <h3 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
                  Checks
                </h3>
                <ComplianceCheckList checks={data.checks} timeZone={data.settings.timeZone} />
              </div>

              <div className="space-y-1 border-t border-slate-200 pt-3 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
                <p>
                  Rules for {JURISDICTION_LABELS[data.jurisdiction] ?? data.jurisdiction} · ruleset{" "}
                  {data.rulesetVersion} · checked {formatInZone(data.evaluatedAt, myZone)}
                </p>
                <p className="font-medium text-slate-700 dark:text-slate-300">{NOT_LEGAL_ADVICE}</p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={reload} loading={loading}>
                  Check again
                </Button>
                {can("owner", "admin", "manager") ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={downloading}
                    onClick={() => void download()}
                  >
                    Download compliance record
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </Card>
  );
}

// ------------------------------------------------------------------ compact badge

/**
 * Compact "can I email them?" for the inbox reply composer. Asks the API in reply mode
 * (`purpose=reply`), which evaluates exactly what sending an inbox reply enforces: no send
 * window, and an archived contact who wrote to you may be answered.
 */
export function ComplianceBadge({ contactId, name }: { contactId: string; name: string }) {
  const { data, error, loading } = useResource<ContactComplianceDto>(
    `/contacts/${contactId}/compliance`,
    { channel: "email", purpose: "reply" },
  );
  if (loading && !data) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
        <Spinner size="sm" label="" /> Checking whether you can email {name}…
      </p>
    );
  }
  if (error || !data) {
    return (
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Couldn&apos;t check the rules for {name} just now. Openline still checks them when you send.
      </p>
    );
  }
  const failing = data.checks.filter((c) => c.outcome === "fail");
  const decision: ComplianceDecision = data.decision === "blocked" ? "blocked" : "allowed";
  return (
    <div
      role="status"
      className={cx(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        decisionStyles[decision],
      )}
    >
      <DecisionIcon decision={decision} className="mt-px h-4 w-4 shrink-0" />
      <p>
        <span className="font-semibold">
          {decision === "allowed" ? "Allowed to reply" : "Blocked"}
        </span>
        {" — "}
        {decision === "allowed"
          ? `Openline checked the rules for ${name}.`
          : failing
              .map((c) => `${RULE_LABELS[c.rule]}: ${readableDetail(c.detail)}`)
              .join(" ")}{" "}
        <Link
          href={`/app/contacts/${contactId}`}
          className="font-medium underline underline-offset-2"
        >
          See every check
        </Link>
      </p>
    </div>
  );
}
