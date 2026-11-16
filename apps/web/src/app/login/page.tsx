"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import type { MeResponse } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, Field, Input, LoadingBlock } from "@/components/ui";
import { parsePlanParams } from "@/content/pricing";
import { api, ApiError, safeNext } from "@/lib/api";
import { afterSignIn, signupHref } from "@/lib/plan-flow";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const choice = parsePlanParams(params);
  // `next` is only honoured for paths inside the app (safeNext); a picked plan without a `next`
  // still lands on the billing page with that plan preselected.
  const next = safeNext(params.get("next"), afterSignIn(choice, "/app/contacts"));
  const notice =
    params.get("reset") === "1"
      ? "Your password was changed. Sign in with your new password."
      : null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (e.g. picked a plan on /pricing in a tab with a live session)? Go straight
  // on. The middleware never redirects /login (an expired cookie must still reach this page);
  // only a session the API confirms is followed. A stale cookie is cleared so /signup works again.
  // Sign-in waits for this check, so clearing a stale cookie can never race a fresh session.
  const sessionCheck = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    sessionCheck.current = api<MeResponse>("/auth/me", { redirectOn401: false }).then(
      () => {
        if (!cancelled) router.replace(next);
      },
      async (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          await api("/auth/logout", { method: "POST", redirectOn401: false }).catch(() => {
            // Nothing to clear, or offline: the form still works.
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [next, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    try {
      await sessionCheck.current;
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
      {notice && !error ? <Alert tone="success">{notice}</Alert> : null}
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
      <div className="-mt-1 text-right">
        <Link
          href="/forgot-password"
          className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
        >
          Forgot password?
        </Link>
      </div>
      <Button type="submit" className="w-full" loading={submitting}>
        Sign in
      </Button>
      <p className="text-center text-sm text-slate-600 dark:text-slate-400">
        New to Openline?{" "}
        <Link
          href={signupHref(choice)}
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
