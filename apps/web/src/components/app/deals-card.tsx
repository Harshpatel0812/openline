"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { DealAttentionDto, DealDto } from "@openline/shared";
import { Alert, Button, Card, CardHeader, LoadingBlock, Spinner, useToast } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { DEALS_CHANGED_EVENT, formatCalendarDate, relativeDays } from "@/lib/deals";
import { useResource } from "@/lib/use-resource";
import { DealDialog, type DealPrefill } from "./deal-dialog";
import { DealBadges, DealRows } from "./deal-parts";

/** A contact's or company's deals, with "Create deal". */
export function DealsCard({
  path,
  label,
  prefill,
}: {
  /** `/contacts/:id/deals` or `/companies/:id/deals`. */
  path: string;
  /** "Ada Lovelace" — used in headings and the empty state. */
  label: string;
  prefill: DealPrefill;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { data, error, loading, reload } = useResource<DealDto[]>(path);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    window.addEventListener(DEALS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DEALS_CHANGED_EVENT, reload);
  }, [reload]);
  const open = (data ?? []).filter((d) => d.stage.kind === "open").length;

  return (
    <Card>
      <CardHeader
        title="Deals"
        description={
          data && data.length ? `${open} open of ${data.length}.` : `Deals with ${label}.`
        }
        actions={
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            Create deal
          </Button>
        }
      />
      {loading && !data ? (
        <LoadingBlock label="Loading deals" />
      ) : error ? (
        <div className="space-y-2 p-5">
          <Alert tone="error">{errorMessage(error)}</Alert>
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : !data || data.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-600 dark:text-slate-400">No deals yet.</p>
      ) : (
        <DealRows deals={data} label={`Deals with ${label}`} />
      )}
      <DealDialog
        open={creating}
        onClose={() => setCreating(false)}
        prefill={prefill}
        onCreated={(deal) => {
          toast(`Deal “${deal.name}” created`);
          router.push(`/app/deals/${deal.id}`);
        }}
      />
    </Card>
  );
}

/** Today: my open deals that are stale or past their next-step date. */
export function DealsAttentionCard() {
  const { data, error, loading, reload } = useResource<DealAttentionDto>("/deals/attention", {
    mine: 1,
    limit: 5,
  });
  useEffect(() => {
    window.addEventListener(DEALS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DEALS_CHANGED_EVENT, reload);
  }, [reload]);
  const items = data?.items ?? [];
  return (
    <Card role="region" aria-labelledby="today-deals">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <h2 id="today-deals" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Deals needing attention
        </h2>
        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
          Your deals that went quiet or missed their next step.
        </p>
      </div>
      <div className="px-5 py-4">
        {loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <Spinner size="sm" label="" /> Loading…
          </p>
        ) : error ? (
          <div className="space-y-2">
            <Alert tone="error">{errorMessage(error)}</Alert>
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            All your deals are moving. Nothing stale.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((d) => (
              <li key={d.id} className="text-sm">
                <Link
                  href={`/app/deals/${d.id}`}
                  className="font-medium break-words text-slate-900 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-slate-100"
                >
                  {d.name}
                </Link>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {d.stage.name} · last activity {relativeDays(d.lastActivityAt)}
                  {d.nextStepDate ? ` · next step ${formatCalendarDate(d.nextStepDate)}` : ""}
                </p>
                <div className="mt-1">
                  <DealBadges deal={d} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <Link
          href="/app/deals?owner=me"
          className="mt-3 inline-block rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-400"
        >
          Open your pipeline<span aria-hidden="true"> →</span>
        </Link>
      </div>
    </Card>
  );
}
