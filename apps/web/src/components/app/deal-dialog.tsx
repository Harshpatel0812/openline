"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  CreateDealInputSchema,
  PIPELINE_LIMITS,
  toMinorUnits,
  type DealDetailDto,
  type MemberDto,
  type PipelineStageDto,
  type WorkspaceSettingsDto,
} from "@openline/shared";
import { Alert, Button, Dialog, Field, Input, Select } from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { currencyOptions, notifyDealsChanged, stageOrder } from "@/lib/deals";
import { zodFieldErrors } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { useMe } from "./me-context";
import { ContactPicker, type PickedContact } from "./task-dialog";

export interface DealPrefill {
  name?: string;
  contact?: PickedContact | null;
  company?: { id: string; name: string } | null;
  stageId?: string;
}

/** "New deal": name, contact, company, stage, amount + currency, dates, next step, owner. */
export function DealDialog({
  open,
  onClose,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  prefill?: DealPrefill;
  onCreated: (deal: DealDetailDto) => void;
}) {
  const { me, can } = useMe();
  const isManager = can("owner", "admin", "manager");
  const stages = useResource<PipelineStageDto[]>(open ? "/pipeline/stages" : null);
  const workspace = useResource<WorkspaceSettingsDto>(open ? "/workspace" : null);
  const members = useResource<MemberDto[]>(open && isManager ? "/members" : null);
  const formId = useId();
  const [name, setName] = useState("");
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [stageId, setStageId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [nextStepDate, setNextStepDate] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  useEffect(() => {
    if (!open) return;
    const p = prefillRef.current;
    setName(p?.name ?? "");
    setContact(p?.contact ?? null);
    setCompany(p?.company ?? p?.contact?.company ?? null);
    setStageId(p?.stageId ?? "");
    setAmount("");
    setCurrency("");
    setCloseDate("");
    setNextStep("");
    setNextStepDate("");
    setOwnerId(me.user.id);
    setErrors({});
    setFormError(null);
  }, [open, me.user.id]);

  const openStages = stageOrder(stages.data ?? []).filter((s) => s.kind === "open");
  const effectiveCurrency = currency || workspace.data?.currency || "USD";
  const effectiveStage = stageId || openStages[0]?.id || "";

  function pickContact(c: PickedContact | null) {
    setContact(c);
    // Follow the contact's company unless one was chosen on purpose (company page).
    if (!prefillRef.current?.company) setCompany(c?.company ?? null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const local: Record<string, string> = {};
    let amountMinor: number | null = null;
    if (amount.trim()) {
      amountMinor = toMinorUnits(amount, effectiveCurrency);
      if (amountMinor === null) {
        local.amountMinor = "Enter an amount like 12500 or 12500.50";
      }
    }
    if (nextStepDate && !nextStep.trim()) local.nextStep = "Describe the next step for this date";
    const body = {
      name,
      companyId: company?.id,
      primaryContactId: contact?.id,
      stageId: effectiveStage || undefined,
      amountMinor: amountMinor ?? undefined,
      currency: effectiveCurrency,
      expectedCloseDate: closeDate || undefined,
      nextStep: nextStep.trim() || undefined,
      nextStepDate: nextStepDate || undefined,
      ownerId: isManager && ownerId && ownerId !== me.user.id ? ownerId : undefined,
    };
    const parsed = CreateDealInputSchema.safeParse(body);
    const zErrors = parsed.success ? {} : zodFieldErrors(parsed.error.issues);
    const all = { ...zErrors, ...local };
    if (Object.keys(all).length || !parsed.success) {
      setErrors(all);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const deal = await api<DealDetailDto>("/deals", { method: "POST", body: parsed.data });
      notifyDealsChanged();
      onCreated(deal);
      onClose();
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      setFormError(
        err instanceof ApiError && err.status === 404
          ? "A contact, company or teammate on this deal no longer exists. Pick again."
          : Object.keys(fe).length
            ? "Please fix the highlighted fields."
            : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New deal"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Create deal
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {stages.error ? (
          <Alert tone="error">Couldn&apos;t load the pipeline: {errorMessage(stages.error)}</Alert>
        ) : null}
        <Field label="Deal name" error={errors.name} required>
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={PIPELINE_LIMITS.dealName}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Tools — annual plan"
              autoFocus
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Stage" error={errors.stageId}>
            {(p) => (
              <Select
                {...p}
                value={effectiveStage}
                disabled={saving || stages.loading}
                onChange={(e) => setStageId(e.target.value)}
              >
                {openStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.probability}%)
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {isManager ? (
            <Field label="Owner" error={errors.ownerId}>
              {(p) => (
                <Select
                  {...p}
                  value={ownerId}
                  disabled={saving || members.loading}
                  onChange={(e) => setOwnerId(e.target.value)}
                >
                  {(members.data ?? [{ userId: me.user.id, name: me.user.name }]).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.userId === me.user.id ? `${m.name} (you)` : m.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field
            label="Amount (optional)"
            error={errors.amountMinor}
            hint="Whole amount, e.g. 12500 or 12500.50."
          >
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={amount}
                disabled={saving}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label="Currency" error={errors.currency}>
            {(p) => (
              <Select
                {...p}
                value={effectiveCurrency}
                disabled={saving}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencyOptions(effectiveCurrency).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Expected close date (optional)" error={errors.expectedCloseDate}>
          {(p) => (
            <Input
              {...p}
              type="date"
              value={closeDate}
              disabled={saving}
              onChange={(e) => setCloseDate(e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Next step (optional)" error={errors.nextStep}>
            {(p) => (
              <Input
                {...p}
                value={nextStep}
                maxLength={PIPELINE_LIMITS.nextStep}
                disabled={saving}
                onChange={(e) => setNextStep(e.target.value)}
                placeholder="Demo with their ops lead"
              />
            )}
          </Field>
          <Field label="Next step date" error={errors.nextStepDate}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={nextStepDate}
                disabled={saving}
                onChange={(e) => setNextStepDate(e.target.value)}
              />
            )}
          </Field>
        </div>
        <ContactPicker
          value={contact}
          onChange={pickContact}
          disabled={saving}
          error={errors.primaryContactId}
          legend="Primary contact (optional)"
          hint="Emails with this contact count as deal activity."
        />
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Company: <strong>{company?.name ?? "None"}</strong>
          {company && !prefill?.company ? (
            <>
              {" "}
              <button
                type="button"
                disabled={saving}
                onClick={() => setCompany(null)}
                className="rounded font-medium text-indigo-700 underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
              >
                Remove company
              </button>
            </>
          ) : null}
        </p>
      </form>
    </Dialog>
  );
}
