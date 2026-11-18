"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  LoadingBlock,
  Select,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  CRM_OBJECT_LABELS,
  CRM_OBJECTS,
  CRM_PROVIDER_LABELS,
  errorCodeLabel,
  relativeTime,
  RUN_KIND_LABELS,
  safeExternalUrl,
  type CrmObject,
  type CrmRunDto,
  type CrmStatusDto,
  type CrmSyncErrorDto,
} from "@/lib/crm";
import { useResource } from "@/lib/use-resource";
import { CRM_ERROR_CODES } from "@openline/shared";

const RECORD_PATHS: Record<CrmObject, string> = {
  contact: "/app/contacts",
  company: "/app/companies",
  deal: "/app/deals",
};
const SINGULAR: Record<CrmObject, string> = {
  contact: "contact",
  company: "company",
  deal: "deal",
};

const RUN_STATUS_TONES = {
  running: "accent",
  succeeded: "success",
  partial: "warning",
  failed: "danger",
} as const;
const RUN_STATUS_LABELS = {
  running: "Running",
  succeeded: "Done",
  partial: "Done with errors",
  failed: "Failed",
} as const;

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Fetches cursor pages and appends them; resets when `key` (the filters) changes. */
function usePaged<T extends { id: string }>(
  path: string | null,
  query: Record<string, string | undefined>,
) {
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(query);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<{ items: T[]; nextCursor: string | null }>(path, {
      query: JSON.parse(key) as Record<string, string>,
      signal: controller.signal,
    })
      .then((page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, key, nonce]);

  async function more() {
    if (!path || !cursor) return;
    setLoading(true);
    try {
      const page = await api<{ items: T[]; nextCursor: string | null }>(path, {
        query: { ...(JSON.parse(key) as Record<string, string>), cursor },
      });
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return {
    items,
    setItems,
    hasMore: cursor !== null,
    more,
    error,
    loading,
    reload: () => setNonce((n) => n + 1),
  };
}

function ErrorRow({
  e,
  crmName,
  canAct,
  onChanged,
}: {
  e: CrmSyncErrorDto;
  crmName: string;
  canAct: boolean;
  onChanged: (e: CrmSyncErrorDto | null, message: string) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"retry" | "dismiss" | null>(null);
  const external = safeExternalUrl(e.externalUrl);
  const recordLabel = `${SINGULAR[e.object]} ${e.localId ? "" : (e.externalId ?? "")}`.trim();

  async function act(action: "retry" | "dismiss") {
    setBusy(action);
    try {
      const updated = await api<CrmSyncErrorDto | undefined>(
        `/integrations/crm/errors/${e.id}/${action}`,
        { method: "POST" },
      );
      onChanged(
        updated && typeof updated === "object" && "id" in updated ? updated : null,
        action === "retry" ? "Retry scheduled" : "Error dismissed",
      );
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start"
      data-testid="sync-error"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={e.resolvedAt ? "neutral" : "danger"}>
            {e.resolvedAt ? "Resolved" : "Open"}
          </Badge>
          <Badge>{CRM_OBJECT_LABELS[e.object]}</Badge>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {errorCodeLabel(e.code)}
          </span>
        </div>
        <p className="text-sm break-words text-slate-700 dark:text-slate-300">{e.message}</p>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          {e.direction === "to_crm" ? `Openline → ${crmName}` : `${crmName} → Openline`} ·{" "}
          {relativeTime(e.createdAt)} · {e.attempts} attempt{e.attempts === 1 ? "" : "s"}
          {e.nextRetryAt && !e.resolvedAt ? ` · next retry ${relativeTime(e.nextRetryAt)}` : ""}
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {e.localId ? (
            <Link
              href={`${RECORD_PATHS[e.object]}/${e.localId}`}
              className="font-medium text-indigo-700 underline dark:text-indigo-300"
            >
              Open the {SINGULAR[e.object]} in Openline
            </Link>
          ) : null}
          {external ? (
            <a
              href={external}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-indigo-700 underline dark:text-indigo-300"
            >
              Open in {crmName}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : e.externalId ? (
            <span className="text-slate-600 dark:text-slate-400">
              {crmName} id <code>{e.externalId}</code>
            </span>
          ) : null}
        </p>
      </div>
      {canAct && !e.resolvedAt ? (
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "retry"}
            disabled={busy !== null}
            onClick={() => void act("retry")}
            aria-label={`Retry: ${errorCodeLabel(e.code)} on ${recordLabel}`}
          >
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "dismiss"}
            disabled={busy !== null}
            onClick={() => void act("dismiss")}
            aria-label={`Dismiss: ${errorCodeLabel(e.code)} on ${recordLabel}`}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export default function SyncLogPage() {
  const { can } = useMe();
  const canView = can("owner", "admin", "manager");
  const canAct = can("owner", "admin");
  const { toast } = useToast();
  const status = useResource<CrmStatusDto>(canView ? "/integrations/crm" : null);
  const provider = status.data?.connection?.provider;
  const crmName = provider ? CRM_PROVIDER_LABELS[provider] : "CRM";
  const [object, setObject] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const [state, setState] = useState<"open" | "all">("open");
  const [announce, setAnnounce] = useState("");
  const objectId = useId();
  const codeId = useId();
  const stateId = useId();

  const runs = usePaged<CrmRunDto>(canView ? "/integrations/crm/runs" : null, {
    limit: "10",
  });
  const errors = usePaged<CrmSyncErrorDto>(canView ? "/integrations/crm/errors" : null, {
    object: object || undefined,
    code: code || undefined,
    open: state === "open" ? "true" : "false",
    limit: "25",
  });

  useEffect(() => {
    if (errors.items && !errors.loading) {
      setAnnounce(
        `${errors.items.length} error${errors.items.length === 1 ? "" : "s"} shown${errors.hasMore ? ", more available" : ""}`,
      );
    }
  }, [errors.items, errors.loading, errors.hasMore]);

  if (!canView) {
    return (
      <>
        <PageHeader title="Sync log" />
        <Alert tone="info">
          The sync log is for managers, admins and owners. Records synced with your CRM show a badge
          on their page.
        </Alert>
      </>
    );
  }

  const forbidden =
    (errors.error instanceof ApiError && errors.error.status === 403) ||
    (runs.error instanceof ApiError && runs.error.status === 403);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link
          href="/app/settings/integrations"
          className="text-slate-600 hover:underline dark:text-slate-400"
        >
          Integrations
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-900 dark:text-slate-100">
          Sync log
        </span>
      </nav>
      <PageHeader
        title="Sync log"
        description={`Every sync run with ${crmName}, and each record that couldn't sync. Messages are written by Openline and never include record values.`}
      />
      {forbidden ? (
        <Alert tone="info">You don&apos;t have access to the sync log.</Alert>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Record errors"
              description="Errors retry automatically at 5 min, 30 min and 2 h, then wait for you."
            />
            <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-3 dark:border-slate-800">
              <div className="space-y-1">
                <label htmlFor={stateId} className="block text-sm font-medium">
                  Status
                </label>
                <Select
                  id={stateId}
                  value={state}
                  onChange={(e) => setState(e.target.value as typeof state)}
                >
                  <option value="open">Open</option>
                  <option value="all">Open and resolved</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor={objectId} className="block text-sm font-medium">
                  Record type
                </label>
                <Select id={objectId} value={object} onChange={(e) => setObject(e.target.value)}>
                  <option value="">All types</option>
                  {CRM_OBJECTS.map((o) => (
                    <option key={o} value={o}>
                      {CRM_OBJECT_LABELS[o]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor={codeId} className="block text-sm font-medium">
                  Problem
                </label>
                <Select id={codeId} value={code} onChange={(e) => setCode(e.target.value)}>
                  <option value="">All problems</option>
                  {CRM_ERROR_CODES.map((c) => (
                    <option key={c} value={c}>
                      {errorCodeLabel(c)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <p className="sr-only" aria-live="polite">
              {announce}
            </p>
            {errors.loading && !errors.items ? (
              <LoadingBlock label="Loading errors" />
            ) : errors.error ? (
              <div className="p-4">
                <Alert tone="error" title="Couldn't load errors">
                  {errorMessage(errors.error)}{" "}
                  <button type="button" className="font-medium underline" onClick={errors.reload}>
                    Try again
                  </button>
                </Alert>
              </div>
            ) : !errors.items || errors.items.length === 0 ? (
              <EmptyState
                title={state === "open" ? "No open errors" : "No errors"}
                description={
                  object || code
                    ? "Nothing matches these filters."
                    : "Every record synced. Errors appear here with a link to the record."
                }
              />
            ) : (
              <>
                <ul
                  className="divide-y divide-slate-200 dark:divide-slate-800"
                  aria-busy={errors.loading}
                >
                  {errors.items.map((e) => (
                    <ErrorRow
                      key={e.id}
                      e={e}
                      crmName={crmName}
                      canAct={canAct}
                      onChanged={(updated, message) => {
                        toast(message);
                        errors.setItems((prev) =>
                          (prev ?? []).flatMap((x) => {
                            if (x.id !== e.id) return [x];
                            // Dismissed (or resolved by a retry) leaves the "Open" view.
                            if (state === "open" && (!updated || updated.resolvedAt)) {
                              return message === "Error dismissed" || updated ? [] : [x];
                            }
                            return [updated ?? x];
                          }),
                        );
                        status.reload();
                      }}
                    />
                  ))}
                </ul>
                {errors.hasMore ? (
                  <div className="flex justify-center p-4">
                    <Button
                      variant="secondary"
                      loading={errors.loading}
                      onClick={() => void errors.more()}
                    >
                      Show more errors
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>

          <Card>
            <CardHeader title="Sync runs" />
            {runs.loading && !runs.items ? (
              <LoadingBlock label="Loading runs" />
            ) : runs.error ? (
              <div className="p-4">
                <Alert tone="error" title="Couldn't load runs">
                  {errorMessage(runs.error)}
                </Alert>
              </div>
            ) : !runs.items || runs.items.length === 0 ? (
              <EmptyState title="No runs yet" description="Runs appear after the first preview." />
            ) : (
              <>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {runs.items.map((r) => (
                    <li key={r.id} className="space-y-1 px-5 py-3 text-sm" data-testid="sync-run">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {RUN_KIND_LABELS[r.kind] ?? r.kind}
                        </span>
                        <Badge tone={RUN_STATUS_TONES[r.status] ?? "neutral"}>
                          {RUN_STATUS_LABELS[r.status] ?? r.status}
                        </Badge>
                        <span className="text-slate-600 dark:text-slate-400">
                          {relativeTime(r.startedAt)} · {duration(r.durationMs)}
                        </span>
                      </div>
                      <p className="text-xs break-words text-slate-600 dark:text-slate-400">
                        {CRM_OBJECTS.filter((o) => r.counts[o])
                          .map(
                            (o) =>
                              `${CRM_OBJECT_LABELS[o]}: ${
                                Object.entries(r.counts[o] ?? {})
                                  .filter(([, n]) => n > 0)
                                  .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
                                  .join(", ") || "no changes"
                              }`,
                          )
                          .join(" · ") || "No changes"}
                        {` · ${r.apiCalls} API calls`}
                        {r.tokens ? ` · ${r.tokens} tokens` : ""}
                        {r.conflicts ? ` · ${r.conflicts} conflicts decided` : ""}
                        {r.errorCode ? ` · ${errorCodeLabel(r.errorCode)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
                {runs.hasMore ? (
                  <div className="flex justify-center p-4">
                    <Button
                      variant="secondary"
                      loading={runs.loading}
                      onClick={() => void runs.more()}
                    >
                      Show more runs
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
