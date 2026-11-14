/**
 * Same-origin proxy to the API: the browser calls /api/v1/..., this forwards to API_URL.
 *
 * Why a route handler instead of a next.config rewrite: rewrites are fixed at build time, but we
 * build one image and promote it from staging to production, so the API address must be read at
 * runtime. Keeping the API on the same origin also means cookies are first-party and no CORS.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Only these request headers reach the API. */
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "user-agent",
  "x-openline-csrf",
  "x-request-id",
];

/** Largest body the proxy accepts (CSV import is up to 5 MB). */
const MAX_BODY_BYTES = 6_000_000;

/**
 * The client's IP for the API's rate limits. A browser can send any X-Forwarded-For, so we only
 * trust the right-most entry, which our own load balancer appends — and only when we are told we
 * run behind one (TRUST_LB_FORWARDED_FOR=true). Otherwise send nothing: the API sees our address.
 */
function clientIp(req: NextRequest): string | undefined {
  if (process.env.TRUST_LB_FORWARDED_FOR !== "true") return undefined;
  const last = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last && /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : undefined;
}

/** Hop-by-hop or recomputed headers never copied back to the browser. */
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
  "set-cookie",
]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // Only the versioned API is reachable through the proxy.
  if (path[0] !== "v1" || path.some((p) => p === ".." || p.includes("/"))) {
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  }

  const target = `${API_URL}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json(
      { code: "payload_too_large", message: "Request is too large" },
      { status: 413 },
    );
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ip = clientIp(req);
  if (ip) headers.set("x-forwarded-for", ip);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json(
      {
        code: "api_unavailable",
        message: "Openline is temporarily unavailable. Try again shortly.",
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append("set-cookie", cookie);

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE, proxy as HEAD };
