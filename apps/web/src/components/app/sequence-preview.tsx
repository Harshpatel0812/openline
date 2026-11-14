"use client";

import { useEffect, useId, useState } from "react";
import type { ContactDto, ContactListDto } from "@openline/shared";
import { Alert, Button, Card, CardHeader, cx, Input, LoadingBlock, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { contactName } from "@/lib/format";
import { useDebounced } from "@/lib/use-resource";

interface PreviewStep {
  position: number;
  subject: string;
  text: string;
  html: string;
}

/** Small contact search used to preview a sequence with a real contact's data. */
function ContactPicker({
  selected,
  onSelect,
}: {
  selected: ContactDto | null;
  onSelect: (c: ContactDto | null) => void;
}) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 250);
  const [results, setResults] = useState<ContactDto[]>([]);
  const [loading, setLoading] = useState(false);
  const inputId = useId();
  const listId = useId();

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api<ContactListDto>("/contacts", {
      query: { q: debounced, limit: 6 },
      signal: controller.signal,
    })
      .then((r) => {
        setResults(r.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setResults([]);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debounced]);

  if (selected) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-600 dark:text-slate-400">Previewing as</span>
        <span className="font-medium">{contactName(selected)}</span>
        <span className="text-slate-600 dark:text-slate-400">({selected.email})</span>
        <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
          Use sample data
        </Button>
      </div>
    );
  }

  return (
    <div className="relative max-w-md">
      <label htmlFor={inputId} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        Preview with a contact (optional)
      </label>
      <div className="relative mt-1.5">
        <Input
          id={inputId}
          type="search"
          value={q}
          placeholder="Search by name, email or company"
          onChange={(e) => setQ(e.target.value)}
          aria-controls={listId}
          autoComplete="off"
        />
        {loading ? (
          <span className="absolute top-2.5 right-3 text-slate-500">
            <Spinner size="sm" label="Searching" />
          </span>
        ) : null}
      </div>
      {debounced && !loading ? (
        <ul
          id={listId}
          aria-label="Matching contacts"
          className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-600 dark:text-slate-400">No matches</li>
          ) : (
            results.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(c);
                    setQ("");
                  }}
                  className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:hover:bg-slate-800"
                >
                  <span className="font-medium">{contactName(c)}</span>
                  <span className="text-xs text-slate-600 dark:text-slate-400">
                    {c.email}
                    {c.company ? ` · ${c.company.name}` : ""}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Renders each step as the contact would see it. Email HTML goes into a sandboxed iframe
 * (no scripts, no same-origin access) — never into our own DOM.
 */
export function SequencePreview({ sequenceId, version }: { sequenceId: string; version: string }) {
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [steps, setSteps] = useState<PreviewStep[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"html" | "text">("html");
  const [nonce, setNonce] = useState(0);
  const groupName = useId();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<{ steps: PreviewStep[] }>(`/sequences/${sequenceId}/preview`, {
      method: "POST",
      body: contact ? { contactId: contact.id } : {},
      signal: controller.signal,
    })
      .then((r) => {
        setSteps([...r.steps].sort((a, b) => a.position - b.position));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [sequenceId, contact, version, nonce]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
          <ContactPicker selected={contact} onSelect={setContact} />
          <fieldset className="shrink-0">
            <legend className="sr-only">Preview format</legend>
            <div className="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
              {(["html", "text"] as const).map((m) => (
                <label
                  key={m}
                  className={cx(
                    "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium focus-within:ring-2 focus-within:ring-indigo-600",
                    mode === m
                      ? "bg-indigo-600 text-white dark:bg-indigo-500"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                  )}
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={m}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="sr-only"
                  />
                  {m === "html" ? "Formatted" : "Plain text"}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <p className="border-t border-slate-200 px-5 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
          Shows the last saved version. {contact ? "" : "Without a contact, sample data is used."}
        </p>
      </Card>

      {loading && !steps ? (
        <LoadingBlock label="Rendering preview" />
      ) : error ? (
        <Alert tone="error" title="Couldn't render the preview">
          {errorMessage(error)}{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => setNonce((n) => n + 1)}
          >
            Try again
          </button>
        </Alert>
      ) : steps ? (
        <ol className={cx("space-y-4", loading && "opacity-60")} aria-busy={loading}>
          {steps.map((s) => (
            <li key={s.position}>
              <Card>
                <CardHeader
                  as="h3"
                  title={`Step ${s.position}`}
                  description={
                    <>
                      <span className="sr-only">Subject: </span>
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {s.subject}
                      </span>
                    </>
                  }
                />
                {mode === "html" ? (
                  <iframe
                    title={`Step ${s.position} email preview`}
                    sandbox=""
                    srcDoc={s.html}
                    referrerPolicy="no-referrer"
                    className="block h-80 w-full rounded-b-lg bg-white"
                  />
                ) : (
                  <pre className="max-h-80 overflow-auto px-5 py-4 font-mono text-sm whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                    {s.text}
                  </pre>
                )}
              </Card>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
