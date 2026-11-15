import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for our own help, blog and legal content (trusted,
 * written in this repo). It builds React elements — never raw HTML — so nothing can inject markup.
 *
 * Supported: `## Heading {#id}`, `### Heading`, paragraphs, `- ` lists, `1. ` lists, `> ` notes,
 * ``` fenced code, `| a | b |` tables, and inline **bold**, `code` and [links](/path).
 */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function headingParts(raw: string): { text: string; id: string } {
  const match = /^(.*?)\s*\{#([a-z0-9-]+)\}\s*$/.exec(raw);
  if (match?.[1] && match[2]) return { text: match[1], id: match[2] };
  return { text: raw, id: slugify(raw) };
}

export interface Heading {
  id: string;
  text: string;
}

/** Level-2 headings, for an "On this page" list. */
export function extractHeadings(source: string): Heading[] {
  return source
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => headingParts(line.slice(3).trim()))
    .map(({ text, id }) => ({ id, text: text.replace(/[`*]/g, "") }));
}

/** Reading time at ~220 words per minute. */
export function readingMinutes(source: string): number {
  const words = source.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

const linkClass =
  "font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-slate-800 dark:bg-slate-800 dark:text-slate-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link?.[1] && link[2]) {
      const href = link[2];
      if (href.startsWith("/") || href.startsWith("#")) {
        return (
          <Link key={key} href={href} className={linkClass}>
            {link[1]}
          </Link>
        );
      }
      return (
        <a key={key} href={href} className={linkClass} rel="noopener noreferrer" target="_blank">
          {link[1]}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      );
    }
    return part;
  });
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const next = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      out.push(
        <pre
          key={next()}
          className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm leading-6 text-slate-100"
        >
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) {
      const level = trimmed.startsWith("### ") ? 3 : 2;
      const { text, id } = headingParts(trimmed.slice(level + 1).trim());
      const k = next();
      out.push(
        level === 2 ? (
          <h2
            key={k}
            id={id}
            className="mt-10 scroll-mt-24 text-xl font-semibold tracking-tight text-slate-900 dark:text-white"
          >
            {inline(text, k)}
          </h2>
        ) : (
          <h3
            key={k}
            id={id}
            className="mt-8 scroll-mt-24 text-lg font-semibold text-slate-900 dark:text-white"
          >
            {inline(text, k)}
          </h3>
        ),
      );
      i += 1;
      continue;
    }

    if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        const cells = tableCells(lines[i] ?? "");
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i += 1;
      }
      const [head, ...body] = rows;
      const k = next();
      out.push(
        <div key={k} className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-left text-sm">
            {head ? (
              <thead>
                <tr className="border-b border-slate-300 dark:border-slate-700">
                  {head.map((cell, c) => (
                    <th key={c} scope="col" className="py-2 pr-4 font-semibold">
                      {inline(cell, `${k}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className="border-b border-slate-200 dark:border-slate-800">
                  {row.map((cell, c) => (
                    <td key={c} className="py-2 pr-4 align-top text-slate-700 dark:text-slate-300">
                      {inline(cell, `${k}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^(- |\d+\. )/.test(trimmed)) {
      const ordered = /^\d+\. /.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? "").trim();
        const marker = ordered ? /^\d+\. / : /^- /;
        if (marker.test(current)) {
          items.push(current.replace(marker, ""));
        } else if (current !== "" && (lines[i] ?? "").startsWith("  ") && items.length > 0) {
          items[items.length - 1] += ` ${current}`;
        } else {
          break;
        }
        i += 1;
      }
      const k = next();
      const children = items.map((item, n) => (
        <li key={n} className="pl-1">
          {inline(item, `${k}-${n}`)}
        </li>
      ));
      out.push(
        ordered ? (
          <ol key={k} className="list-decimal space-y-2 pl-6">
            {children}
          </ol>
        ) : (
          <ul key={k} className="list-disc space-y-2 pl-6">
            {children}
          </ul>
        ),
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quote.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const k = next();
      out.push(
        <aside
          key={k}
          className="rounded-lg border-l-4 border-indigo-500 bg-indigo-50 px-4 py-3 text-slate-800 dark:bg-indigo-950/40 dark:text-slate-200"
        >
          {inline(quote.join(" "), k)}
        </aside>,
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const current = (lines[i] ?? "").trim();
      if (
        current === "" ||
        (para.length > 0 && /^#{2,3} /.test(current)) ||
        current.startsWith("```") ||
        current.startsWith("|") ||
        current.startsWith(">") ||
        /^(- |\d+\. )/.test(current)
      ) {
        break;
      }
      para.push(current);
      i += 1;
    }
    const k = next();
    out.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }

  return (
    <div className="space-y-4 text-base leading-7 text-slate-700 dark:text-slate-300">{out}</div>
  );
}
