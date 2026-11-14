"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { MeResponse, Role } from "@openline/shared";
import { api, ApiError, errorMessage, loginUrl } from "@/lib/api";
import { Alert, Button, LoadingBlock } from "@/components/ui";

interface MeContextValue {
  me: MeResponse;
  reload: () => void;
  /** True when the current role is one of `roles`. UI hint only; the API enforces roles. */
  can: (...roles: Role[]) => boolean;
}

const MeContext = createContext<MeContextValue | null>(null);

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used inside <MeProvider>");
  return ctx;
}

/** Loads /auth/me once for the whole app shell. Redirects to /login on 401. */
export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<MeResponse>("/auth/me", { redirectOn401: false })
      .then((data) => !cancelled && setMe(data))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.assign(loginUrl());
          return;
        }
        setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  if (error) {
    return (
      <main id="main" className="mx-auto max-w-md px-4 py-24">
        <Alert tone="error" title="We couldn't load your workspace">
          {errorMessage(error)}
        </Alert>
        <Button variant="secondary" className="mt-4" onClick={reload}>
          Try again
        </Button>
      </main>
    );
  }
  if (!me) {
    return (
      <main id="main" className="py-24">
        <LoadingBlock label="Loading your workspace" />
      </main>
    );
  }

  const can = (...roles: Role[]) => roles.includes(me.role);
  return <MeContext.Provider value={{ me, reload, can }}>{children}</MeContext.Provider>;
}
