"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Input } from "@/components/ui";

export interface HelpSearchItem {
  slug: string;
  title: string;
  summary: string;
  category: string;
}

/** Client-side filter over article titles and summaries. Works without JS as a plain list below. */
export function HelpSearch({ items }: { items: HelpSearchItem[] }) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const statusId = useId();
  const q = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      q
        ? items.filter((a) =>
            q.split(/\s+/).every((word) => `${a.title} ${a.summary}`.toLowerCase().includes(word)),
          )
        : [],
    [items, q],
  );

  return (
    <div role="search" aria-label="Help articles">
      <label htmlFor={inputId} className="block text-sm font-medium">
        Search help articles
      </label>
      <Input
        id={inputId}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. unsubscribe, CSV, daily cap"
        aria-describedby={statusId}
        className="mt-1.5 h-12 text-base"
        autoComplete="off"
      />
      <p id={statusId} role="status" className="sr-only">
        {q ? `${results.length} ${results.length === 1 ? "article" : "articles"} found` : ""}
      </p>
      {q ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {results.length === 0 ? (
            <p className="p-4 text-sm text-slate-600 dark:text-slate-400">
              No articles match “{query.trim()}”. Try another word, or{" "}
              <Link
                href="/contact"
                className="font-medium text-indigo-700 underline dark:text-indigo-300"
              >
                ask us
              </Link>
              .
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {results.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/help/${a.slug}`}
                    className="block p-4 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:hover:bg-slate-800"
                  >
                    <span className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                      {a.category}
                    </span>
                    <span className="block font-medium">{a.title}</span>
                    <span className="mt-0.5 block text-sm text-slate-600 dark:text-slate-400">
                      {a.summary}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
