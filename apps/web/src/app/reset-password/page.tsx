"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { PasswordSchema } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, Field, Input, LoadingBlock } from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [expired, setExpired] = useState(!token);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: Record<string, string> = {};
    const parsed = PasswordSchema.safeParse(password);
    if (!parsed.success) next.password = parsed.error.issues[0]?.message ?? "Invalid password";
    if (confirm !== password) next.confirm = "The passwords don't match";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSubmitting(true);
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: { token, password },
        redirectOn401: false,
      });
      router.push("/login?reset=1");
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.code === "token_invalid") {
        setExpired(true);
        return;
      }
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      setFormError(
        Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
      );
    }
  }

  if (expired) {
    return (
      <div className="space-y-4">
        <Alert tone="warning" title="This link is expired or invalid">
          Reset links work once and expire after 1 hour.
        </Alert>
        <Link
          href="/forgot-password"
          className="block text-center text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {formError ? <Alert tone="error">{formError}</Alert> : null}
      <Field
        label="New password"
        hint="At least 12 characters. A long passphrase is best."
        error={errors.password}
        required
      >
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
      </Field>
      <Field label="Confirm new password" error={errors.confirm} required>
        {(p) => (
          <Input
            {...p}
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        )}
      </Field>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Saving signs you out everywhere, including other devices.
      </p>
      <Button type="submit" className="w-full" loading={submitting}>
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell title="Choose a new password">
      <Suspense fallback={<LoadingBlock />}>
        <ResetForm />
      </Suspense>
    </AuthShell>
  );
}
