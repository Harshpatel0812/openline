"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import type { PlanChoiceDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import { BillingToggle } from "@/components/site/pricing-plans";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  cx,
  LoadingBlock,
  useToast,
} from "@/components/ui";
import {
  describePlanChoice,
  formatCount,
  formatPrice,
  parsePlanParams,
  PLANS,
  type BillingPeriod,
  type PlanId,
} from "@/content/pricing";
import { api, errorMessage } from "@/lib/api";
import { daysUntil, formatDate, titleCase } from "@/lib/format";
import { BILLING_PATH } from "@/lib/plan-flow";

type Choice = { plan: PlanId; billing: BillingPeriod };

const same = (a: Choice | null, b: Choice | null) =>
  a?.plan === b?.plan && a?.billing === b?.billing;

function TrialCard() {
  const { me } = useMe();
  const { plan, trialEndsAt } = me.workspace;
  if (plan !== "trial") {
    return (
      <Card>
        <CardHeader title="Current plan" />
        <p className="p-5 text-sm">{titleCase(plan)}</p>
      </Card>
    );
  }
  const days = daysUntil(trialEndsAt);
  return (
    <Card>
      <CardHeader title="Your trial" />
      <div className="space-y-1 p-5 text-sm">
        <p className="text-base font-semibold" data-testid="trial-status">
          {days === 0
            ? "Your free trial ends today"
            : `Free trial: ${days} day${days === 1 ? "" : "s"} left`}
        </p>
        <p className="text-slate-600 dark:text-slate-400">
          Every feature is on during the trial. It ends on {formatDate(trialEndsAt)}.
        </p>
      </div>
    </Card>
  );
}

function BillingPageContent() {
  const { me, can, reload } = useMe();
  const { toast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const canEdit = can("owner", "admin");

  // Set right after a save so the page doesn't wait for /auth/me to reload.
  const [justSaved, setJustSaved] = useState<Choice | null>(null);
  const saved: Choice | null =
    justSaved ??
    (me.workspace.chosenPlan && me.workspace.chosenBilling
      ? { plan: me.workspace.chosenPlan, billing: me.workspace.chosenBilling }
      : null);
  const fromLink = parsePlanParams(params);

  // What's highlighted: the plan from the pricing link, else the saved choice. Never saved
  // automatically — the person confirms with "Save my choice".
  const [selected, setSelected] = useState<Choice | null>(fromLink ?? saved);
  const [period, setPeriod] = useState<BillingPeriod>(
    fromLink?.billing ?? saved?.billing ?? "monthly",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = selected !== null && !same(selected, saved);

  function pick(plan: PlanId) {
    setError(null);
    setSelected({ plan, billing: period });
  }

  function changePeriod(billing: BillingPeriod) {
    setPeriod(billing);
    setSelected((s) => (s ? { ...s, billing } : s));
  }

  function discard() {
    setSelected(saved);
    setPeriod(saved?.billing ?? period);
    setError(null);
    if (fromLink) router.replace(BILLING_PATH);
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<PlanChoiceDto>("/workspace/plan-choice", {
        method: "PUT",
        body: selected,
      });
      setJustSaved({ plan: result.chosenPlan, billing: result.chosenBilling });
      toast(`Saved: ${describePlanChoice(selected.plan, selected.billing)}`);
      if (fromLink) router.replace(BILLING_PATH);
      // The header badge shows the chosen plan.
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Plan & billing"
        description="Your trial, and the plan you'd like when it ends."
      />
      <div className="space-y-6">
        <Alert tone="info">
          Payments aren&apos;t switched on yet — you won&apos;t be charged. We&apos;ll ask you to
          confirm before your trial ends.
        </Alert>

        <div className="grid gap-6 md:grid-cols-2">
          <TrialCard />
          <Card>
            <CardHeader title="Chosen plan" />
            <div className="p-5 text-sm">
              {saved ? (
                <p className="text-base font-semibold" data-testid="chosen-plan">
                  {describePlanChoice(saved.plan, saved.billing)}
                </p>
              ) : (
                <p className="text-base font-semibold" data-testid="chosen-plan">
                  No plan chosen yet
                </p>
              )}
              <p className="mt-1 text-slate-600 dark:text-slate-400">
                {saved
                  ? "You can change it any time before your trial ends."
                  : "Pick the plan you'd like after the trial. Every plan has every feature; CRM sync starts on Team."}
              </p>
            </div>
          </Card>
        </div>

        {!canEdit ? (
          <Alert tone="info">
            Only workspace owners and admins can choose the plan. You can see the options below.
          </Alert>
        ) : null}

        {pending && selected ? (
          <section
            aria-labelledby="confirm-plan-heading"
            data-testid="confirm-plan"
            className="rounded-lg border border-indigo-300 bg-indigo-50 p-4 dark:border-indigo-700 dark:bg-indigo-950/60"
          >
            <h2 id="confirm-plan-heading" className="text-sm font-semibold">
              {fromLink && same(selected, fromLink)
                ? "You picked this plan on the pricing page"
                : "Confirm your plan choice"}
            </h2>
            <p className="mt-1 text-sm">
              <strong>{describePlanChoice(selected.plan, selected.billing)}</strong>. You won&apos;t
              be charged now.
            </p>
            {error ? (
              <Alert tone="error" className="mt-3">
                {error}
              </Alert>
            ) : null}
            {canEdit ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" loading={saving} onClick={() => void save()}>
                  Save my choice
                </Button>
                <Button size="sm" variant="secondary" disabled={saving} onClick={discard}>
                  {saved ? "Keep my current choice" : "Not now"}
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
                Ask a workspace owner or admin to save this plan.
              </p>
            )}
          </section>
        ) : null}

        <section aria-labelledby="plans-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 id="plans-heading" className="text-lg font-semibold">
              Plans
            </h2>
            <BillingToggle value={period} onChange={changePeriod} />
          </div>
          <ul className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {PLANS.map((plan) => {
              const price = period === "monthly" ? plan.monthly : plan.annual;
              const isSelected = selected?.plan === plan.id;
              const isSaved = saved?.plan === plan.id && saved.billing === period;
              return (
                <li
                  key={plan.id}
                  aria-labelledby={`billing-plan-${plan.id}`}
                  data-testid={`billing-plan-${plan.id}`}
                  className={cx(
                    "flex flex-col rounded-lg border bg-white p-5 dark:bg-slate-900",
                    isSelected
                      ? "border-indigo-600 ring-1 ring-indigo-600 dark:border-indigo-400 dark:ring-indigo-400"
                      : "border-slate-200 dark:border-slate-800",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 id={`billing-plan-${plan.id}`} className="font-semibold">
                      {plan.name}
                    </h3>
                    {isSaved ? <Badge tone="success">Your choice</Badge> : null}
                  </div>
                  <p className="mt-3 flex items-baseline gap-1">
                    <span className="text-3xl font-semibold tracking-tight">
                      {formatPrice(price)}
                    </span>
                    <span className="text-sm text-slate-600 dark:text-slate-400">/ month</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                    {period === "annual"
                      ? `Billed annually · ${formatPrice(plan.monthly)} if paid monthly`
                      : "Billed monthly · flat price for the team"}
                  </p>
                  <ul className="mt-4 flex-1 space-y-1 text-sm text-slate-700 dark:text-slate-300">
                    <li>
                      {formatCount(plan.users)} {plan.users === 1 ? "user" : "users"}
                    </li>
                    <li>{formatCount(plan.mailboxes)} mailboxes</li>
                    <li>{formatCount(plan.contacts)} contacts</li>
                    <li>{formatCount(plan.emailsPerDay)} cold emails a day</li>
                  </ul>
                  <Button
                    size="sm"
                    variant={isSelected ? "primary" : "secondary"}
                    className="mt-4 w-full"
                    disabled={!canEdit || saving}
                    aria-pressed={isSelected}
                    onClick={() => pick(plan.id)}
                  >
                    {isSelected ? `${plan.name} selected` : `Choose ${plan.name}`}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

export default function BillingSettingsPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading plan and billing" />}>
      <BillingPageContent />
    </Suspense>
  );
}
