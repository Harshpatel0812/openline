"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import type { MeResponse } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import { Alert, Button, buttonClasses, LoadingBlock } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";

type State = "verifying" | "verified" | "invalid" | "error";

function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>(token ? "verifying" : "invalid");
  const [error, setError] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const started = useRef(false);

  useEffect(() => {
    // Strict mode runs effects twice in dev; a token is single use, so only send it once.
    if (!token || started.current) return;
    started.current = true;
    api("/auth/verify-email", { method: "POST", body: { token }, redirectOn401: false })
      .then(() => setState("verified"))
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 410 || err.status === 400)) {
          setState("invalid");
        } else {
          setError(errorMessage(err));
          setState("error");
        }
      });
  }, [token]);

  useEffect(() => {
    if (state !== "invalid") return;
    api<MeResponse>("/auth/me", { redirectOn401: false })
      .then((me) => setCanResend(!me.user.emailVerified))
      .catch(() => setCanResend(false));
  }, [state]);

  async function resend() {
    setResending(true);
    setResendMessage(undefined);
    try {
      await api("/auth/resend-verification", { method: "POST", redirectOn401: false });
      setResendMessage({ tone: "success", text: "We've sent a new link. Check your inbox." });
    } catch (err) {
      setResendMessage({
        tone: "error",
        text:
          err instanceof ApiError && err.status === 429
            ? "You've asked for several emails already. Please wait an hour and try again."
            : errorMessage(err),
      });
    } finally {
      setResending(false);
    }
  }

  if (state === "verifying") return <LoadingBlock label="Verifying your email" />;

  if (state === "verified") {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your email is verified">
          You can now connect a mailbox and start sequences.
        </Alert>
        <Link href="/app" className={buttonClasses("primary") + " w-full"}>
          Continue to Openline
        </Link>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="space-y-4">
        <Alert tone="error" title="We couldn't verify your email">
          {error}
        </Alert>
        <Button variant="secondary" className="w-full" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Alert tone="warning" title="This link is expired or invalid">
        Verification links work once and expire after 24 hours.
      </Alert>
      {resendMessage ? <Alert tone={resendMessage.tone}>{resendMessage.text}</Alert> : null}
      {canResend ? (
        <Button className="w-full" loading={resending} onClick={() => void resend()}>
          Send a new link
        </Button>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          <Link
            href="/login?next=%2Fapp"
            className="font-medium text-indigo-700 hover:underline dark:text-indigo-400"
          >
            Sign in
          </Link>{" "}
          to get a new verification link.
        </p>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthShell title="Verify your email">
      <Suspense fallback={<LoadingBlock />}>
        <VerifyEmail />
      </Suspense>
    </AuthShell>
  );
}
