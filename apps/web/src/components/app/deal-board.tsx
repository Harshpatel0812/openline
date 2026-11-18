"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from "react";
import type { DealDto, DealSummaryDto, PipelineStageDto } from "@openline/shared";
import { Avatar, Badge, cx, EmptyState, initials, Table, Td, Th } from "@/components/ui";
import { formatCalendarDate, formatMoney, totalsFor, type Totals } from "@/lib/deals";
import { crmOf } from "@/lib/crm";
import { formatDate } from "@/lib/format";
import { CrmBadge } from "./crm-badge";
import { DealBadges, MoveMenu, StageKindBadge } from "./deal-parts";

export type MoveRequest = (deal: DealDto, stage: PipelineStageDto) => void;

// ------------------------------------------------------------------ totals

function TotalsLine({ totals, currency }: { totals: Totals; currency: string }) {
  return (
    <p className="text-xs text-slate-600 tabular-nums dark:text-slate-400">
      <span>{formatMoney(totals.amountMinor, currency, true)}</span>
      <span aria-hidden="true"> · </span>
      <span>
        <span className="sr-only">weighted </span>
        {formatMoney(totals.weightedMinor, currency, true)}
        <span aria-hidden="true"> weighted</span>
      </span>
      {totals.others.length ? (
        <span className="block" title="Other currencies aren't converted or included in totals">
          + {totals.others.map((o) => formatMoney(o.amountMinor, o.currency, true)).join(", ")} not
          in totals
        </span>
      ) : null}
    </p>
  );
}

// ------------------------------------------------------------------ forecast strip

export function ForecastStrip({
  summary,
  scopeLabel,
}: {
  summary: DealSummaryDto | undefined;
  scopeLabel: string;
}) {
  const items = summary
    ? [
        { label: "Open pipeline", value: summary.forecast.open.amountMinor },
        { label: "Weighted", value: summary.forecast.open.weightedMinor },
        { label: "Closing this month", value: summary.forecast.thisMonth.amountMinor },
        { label: "Closing this quarter", value: summary.forecast.thisQuarter.amountMinor },
      ]
    : [];
  const others = summary?.forecast.open.byCurrency.filter((c) => c.currency !== summary.currency);
  return (
    <section aria-labelledby="forecast-title" className="mb-4">
      <h2 id="forecast-title" className="sr-only">
        Forecast for {scopeLabel}
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summary
          ? items.map((i) => (
              <div
                key={i.label}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
              >
                <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">
                  {i.label}
                </dt>
                <dd className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums dark:text-white">
                  {formatMoney(i.value, summary.currency)}
                </dd>
              </div>
            ))
          : [0, 1, 2, 3].map((i) => (
              <div
                key={i}
                aria-hidden="true"
                className="h-[4.25rem] animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none dark:bg-slate-800"
              />
            ))}
      </dl>
      {summary ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          {scopeLabel}. Weighted = amount × stage probability. &ldquo;Closing&rdquo; uses expected
          close dates.
          {summary.multiCurrency ? (
            <>
              {" "}
              Totals are in {summary.currency} only; deals in other currencies aren&apos;t converted
              {others && others.length
                ? ` (${others.map((o) => formatMoney(o.amountMinor, o.currency)).join(", ")} open)`
                : ""}
              .
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ card

const DRAG_HOLD_MS = 350;

interface TouchDrag {
  dealId: string;
  timer: number | null;
  startX: number;
  startY: number;
  active: boolean;
}

function DealCard({
  deal,
  stages,
  onMove,
  dragging,
  onDragStart,
  onDragEnd,
  onTouchDrag,
}: {
  deal: DealDto;
  stages: PipelineStageDto[];
  onMove: MoveRequest;
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onTouchDrag: {
    start: (e: PointerEvent<HTMLElement>, deal: DealDto) => void;
  };
}) {
  return (
    <li
      draggable={deal.canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", deal.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(deal.id);
      }}
      onDragEnd={onDragEnd}
      onPointerDown={(e) => deal.canEdit && onTouchDrag.start(e, deal)}
      data-deal-id={deal.id}
      className={cx(
        "rounded-lg border bg-white p-3 shadow-xs select-none dark:bg-slate-900",
        deal.canEdit && "cursor-grab active:cursor-grabbing",
        dragging
          ? "border-indigo-500 opacity-60 ring-2 ring-indigo-500"
          : "border-slate-200 dark:border-slate-700",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/app/deals/${deal.id}`}
          draggable={false}
          className="min-w-0 rounded text-sm font-semibold break-words text-slate-900 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-slate-100"
        >
          {deal.name}
        </Link>
        <span title={deal.owner.name} className="shrink-0">
          <Avatar name={deal.owner.name} size="sm" />
          <span className="sr-only">Owner {deal.owner.name}</span>
        </span>
      </div>
      {deal.company ? (
        <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-400">
          {deal.company.name}
        </p>
      ) : null}
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-700 dark:text-slate-300">
        <span className="font-medium tabular-nums">
          {formatMoney(deal.amountMinor, deal.currency)}
        </span>
        {deal.expectedCloseDate ? (
          <span>
            <span aria-hidden="true">· </span>closes {formatCalendarDate(deal.expectedCloseDate)}
          </span>
        ) : null}
      </p>
      {crmOf(deal) ? (
        <div className="mt-2">
          <CrmBadge crm={crmOf(deal)} label={deal.name} />
        </div>
      ) : null}
      <div className="mt-2 flex items-end justify-between gap-2">
        <DealBadges deal={deal} compact />
        {deal.canEdit ? (
          <div className="ml-auto">
            <MoveMenu deal={deal} stages={stages} onMove={(s) => onMove(deal, s)} />
          </div>
        ) : (
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400" aria-hidden="true">
            {initials(deal.owner.name)}&apos;s deal
          </span>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ board

export function DealBoard({
  stages,
  deals,
  currency,
  closedTotals,
  truncated,
  onMove,
}: {
  stages: PipelineStageDto[];
  deals: DealDto[];
  currency: string;
  /** Summary totals for closed columns whose list is cut short (more than were loaded). */
  closedTotals: Map<string, Totals>;
  truncated: Set<string>;
  onMove: MoveRequest;
}) {
  const [dragId, setDragIdState] = useState<string | null>(null);
  // The first dragover can arrive before React re-renders: read the dragged id from a ref.
  const dragRef = useRef<string | null>(null);
  const setDragId = (id: string | null) => {
    dragRef.current = id;
    setDragIdState(id);
  };
  const [over, setOver] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(stages.filter((s) => s.kind !== "open").map((s) => s.id)),
  );
  const touch = useRef<TouchDrag | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);
  const dealsRef = useRef(deals);
  dealsRef.current = deals;
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const rootRef = useRef<HTMLDivElement>(null);
  // A card moved from its "Move to…" menu remounts in another column: keep keyboard focus on it.
  const focusAfterMove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-deal-id="${CSS.escape(id)}"] [aria-haspopup="menu"]`,
    );
    if (document.querySelector("dialog[open]")) return;
    el?.focus();
    focusAfterMove.current = null;
  }, [deals]);
  const menuMove: MoveRequest = (deal, stage) => {
    focusAfterMove.current = deal.id;
    onMove(deal, stage);
  };

  const byStage = new Map<string, DealDto[]>();
  for (const s of stages) byStage.set(s.id, []);
  for (const d of deals) byStage.get(d.stage.id)?.push(d);

  function drop(stageId: string, dealId: string | null) {
    setOver(null);
    setDragId(null);
    const deal = dealsRef.current.find((d) => d.id === dealId);
    const stage = stagesRef.current.find((s) => s.id === stageId);
    if (deal && stage && deal.stage.id !== stage.id) onMoveRef.current(deal, stage);
  }

  // Touch and pen: hold a card briefly, then drag it; scrolling works until the hold completes.
  useEffect(() => {
    const blockScroll = (e: TouchEvent) => {
      if (touch.current?.active) e.preventDefault();
    };
    const move = (e: globalThis.PointerEvent) => {
      const t = touch.current;
      if (!t) return;
      if (!t.active) {
        if (Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 8) cancel();
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest<HTMLElement>("[data-stage-id]");
      setOver(col?.dataset.stageId ?? null);
      setGhost((g) => (g ? { ...g, x: e.clientX, y: e.clientY } : g));
    };
    const up = (e: globalThis.PointerEvent) => {
      const t = touch.current;
      if (!t) return;
      if (t.active) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const col = el?.closest<HTMLElement>("[data-stage-id]");
        if (col?.dataset.stageId) drop(col.dataset.stageId, t.dealId);
      }
      cancel();
    };
    const cancel = () => {
      // Native (mouse) drags fire pointercancel too: only end a touch drag here.
      if (!touch.current) return;
      if (touch.current.timer) window.clearTimeout(touch.current.timer);
      touch.current = null;
      setGhost(null);
      setDragId(null);
      setOver(null);
    };
    document.addEventListener("touchmove", blockScroll, { passive: false });
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    return () => {
      document.removeEventListener("touchmove", blockScroll);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
    };
  }, []);

  const touchDrag = {
    start(e: PointerEvent<HTMLElement>, deal: DealDto) {
      if (e.pointerType === "mouse") return;
      if ((e.target as HTMLElement).closest("a,button")) return;
      const { clientX, clientY } = e;
      const t: TouchDrag = {
        dealId: deal.id,
        startX: clientX,
        startY: clientY,
        active: false,
        timer: null,
      };
      t.timer = window.setTimeout(() => {
        t.active = true;
        setDragId(deal.id);
        setGhost({ x: clientX, y: clientY, name: deal.name });
      }, DRAG_HOLD_MS);
      touch.current = t;
    },
  };

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="relative" ref={rootRef}>
      <div
        className="relative -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0"
        role="list"
        aria-label="Pipeline stages"
      >
        {stages.map((stage) => {
          const list = byStage.get(stage.id) ?? [];
          const isClosed = stage.kind !== "open";
          const isCollapsed = isClosed && collapsed.has(stage.id);
          const totals =
            truncated.has(stage.id) && closedTotals.get(stage.id)
              ? closedTotals.get(stage.id)!
              : totalsFor(list, currency, () => stage.probability);
          const headingId = `col-${stage.id}`;
          const isOver = over === stage.id && dragId !== null;
          return (
            <section
              key={stage.id}
              role="listitem"
              aria-labelledby={headingId}
              data-stage-id={stage.id}
              onDragOver={(e: DragEvent) => {
                if (!dragRef.current) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== stage.id) setOver(stage.id);
              }}
              onDragLeave={(e: DragEvent) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                drop(stage.id, e.dataTransfer.getData("text/plain") || dragRef.current);
              }}
              className={cx(
                "flex shrink-0 snap-start flex-col rounded-lg border bg-slate-50 dark:bg-slate-950",
                isCollapsed ? "w-[70vw] sm:w-48" : "w-[85vw] sm:w-72",
                isOver
                  ? "border-indigo-500 ring-2 ring-indigo-500"
                  : "border-slate-200 dark:border-slate-800",
              )}
            >
              <header className="border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
                <div className="flex items-center justify-between gap-2">
                  <h2
                    id={headingId}
                    className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
                  >
                    {stage.name}
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-800 tabular-nums dark:bg-slate-800 dark:text-slate-200">
                      {totals.count}
                      {truncated.has(stage.id) && !closedTotals.get(stage.id) ? "+" : ""}
                      <span className="sr-only"> deals</span>
                    </span>
                  </h2>
                  {isClosed ? (
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggle(stage.id)}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
                    >
                      {isCollapsed ? "Show" : "Hide"}
                      <span className="sr-only"> {stage.name} deals</span>
                    </button>
                  ) : (
                    <span className="text-xs text-slate-600 dark:text-slate-400">
                      {stage.probability}%
                    </span>
                  )}
                </div>
                <TotalsLine totals={totals} currency={currency} />
              </header>
              {isCollapsed ? (
                <p className="px-3 py-3 text-xs text-slate-600 dark:text-slate-400">
                  Drop a deal here to mark it {stage.kind === "won" ? "won" : "lost"}.
                </p>
              ) : list.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-slate-600 dark:text-slate-400">
                  No deals in {stage.name}.
                </p>
              ) : (
                <ul
                  aria-label={`${stage.name} deals`}
                  className="flex max-h-[65vh] flex-col gap-2 overflow-y-auto p-2"
                >
                  {list.map((d) => (
                    <DealCard
                      key={d.id}
                      deal={d}
                      stages={stages}
                      onMove={menuMove}
                      dragging={dragId === d.id}
                      onDragStart={setDragId}
                      onDragEnd={() => {
                        setDragId(null);
                        setOver(null);
                      }}
                      onTouchDrag={touchDrag}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {ghost ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 max-w-56 -translate-x-1/2 -translate-y-full rounded-lg border border-indigo-500 bg-white px-3 py-2 text-sm font-medium shadow-lg dark:bg-slate-900"
          style={{ left: ghost.x, top: ghost.y - 8 }}
        >
          {ghost.name}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ list view

type SortKey = "name" | "company" | "stage" | "amount" | "owner" | "close" | "activity";

const SORTERS: Record<
  SortKey,
  (a: DealDto, b: DealDto, stageIndex: Map<string, number>) => number
> = {
  name: (a, b) => a.name.localeCompare(b.name),
  company: (a, b) => (a.company?.name ?? "￿").localeCompare(b.company?.name ?? "￿"),
  stage: (a, b, idx) => (idx.get(a.stage.id) ?? 0) - (idx.get(b.stage.id) ?? 0),
  amount: (a, b) => (a.amountMinor ?? -1) - (b.amountMinor ?? -1),
  owner: (a, b) => a.owner.name.localeCompare(b.owner.name),
  close: (a, b) =>
    (a.expectedCloseDate ?? "9999-99-99").localeCompare(b.expectedCloseDate ?? "9999-99-99"),
  activity: (a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt),
};

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Deal" },
  { key: "company", label: "Company" },
  { key: "stage", label: "Stage" },
  { key: "amount", label: "Amount", className: "text-right" },
  { key: "owner", label: "Owner" },
  { key: "close", label: "Close date" },
  { key: "activity", label: "Last activity" },
];

export function DealTable({
  stages,
  deals,
  onMove,
}: {
  stages: PipelineStageDto[];
  deals: DealDto[];
  onMove: MoveRequest;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "stage", dir: 1 });
  const stageIndex = new Map(stages.map((s, i) => [s.id, i]));
  const rows = [...deals].sort(
    (a, b) => SORTERS[sort.key](a, b, stageIndex) * sort.dir || a.name.localeCompare(b.name),
  );
  if (deals.length === 0) {
    return <EmptyState title="No deals match" description="Try other filters." />;
  }
  return (
    <Table caption="Deals">
      <thead>
        <tr>
          {COLUMNS.map((c) => {
            const active = sort.key === c.key;
            return (
              <Th
                key={c.key}
                className={c.className}
                aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
              >
                <button
                  type="button"
                  onClick={() =>
                    setSort((s) =>
                      s.key === c.key
                        ? { key: c.key, dir: s.dir === 1 ? -1 : 1 }
                        : { key: c.key, dir: 1 },
                    )
                  }
                  className="inline-flex items-center gap-1 rounded uppercase focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none"
                >
                  {c.label}
                  <span aria-hidden="true" className={active ? "" : "opacity-30"}>
                    {active && sort.dir === -1 ? "↓" : "↑"}
                  </span>
                </button>
              </Th>
            );
          })}
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id}>
            <Td>
              <Link
                href={`/app/deals/${d.id}`}
                className="font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
              >
                {d.name}
              </Link>
              <div className="mt-1 flex flex-wrap gap-1">
                <DealBadges deal={d} compact />
                <CrmBadge crm={crmOf(d)} label={d.name} />
              </div>
            </Td>
            <Td className="text-slate-600 dark:text-slate-400">{d.company?.name ?? "—"}</Td>
            <Td>
              <span className="flex items-center gap-1.5">
                {d.stage.name}
                <StageKindBadge kind={d.stage.kind} />
              </span>
            </Td>
            <Td className="text-right tabular-nums">{formatMoney(d.amountMinor, d.currency)}</Td>
            <Td>{d.owner.name}</Td>
            <Td className="whitespace-nowrap">{formatCalendarDate(d.expectedCloseDate)}</Td>
            <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
              {formatDate(d.lastActivityAt)}
            </Td>
            <Td>
              {d.canEdit ? (
                <MoveMenu deal={d} stages={stages} onMove={(s) => onMove(d, s)} />
              ) : (
                <Badge>View only</Badge>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
