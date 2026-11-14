"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SignupInputSchema } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, Field, Input } from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { zodFieldErrors } from "@/lib/format";

type Fields = "name" | "email" | "password" | "workspaceName";

export default function SignupPage() {
  const router = useRouter();
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
    const parsed = SignupInputSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await api("/auth/signup", { method: "POST", body: parsed.data, redirectOn401: false });
      router.push("/app/contacts");
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.code === "email_taken") {
        setErrors({ email: "An account with this email already exists." });
        setFormError(
          <>
            This email already has an Openline account.{" "}
            <Link href="/login" className="font-medium underline">
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
    <AuthShell title="Start your free trial" subtitle="Set up your workspace in under a minute.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
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
            href="/login"
            className="font-medium text-indigo-700 hover:underline dark:text-indigo-400"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
