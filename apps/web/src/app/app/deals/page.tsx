"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import type {
  DealDto,
  DealPageDto,
  DealSummaryDto,
  MemberDto,
  PipelineStageDto,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { DealBoard, DealTable, ForecastStrip } from "@/components/app/deal-board";
import { DealDialog } from "@/components/app/deal-dialog";
import { LostReasonDialog, moveDeal, moveErrorMessage } from "@/components/app/deal-parts";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  cx,
  Input,
  Label,
  LoadingBlock,
  Select,
  useToast,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { DEALS_CHANGED_EVENT, stageOrder, type Totals } from "@/lib/deals";
import { useResource } from "@/lib/use-resource";

const OPEN_LIMIT = 500;
const CLOSED_LIMIT = 100;
const isDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

function useFilters() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const owner = params.get("owner") ?? "all";
  const filters = {
    owner,
    from: isDate(params.get("from")),
    to: isDate(params.get("to")),
    stale: params.get("stale") === "1",
    flagged: params.get("flagged") === "1",
    view: params.get("view") === "list" ? ("list" as const) : ("board" as const),
  };
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return { filters, set };
}

type Filters = ReturnType<typeof useFilters>["filters"];

function ownerQuery(owner: string): string | undefined {
  return owner === "all" ? undefined : owner;
}

function summaryTotals(summary: DealSummaryDto, stageId: string): Totals | undefined {
  const col = summary.columns.find((c) => c.stageId === stageId);
  if (!col) return undefined;
  return {
    count: col.count,
    amountMinor: col.amountMinor,
    weightedMinor: col.weightedMinor,
    others: col.byCurrency
      .filter((c) => c.currency !== summary.currency)
      .map((c) => ({ currency: c.currency, amountMinor: c.amountMinor })),
  };
}

/** Open deals (≤500) plus each closed stage's newest deals (≤100), with the same filters. */
function useBoardDeals(stages: PipelineStageDto[] | undefined, filters: Filters) {
  const [deals, setDeals] = useState<DealDto[] | undefined>(undefined);
  const [truncated, setTruncated] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(undefined);
  const [nonce, setNonce] = useState(0);
  const badRange = Boolean(filters.from && filters.to && filters.from > filters.to);
  const key = JSON.stringify([
    filters.owner,
    filters.from,
    filters.to,
    filters.stale,
    filters.flagged,
  ]);
  const stageKey = (stages ?? []).map((s) => `${s.id}:${s.kind}`).join(",");

  useEffect(() => {
    if (!stages || badRange) return;
    const controller = new AbortController();
    const base = {
      ownerId: ownerQuery(filters.owner),
      closeFrom: filters.from || undefined,
      closeTo: filters.to || undefined,
      stale: filters.stale ? 1 : undefined,
      flagged: filters.flagged ? 1 : undefined,
    };
    const closed = stages.filter((s) => s.kind !== "open");
    setError(undefined);
    Promise.all([
      api<DealPageDto>("/deals", {
        query: { ...base, status: "open", limit: OPEN_LIMIT },
        signal: controller.signal,
      }),
      ...closed.map((s) =>
        api<DealPageDto>("/deals", {
          query: { ...base, stageId: s.id, limit: CLOSED_LIMIT },
          signal: controller.signal,
        }),
      ),
    ])
      .then(([open, ...rest]) => {
        const cut = new Set<string>();
        if (open!.nextCursor) for (const s of stages) if (s.kind === "open") cut.add(s.id);
        rest.forEach((page, i) => page.nextCursor && cut.add(closed[i]!.id));
        setTruncated(cut);
        setDeals([...open!.items, ...rest.flatMap((p) => p.items)]);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err);
      });
    return () => controller.abort();
  }, [key, stageKey, nonce, badRange]);

  return {
    deals,
    setDeals,
    truncated,
    error,
    badRange,
    reload: () => setNonce((n) => n + 1),
  };
}

function DealsView() {
  const { me } = useMe();
  const { toast } = useToast();
  const { filters, set } = useFilters();
  const stages = useResource<PipelineStageDto[]>("/pipeline/stages");
  const members = useResource<MemberDto[]>("/members");
  const summary = useResource<DealSummaryDto>("/deals/summary", {
    ownerId: ownerQuery(filters.owner),
  });
  const ordered = useMemo(() => stageOrder(stages.data ?? []), [stages.data]);
  const board = useBoardDeals(stages.data ? ordered : undefined, filters);
  const [creating, setCreating] = useState(false);
  const [pendingLost, setPendingLost] = useState<{
    deal: DealDto;
    stage: PipelineStageDto;
  } | null>(null);
  const [live, setLive] = useState("");
  const ownerId = useId();
  const fromId = useId();
  const toId = useId();
  const reloadSummary = summary.reload;
  const { setDeals, reload: reloadBoard } = board;

  useEffect(() => {
    const onChange = () => reloadSummary();
    window.addEventListener(DEALS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DEALS_CHANGED_EVENT, onChange);
  }, [reloadSummary]);

  async function doMove(deal: DealDto, stage: PipelineStageDto, lostReason?: string) {
    const before = deal;
    const optimistic: DealDto = {
      ...deal,
      stage: { id: stage.id, name: stage.name, kind: stage.kind, probability: stage.probability },
    };
    setDeals((prev) => prev?.map((d) => (d.id === deal.id ? optimistic : d)));
    setLive(`Moving ${deal.name} to ${stage.name}…`);
    try {
      const saved = await moveDeal(deal.id, stage.id, lostReason);
      setDeals((prev) => prev?.map((d) => (d.id === deal.id ? saved : d)));
      setLive(`Moved ${deal.name} to ${stage.name}.`);
    } catch (err) {
      setDeals((prev) => prev?.map((d) => (d.id === deal.id ? before : d)));
      const msg = `Couldn't move ${deal.name}: ${moveErrorMessage(err)} It's back in ${before.stage.name}.`;
      setLive(msg);
      toast(msg, "error");
    }
  }

  function requestMove(deal: DealDto, stage: PipelineStageDto) {
    if (stage.kind === "lost") setPendingLost({ deal, stage });
    else void doMove(deal, stage);
  }

  const people = (members.data ?? []).filter((m) => m.userId !== me.user.id);
  const ownerLabel =
    filters.owner === "me"
      ? "Your deals"
      : filters.owner === "all"
        ? "Everyone's deals"
        : `${members.data?.find((m) => m.userId === filters.owner)?.name ?? "One person"}'s deals`;
  const extraFilters = Boolean(filters.from || filters.to || filters.stale || filters.flagged);
  const anyFilter = extraFilters || filters.owner !== "all";
  const closedTotals = new Map<string, Totals>();
  if (summary.data && !extraFilters) {
    for (const s of ordered) {
      const t = summaryTotals(summary.data, s.id);
      if (t) closedTotals.set(s.id, t);
    }
  }
  const currency = summary.data?.currency ?? "USD";

  return (
    <>
      <PageHeader
        title="Deals"
        description="Your team's pipeline. Drag a card, or use “Move to…”, to change its stage."
        actions={<Button onClick={() => setCreating(true)}>New deal</Button>}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>

      <ForecastStrip summary={summary.data} scopeLabel={ownerLabel} />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor={ownerId}>Owner</Label>
            <Select
              id={ownerId}
              value={filters.owner}
              onChange={(e) => set({ owner: e.target.value === "all" ? null : e.target.value })}
              className="w-48"
            >
              <option value="all">Everyone</option>
              <option value="me">Mine</option>
              {people.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fromId}>Closes from</Label>
            <Input
              id={fromId}
              type="date"
              value={filters.from}
              aria-invalid={board.badRange || undefined}
              aria-describedby={board.badRange ? `${fromId}-err` : undefined}
              onChange={(e) => set({ from: e.target.value })}
              className="w-44"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={toId}>Closes by</Label>
            <Input
              id={toId}
              type="date"
              value={filters.to}
              onChange={(e) => set({ to: e.target.value })}
              className="w-44"
            />
          </div>
          <div className="flex flex-col gap-2 pb-1">
            <Checkbox
              label="Stale only"
              checked={filters.stale}
              onChange={(e) => set({ stale: e.target.checked ? "1" : null })}
            />
            <Checkbox
              label="Flagged only"
              checked={filters.flagged}
              onChange={(e) => set({ flagged: e.target.checked ? "1" : null })}
            />
          </div>
          {anyFilter ? (
            <Button
              variant="ghost"
              size="sm"
              className="mb-1"
              onClick={() => set({ owner: null, from: null, to: null, stale: null, flagged: null })}
            >
              Clear filters
            </Button>
          ) : null}
          <div
            role="group"
            aria-label="View"
            className="ml-auto inline-flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700"
          >
            {(["board", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={filters.view === v}
                onClick={() => set({ view: v === "list" ? "list" : null })}
                className={cx(
                  "h-9 px-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none focus-visible:ring-inset",
                  filters.view === v
                    ? "bg-indigo-600 text-white dark:bg-indigo-500"
                    : "bg-white text-slate-800 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
                )}
              >
                {v === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
        </div>
        {board.badRange ? (
          <p
            id={`${fromId}-err`}
            className="mt-2 text-xs font-medium text-red-700 dark:text-red-400"
          >
            “Closes from” must be on or before “Closes by”.
          </p>
        ) : null}
      </Card>

      {stages.error ? (
        <Alert tone="error" title="Couldn't load the pipeline">
          {errorMessage(stages.error)}
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={stages.reload}>
              Try again
            </Button>
          </div>
        </Alert>
      ) : board.error ? (
        <Alert tone="error" title="Couldn't load deals">
          {errorMessage(board.error)}
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={reloadBoard}>
              Try again
            </Button>
          </div>
        </Alert>
      ) : board.badRange ? null : !stages.data || !board.deals ? (
        <LoadingBlock label="Loading deals" />
      ) : filters.view === "list" ? (
        <Card>
          <DealTable stages={ordered} deals={board.deals} onMove={requestMove} />
        </Card>
      ) : (
        <>
          {board.deals.length === 0 ? (
            <Alert tone="info" className="mb-3">
              {anyFilter
                ? "No deals match these filters."
                : "No deals yet. Press “New deal”, or create one from a reply in the inbox, a contact or a company."}
            </Alert>
          ) : null}
          <DealBoard
            stages={ordered}
            deals={board.deals}
            currency={currency}
            closedTotals={closedTotals}
            truncated={board.truncated}
            onMove={requestMove}
          />
          {board.truncated.size ? (
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              Showing the newest {OPEN_LIMIT} open deals. Use the filters to narrow the board.
            </p>
          ) : null}
        </>
      )}
      <p className="mt-4 text-xs text-slate-600 dark:text-slate-400">
        Stages, probabilities and stale limits are set in{" "}
        <Link
          href="/app/settings/pipeline"
          className="font-medium text-indigo-700 underline dark:text-indigo-300"
        >
          Settings → Pipeline
        </Link>
        .
      </p>

      <DealDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(deal) => {
          setDeals((prev) => (prev ? [deal, ...prev] : prev));
          setLive(`Created ${deal.name} in ${deal.stage.name}.`);
          toast(`Deal “${deal.name}” created`);
        }}
      />
      <LostReasonDialog
        deal={pendingLost?.deal ?? null}
        stage={pendingLost?.stage ?? null}
        onCancel={() => setPendingLost(null)}
        onConfirm={async (reason) => {
          const p = pendingLost;
          setPendingLost(null);
          if (p) await doMove(p.deal, p.stage, reason);
        }}
      />
    </>
  );
}

export default function DealsPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading deals" />}>
      <DealsView />
    </Suspense>
  );
}
