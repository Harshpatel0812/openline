"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SequenceInputSchema, type SequenceDto, type SequenceInput } from "@openline/shared";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cx,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { zodFieldErrors } from "@/lib/format";

export const MAX_STEPS = 10;

const WEEKDAYS = [
  { iso: 1, short: "Mon", long: "Monday" },
  { iso: 2, short: "Tue", long: "Tuesday" },
  { iso: 3, short: "Wed", long: "Wednesday" },
  { iso: 4, short: "Thu", long: "Thursday" },
  { iso: 5, short: "Fri", long: "Friday" },
  { iso: 6, short: "Sat", long: "Saturday" },
  { iso: 7, short: "Sun", long: "Sunday" },
];

export const TEMPLATE_VARIABLES = [
  "firstName",
  "lastName",
  "fullName",
  "company",
  "title",
  "senderName",
] as const;

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12:00 AM (midnight)";
  if (h === 12) return "12:00 PM (noon)";
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

interface StepDraft {
  key: string;
  delayDays: string;
  subject: string;
  body: string;
  threadWithPrevious: boolean;
}

export interface SequenceDraft {
  name: string;
  days: number[];
  startHour: number;
  endHour: number;
  steps: StepDraft[];
}

let keySeq = 0;
const newKey = () => `step-${++keySeq}`;

export function emptyStep(first: boolean): StepDraft {
  return {
    key: newKey(),
    delayDays: first ? "0" : "3",
    subject: "",
    body: "",
    threadWithPrevious: true,
  };
}

export function draftFrom(seq?: SequenceDto): SequenceDraft {
  if (!seq) {
    return {
      name: "",
      days: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 17,
      steps: [
        {
          ...emptyStep(true),
          subject: "Quick question, {{firstName|there}}",
          body: "Hi {{firstName|there}},\n\n\n\nBest,\n{{senderName}}",
        },
      ],
    };
  }
  return {
    name: seq.name,
    days: [...seq.sendWindow.days].sort(),
    startHour: seq.sendWindow.startHour,
    endHour: seq.sendWindow.endHour,
    steps: [...seq.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        key: newKey(),
        delayDays: String(s.delayDays),
        subject: s.subject,
        body: s.body,
        threadWithPrevious: s.threadWithPrevious,
      })),
  };
}

/** Converts the draft to the API body (steps may be dropped by the caller). */
export function toInput(d: SequenceDraft): Required<Pick<SequenceInput, "name">> & SequenceInput {
  return {
    name: d.name,
    sendWindow: { days: [...d.days].sort(), startHour: d.startHour, endHour: d.endHour },
    steps: d.steps.map((s, i) => ({
      delayDays: i === 0 ? 0 : Number(s.delayDays),
      subject: s.subject,
      body: s.body,
      threadWithPrevious: i === 0 ? false : s.threadWithPrevious,
    })),
  };
}

const stepsSignature = (d: SequenceDraft) => JSON.stringify(toInput(d).steps);

// ------------------------------------------------------------------ step card

function StepCard({
  step,
  index,
  count,
  errors,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  step: StepDraft;
  index: number;
  count: number;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (patch: Partial<StepDraft>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"subject" | "body">("body");
  const headingId = useId();
  const err = (k: string) => errors[`steps.${index}.${k}`];
  const first = index === 0;

  function insertVariable(name: string) {
    const field = lastFocused.current;
    const el = field === "subject" ? subjectRef.current : bodyRef.current;
    const value = field === "subject" ? step.subject : step.body;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(field === "subject" ? { subject: next } : { body: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <li>
      <Card className="overflow-hidden" aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
          <h3 id={headingId} className="text-sm font-semibold text-slate-900 dark:text-white">
            Step {index + 1}
          </h3>
          <div className="text-sm text-slate-700 dark:text-slate-300">
            {first ? (
              "Send at the first allowed time"
            ) : (
              <label className="flex items-center gap-2 whitespace-nowrap">
                Wait
                <span className="w-16 shrink-0">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={60}
                    value={step.delayDays}
                    disabled={disabled}
                    onChange={(e) => onChange({ delayDays: e.target.value })}
                    aria-invalid={err("delayDays") ? true : undefined}
                    className="h-8 px-2"
                  />
                </span>
                days after step {index}
              </label>
            )}
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || first}
              onClick={() => onMove(-1)}
              aria-label={`Move step ${index + 1} up`}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || index === count - 1}
              onClick={() => onMove(1)}
              aria-label={`Move step ${index + 1} down`}
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || count === 1}
              onClick={onRemove}
              className="text-red-700 dark:text-red-400"
              aria-label={`Delete step ${index + 1}`}
            >
              Delete
            </Button>
          </div>
        </div>
        <div className="space-y-4 p-4">
          {err("delayDays") ? (
            <p className="text-xs font-medium text-red-700 dark:text-red-400">
              Wait: {err("delayDays")}
            </p>
          ) : null}
          <Field label="Subject" error={err("subject")} required>
            {(p) => (
              <Input
                {...p}
                ref={subjectRef}
                value={step.subject}
                disabled={disabled}
                maxLength={200}
                onFocus={() => (lastFocused.current = "subject")}
                onChange={(e) => onChange({ subject: e.target.value })}
              />
            )}
          </Field>
          <Field label="Email body" error={err("body")} required>
            {(p) => (
              <Textarea
                {...p}
                ref={bodyRef}
                rows={8}
                value={step.body}
                disabled={disabled}
                maxLength={10_000}
                onFocus={() => (lastFocused.current = "body")}
                onChange={(e) => onChange({ body: e.target.value })}
                className="font-mono leading-relaxed"
              />
            )}
          </Field>
          <div>
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Insert a variable at the cursor:
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(v)}
                  aria-label={`Insert ${v} into step ${index + 1}`}
                  className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 font-mono text-xs text-indigo-800 hover:bg-indigo-100 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none disabled:opacity-60 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          </div>
          {!first ? (
            <Checkbox
              label="Reply in the same thread"
              description={`Sends as “Re: …” under step ${index}'s subject, so it reads as a follow-up.`}
              checked={step.threadWithPrevious}
              disabled={disabled}
              onChange={(e) => onChange({ threadWithPrevious: e.target.checked })}
            />
          ) : null}
        </div>
      </Card>
    </li>
  );
}

// ------------------------------------------------------------------ editor

export function SequenceEditor({
  sequence,
  canDuplicate = true,
  onSaved,
  footerExtra,
}: {
  sequence?: SequenceDto;
  canDuplicate?: boolean;
  onSaved?: (seq: SequenceDto) => void;
  footerExtra?: ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState<SequenceDraft>(() => draftFrom(sequence));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const [inUse, setInUse] = useState(false);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const daysLabelId = useId();

  // Re-sync only when the saved content changes, so a status change elsewhere on the page
  // doesn't wipe unsaved edits.
  const latest = useRef(sequence);
  latest.current = sequence;
  const syncKey = sequence ? `${sequence.id}:${JSON.stringify(toInput(draftFrom(sequence)))}` : "";
  useEffect(() => {
    setDraft(draftFrom(latest.current));
  }, [syncKey]);

  const original = sequence ? draftFrom(sequence) : null;
  const stepsChanged = !original || stepsSignature(original) !== stepsSignature(draft);
  const dirty =
    !original ||
    stepsChanged ||
    JSON.stringify({ ...toInput(original), steps: null }) !==
      JSON.stringify({ ...toInput(draft), steps: null });
  const locked = sequence?.status === "archived";
  const hasLiveEnrollments = (sequence?.stats.active ?? 0) > 0;

  const updateStep = (i: number, patch: Partial<StepDraft>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  function moveStep(i: number, dir: -1 | 1) {
    setDraft((d) => {
      const steps = [...d.steps];
      const j = i + dir;
      const a = steps[i];
      const b = steps[j];
      if (!a || !b) return d;
      steps[i] = b;
      steps[j] = a;
      return { ...d, steps };
    });
  }

  function validate(): SequenceInput | null {
    const parsed = SequenceInputSchema.safeParse(toInput(draft));
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      setFormError("Please fix the highlighted fields.");
      return null;
    }
    setErrors({});
    return parsed.data;
  }

  async function duplicate() {
    const input = validate();
    if (!input) return;
    setDuplicating(true);
    try {
      const copy = await api<SequenceDto>("/sequences", {
        method: "POST",
        body: { ...input, name: `${input.name} (copy)`.slice(0, 120) },
      });
      toast("Created a draft copy with these steps");
      router.push(`/app/sequences/${copy.id}`);
    } catch (err) {
      setFormError(errorMessage(err));
      setDuplicating(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setInUse(false);
    const input = validate();
    if (!input) return;
    setSaving(true);
    try {
      let saved: SequenceDto;
      if (sequence) {
        // Only send steps when they changed: name and send window can change on a live sequence.
        const body: SequenceInput = stepsChanged ? input : { ...input, steps: undefined };
        saved = await api<SequenceDto>(`/sequences/${sequence.id}`, { method: "PATCH", body });
        toast("Sequence saved");
        onSaved?.(saved);
      } else {
        saved = await api<SequenceDto>("/sequences", { method: "POST", body: input });
        toast("Sequence created as a draft");
        router.replace(`/app/sequences/${saved.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "sequence_in_use") {
        setInUse(true);
      } else {
        const fe = fieldErrorsFrom(err);
        setErrors(fe);
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const disabled = saving || locked;
  const stepsArrayError = errors.steps;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {formError ? (
        <Alert tone="error" title="Not saved">
          {formError}
        </Alert>
      ) : null}
      {inUse ? (
        <Alert tone="warning" title="Steps can't change while contacts are enrolled">
          <p>
            Pausing won&apos;t help — paused contacts are still enrolled. Duplicate the sequence
            instead: you get a new draft with these steps, and can enroll contacts in it.
          </p>
          {canDuplicate ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              loading={duplicating}
              onClick={() => void duplicate()}
            >
              Duplicate with these steps
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {locked ? (
        <Alert tone="info">This sequence is archived. Duplicate it to reuse its steps.</Alert>
      ) : hasLiveEnrollments ? (
        <Alert tone="info" title="Contacts are enrolled">
          You can rename it or change the send window. Steps can&apos;t change while contacts are
          enrolled — duplicate it to try new copy.
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="Settings" />
        <div className="space-y-5 p-5">
          <Field label="Sequence name" error={errors.name} required>
            {(p) => (
              <Input
                {...p}
                value={draft.name}
                disabled={disabled}
                maxLength={120}
                placeholder="e.g. Q4 outbound — operations leaders"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            )}
          </Field>

          <fieldset>
            <legend
              id={daysLabelId}
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Send window
            </legend>
            <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
              Emails only go out on these days and hours{" "}
              <strong>in each contact&apos;s own time zone</strong> (or the workspace default when a
              contact has none).
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-labelledby={daysLabelId}>
              {WEEKDAYS.map((d) => {
                const on = draft.days.includes(d.iso);
                return (
                  <button
                    key={d.iso}
                    type="button"
                    aria-pressed={on}
                    aria-label={d.long}
                    disabled={disabled}
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        days: on ? prev.days.filter((x) => x !== d.iso) : [...prev.days, d.iso],
                      }))
                    }
                    className={cx(
                      "h-10 min-w-12 rounded-lg border px-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60",
                      on
                        ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
                    )}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
            {errors.sendWindow ? (
              <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">
                {errors.sendWindow}
              </p>
            ) : null}
            {errors["sendWindow.days"] ? (
              <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">
                {draft.days.length === 0 ? "Pick at least one day" : errors["sendWindow.days"]}
              </p>
            ) : null}
            <div className="mt-4 grid max-w-md gap-4 sm:grid-cols-2">
              <Field label="From" error={errors["sendWindow.startHour"]}>
                {(p) => (
                  <Select
                    {...p}
                    value={draft.startHour}
                    disabled={disabled}
                    onChange={(e) => setDraft((d) => ({ ...d, startHour: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Until" error={errors["sendWindow.endHour"]}>
                {(p) => (
                  <Select
                    {...p}
                    value={draft.endHour}
                    disabled={disabled}
                    onChange={(e) => setDraft((d) => ({ ...d, endHour: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </fieldset>
        </div>
      </Card>

      <section aria-labelledby="steps-heading" className="space-y-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="steps-heading"
              className="text-base font-semibold text-slate-900 dark:text-white"
            >
              Steps
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Write plain text. Variables fill in per contact; add a fallback for missing data, e.g.{" "}
              <code className="font-mono text-xs">{"{{firstName|there}}"}</code> becomes “there”
              when the first name is empty. An unsubscribe link and your mailing address are added
              automatically.
            </p>
          </div>
          <p className="shrink-0 text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
            {draft.steps.length} of {MAX_STEPS} steps
          </p>
        </div>
        {stepsArrayError ? <Alert tone="error">{stepsArrayError}</Alert> : null}
        <ol className="space-y-4">
          {draft.steps.map((step, i) => (
            <StepCard
              key={step.key}
              step={step}
              index={i}
              count={draft.steps.length}
              errors={errors}
              disabled={disabled}
              onChange={(patch) => updateStep(i, patch)}
              onMove={(dir) => moveStep(i, dir)}
              onRemove={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}
            />
          ))}
        </ol>
        <Button
          variant="secondary"
          disabled={disabled || draft.steps.length >= MAX_STEPS}
          onClick={() =>
            setDraft((d) => ({ ...d, steps: [...d.steps, emptyStep(d.steps.length === 0)] }))
          }
        >
          + Add step
        </Button>
        {draft.steps.length >= MAX_STEPS ? (
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Sequences can have up to {MAX_STEPS} steps.
          </p>
        ) : null}
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-end sm:rounded-lg sm:border dark:border-slate-800 dark:bg-slate-950/95">
        {footerExtra}
        {sequence && canDuplicate ? (
          <Button
            variant="ghost"
            loading={duplicating}
            disabled={saving}
            onClick={() => void duplicate()}
            className="sm:mr-auto"
          >
            Duplicate
          </Button>
        ) : null}
        {sequence ? (
          <Button
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(draftFrom(sequence));
              setErrors({});
              setFormError(null);
            }}
          >
            Discard changes
          </Button>
        ) : (
          <Link
            href="/app/sequences"
            className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </Link>
        )}
        <Button type="submit" loading={saving} disabled={locked || (!!sequence && !dirty)}>
          {sequence ? "Save changes" : "Create sequence"}
        </Button>
      </div>
    </form>
  );
}
