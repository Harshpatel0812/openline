"use client";

import Link from "next/link";
import { useState } from "react";
import { buttonClasses, cx } from "@/components/ui";
import { formatCount, formatPrice, PLANS, type BillingPeriod } from "@/content/pricing";
import { CheckIcon } from "./blocks";

function BillingToggle({
  value,
  onChange,
}: {
  value: BillingPeriod;
  onChange: (v: BillingPeriod) => void;
}) {
  const options: { id: BillingPeriod; label: string }[] = [
    { id: "monthly", label: "Monthly" },
    { id: "annual", label: "Annual (2 months free)" },
  ];
  return (
    <fieldset className="inline-flex rounded-full border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
      <legend className="sr-only">Billing period</legend>
      {options.map((opt) => (
        <label
          key={opt.id}
          className={cx(
            "cursor-pointer rounded-full px-4 py-2 text-sm font-medium focus-within:ring-2 focus-within:ring-indigo-600 focus-within:ring-offset-2",
            value === opt.id
              ? "bg-indigo-600 text-white"
              : "text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white",
          )}
        >
          <input
            type="radio"
            name="billing"
            value={opt.id}
            checked={value === opt.id}
            onChange={() => onChange(opt.id)}
            className="sr-only"
          />
          {opt.label}
        </label>
      ))}
    </fieldset>
  );
}

export function PricingPlans() {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  return (
    <div>
      <div className="flex justify-center">
        <BillingToggle value={period} onChange={setPeriod} />
      </div>
      <ul className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {PLANS.map((plan) => {
          const price = period === "monthly" ? plan.monthly : plan.annual;
          return (
            <li
              key={plan.id}
              aria-labelledby={`plan-${plan.id}`}
              className={cx(
                "relative flex flex-col rounded-2xl border bg-white p-6 dark:bg-slate-900",
                plan.popular
                  ? "border-indigo-600 shadow-lg ring-1 ring-indigo-600 dark:border-indigo-400 dark:ring-indigo-400"
                  : "border-slate-200 dark:border-slate-800",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 id={`plan-${plan.id}`} className="text-lg font-semibold">
                  {plan.name}
                </h3>
                {plan.popular ? (
                  <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200">
                    Most popular
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{plan.summary}</p>
              <p className="mt-6 flex items-baseline gap-1">
                <span
                  className="text-4xl font-semibold tracking-tight"
                  data-testid={`price-${plan.id}`}
                >
                  {formatPrice(price)}
                </span>
                <span className="text-sm text-slate-600 dark:text-slate-400">/ month</span>
              </p>
              <p className="mt-1 h-5 text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
                {period === "annual"
                  ? `Billed annually · ${formatPrice(plan.monthly)} if paid monthly`
                  : "Billed monthly · flat price for the team"}
              </p>
              <Link
                href="/signup"
                className={cx(
                  buttonClasses(plan.popular ? "primary" : "secondary", "md"),
                  "mt-6 w-full",
                )}
              >
                Start free trial
              </Link>
              <ul className="mt-6 space-y-3 text-sm">
                {[
                  `${formatCount(plan.users)} ${plan.users === 1 ? "user" : "users"}`,
                  `${formatCount(plan.mailboxes)} mailboxes`,
                  `${formatCount(plan.contacts)} contacts`,
                  `${formatCount(plan.emailsPerDay)} cold emails a day`,
                  "Every feature, including Scout",
                  plan.support,
                ].map((line) => (
                  <li key={line} className="flex gap-2">
                    <CheckIcon />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
