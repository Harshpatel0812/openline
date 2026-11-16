import { NextResponse, type NextRequest } from "next/server";
import { PLAN_IDS, type PlanId } from "@openline/shared";

/**
 * Runs on every page request:
 *  1. Content-Security-Policy with a per-request nonce. Next.js reads the nonce from the request
 *     header and adds it to its own scripts, so only our scripts can run (XSS containment).
 *  2. Cheap auth pre-check for /app (the API is the real gate; this avoids flashing the shell).
 *  3. Signed-in visitors to the home page (e.g. clicking the logo) go straight into the app, and
 *     to /signup (e.g. "Start free trial" on /pricing) go to the billing page with the plan they
 *     picked (or /app without one). Never /login: with an expired cookie, /app sends you to /login,
 *     which must not send you back. The login page itself moves a signed-in visitor on, but only
 *     after the API confirms the session (GET /auth/me), and clears a stale cookie otherwise, so
 *     an expired cookie can't trap anyone: /signup -> /app -> /login (stays) -> cookie cleared.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has("ol_session") || request.cookies.has("__Host-ol_session");

  if (pathname === "/" && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (pathname === "/signup" && hasSession) {
    const plan = request.nextUrl.searchParams.get("plan");
    const billing = request.nextUrl.searchParams.get("billing");
    const url = request.nextUrl.clone();
    url.search = "";
    if (plan && PLAN_IDS.includes(plan as PlanId)) {
      url.pathname = "/app/settings/billing";
      url.searchParams.set("plan", plan);
      url.searchParams.set("billing", billing === "annual" ? "annual" : "monthly");
    } else {
      url.pathname = "/app";
    }
    return NextResponse.redirect(url);
  }

  if (pathname === "/app" || pathname.startsWith("/app/")) {
    if (!hasSession) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(url);
    }
  }

  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // All pages; not the API proxy, Next's static assets, or icons.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
