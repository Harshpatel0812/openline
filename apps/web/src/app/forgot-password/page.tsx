"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ForgotPasswordInputSchema } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, Field, Input } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = ForgotPasswordInputSchema.safeParse({ email });
    if (!parsed.success) {
      setError("Enter a valid email address");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api("/auth/forgot-password", {
        method: "POST",
        body: parsed.data,
        redirectOn401: false,
      });
      setSent(true);
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 429
          ? "Too many requests. Please wait a few minutes and try again."
          : errorMessage(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle={sent ? undefined : "Enter your account email and we'll send you a reset link."}
    >
      {sent ? (
        <div className="space-y-4">
          <Alert tone="success" title="Check your inbox">
            If an account exists for {email.trim()}, we&apos;ve sent a link to reset your password.
            It expires in 1 hour.
          </Alert>
          <Link
            href="/login"
            className="block text-center text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <Field label="Email" error={error ?? undefined} required>
            {(p) => (
              <Input
                {...p}
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Button type="submit" className="w-full" loading={submitting}>
            Send reset link
          </Button>
          <p className="text-center text-sm text-slate-600 dark:text-slate-400">
            Remembered it?{" "}
            <Link
              href="/login"
              className="font-medium text-indigo-700 hover:underline dark:text-indigo-400"
            >
              Sign in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
