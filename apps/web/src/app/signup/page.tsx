"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { SignupInputSchema } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, Field, Input, LoadingBlock } from "@/components/ui";
import { describePlanChoice, parsePlanParams, planQuery } from "@/content/pricing";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { zodFieldErrors } from "@/lib/format";
import { BILLING_PATH, loginHref, type PlanChoice } from "@/lib/plan-flow";

type Fields = "name" | "email" | "password" | "workspaceName";

/** What the visitor picked on /pricing, so they can see it carried over. */
function PlanSummary({ choice }: { choice: NonNullable<PlanChoice> }) {
  return (
    <section
      aria-labelledby="plan-summary-heading"
      data-testid="plan-summary"
      className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-100"
    >
      <h2 id="plan-summary-heading" className="font-semibold">
        You&apos;re starting a free 14-day trial.
      </h2>
      <p className="mt-1">
        Plan you picked:{" "}
        <strong className="font-semibold">{describePlanChoice(choice.plan, choice.billing)}</strong>
        .
      </p>
      <p className="mt-1 text-indigo-900/80 dark:text-indigo-200/80">
        You won&apos;t be charged during the trial; you&apos;ll confirm before any payment.
      </p>
      <Link
        href={`/pricing${planQuery(choice)}`}
        className="mt-2 inline-block font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
      >
        Change plan
      </Link>
    </section>
  );
}

function SignupForm() {
  const router = useRouter();
  const choice = parsePlanParams(useSearchParams());
  const [values, setValues] = useState<Record<Fields, string>>({
    name: "",
    email: "",
    password: "",
    workspaceName: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = SignupInputSchema.safeParse(
      choice ? { ...values, plan: choice.plan, billing: choice.billing } : values,
    );
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await api("/auth/signup", { method: "POST", body: parsed.data, redirectOn401: false });
      // The plan is saved with the workspace: show it on the billing page; otherwise start working.
      router.push(choice ? BILLING_PATH : "/app/contacts");
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.code === "email_taken") {
        setErrors({ email: "An account with this email already exists." });
        setFormError(
          <>
            This email already has an Openline account.{" "}
            <Link href={loginHref(choice)} className="font-medium underline">
              Sign in instead
            </Link>
            .
          </>,
        );
        return;
      }
      const fieldErrors = fieldErrorsFrom(err);
      setErrors(fieldErrors);
      setFormError(
        Object.keys(fieldErrors).length > 0
          ? "Please fix the highlighted fields."
          : errorMessage(err),
      );
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {choice ? <PlanSummary choice={choice} /> : null}
      {formError ? <Alert tone="error">{formError}</Alert> : null}
      <Field label="Your name" error={errors.name} required>
        {(p) => (
          <Input
            {...p}
            name="name"
            autoComplete="name"
            value={values.name}
            onChange={set("name")}
            required
          />
        )}
      </Field>
      <Field label="Work email" error={errors.email} required>
        {(p) => (
          <Input
            {...p}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={values.email}
            onChange={set("email")}
            required
          />
        )}
      </Field>
      <Field label="Password" hint="At least 12 characters" error={errors.password} required>
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={values.password}
            onChange={set("password")}
            required
          />
        )}
      </Field>
      <Field
        label="Workspace name"
        hint="Usually your company name"
        error={errors.workspaceName}
        required
      >
        {(p) => (
          <Input
            {...p}
            name="workspaceName"
            autoComplete="organization"
            value={values.workspaceName}
            onChange={set("workspaceName")}
            required
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={submitting}>
        Create workspace
      </Button>
      <p className="text-center text-sm text-slate-600 dark:text-slate-400">
        Already have an account?{" "}
        <Link
          href={loginHref(choice)}
          className="font-medium text-indigo-700 hover:underline dark:text-indigo-400"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <AuthShell title="Start your free trial" subtitle="Set up your workspace in under a minute.">
      <Suspense fallback={<LoadingBlock />}>
        <SignupForm />
      </Suspense>
    </AuthShell>
  );
}
