"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  MoveDealInputSchema,
  PIPELINE_LIMITS,
  type DealDetailDto,
  type DealDto,
  type PipelineStageDto,
} from "@openline/shared";
import { Alert, Badge, Button, cx, Dialog, Field, Textarea } from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import {
  dealFlags,
  formatCalendarDate,
  formatMoney,
  notifyDealsChanged,
  realityFlagged,
} from "@/lib/deals";

// ------------------------------------------------------------------ badges

export function FlagIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={cx("h-3.5 w-3.5", className)}
    >
      <path d="M3.5 2.75a.75.75 0 00-1.5 0v14.5a.75.75 0 001.5 0v-4.392l1.657-.348a6.449 6.449 0 014.271.572 7.948 7.948 0 005.965.524l2.078-.64A.75.75 0 0018 12.25v-8.5a.75.75 0 00-.904-.734l-2.38.501a7.25 7.25 0 01-4.186-.363l-.502-.2a8.75 8.75 0 00-5.053-.439l-1.475.31V2.75z" />
    </svg>
  );
}

/** Stale / Next step overdue / Reality Check flag — always words, never colour alone. */
export function DealBadges({ deal, compact = false }: { deal: DealDto; compact?: boolean }) {
  const flags = dealFlags(deal);
  const reality = flags.filter((f) => f.key === "close" || f.key === "missing");
  const flagged = realityFlagged(deal);
  if (!deal.isStale && !deal.nextStepOverdue && !flagged) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {deal.isStale ? <Badge tone="warning">Stale</Badge> : null}
      {deal.nextStepOverdue ? <Badge tone="danger">Next step overdue</Badge> : null}
      {flagged ? (
        <Badge tone="danger" className="gap-1">
          <FlagIcon />
          {compact ? (
            <>
              <span aria-hidden="true">Flag</span>
              <span className="sr-only">
                Reality Check flag
                {reality.length ? `: ${reality.map((f) => f.label).join(", ")}` : ""}
              </span>
            </>
          ) : (
            <>
              Reality Check
              {reality.length ? `: ${reality.map((f) => f.label.toLowerCase()).join(", ")}` : ""}
            </>
          )}
        </Badge>
      ) : null}
    </span>
  );
}

export function StageKindBadge({ kind }: { kind: DealDto["stage"]["kind"] }) {
  if (kind === "won") return <Badge tone="success">Won</Badge>;
  if (kind === "lost") return <Badge tone="neutral">Lost</Badge>;
  return null;
}

// ------------------------------------------------------------------ move menu

/** Keyboard-accessible alternative to drag and drop: a menu of the other stages. */
export function MoveMenu({
  deal,
  stages,
  onMove,
  disabled,
  align = "right",
}: {
  deal: DealDto;
  stages: PipelineStageDto[];
  onMove: (stage: PipelineStageDto) => void;
  disabled?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const targets = stages.filter((s) => s.id !== deal.stage.id);

  useEffect(() => {
    if (!open) return;
    itemsRef.current[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = itemsRef.current.filter(Boolean) as HTMLButtonElement[];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        Move to…<span className="sr-only"> (deal: {deal.name})</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Move ${deal.name} to`}
          onKeyDown={onMenuKey}
          className={cx(
            "absolute z-30 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {targets.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => {
                itemsRef.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                onMove(s);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-100 focus:bg-indigo-50 focus:outline-none dark:text-slate-200 dark:hover:bg-slate-800 dark:focus:bg-indigo-950"
            >
              <span>{s.name}</span>
              <span className="text-xs text-slate-600 dark:text-slate-400">
                {s.kind === "open" ? `${s.probability}%` : s.kind === "won" ? "Won" : "Lost"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ lost reason

export function LostReasonDialog({
  deal,
  stage,
  onCancel,
  onConfirm,
}: {
  deal: DealDto | null;
  stage: PipelineStageDto | null;
  onCancel: () => void;
  /** Resolves when the move is done; reject to keep the dialog open with an error. */
  onConfirm: (reason: string) => Promise<void>;
}) {
  const open = deal !== null && stage !== null;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setReason("");
      setError(undefined);
      setFormError(null);
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stage) return;
    const parsed = MoveDealInputSchema.safeParse({ stageId: stage.id, lostReason: reason });
    if (!parsed.success || !reason.trim()) {
      setError("Say why the deal was lost.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      if (fe.lostReason) setError(fe.lostReason);
      else setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="sm"
      title={`Mark “${deal?.name ?? ""}” as lost`}
      description="A short reason helps your team learn from lost deals. It stays on the deal."
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Move to {stage?.name ?? "Lost"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-3">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Lost reason" required error={error}>
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={reason}
              maxLength={PIPELINE_LIMITS.lostReason}
              disabled={saving}
              autoFocus
              placeholder="Went with a cheaper tool; no budget until Q3…"
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/** POST /deals/:id/move. Throws ApiError; callers roll back. */
export async function moveDeal(
  dealId: string,
  stageId: string,
  lostReason?: string,
): Promise<DealDetailDto> {
  const deal = await api<DealDetailDto>(`/deals/${dealId}/move`, {
    method: "POST",
    body: lostReason ? { stageId, lostReason } : { stageId },
  });
  notifyDealsChanged();
  return deal;
}

export function moveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Only the deal's owner or a manager can move it.";
    if (err.status === 404) return "This deal or stage no longer exists. Refresh the board.";
  }
  return errorMessage(err);
}

// ------------------------------------------------------------------ deal list (contact/company)

export function DealRows({ deals, label }: { deals: DealDto[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-slate-200 dark:divide-slate-800">
      {deals.map((d) => (
        <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3">
          <div className="min-w-0">
            <Link
              href={`/app/deals/${d.id}`}
              className="font-medium break-words text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
            >
              {d.name}
            </Link>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {d.stage.name} · {formatMoney(d.amountMinor, d.currency)}
              {d.expectedCloseDate
                ? ` · closes ${formatCalendarDate(d.expectedCloseDate)}`
                : ""} · {d.owner.name}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <StageKindBadge kind={d.stage.kind} />
            <DealBadges deal={d} compact />
          </div>
        </li>
      ))}
    </ul>
  );
}
