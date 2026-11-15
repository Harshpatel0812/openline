"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ScoutSettingsInputSchema, type ScoutSettingsDto } from "@openline/shared";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cx,
  Field,
  Input,
  LoadingBlock,
  Textarea,
  useToast,
} from "@/components/ui";
import { api, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { zodFieldErrors } from "@/lib/format";
import { formatDay } from "@/lib/labels";
import { useResource } from "@/lib/use-resource";

interface Values {
  enabled: boolean;
  monthlyCredits: string;
  webResearch: boolean;
  aboutUs: string;
  valueProposition: string;
}

const fromDto = (s: ScoutSettingsDto): Values => ({
  enabled: s.enabled,
  monthlyCredits: String(s.monthlyCredits),
  webResearch: s.webResearch,
  aboutUs: s.aboutUs ?? "",
  valueProposition: s.valueProposition ?? "",
});

function UsageMeter({ settings }: { settings: ScoutSettingsDto }) {
  const { usage, monthlyCredits } = settings;
  const pct =
    monthlyCredits > 0
      ? Math.min(100, Math.round((usage.creditsUsed / monthlyCredits) * 100))
      : 100;
  const tone = pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-indigo-600";
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Usage this month</p>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          <span className="font-semibold">{usage.creditsUsed.toLocaleString()}</span> of{" "}
          {monthlyCredits.toLocaleString()} credits
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Scout credits used this month"
        aria-valuemin={0}
        aria-valuemax={Math.max(monthlyCredits, 1)}
        aria-valuenow={Math.min(usage.creditsUsed, Math.max(monthlyCredits, 1))}
        aria-valuetext={`${usage.creditsUsed} of ${monthlyCredits} credits used`}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
      >
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        {usage.creditsRemaining.toLocaleString()} left · resets {formatDay(usage.resetsAt)}. One
        credit is 1,000 tokens — roughly 750 words of AI reading and writing. Drafts, and
        classifying replies, use credits; everything else is free.
      </p>
    </div>
  );
}

/** Workspace settings → Scout (GET/PATCH /workspace/scout). Owners and admins edit. */
export function ScoutSettingsCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const { data, error, loading, reload, setData } =
    useResource<ScoutSettingsDto>("/workspace/scout");
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setValues(fromDto(data));
  }, [data]);

  if (loading && !data) {
    return (
      <Card id="scout" className="max-w-2xl">
        <CardHeader title="Scout" />
        <LoadingBlock label="Loading Scout settings" />
      </Card>
    );
  }
  if (error || !data || !values) {
    return (
      <Card id="scout" className="max-w-2xl">
        <CardHeader title="Scout" />
        <div className="space-y-3 p-5">
          <Alert tone="error" title="Couldn't load Scout settings">
            {errorMessage(error)}
          </Alert>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  const dirty = JSON.stringify(values) !== JSON.stringify(fromDto(data));
  const disabled = !canEdit || saving;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    setFormError(null);
    const parsed = ScoutSettingsInputSchema.safeParse({
      enabled: values.enabled,
      monthlyCredits: values.monthlyCredits,
      webResearch: values.webResearch,
      aboutUs: values.aboutUs,
      valueProposition: values.valueProposition,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const updated = await api<ScoutSettingsDto>("/workspace/scout", {
        method: "PATCH",
        // Empty text clears a field ("" in the API contract).
        body: {
          ...parsed.data,
          aboutUs: parsed.data.aboutUs ?? "",
          valueProposition: parsed.data.valueProposition ?? "",
        },
      });
      setData(() => updated);
      toast("Scout settings saved");
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      setFormError(
        Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev));

  return (
    <Card id="scout" className="max-w-2xl scroll-mt-20">
      <CardHeader
        title="Scout"
        description="Openline's AI assistant. It drafts emails and replies for you to review — it never sends anything on its own."
      />
      <form onSubmit={onSubmit} noValidate className="space-y-5 p-5">
        {!data.providerConfigured ? (
          <Alert tone="warning" title="No AI model is set up on this server">
            Scout can&apos;t draft or classify replies until an AI provider is configured. Replies
            are still labelled with simple rules (shown as “(rule)”). You can save these settings
            now; they apply once a model is available.
          </Alert>
        ) : !data.available ? (
          <Alert tone="info">Scout is turned off. Replies are labelled with simple rules.</Alert>
        ) : null}
        {!canEdit ? (
          <Alert tone="info">Only workspace owners and admins can change Scout settings.</Alert>
        ) : null}
        {formError ? <Alert tone="error">{formError}</Alert> : null}

        <UsageMeter settings={data} />

        <Checkbox
          label="Turn on Scout for this workspace"
          description="Drafts in the sequence editor and inbox, and AI labels for replies."
          checked={values.enabled}
          disabled={disabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        <Checkbox
          label="Let Scout read company websites"
          description="Up to 3 public pages of a contact's company site, cached for 7 days, so drafts can mention real facts — each one cited."
          checked={values.webResearch}
          disabled={disabled}
          onChange={(e) => set("webResearch", e.target.checked)}
        />
        <Field
          label="Monthly budget (credits)"
          hint="When it runs out, Scout stops until the 1st of next month (UTC). Default 2,000."
          error={errors.monthlyCredits}
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              value={values.monthlyCredits}
              disabled={disabled}
              onChange={(e) => set("monthlyCredits", e.target.value)}
              className="max-w-[12rem]"
            />
          )}
        </Field>
        <Field
          label="About us"
          hint="What your company does, in a few sentences. Scout only claims what's written here about you."
          error={errors.aboutUs}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              maxLength={2_000}
              value={values.aboutUs}
              disabled={disabled}
              placeholder="e.g. Acme makes inventory software for mid-size warehouses in North America."
              onChange={(e) => set("aboutUs", e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Value proposition"
          hint="Why customers buy from you — the outcome, ideally with a number you can back up."
          error={errors.valueProposition}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              maxLength={1_000}
              value={values.valueProposition}
              disabled={disabled}
              placeholder="e.g. Customers cut stock-outs by a third in their first quarter."
              onChange={(e) => set("valueProposition", e.target.value)}
            />
          )}
        </Field>

        {canEdit ? (
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="secondary"
              disabled={!dirty || saving}
              onClick={() => {
                setValues(fromDto(data));
                setErrors({});
                setFormError(null);
              }}
            >
              Discard changes
            </Button>
            <Button type="submit" loading={saving} disabled={!dirty}>
              Save Scout settings
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
