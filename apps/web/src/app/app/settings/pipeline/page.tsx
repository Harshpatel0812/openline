"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  DEAL_EVIDENCE_TYPES,
  DEFAULT_STALE_AFTER_DAYS,
  PIPELINE_LIMITS,
  ReplaceStagesInputSchema,
  STAGE_KINDS,
  type DealEvidenceType,
  type PipelineStageDto,
  type StageKind,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  Field,
  Input,
  LoadingBlock,
  Select,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { EVIDENCE_TYPE_LABELS, notifyDealsChanged, stageOrder } from "@/lib/deals";
import { zodFieldErrors } from "@/lib/format";
import { useResource } from "@/lib/use-resource";

interface Draft {
  key: string;
  id?: string;
  name: string;
  probability: string;
  kind: StageKind;
  staleAfterDays: string;
  neverStale: boolean;
  criteria: { label: string; evidence: DealEvidenceType }[];
  dealCount: number;
  /** Kind when loaded (a stage with deals can't change kind). */
  savedKind?: StageKind;
}

const KIND_LABELS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };

let keySeq = 0;
const newKey = () => `new-${++keySeq}`;

function toDrafts(stages: PipelineStageDto[]): Draft[] {
  return stageOrder(stages).map((s) => ({
    key: s.id,
    id: s.id,
    name: s.name,
    probability: String(s.probability),
    kind: s.kind,
    staleAfterDays:
      s.staleAfterDays === null ? String(DEFAULT_STALE_AFTER_DAYS) : String(s.staleAfterDays),
    neverStale: s.staleAfterDays === null,
    criteria: s.entryCriteria.map((c) => ({ label: c.label, evidence: c.evidence })),
    dealCount: s.dealCount,
    savedKind: s.kind,
  }));
}

function toInput(drafts: Draft[]) {
  return {
    stages: drafts.map((d) => ({
      ...(d.id ? { id: d.id } : {}),
      name: d.name,
      probability: d.probability.trim() === "" ? Number.NaN : Number(d.probability),
      kind: d.kind,
      staleAfterDays: d.neverStale
        ? null
        : d.staleAfterDays.trim() === ""
          ? Number.NaN
          : Number(d.staleAfterDays),
      entryCriteria: d.criteria,
    })),
  };
}

function StageEditor({
  draft,
  index,
  count,
  errors,
  readOnly,
  onChange,
  onMove,
  onRemove,
  drag,
}: {
  draft: Draft;
  index: number;
  count: number;
  errors: Record<string, string>;
  readOnly: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  drag: {
    over: boolean;
    onDragStart: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: () => void;
    onDragEnd: () => void;
  };
}) {
  const e = (field: string) => errors[`stages.${index}.${field}`];
  const label = draft.name.trim() || `Stage ${index + 1}`;
  const kindLocked = draft.dealCount > 0 && draft.savedKind !== undefined;
  return (
    <li
      onDragOver={drag.onDragOver}
      onDrop={(ev) => {
        ev.preventDefault();
        drag.onDrop();
      }}
      className={cx(
        "rounded-lg border bg-white dark:bg-slate-900",
        drag.over
          ? "border-indigo-500 ring-2 ring-indigo-500"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      <fieldset className="space-y-4 p-4" aria-label={`Stage ${index + 1}: ${label}`}>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly ? (
            <span
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData("text/plain", draft.key);
                ev.dataTransfer.effectAllowed = "move";
                drag.onDragStart();
              }}
              onDragEnd={drag.onDragEnd}
              title="Drag to reorder"
              aria-hidden="true"
              className="cursor-grab rounded px-1 text-slate-400 select-none hover:text-slate-700 dark:hover:text-slate-200"
            >
              ⠿
            </span>
          ) : null}
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {index + 1}. {label}
          </span>
          {draft.kind !== "open" ? (
            <Badge tone={draft.kind === "won" ? "success" : "neutral"}>
              {KIND_LABELS[draft.kind]}
            </Badge>
          ) : null}
          <span className="text-xs text-slate-600 dark:text-slate-400">
            {draft.dealCount} deal{draft.dealCount === 1 ? "" : "s"}
          </span>
          {!readOnly ? (
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={index === 0}
                onClick={() => onMove(index - 1)}
                aria-label={`Move ${label} up`}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={index === count - 1}
                onClick={() => onMove(index + 1)}
                aria-label={`Move ${label} down`}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={draft.dealCount > 0}
                onClick={onRemove}
                aria-label={`Remove ${label}`}
                title={draft.dealCount > 0 ? "Move this stage's deals first" : undefined}
              >
                Remove
              </Button>
            </span>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem_9rem]">
          <Field label="Name" error={e("name")} required>
            {(p) => (
              <Input
                {...p}
                value={draft.name}
                maxLength={PIPELINE_LIMITS.stageName}
                disabled={readOnly}
                onChange={(ev) => onChange({ name: ev.target.value })}
              />
            )}
          </Field>
          <Field label="Probability %" error={e("probability")}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                value={draft.probability}
                disabled={readOnly}
                onChange={(ev) => onChange({ probability: ev.target.value })}
              />
            )}
          </Field>
          <Field
            label="Kind"
            error={e("kind")}
            hint={kindLocked ? "Has deals: kind is fixed" : undefined}
          >
            {(p) => (
              <Select
                {...p}
                value={draft.kind}
                disabled={readOnly || kindLocked}
                onChange={(ev) => onChange({ kind: ev.target.value as StageKind })}
              >
                {STAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {draft.kind === "open" ? (
          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Stale after (days)"
              error={e("staleAfterDays")}
              hint="No activity for this long marks a deal Stale."
              className="w-48"
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={PIPELINE_LIMITS.maxStaleDays}
                  inputMode="numeric"
                  value={draft.staleAfterDays}
                  disabled={readOnly || draft.neverStale}
                  onChange={(ev) => onChange({ staleAfterDays: ev.target.value })}
                />
              )}
            </Field>
            <Checkbox
              className="pb-6"
              label="Never stale"
              checked={draft.neverStale}
              disabled={readOnly}
              onChange={(ev) => onChange({ neverStale: ev.target.checked })}
            />
          </div>
        ) : null}
        <div>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Entry criteria{" "}
            <span className="font-normal text-slate-600 dark:text-slate-400">
              ({draft.criteria.length} of {PIPELINE_LIMITS.maxCriteria})
            </span>
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            What should be true before a deal is here. Tie an item to evidence and Reality Check
            looks for it in the emails.
          </p>
          {e("entryCriteria") ? (
            <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">
              {e("entryCriteria")}
            </p>
          ) : null}
          <ul className="mt-2 space-y-2">
            {draft.criteria.map((c, ci) => (
              <li key={ci} className="grid items-start gap-2 sm:grid-cols-[1fr_16rem_auto]">
                <Field
                  label={`Criterion ${ci + 1}`}
                  error={errors[`stages.${index}.entryCriteria.${ci}.label`]}
                >
                  {(p) => (
                    <Input
                      {...p}
                      value={c.label}
                      maxLength={PIPELINE_LIMITS.criterionLabel}
                      disabled={readOnly}
                      placeholder="Budget owner confirmed"
                      onChange={(ev) =>
                        onChange({
                          criteria: draft.criteria.map((x, i) =>
                            i === ci ? { ...x, label: ev.target.value } : x,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Evidence">
                  {(p) => (
                    <Select
                      {...p}
                      value={c.evidence}
                      disabled={readOnly}
                      onChange={(ev) =>
                        onChange({
                          criteria: draft.criteria.map((x, i) =>
                            i === ci ? { ...x, evidence: ev.target.value as DealEvidenceType } : x,
                          ),
                        })
                      }
                    >
                      {DEAL_EVIDENCE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {EVIDENCE_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {!readOnly ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="sm:mt-7"
                    onClick={() =>
                      onChange({ criteria: draft.criteria.filter((_, i) => i !== ci) })
                    }
                    aria-label={`Remove criterion ${ci + 1} from ${label}`}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {!readOnly ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={draft.criteria.length >= PIPELINE_LIMITS.maxCriteria}
              onClick={() =>
                onChange({ criteria: [...draft.criteria, { label: "", evidence: "none" }] })
              }
            >
              Add criterion<span className="sr-only"> to {label}</span>
            </Button>
          ) : null}
        </div>
      </fieldset>
    </li>
  );
}

export default function PipelineSettingsPage() {
  const { can } = useMe();
  const { toast } = useToast();
  const canEdit = can("owner", "admin");
  const { data, error, loading, reload, setData } =
    useResource<PipelineStageDto[]>("/pipeline/stages");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [live, setLive] = useState("");
  const dragKey = useRef<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDrafts(toDrafts(data));
  }, [data]);

  if (loading && !data) return <LoadingBlock label="Loading pipeline" />;
  if (error || !data || !drafts) {
    return (
      <div className="max-w-xl space-y-4">
        <PageHeader title="Pipeline" />
        <Alert tone="error" title="Couldn't load the pipeline">
          {errorMessage(error)}
        </Alert>
        <Button variant="secondary" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }

  const dirty = JSON.stringify(drafts) !== JSON.stringify(toDrafts(data));
  const readOnly = !canEdit || saving;

  function update(i: number, patch: Partial<Draft>) {
    setDrafts((prev) => prev && prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  function move(from: number, to: number) {
    setDrafts((prev) => {
      if (!prev || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      setLive(`${item!.name || "Stage"} moved to position ${to + 1} of ${next.length}.`);
      return next;
    });
  }

  function addStage() {
    setDrafts((prev) => {
      if (!prev) return prev;
      const firstClosed = prev.findIndex((d) => d.kind !== "open");
      const at = firstClosed === -1 ? prev.length : firstClosed;
      const next = [...prev];
      next.splice(at, 0, {
        key: newKey(),
        name: "",
        probability: "50",
        kind: "open",
        staleAfterDays: String(DEFAULT_STALE_AFTER_DAYS),
        neverStale: false,
        criteria: [],
        dealCount: 0,
      });
      setLive(`New stage added at position ${at + 1}.`);
      return next;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!drafts) return;
    setFormError(null);
    const parsed = ReplaceStagesInputSchema.safeParse(toInput(drafts));
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error.issues);
      setErrors(fe);
      setFormError(fe.stages ?? "Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const saved = await api<PipelineStageDto[]>("/pipeline/stages", {
        method: "PUT",
        body: parsed.data,
      });
      setData(() => saved);
      notifyDealsChanged();
      toast("Pipeline saved");
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      if (err instanceof ApiError && err.code === "stage_has_deals") {
        const details = err.details as { stages?: { name: string; deals?: number }[] } | undefined;
        const names = details?.stages?.map((s) => `${s.name} (${s.deals ?? "some"} deals)`) ?? [];
        setFormError(
          `${err.message}${names.length ? ` Still holding deals: ${names.join(", ")}.` : ""}`,
        );
      } else {
        setFormError(
          fe.stages ??
            (Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err)),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Stages every deal moves through, their win probability, when a deal counts as stale and what should be true before it gets there."
      />
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      <form onSubmit={onSubmit} noValidate className="max-w-3xl space-y-4">
        {!canEdit ? (
          <Alert tone="info">Only workspace owners and admins can change the pipeline.</Alert>
        ) : (
          <Alert tone="info">
            Open stages come first, then exactly one Won and one Lost stage. A stage with deals
            can&apos;t be removed or change kind until its deals move.
          </Alert>
        )}
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <ol aria-label="Stages in board order" className="space-y-3">
          {drafts.map((d, i) => (
            <StageEditor
              key={d.key}
              draft={d}
              index={i}
              count={drafts.length}
              errors={errors}
              readOnly={readOnly}
              onChange={(patch) => update(i, patch)}
              onMove={(to) => move(i, to)}
              onRemove={() => {
                setDrafts((prev) => prev && prev.filter((_, j) => j !== i));
                setLive(`${d.name || "Stage"} removed. Save to apply.`);
              }}
              drag={{
                over: overKey === d.key,
                onDragStart: () => {
                  dragKey.current = d.key;
                },
                onDragOver: (ev) => {
                  if (!dragKey.current) return;
                  ev.preventDefault();
                  if (overKey !== d.key) setOverKey(d.key);
                },
                onDrop: () => {
                  const from = drafts.findIndex((x) => x.key === dragKey.current);
                  dragKey.current = null;
                  setOverKey(null);
                  if (from !== -1 && from !== i) move(from, i);
                },
                onDragEnd: () => {
                  dragKey.current = null;
                  setOverKey(null);
                },
              }}
            />
          ))}
        </ol>
        {canEdit ? (
          <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
            <Button
              variant="secondary"
              onClick={addStage}
              disabled={saving || drafts.length >= PIPELINE_LIMITS.maxStages}
            >
              Add stage
            </Button>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={!dirty || saving}
                onClick={() => {
                  setDrafts(toDrafts(data));
                  setErrors({});
                  setFormError(null);
                }}
              >
                Discard changes
              </Button>
              <Button type="submit" loading={saving} disabled={!dirty}>
                Save pipeline
              </Button>
            </div>
          </Card>
        ) : null}
      </form>
    </>
  );
}
