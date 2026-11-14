"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Button, LoadingBlock } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";

interface UnsubscribeLookup {
  email: string;
  workspaceName: string;
  alreadyUnsubscribed: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "error"; message: string }
  | { kind: "confirm"; data: UnsubscribeLookup }
  | { kind: "done"; data: UnsubscribeLookup };

/**
 * Public unsubscribe page linked from every outreach email footer. No session, no app shell:
 * the person receiving the email is not an Openline user.
 */
export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api<UnsubscribeLookup>(`/public/unsubscribe/${encodeURIComponent(token)}`, {
      redirectOn401: false,
    })
      .then((data) => {
        if (cancelled) return;
        setState(data.alreadyUnsubscribed ? { kind: "done", data } : { kind: "confirm", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
          setState({ kind: "invalid" });
        } else {
          setState({ kind: "error", message: errorMessage(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, nonce]);

  async function confirm(data: UnsubscribeLookup) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api(`/public/unsubscribe/${encodeURIComponent(token)}`, {
        method: "POST",
        body: {},
        redirectOn401: false,
      });
      setState({ kind: "done", data });
    } catch (err) {
      setSubmitError(
        err instanceof ApiError && err.status === 404
          ? "This link is invalid or expired."
          : errorMessage(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  let content: React.ReactNode;
  switch (state.kind) {
    case "loading":
      content = <LoadingBlock label="Loading" />;
      break;
    case "invalid":
      content = (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Link not valid</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            This link is invalid or expired. If you keep getting emails you don&apos;t want, reply
            to one of them and ask the sender to stop.
          </p>
        </>
      );
      break;
    case "error":
      content = (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
          <Alert tone="error" className="mt-4">
            {state.message}
          </Alert>
          <Button
            variant="secondary"
            className="mt-4 w-full"
            onClick={() => setNonce((n) => n + 1)}
          >
            Try again
          </Button>
        </>
      );
      break;
    case "confirm":
      content = (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Unsubscribe?</h1>
          <p className="mt-2 text-base text-slate-700 dark:text-slate-300">
            Unsubscribe <strong className="font-semibold break-all">{state.data.email}</strong> from
            emails sent by <strong className="font-semibold">{state.data.workspaceName}</strong>?
          </p>
          {submitError ? (
            <Alert tone="error" className="mt-4">
              {submitError}
            </Alert>
          ) : null}
          <Button
            size="lg"
            className="mt-6 w-full"
            loading={submitting}
            onClick={() => void confirm(state.data)}
          >
            Unsubscribe
          </Button>
        </>
      );
      break;
    case "done":
      content = (
        <div role="status">
          <h1 className="text-xl font-semibold tracking-tight">You&apos;re unsubscribed</h1>
          <p className="mt-2 text-base text-slate-700 dark:text-slate-300">
            You won&apos;t receive more emails from{" "}
            <strong className="font-semibold">{state.data.workspaceName}</strong> at{" "}
            <span className="break-all">{state.data.email}</span>.
          </p>
        </div>
      );
      break;
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10 sm:py-20">
      <main
        id="main"
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xs sm:p-8 dark:border-slate-800 dark:bg-slate-900"
      >
        {content}
      </main>
      <p className="mt-6 text-center text-xs text-slate-600 dark:text-slate-400">
        Unsubscribe handled by Openline on behalf of the sender.
      </p>
    </div>
  );
}
