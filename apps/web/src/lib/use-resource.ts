"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ApiOptions } from "./api";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (updater: (prev: T | undefined) => T | undefined) => void;
}

/** Loads a GET endpoint; pass `null` as path to skip loading. */
export function useResource<T>(path: string | null, query?: ApiOptions["query"]): Resource<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const queryKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    api<T>(path, {
      query: JSON.parse(queryKey) as ApiOptions["query"],
      signal: controller.signal,
    })
      .then((result) => {
        setDataState(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, queryKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (updater: (prev: T | undefined) => T | undefined) => setDataState(updater),
    [],
  );

  return { data, error, loading, reload, setData };
}

/** Returns `value` after it has stopped changing for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
