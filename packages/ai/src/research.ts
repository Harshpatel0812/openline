/**
 * Website research for Scout drafts: fetches at most 3 pages of a company's site (`/`, plus an
 * about page and a products/services page when the home page links to them) and turns them into
 * plain text. Page text is untrusted and is only ever given to the model fenced.
 *
 * SSRF guard (same rules as SMTP): https only, port 443, the host is resolved once and refused
 * when any address is non-public (outside development/test), and the connection is pinned to the
 * checked address — while TLS still verifies the certificate against the host name. Redirects
 * are followed (max 3) only within the same site and are checked again. 5 s per page, 1 MB cap.
 */
import { request, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { resolveSafeAddress } from "@openline/email";
import type { WebPage } from "./draft";

export interface ResearchOptions {
  /** Development/test only: allow private and loopback addresses. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  /** Test only: the port of a local https server (production always uses 443). */
  port?: number;
  /** Test only: trust this CA (a self-signed test certificate). */
  ca?: string | Buffer;
}

export interface ResearchResult {
  pages: WebPage[];
  /** True when the home page could not be fetched (nothing to research). */
  failed: boolean;
}

export const RESEARCH_DEFAULTS = {
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  maxPages: 3,
  maxRedirects: 3,
  maxTextChars: 20_000,
} as const;

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ABOUT_PATH = /^\/(about|about-us)\/?$/i;
const OFFER_PATH = /^\/(products?|services?)\/?$/i;

/** "https://www.Acme.com/x" → "acme.com"; null when it isn't a plain host name. */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  host = host
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]!
    .replace(/\.$/, "");
  if (host.includes(":") || host.includes("@")) return null;
  host = host.replace(/^www\./, "");
  if (!HOSTNAME.test(host) || isIP(host)) return null;
  return host;
}

/** Same site = the domain itself or one of its subdomains (www.acme.com, shop.acme.com). */
export function isSameSite(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

class FetchFailed extends Error {}

interface RawPage {
  url: string;
  html: string;
}

function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as LookupFunction;
}

async function fetchPage(
  url: URL,
  domain: string,
  opts: ResearchOptions,
  redirectsLeft: number = RESEARCH_DEFAULTS.maxRedirects,
): Promise<RawPage> {
  if (url.protocol !== "https:") throw new FetchFailed("https only");
  if (!isSameSite(url.hostname, domain)) throw new FetchFailed("other site");
  const port = opts.port ?? 443;
  if ((url.port || "443") !== String(port)) throw new FetchFailed("port");
  const address = await resolveSafeAddress(url.hostname, { allowPrivate: opts.allowPrivate });
  if (!address) throw new FetchFailed("unsafe address");

  const timeoutMs = opts.timeoutMs ?? RESEARCH_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? RESEARCH_DEFAULTS.maxBytes;
  const options: RequestOptions = {
    hostname: url.hostname,
    servername: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    lookup: pinnedLookup(address),
    headers: {
      accept: "text/html,text/plain;q=0.9",
      "accept-encoding": "identity",
      "user-agent": "OpenlineScout/1.0 (company research for a sales email; one visit per week)",
    },
    ...(opts.ca ? { ca: opts.ca } : {}),
  };

  const result = await new Promise<
    { kind: "redirect"; location: string } | { kind: "page"; html: string }
  >((resolve, reject) => {
    const req = request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ kind: "redirect", location: res.headers.location });
        return;
      }
      const type = String(res.headers["content-type"] ?? "");
      if (status !== 200 || !/^(text\/html|text\/plain|application\/xhtml\+xml)/i.test(type)) {
        res.resume();
        reject(new FetchFailed(`status ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ kind: "page", html: Buffer.concat(chunks).toString("utf8") });
      };
      res.on("data", (chunk: Buffer) => {
        if (done) return;
        const room = maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (size >= maxBytes) {
          // Cap reached: keep what we have and stop downloading.
          finish();
          req.destroy();
        }
      });
      res.on("end", finish);
      res.on("error", (err) => (done ? undefined : reject(err)));
    });
    const timer = setTimeout(() => req.destroy(new FetchFailed("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });

  if (result.kind === "redirect") {
    if (redirectsLeft <= 0) throw new FetchFailed("too many redirects");
    let next: URL;
    try {
      next = new URL(result.location, url);
    } catch {
      throw new FetchFailed("bad redirect");
    }
    return fetchPage(next, domain, opts, redirectsLeft - 1);
  }
  return { url: url.toString(), html: result.html };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? whole;
    if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10)) ?? whole;
    return ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(n: number): string | undefined {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/** HTML → readable text, plus the page title and its link targets. */
export function htmlToText(html: string): { title?: string; text: string; links: string[] } {
  const links = [...html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#][^"']*)["']/gi)].map(
    (m) => m[1]!,
  );
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = rawTitle ? decodeEntities(rawTitle).replace(/\s+/g, " ").trim() : undefined;
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(
        /<\/?(p|div|br|li|h[1-6]|section|article|header|footer|tr|ul|ol|table|nav|main)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]*>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, RESEARCH_DEFAULTS.maxTextChars);
  return { ...(title ? { title: title.slice(0, 200) } : {}), text, links };
}

/** Fetches up to 3 pages of `domain`. Never throws for network problems: see `failed`. */
export async function researchWebsite(
  domainInput: string,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  const domain = normalizeDomain(domainInput);
  if (!domain) return { pages: [], failed: true };
  const maxPages = Math.min(opts.maxPages ?? RESEARCH_DEFAULTS.maxPages, 3);
  const portPart = opts.port && opts.port !== 443 ? `:${opts.port}` : "";

  let home: RawPage;
  try {
    home = await fetchPage(new URL(`https://${domain}${portPart}/`), domain, opts);
  } catch {
    return { pages: [], failed: true };
  }
  const parsedHome = htmlToText(home.html);
  const pages: WebPage[] = [
    {
      url: home.url,
      ...(parsedHome.title ? { title: parsedHome.title } : {}),
      text: parsedHome.text,
    },
  ];

  const base = new URL(home.url);
  const candidates: URL[] = [];
  for (const pattern of [ABOUT_PATH, OFFER_PATH]) {
    for (const href of parsedHome.links) {
      let link: URL;
      try {
        link = new URL(href, base);
      } catch {
        continue;
      }
      if (link.protocol !== "https:" || !isSameSite(link.hostname, domain)) continue;
      if (!pattern.test(link.pathname)) continue;
      link.hash = "";
      link.search = "";
      if (
        link.toString() !== home.url &&
        !candidates.some((c) => c.toString() === link.toString())
      ) {
        candidates.push(link);
        break;
      }
    }
  }

  for (const link of candidates.slice(0, maxPages - 1)) {
    try {
      const page = await fetchPage(link, domain, opts);
      const parsed = htmlToText(page.html);
      if (pages.some((p) => p.url === page.url)) continue;
      pages.push({
        url: page.url,
        ...(parsed.title ? { title: parsed.title } : {}),
        text: parsed.text,
      });
    } catch {
      // A missing about/products page is fine: research is best-effort.
    }
  }
  return { pages, failed: false };
}
