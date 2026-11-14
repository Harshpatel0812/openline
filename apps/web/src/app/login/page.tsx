"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, Field, Input, LoadingBlock } from "@/components/ui";
import { api, ApiError, safeNext } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    try {
      await api("/auth/login", {
        method: "POST",
        body: { email: email.trim(), password },
        redirectOn401: false,
      });
      router.push(next);
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many sign-in attempts. Please wait a few minutes and try again.");
      } else if (err instanceof ApiError && err.code === "no_workspace") {
        setError("Your account isn't a member of any workspace. Ask a teammate for a new invite.");
      } else if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
        setError("That email and password don't match. Check them and try again.");
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field label="Email">
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
      <Field label="Password">
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={submitting}>
        Sign in
      </Button>
      <p className="text-center text-sm text-slate-600 dark:text-slate-400">
        New to Openline?{" "}
        <Link
          href="/signup"
          className="font-medium text-indigo-700 hover:underline dark:text-indigo-400"
        >
          Start a free trial
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthShell title="Sign in to Openline">
      <Suspense fallback={<LoadingBlock />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
