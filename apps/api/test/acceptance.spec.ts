/**
 * Acceptance criteria from docs/product/OL-E1-foundation.md and OL-E2-contacts.md, as API tests.
 * Where a PRD and docs/api/README.md disagree, these tests follow the README and current code.
 * Tests marked `it.skip` with `// BUG:` reproduce a real application bug; un-skip once fixed.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import { auditLog, eq, type DatabaseHandle } from "@openline/db";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DB } from "../src/database/database.module";
import {
  browser,
  createTestApp,
  joinAs,
  PASSWORD,
  signedUp,
  uniqueEmail,
  type Browser,
} from "./helpers";

type Role = "owner" | "admin" | "manager" | "rep";
const ROLES: Role[] = ["owner", "admin", "manager", "rep"];
const DAY_MS = 86_400_000;
const CSRF = { "x-openline-csrf": "1" };

/** The raw `name=value` part of the session cookie a response set. */
function sessionCookie(res: request.Response): string {
  const all = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const cookie = all.find((c) => c.startsWith("ol_session="));
  if (!cookie) throw new Error("no session cookie set");
  return cookie.split(";")[0]!;
}

function tokenFrom(inviteUrl: string): string {
  return inviteUrl.split("/invite/")[1]!;
}

async function userId(b: Browser): Promise<string> {
  const me = await b.get("/v1/auth/me").expect(200);
  return me.body.user.id as string;
}

async function workspaceId(b: Browser): Promise<string> {
  const me = await b.get("/v1/auth/me").expect(200);
  return me.body.workspace.id as string;
}

/** Signs up a fresh user and returns the raw cookie as well as the browser. */
async function signupWithCookie(app: NestExpressApplication) {
  const b = browser(app);
  const email = uniqueEmail("cookie");
  const res = await b
    .post("/v1/auth/signup", { name: "C", email, password: PASSWORD, workspaceName: "W" })
    .expect(201);
  return { b, email, cookie: sessionCookie(res), res };
}

const raw = (app: NestExpressApplication) => request(app.getHttpServer());

// =====================================================================================
// Role permissions: every authenticated route in docs/api/README.md × every role.
// =====================================================================================

interface Team {
  owner: Browser;
  admin: Browser;
  manager: Browser;
  rep: Browser;
  workspaceId: string;
}

interface RouteCase {
  method: "get" | "post" | "patch" | "delete";
  route: string;
  allowed: Role[] | "all";
  ok: number;
  /** Builds the concrete path and body (fresh resources per test, created by the owner). */
  setup?: (app: NestExpressApplication, t: Team) => Promise<{ path: string; body?: object }>;
  body?: () => object;
}

const freshMember = async (app: NestExpressApplication, t: Team) =>
  userId(await joinAs(app, t.owner, "rep"));

const ROUTES: RouteCase[] = [
  { method: "get", route: "/v1/auth/me", allowed: "all", ok: 200 },
  {
    method: "post",
    route: "/v1/auth/switch-workspace",
    allowed: "all",
    ok: 200,
    setup: async (_app, t) => ({
      path: "/v1/auth/switch-workspace",
      body: { workspaceId: t.workspaceId },
    }),
  },
  { method: "get", route: "/v1/members", allowed: "all", ok: 200 },
  {
    method: "patch",
    route: "/v1/members/:userId",
    allowed: ["owner", "admin"],
    ok: 200,
    setup: async (app, t) => ({
      path: `/v1/members/${await freshMember(app, t)}`,
      body: { role: "manager" },
    }),
  },
  {
    method: "delete",
    route: "/v1/members/:userId (someone else)",
    allowed: ["owner", "admin"],
    ok: 200,
    setup: async (app, t) => ({ path: `/v1/members/${await freshMember(app, t)}` }),
  },
  { method: "get", route: "/v1/invites", allowed: ["owner", "admin"], ok: 200 },
  {
    method: "post",
    route: "/v1/invites",
    allowed: ["owner", "admin"],
    ok: 201,
    body: () => ({ email: uniqueEmail("matrix"), role: "rep" }),
  },
  {
    method: "delete",
    route: "/v1/invites/:id",
    allowed: ["owner", "admin"],
    ok: 200,
    setup: async (_app, t) => {
      const res = await t.owner
        .post("/v1/invites", { email: uniqueEmail("rev"), role: "rep" })
        .expect(201);
      return { path: `/v1/invites/${res.body.invite.id as string}` };
    },
  },
  { method: "get", route: "/v1/contacts", allowed: "all", ok: 200 },
  {
    method: "post",
    route: "/v1/contacts",
    allowed: "all",
    ok: 201,
    body: () => ({ email: uniqueEmail("contact") }),
  },
  ...(["get", "patch", "delete"] as const).map((method): RouteCase => ({
    method,
    route: "/v1/contacts/:id",
    allowed: method === "delete" ? ["owner", "admin", "manager"] : "all",
    ok: 200,
    setup: async (_app, t) => {
      const c = await t.owner.post("/v1/contacts", { email: uniqueEmail("c") }).expect(201);
      return { path: `/v1/contacts/${c.body.id as string}`, body: { title: "Updated" } };
    },
  })),
  {
    method: "post",
    route: "/v1/contacts/import/preview",
    allowed: "all",
    ok: 200,
    body: () => ({ csv: `email\n${uniqueEmail("prev")}\n` }),
  },
  {
    method: "post",
    route: "/v1/contacts/import",
    allowed: "all",
    ok: 200,
    body: () => ({
      csv: `email\n${uniqueEmail("imp")}\n`,
      duplicates: "skip",
      confirmLawfulBasis: true,
    }),
  },
  { method: "get", route: "/v1/companies", allowed: "all", ok: 200 },
  { method: "get", route: "/v1/suppressions", allowed: "all", ok: 200 },
  {
    method: "post",
    route: "/v1/suppressions",
    allowed: ["owner", "admin"],
    ok: 201,
    body: () => ({ value: uniqueEmail("sup"), reason: "other" }),
  },
  {
    method: "delete",
    route: "/v1/suppressions/:id",
    allowed: ["owner", "admin"],
    ok: 200,
    setup: async (_app, t) => {
      const s = await t.owner
        .post("/v1/suppressions", { value: uniqueEmail("s"), reason: "competitor" })
        .expect(201);
      return { path: `/v1/suppressions/${s.body.id as string}` };
    },
  },
];

describe("acceptance: role permissions per endpoint", () => {
  let app: NestExpressApplication;
  let team: Team;

  beforeAll(async () => {
    app = await createTestApp();
    const { b: owner } = await signedUp(app, { workspaceName: "Matrix Co" });
    team = {
      owner,
      admin: await joinAs(app, owner, "admin"),
      manager: await joinAs(app, owner, "manager"),
      rep: await joinAs(app, owner, "rep"),
      workspaceId: await workspaceId(owner),
    };
  });
  afterAll(async () => {
    await app.close();
  });

  const cases = ROUTES.flatMap((c) => ROLES.map((role) => ({ ...c, role })));

  it.each(cases)("$role $method $route", async (c) => {
    const { path, body } = c.setup ? await c.setup(app, team) : { path: c.route, body: c.body?.() };
    const b = team[c.role];
    const res =
      c.method === "get"
        ? await b.get(path)
        : c.method === "delete"
          ? await b.delete(path)
          : await b[c.method](path, body ?? c.body?.());
    const allowed = c.allowed === "all" || c.allowed.includes(c.role);
    expect(res.status, JSON.stringify(res.body)).toBe(allowed ? c.ok : 403);
    if (!allowed) expect(res.body.code).toBe("forbidden");
  });

  it("forbidden calls change nothing", async () => {
    const email = uniqueEmail("nope");
    await team.rep.post("/v1/invites", { email, role: "rep" }).expect(403);
    await team.manager.post("/v1/invites", { email, role: "rep" }).expect(403);
    const invites = await team.owner.get("/v1/invites").expect(200);
    expect(invites.body.map((i: { email: string }) => i.email)).not.toContain(email);

    const c = await team.rep.post("/v1/contacts", { email: uniqueEmail("keep") }).expect(201);
    await team.rep.delete(`/v1/contacts/${c.body.id as string}`).expect(403);
    await team.owner.get(`/v1/contacts/${c.body.id as string}`).expect(200);

    const value = uniqueEmail("nosup");
    await team.manager.post("/v1/suppressions", { value, reason: "other" }).expect(403);
    const list = await team.owner.get("/v1/suppressions").expect(200);
    expect(list.body.map((s: { value: string }) => s.value)).not.toContain(value);
  });

  it("managers and reps may remove themselves (leave)", async () => {
    for (const role of ["manager", "rep"] as const) {
      const member = await joinAs(app, team.owner, role);
      await member.delete(`/v1/members/${await userId(member)}`).expect(200);
      await member.get("/v1/auth/me").expect(401);
    }
  });

  it.each(ROUTES)("unauthenticated $method $route → 401", async (c) => {
    const path = c.route.replace(/:\w+.*$/, "00000000-0000-4000-8000-000000000000");
    const r = raw(app)[c.method](path).set(CSRF);
    const res = await (c.method === "get" ? r : r.send(c.body?.() ?? {}));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("public routes work without a session", async () => {
    await raw(app).post("/v1/auth/logout").set(CSRF).expect(200);
    await raw(app)
      .get(`/v1/invites/lookup?token=${"x".repeat(43)}`)
      .expect(404);
    await raw(app)
      .post("/v1/invites/accept")
      .set(CSRF)
      .send({ token: "x".repeat(43), name: "A", password: PASSWORD })
      .expect(404);
    await raw(app)
      .post("/v1/auth/login")
      .set(CSRF)
      .send({ email: uniqueEmail("ghost"), password: "wrong password!!" })
      .expect(401);
  });

  it.each(
    ROUTES.filter((c) => c.method !== "get").map((c) => ({
      ...c,
      path: c.route.replace(/:\w+.*$/, "00000000-0000-4000-8000-000000000000"),
    })),
  )("$method $route without the CSRF header → 403 csrf", async (c) => {
    const res = await team.owner.agent[c.method](c.path).send(c.body?.() ?? {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf");
  });
});

// =====================================================================================
// Cross-workspace isolation for every :id route.
// =====================================================================================

describe("acceptance: another workspace's ids look like 404", () => {
  let app: NestExpressApplication;
  let a: { owner: Browser; admin: Browser };
  let b: {
    owner: Browser;
    ownerId: string;
    repId: string;
    inviteId: string;
    contactId: string;
    suppressionId: string;
    workspaceId: string;
  };

  beforeAll(async () => {
    app = await createTestApp();
    const { b: aOwner } = await signedUp(app, { workspaceName: "Alpha" });
    a = { owner: aOwner, admin: await joinAs(app, aOwner, "admin") };

    const { b: bOwner } = await signedUp(app, { workspaceName: "Beta" });
    const rep = await joinAs(app, bOwner, "rep");
    const invite = await bOwner
      .post("/v1/invites", { email: uniqueEmail("beta-inv"), role: "rep" })
      .expect(201);
    const contact = await bOwner
      .post("/v1/contacts", { email: "secret@beta.io", firstName: "Secret" })
      .expect(201);
    const supp = await bOwner
      .post("/v1/suppressions", { value: "x@beta.io", reason: "other" })
      .expect(201);
    b = {
      owner: bOwner,
      ownerId: await userId(bOwner),
      repId: await userId(rep),
      inviteId: invite.body.invite.id as string,
      contactId: contact.body.id as string,
      suppressionId: supp.body.id as string,
      workspaceId: await workspaceId(bOwner),
    };
  });
  afterAll(async () => {
    await app.close();
  });

  const cases: {
    name: string;
    method: "get" | "patch" | "delete";
    path: () => string;
    body?: object;
  }[] = [
    {
      name: "PATCH member",
      method: "patch",
      path: () => `/v1/members/${b.repId}`,
      body: { role: "admin" },
    },
    {
      name: "PATCH member (owner)",
      method: "patch",
      path: () => `/v1/members/${b.ownerId}`,
      body: { role: "rep" },
    },
    { name: "DELETE member", method: "delete", path: () => `/v1/members/${b.repId}` },
    { name: "DELETE invite", method: "delete", path: () => `/v1/invites/${b.inviteId}` },
    { name: "GET contact", method: "get", path: () => `/v1/contacts/${b.contactId}` },
    {
      name: "PATCH contact",
      method: "patch",
      path: () => `/v1/contacts/${b.contactId}`,
      body: { firstName: "Hacked" },
    },
    { name: "DELETE contact", method: "delete", path: () => `/v1/contacts/${b.contactId}` },
    {
      name: "DELETE contact ?suppress=true",
      method: "delete",
      path: () => `/v1/contacts/${b.contactId}?suppress=true`,
    },
    {
      name: "DELETE suppression",
      method: "delete",
      path: () => `/v1/suppressions/${b.suppressionId}`,
    },
  ];

  const send = (who: Browser, c: (typeof cases)[number], path: string) =>
    c.method === "get"
      ? who.get(path)
      : c.method === "delete"
        ? who.delete(path)
        : who.patch(path, c.body);

  it.each(cases.flatMap((c) => (["owner", "admin"] as const).map((as) => ({ ...c, as }))))(
    "$as of A: $name of B → 404 (same as an unknown id)",
    async (c) => {
      const res = await send(a[c.as], c, c.path());
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      // Indistinguishable from an id that does not exist anywhere.
      const unknown = c.path().replace(/[0-9a-f-]{36}/, "00000000-0000-4000-8000-000000000000");
      const res2 = await send(a[c.as], c, unknown);
      expect(res2.status).toBe(404);
      expect(res.body).toEqual(res2.body);
    },
  );

  it("B's records are untouched after A's attempts", async () => {
    const contact = await b.owner.get(`/v1/contacts/${b.contactId}`).expect(200);
    expect(contact.body.firstName).toBe("Secret");
    const members = await b.owner.get("/v1/members").expect(200);
    expect(members.body).toHaveLength(2);
    expect(members.body.find((m: { userId: string }) => m.userId === b.repId).role as string).toBe(
      "rep",
    );
    const invites = await b.owner.get("/v1/invites").expect(200);
    expect(invites.body.map((i: { id: string }) => i.id)).toContain(b.inviteId);
    const supp = await b.owner.get("/v1/suppressions").expect(200);
    expect(supp.body.map((s: { id: string }) => s.id)).toContain(b.suppressionId);
    expect((await a.owner.get("/v1/suppressions").expect(200)).body).toEqual([]);
  });

  it("cannot switch into a workspace you are not a member of (403 per README)", async () => {
    const res = await a.owner
      .post("/v1/auth/switch-workspace", { workspaceId: b.workspaceId })
      .expect(403);
    expect(res.body.code).toBe("forbidden");
    const me = await a.owner.get("/v1/auth/me").expect(200);
    expect(me.body.workspace.name).toBe("Alpha");
  });

  it("lists and searches never include B's rows", async () => {
    expect((await a.owner.get("/v1/contacts?q=secret").expect(200)).body.total).toBe(0);
    expect((await a.owner.get("/v1/companies?q=beta").expect(200)).body.items).toEqual([]);
    const members = await a.owner.get("/v1/members").expect(200);
    expect(members.body.map((m: { userId: string }) => m.userId)).not.toContain(b.repId);
  });
});

// =====================================================================================
// Sign-up, passwords, rate limits.
// =====================================================================================

describe("acceptance: sign-up and passwords", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("an 11-character password is rejected and nothing is created", async () => {
    const email = uniqueEmail("short");
    const res = await browser(app)
      .post("/v1/auth/signup", { name: "S", email, password: "a".repeat(11), workspaceName: "W" })
      .expect(400);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain("password");
    // Nothing was created: signing up again with a good password works.
    await signedUp(app, { email });
  });

  it("spaces and Unicode are allowed in a 12+ character password, with no composition rules", async () => {
    const email = uniqueEmail("uni");
    const password = "pâté  日本語 ök ✓";
    const b = browser(app);
    await b.post("/v1/auth/signup", { name: "U", email, password, workspaceName: "W" }).expect(201);
    await b.post("/v1/auth/logout").expect(200);
    await b.post("/v1/auth/login", { email, password }).expect(200);
  });

  it("workspace name over 100 characters is rejected", async () => {
    const res = await browser(app)
      .post("/v1/auth/signup", {
        name: "N",
        email: uniqueEmail(),
        password: PASSWORD,
        workspaceName: "w".repeat(101),
      })
      .expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain("workspaceName");
  });

  it("sets the session cookie with HttpOnly, SameSite=Lax, Path=/ and a 14-day lifetime", async () => {
    const { res } = await signupWithCookie(app);
    const cookie = ([] as string[])
      .concat(res.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith("ol_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(new RegExp(`Max-Age=${(14 * DAY_MS) / 1000}`));
  });

  it("login issues a new session token every time", async () => {
    const { b, email, cookie } = await signupWithCookie(app);
    const login = await b.post("/v1/auth/login", { email, password: PASSWORD }).expect(200);
    expect(sessionCookie(login)).not.toBe(cookie);
  });

  it("rate-limits failed logins for an unknown email the same way as a known one", async () => {
    const email = uniqueEmail("nobody");
    const b = browser(app);
    for (let i = 0; i < 10; i += 1) {
      await b.post("/v1/auth/login", { email, password: "wrong password!!" }).expect(401);
    }
    const res = await b.post("/v1/auth/login", { email, password: "wrong password!!" }).expect(429);
    expect(res.body.code).toBe("rate_limited");
  });

  // BUG: login always picks the oldest membership (members.createdAt asc) instead of the
  // workspace the user used last. Repro: sign up (workspace A), accept an invite to B (session
  // switches to B), log out, log in → /v1/auth/me shows A. PRD OL-E1: "I land in the workspace
  // I used last".
  it("login lands in the workspace used last", async () => {
    const { b: ownerB } = await signedUp(app, { workspaceName: "Second Co" });
    const { b: user, email } = await signedUp(app, { workspaceName: "First Co" });
    const inv = await ownerB.post("/v1/invites", { email, role: "rep" }).expect(201);
    await user
      .post("/v1/invites/accept", { token: tokenFrom(inv.body.inviteUrl as string) })
      .expect(200);
    expect((await user.get("/v1/auth/me").expect(200)).body.workspace.name).toBe("Second Co");
    await user.post("/v1/auth/logout").expect(200);
    await user.post("/v1/auth/login", { email, password: PASSWORD }).expect(200);
    expect((await user.get("/v1/auth/me").expect(200)).body.workspace.name).toBe("Second Co");
  });
});

describe("acceptance: sign-up rate limit (SIGNUPS_PER_IP_PER_HOUR=2)", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ SIGNUPS_PER_IP_PER_HOUR: "2" });
  });
  afterAll(async () => {
    await app.close();
  });

  it("the third sign-up from one IP within the hour gets 429 and creates nothing", async () => {
    await signedUp(app);
    await signedUp(app);
    const email = uniqueEmail("third");
    const res = await browser(app)
      .post("/v1/auth/signup", { name: "T", email, password: PASSWORD, workspaceName: "W" })
      .expect(429);
    expect(res.body.code).toBe("rate_limited");
    await browser(app).post("/v1/auth/login", { email, password: PASSWORD }).expect(401);
  });
});

describe("acceptance: login rate limit per IP", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("rate-limits login spraying from one IP across many emails (50 per window)", async () => {
    for (let i = 0; i < 50; i += 1) {
      await browser(app)
        .post("/v1/auth/login", { email: uniqueEmail("spray"), password: "wrong password!!" })
        .expect(401);
    }
    const res = await browser(app)
      .post("/v1/auth/login", { email: uniqueEmail("spray"), password: "wrong password!!" })
      .expect(429);
    expect(res.body.code).toBe("rate_limited");
  });
});

// =====================================================================================
// Sessions: expiry, forged cookies, logout, member removal.
// =====================================================================================

describe("acceptance: sessions", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a session idle for more than 14 days returns 401 and stays dead", async () => {
    const { cookie } = await signupWithCookie(app);
    await raw(app).get("/v1/auth/me").set("Cookie", cookie).expect(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 15 * DAY_MS });
    const res = await raw(app).get("/v1/auth/me").set("Cookie", cookie).expect(401);
    expect(res.body.code).toBe("unauthorized"); // PRD says session_expired
    vi.useRealTimers();
    await raw(app).get("/v1/auth/me").set("Cookie", cookie).expect(401);
  });

  it.each([
    ["random token", "ol_session=forged-token-forged-token-forged-token"],
    ["too short", "ol_session=abc"],
    ["oversized", `ol_session=${"a".repeat(500)}`],
    ["production cookie name in dev", "__Host-ol_session=forged-token-forged-token-forged"],
  ])("a forged session cookie (%s) is rejected on reads and writes", async (_n, cookie) => {
    await raw(app).get("/v1/contacts").set("Cookie", cookie).expect(401);
    await raw(app)
      .post("/v1/contacts")
      .set("Cookie", cookie)
      .set(CSRF)
      .send({ email: uniqueEmail() })
      .expect(401);
  });

  it("logout revokes the session server-side: replaying the old cookie returns 401", async () => {
    const { b, cookie } = await signupWithCookie(app);
    await raw(app).get("/v1/auth/me").set("Cookie", cookie).expect(200);
    const out = await b.post("/v1/auth/logout").expect(200);
    const cleared = ([] as string[]).concat(out.headers["set-cookie"] ?? []).join(";");
    expect(cleared).toMatch(/ol_session=;/);
    await raw(app).get("/v1/auth/me").set("Cookie", cookie).expect(401);
    await raw(app)
      .post("/v1/contacts")
      .set("Cookie", cookie)
      .set(CSRF)
      .send({ email: uniqueEmail() })
      .expect(401);
  });

  it("logging out one session leaves the user's other sessions alone", async () => {
    const { b, email } = await signupWithCookie(app);
    const other = browser(app);
    await other.post("/v1/auth/login", { email, password: PASSWORD }).expect(200);
    await b.post("/v1/auth/logout").expect(200);
    await other.get("/v1/auth/me").expect(200);
  });
});

// =====================================================================================
// Members: removal, role changes, last owner.
// =====================================================================================

describe("acceptance: members", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function inviteAndAccept(owner: Browser, role: "admin" | "manager" | "rep") {
    const email = uniqueEmail(role);
    const inv = await owner.post("/v1/invites", { email, role }).expect(201);
    const b = browser(app);
    await b
      .post("/v1/invites/accept", {
        token: tokenFrom(inv.body.inviteUrl as string),
        name: "Member",
        password: PASSWORD,
      })
      .expect(200);
    return { b, email, id: await userId(b) };
  }

  it("removing a member revokes all their sessions, keeps their contacts, and leaves them with no workspace", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await inviteAndAccept(owner, "rep");
    const second = browser(app);
    await second.post("/v1/auth/login", { email: rep.email, password: PASSWORD }).expect(200);
    const contact = await rep.b.post("/v1/contacts", { email: uniqueEmail("owned") }).expect(201);

    await owner.delete(`/v1/members/${rep.id}`).expect(200);
    await rep.b.get("/v1/auth/me").expect(401);
    await second.get("/v1/contacts").expect(401);
    await owner.get(`/v1/contacts/${contact.body.id as string}`).expect(200);

    const login = await browser(app)
      .post("/v1/auth/login", { email: rep.email, password: PASSWORD })
      .expect(403);
    expect(login.body.code).toBe("no_workspace");
  });

  // BUG: removing a member does not revoke the invites they created. Repro: owner invites an
  // admin; admin creates an invite for x@...; owner DELETE /v1/members/<admin>; the admin's
  // invite still looks up as "valid" and can be accepted (200). PRD OL-E1: "invites they created
  // that are still pending are revoked" (also listed under Privilege escalation threats).
  it("removing a member revokes the pending invites they created", async () => {
    const { b: owner } = await signedUp(app);
    const admin = await inviteAndAccept(owner, "admin");
    const inv = await admin.b
      .post("/v1/invites", { email: uniqueEmail("orphan"), role: "rep" })
      .expect(201);
    const token = tokenFrom(inv.body.inviteUrl as string);
    await owner.delete(`/v1/members/${admin.id}`).expect(200);

    const lookup = await browser(app).get(`/v1/invites/lookup?token=${token}`).expect(200);
    expect(lookup.body.status).toBe("revoked");
    const res = await browser(app)
      .post("/v1/invites/accept", { token, name: "Orphan", password: PASSWORD })
      .expect(410);
    expect(res.body.code).toBe("invite_revoked");
  });

  it("a role change applies to the member's very next request", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await inviteAndAccept(owner, "rep");
    await rep.b.get("/v1/invites").expect(403);
    await owner.patch(`/v1/members/${rep.id}`, { role: "admin" }).expect(200);
    await rep.b.get("/v1/invites").expect(200);
    expect((await rep.b.get("/v1/auth/me").expect(200)).body.role).toBe("admin");
    await owner.patch(`/v1/members/${rep.id}`, { role: "rep" }).expect(200);
    await rep.b.get("/v1/invites").expect(403);
  });

  it("admins cannot promote anyone to owner; owners can", async () => {
    const { b: owner } = await signedUp(app);
    const admin = await inviteAndAccept(owner, "admin");
    const rep = await inviteAndAccept(owner, "rep");
    const res = await admin.b.patch(`/v1/members/${rep.id}`, { role: "owner" }).expect(403);
    expect(res.body.code).toBe("forbidden");
    await admin.b.patch(`/v1/members/${admin.id}`, { role: "owner" }).expect(403);
    expect((await rep.b.get("/v1/auth/me").expect(200)).body.role).toBe("rep");
    await owner.patch(`/v1/members/${rep.id}`, { role: "owner" }).expect(200);
    expect((await rep.b.get("/v1/auth/me").expect(200)).body.role).toBe("owner");
  });

  it("an unknown role is a validation error", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await inviteAndAccept(owner, "rep");
    const res = await owner.patch(`/v1/members/${rep.id}`, { role: "superuser" }).expect(400);
    expect(res.body.code).toBe("validation_error");
  });

  it("two owners demoting each other at the same moment leaves exactly one owner", async () => {
    const { b: owner } = await signedUp(app);
    const second = await inviteAndAccept(owner, "admin");
    const ownerId = await userId(owner);
    await owner.patch(`/v1/members/${second.id}`, { role: "owner" }).expect(200);

    const [r1, r2] = await Promise.all([
      owner.patch(`/v1/members/${second.id}`, { role: "admin" }),
      second.b.patch(`/v1/members/${ownerId}`, { role: "admin" }),
    ]);
    // Exactly one wins; the loser gets 409 last_owner (or 403 if it was already demoted).
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const members = await (r1.status === 200 ? owner : second.b).get("/v1/members").expect(200);
    expect(members.body.filter((m: { role: string }) => m.role === "owner")).toHaveLength(1);
  });

  it("the last owner cannot leave either", async () => {
    const { b: owner } = await signedUp(app);
    const res = await owner.delete(`/v1/members/${await userId(owner)}`).expect(409);
    expect(res.body.code).toBe("last_owner");
    await owner.get("/v1/auth/me").expect(200);
  });
});

// =====================================================================================
// Invites.
// =====================================================================================

describe("acceptance: invites", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an invite expires in 7 days and the link points at the web app", async () => {
    const { b: owner } = await signedUp(app);
    const before = Date.now();
    const res = await owner
      .post("/v1/invites", { email: uniqueEmail("sam"), role: "rep" })
      .expect(201);
    const expires = new Date(res.body.invite.expiresAt as string).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(7 * DAY_MS - 5_000);
    expect(expires - before).toBeLessThanOrEqual(7 * DAY_MS + 5_000);
    expect(res.body.inviteUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{43}$/);
    // The token is never returned again.
    const list = await owner.get("/v1/invites").expect(200);
    expect(JSON.stringify(list.body)).not.toContain(tokenFrom(res.body.inviteUrl as string));
  });

  it("re-inviting a pending email revokes the old link and issues a new one", async () => {
    const { b: owner } = await signedUp(app);
    const email = uniqueEmail("again");
    const first = await owner.post("/v1/invites", { email, role: "rep" }).expect(201);
    const second = await owner.post("/v1/invites", { email, role: "manager" }).expect(201);
    const oldToken = tokenFrom(first.body.inviteUrl as string);
    const newToken = tokenFrom(second.body.inviteUrl as string);
    expect(newToken).not.toBe(oldToken);

    const pending = await owner.get("/v1/invites").expect(200);
    expect(pending.body.filter((i: { email: string }) => i.email === email)).toEqual([
      expect.objectContaining({ id: second.body.invite.id, role: "manager" }),
    ]);

    const lookup = await browser(app).get(`/v1/invites/lookup?token=${oldToken}`).expect(200);
    expect(lookup.body.status).toBe("revoked");
    const old = await browser(app).post("/v1/invites/accept", {
      token: oldToken,
      name: "Old",
      password: PASSWORD,
    });
    expect([404, 410]).toContain(old.status);

    const invitee = browser(app);
    await invitee
      .post("/v1/invites/accept", { token: newToken, name: "New", password: PASSWORD })
      .expect(200);
    expect((await invitee.get("/v1/auth/me").expect(200)).body.role).toBe("manager");
  });

  it("nobody can invite as owner (400: owner is not an invitable role)", async () => {
    const { b: owner } = await signedUp(app);
    const admin = await joinAs(app, owner, "admin");
    const email = uniqueEmail("wannabe");
    const res = await admin.post("/v1/invites", { email, role: "owner" }).expect(400);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain("role");
    await owner.post("/v1/invites", { email, role: "owner" }).expect(400);
    const list = await owner.get("/v1/invites").expect(200);
    expect(list.body.map((i: { email: string }) => i.email)).not.toContain(email);
  });

  it("inviting an existing member (any case) is 409 already_member and creates nothing", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await joinAs(app, owner, "rep");
    const repEmail = (await rep.get("/v1/auth/me").expect(200)).body.user.email as string;
    const res = await owner
      .post("/v1/invites", { email: repEmail.toUpperCase(), role: "admin" })
      .expect(409);
    expect(res.body.code).toBe("already_member");
    expect((await owner.get("/v1/invites").expect(200)).body).toEqual([]);
  });

  it("an invite older than 7 days cannot be accepted and creates nothing", async () => {
    const { b: owner } = await signedUp(app);
    const email = uniqueEmail("late");
    const inv = await owner.post("/v1/invites", { email, role: "rep" }).expect(201);
    const token = tokenFrom(inv.body.inviteUrl as string);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 8 * DAY_MS });
    const lookup = await browser(app).get(`/v1/invites/lookup?token=${token}`).expect(200);
    expect(lookup.body.status).toBe("expired");
    const res = await browser(app)
      .post("/v1/invites/accept", { token, name: "Late", password: PASSWORD })
      .expect(410);
    expect(res.body.code).toBe("invite_expired");
    // Expired invites drop out of the pending list.
    expect((await owner.get("/v1/invites").expect(200)).body).toEqual([]);
    vi.useRealTimers();

    await browser(app).post("/v1/auth/login", { email, password: PASSWORD }).expect(401);
  });

  it("unknown tokens are 404 for lookup and accept", async () => {
    const token = "A".repeat(43);
    await browser(app).get(`/v1/invites/lookup?token=${token}`).expect(404);
    await browser(app)
      .post("/v1/invites/accept", { token, name: "X", password: PASSWORD })
      .expect(404);
  });

  it("invite accept with an 11-character password creates nothing", async () => {
    const { b: owner } = await signedUp(app);
    const inv = await owner
      .post("/v1/invites", { email: uniqueEmail("weak"), role: "rep" })
      .expect(201);
    const token = tokenFrom(inv.body.inviteUrl as string);
    const res = await browser(app)
      .post("/v1/invites/accept", { token, name: "W", password: "b".repeat(11) })
      .expect(400);
    expect(res.body.code).toBe("validation_error");
    const lookup = await browser(app).get(`/v1/invites/lookup?token=${token}`).expect(200);
    expect(lookup.body).toMatchObject({ status: "valid", accountExists: false });
  });

  it("signed in as a different email: logout_required and nothing changes", async () => {
    const { b: owner } = await signedUp(app, { workspaceName: "Target" });
    const { email: invitedEmail } = await signedUp(app, { workspaceName: "Invitee Co" });
    const { b: intruder } = await signedUp(app, { workspaceName: "Intruder Co" });
    const inv = await owner.post("/v1/invites", { email: invitedEmail, role: "rep" }).expect(201);
    const token = tokenFrom(inv.body.inviteUrl as string);

    const res = await intruder.post("/v1/invites/accept", { token }).expect(409);
    expect(res.body.code).toBe("logout_required");
    // Even with a name and password, a signed-in different user cannot take the invite.
    await intruder.post("/v1/invites/accept", { token, name: "X", password: PASSWORD }).expect(409);
    const me = await intruder.get("/v1/auth/me").expect(200);
    expect(me.body.workspace.name).toBe("Intruder Co");
    expect(me.body.workspaces).toHaveLength(1);
    const lookup = await browser(app).get(`/v1/invites/lookup?token=${token}`).expect(200);
    expect(lookup.body.status).toBe("valid");
  });
});

// =====================================================================================
// Audit log (read straight from the database; there is no API for it yet).
// =====================================================================================

describe("acceptance: audit log", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function actions(wsId: string): Promise<string[]> {
    const handle = app.get<DatabaseHandle>(DB);
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.workspaceId, wsId));
    return rows.map((r) => r.action);
  }

  it("records workspace creation, invites, role changes and removals without secrets", async () => {
    const { b: owner, email } = await signedUp(app);
    const wsId = await workspaceId(owner);
    const inv = await owner
      .post("/v1/invites", { email: uniqueEmail("aud"), role: "rep" })
      .expect(201);
    await owner.delete(`/v1/invites/${inv.body.invite.id as string}`).expect(200);
    const rep = await joinAs(app, owner, "rep");
    const repId = await userId(rep);
    await owner.patch(`/v1/members/${repId}`, { role: "manager" }).expect(200);
    await owner.delete(`/v1/members/${repId}`).expect(200);
    await owner.post("/v1/auth/logout").expect(200);
    await owner.post("/v1/auth/login", { email, password: PASSWORD }).expect(200);

    const got = await actions(wsId);
    expect(got).toEqual(
      expect.arrayContaining([
        "workspace.created",
        "invite.created",
        "invite.revoked",
        "invite.accepted",
        "member.role_changed",
        "member.removed",
        "auth.login",
      ]),
    );

    const handle = app.get<DatabaseHandle>(DB);
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.workspaceId, wsId));
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(tokenFrom(inv.body.inviteUrl as string));
    expect(dump).not.toMatch(/scrypt\$/);
    expect(dump).not.toContain(inv.body.invite.email as string);
  });

  it("suppression audit rows carry no email or domain value", async () => {
    const { b: owner } = await signedUp(app);
    const wsId = await workspaceId(owner);
    const s = await owner
      .post("/v1/suppressions", { value: "audited@private.io", reason: "other" })
      .expect(201);
    await owner.delete(`/v1/suppressions/${s.body.id as string}`).expect(200);
    const got = await actions(wsId);
    expect(got).toEqual(expect.arrayContaining(["suppression.created", "suppression.deleted"]));
    const handle = app.get<DatabaseHandle>(DB);
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.workspaceId, wsId));
    expect(JSON.stringify(rows)).not.toContain("private.io");
  });

  // BUG: logout and failed logins for a known account are not audit-logged. Repro: sign up,
  // POST /v1/auth/logout, POST /v1/auth/login with a wrong password; audit_log for the
  // workspace has no logout or login-failed row. PRD OL-E1 audit criterion lists both.
  it("records logout and failed logins for known accounts", async () => {
    const { b: owner, email } = await signedUp(app);
    const wsId = await workspaceId(owner);
    await owner.post("/v1/auth/logout").expect(200);
    await browser(app).post("/v1/auth/login", { email, password: "wrong password!!" }).expect(401);
    const got = await actions(wsId);
    expect(got.some((a) => /logout/.test(a))).toBe(true);
    expect(got.some((a) => /login.*fail|fail.*login/.test(a))).toBe(true);
  });

  it("contact deletion is audited by id, without the email", async () => {
    const { b: owner } = await signedUp(app);
    const wsId = await workspaceId(owner);
    const c = await owner.post("/v1/contacts", { email: "erase.me@acme.com" }).expect(201);
    await owner.delete(`/v1/contacts/${c.body.id as string}`).expect(200);
    const handle = app.get<DatabaseHandle>(DB);
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.workspaceId, wsId));
    const del = rows.find((r) => r.action === "contact.deleted");
    expect(del).toMatchObject({ entityId: c.body.id });
    expect(JSON.stringify(rows)).not.toContain("erase.me@acme.com");
  });
});

// =====================================================================================
// Contacts.
// =====================================================================================

describe("acceptance: contacts", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(["yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "aol.com"])(
    "free-mail domain %s never creates or links a company",
    async (domain) => {
      const { b } = await signedUp(app);
      const res = await b.post("/v1/contacts", { email: `someone@${domain}` }).expect(201);
      expect(res.body.company).toBeNull();
      expect((await b.get("/v1/companies").expect(200)).body.items).toEqual([]);
    },
  );

  it("an explicit company domain wins over the email domain", async () => {
    const { b } = await signedUp(app);
    const res = await b
      .post("/v1/contacts", { email: "jane@acme.com", companyDomain: "globex.io" })
      .expect(201);
    expect(res.body.company.domain).toBe("globex.io");
  });

  it.each([
    ["country", { country: "Canada" }],
    ["country", { country: "1A" }],
    ["companyDomain", { companyDomain: "not a domain" }],
    ["phone", { phone: "1".repeat(41) }],
    ["firstName", { firstName: "x".repeat(101) }],
    ["email", { email: `${"a".repeat(250)}@acme.com` }],
  ])("rejects invalid %s %j", async (path, fields) => {
    const { b } = await signedUp(app);
    const res = await b.post("/v1/contacts", { email: "v@acme.com", ...fields }).expect(400);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(0);
  });

  it("lists 50 per page by default, newest first, with a total", async () => {
    const { b } = await signedUp(app);
    const emails = Array.from({ length: 51 }, (_, i) => `p${String(i).padStart(2, "0")}@acme.com`);
    await b
      .post("/v1/contacts/import", {
        csv: ["email", ...emails].join("\n"),
        duplicates: "skip",
        confirmLawfulBasis: true,
      })
      .expect(200);
    const page1 = await b.get("/v1/contacts").expect(200);
    expect(page1.body.items).toHaveLength(50);
    expect(page1.body.total).toBe(51);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await b.get(`/v1/contacts?cursor=${page1.body.nextCursor as string}`).expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    const seen = new Set(
      [...page1.body.items, ...page2.body.items].map((c: { email: string }) => c.email),
    );
    expect(seen.size).toBe(51);
  });

  it("searches last name, email and company domain case-insensitively", async () => {
    const { b } = await signedUp(app);
    await b
      .post("/v1/contacts", { email: "zed@umbrella.org", firstName: "Zed", lastName: "Quarry" })
      .expect(201);
    await b.post("/v1/contacts", { email: "amy@other.net" }).expect(201);
    for (const q of ["QUARRY", "ZED@UMB", "umbrella.org", "zed quarry"]) {
      const res = await b.get(`/v1/contacts?q=${encodeURIComponent(q)}`).expect(200);
      expect(res.body.items.map((c: { email: string }) => c.email)).toEqual(["zed@umbrella.org"]);
    }
  });

  it("search treats % _ and \\ literally and never matches everything", async () => {
    const { b } = await signedUp(app);
    await b.post("/v1/contacts", { email: "plain@acme.com", firstName: "Plain" }).expect(201);
    await b.post("/v1/contacts", { email: "other@globex.io", firstName: "Other" }).expect(201);
    for (const q of ["%", "%%", "_", "__", "%_%", "\\", "\\%", "'", "' OR '1'='1"]) {
      const res = await b.get(`/v1/contacts?q=${encodeURIComponent(q)}`).expect(200);
      expect(res.body.total, `q=${q}`).toBe(0);
    }
    await b.post("/v1/contacts", { email: "under_score@acme.com", firstName: "100%" }).expect(201);
    const us = await b.get(`/v1/contacts?q=${encodeURIComponent("_")}`).expect(200);
    expect(us.body.items.map((c: { email: string }) => c.email)).toEqual(["under_score@acme.com"]);
    const pct = await b.get(`/v1/contacts?q=${encodeURIComponent("0%")}`).expect(200);
    expect(pct.body.total).toBe(1);
  });

  it.each([
    ["garbage", "garbage"],
    ["empty-ish base64", Buffer.from("|").toString("base64url")],
    ["missing id", Buffer.from("2026-01-01T00:00:00Z|").toString("base64url")],
    ["sql in cursor", Buffer.from("2026-01-01T00:00:00Z|' OR 1=1 --").toString("base64url")],
    ["too long", "a".repeat(201)],
  ])("a tampered cursor (%s) is 400, never 500", async (_name, cursor) => {
    const { b } = await signedUp(app);
    await b.post("/v1/contacts", { email: "c@acme.com" }).expect(201);
    const res = await b.get(`/v1/contacts?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe("validation_error");
  });

  // Regression: this returned 500 before decodeCursor validated the date.
  it("a cursor with an impossible timestamp is 400, never 500", async () => {
    const { b } = await signedUp(app);
    await b.post("/v1/contacts", { email: "c@acme.com" }).expect(201);
    const cursor = Buffer.from(
      "2026-13-45T25:61:61Z|00000000-0000-4000-8000-000000000000",
    ).toString("base64url");
    const res = await b.get(`/v1/contacts?cursor=${cursor}`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe("validation_error");
  });

  it.each(["0", "101", "abc", "-1", "1.5"])("limit=%s is a validation error", async (limit) => {
    const { b } = await signedUp(app);
    const res = await b.get(`/v1/contacts?limit=${limit}`).expect(400);
    expect(res.body.code).toBe("validation_error");
  });

  it("changing the company domain re-links the company", async () => {
    const { b } = await signedUp(app);
    const c = await b.post("/v1/contacts", { email: "kim@initech.com" }).expect(201);
    const res = await b
      .patch(`/v1/contacts/${c.body.id as string}`, { companyDomain: "hooli.com" })
      .expect(200);
    expect(res.body.company.domain).toBe("hooli.com");
    expect(res.body.email).toBe("kim@initech.com");
  });

  // Fixed in Sprint 3: consent needs a source and date, so PATCH refuses it and points to
  // PUT /v1/contacts/:id/consent (which validates both).
  it("a consent basis other than none requires a date", async () => {
    const { b } = await signedUp(app);
    const c = await b.post("/v1/contacts", { email: "consent@acme.com" }).expect(201);
    const res = await b
      .patch(`/v1/contacts/${c.body.id as string}`, { consentBasis: "express" })
      .expect(400);
    expect(res.body.code).toBe("use_consent_endpoint");
    const noDate = await b
      .put(`/v1/contacts/${c.body.id as string}/consent`, { basis: "express", source: "Form" })
      .expect(400);
    expect(noDate.body.code).toBe("validation_error");
    expect((await b.get(`/v1/contacts/${c.body.id as string}`)).body.consentBasis).toBe("none");
  });

  it("reps cannot record a consent basis other than none; managers can", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await joinAs(app, owner, "rep");
    const manager = await joinAs(app, owner, "manager");
    const c = await rep.post("/v1/contacts", { email: "rep-consent@acme.com" }).expect(201);
    const id = c.body.id as string;

    const res = await rep.patch(`/v1/contacts/${id}`, { consentBasis: "express" }).expect(403);
    expect(res.body.code).toBe("forbidden");
    await rep
      .post("/v1/contacts", { email: "rep-consent2@acme.com", consentBasis: "implied_inquiry" })
      .expect(403);
    await rep.patch(`/v1/contacts/${id}`, { consentBasis: "none" }).expect(200);
    await rep.patch(`/v1/contacts/${id}`, { title: "Still editable" }).expect(200);
    expect((await owner.get(`/v1/contacts/${id}`).expect(200)).body.consentBasis).toBe("none");

    await manager
      .put(`/v1/contacts/${id}/consent`, {
        basis: "express",
        source: "Signed up at a webinar",
        obtainedAt: "2026-01-15",
      })
      .expect(200);
    expect((await owner.get(`/v1/contacts/${id}`).expect(200)).body.consentBasis).toBe("express");
  });

  it("a non-import JSON body over 100 KB is 413 payload_too_large", async () => {
    const { b } = await signedUp(app);
    const res = await b
      .post("/v1/contacts", { email: "big@acme.com", title: "t".repeat(110 * 1024) })
      .expect(413);
    expect(res.body.code).toBe("payload_too_large");
    await b
      .patch("/v1/contacts/00000000-0000-4000-8000-000000000000", {
        firstName: "f".repeat(110 * 1024),
      })
      .expect(413);
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(0);
    // Imports keep their larger limit.
    await b
      .post("/v1/contacts/import/preview", {
        csv: `email,notes\na@acme.com,${"n".repeat(200_000)}`,
      })
      .expect(200);
  });

  it("delete is permanent: the same email can be added again", async () => {
    const { b } = await signedUp(app);
    const c = await b.post("/v1/contacts", { email: "again@acme.com" }).expect(201);
    await b.delete(`/v1/contacts/${c.body.id as string}`).expect(200);
    await b.get(`/v1/contacts/${c.body.id as string}`).expect(404);
    await b.post("/v1/contacts", { email: "again@acme.com" }).expect(201);
  });

  // BUG: managers can add to the suppression list through DELETE /v1/contacts/:id?suppress=true,
  // although POST /v1/suppressions is owner/admin only (and PRD OL-E2 shows the suppress option
  // only to owners and admins). Repro: as a manager, DELETE /v1/contacts/<id>?suppress=true → 200
  // and the email appears in GET /v1/suppressions.
  it("a manager cannot add a suppression via delete ?suppress=true", async () => {
    const { b: owner } = await signedUp(app);
    const manager = await joinAs(app, owner, "manager");
    const c = await owner.post("/v1/contacts", { email: "mgr-del@acme.com" }).expect(201);
    const res = await manager.delete(`/v1/contacts/${c.body.id as string}?suppress=true`);
    const list = await owner.get("/v1/suppressions").expect(200);
    if (res.status === 200) {
      expect(list.body.map((s: { value: string }) => s.value)).not.toContain("mgr-del@acme.com");
    } else {
      expect(res.status).toBe(403);
      await owner.get(`/v1/contacts/${c.body.id as string}`).expect(200);
    }
  });

  it("?suppress with a junk value is a validation error and deletes nothing", async () => {
    const { b } = await signedUp(app);
    const c = await b.post("/v1/contacts", { email: "junk@acme.com" }).expect(201);
    await b.delete(`/v1/contacts/${c.body.id as string}?suppress=yes`).expect(400);
    await b.get(`/v1/contacts/${c.body.id as string}`).expect(200);
  });
});

// =====================================================================================
// CSV import.
// =====================================================================================

describe("acceptance: CSV import", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const preview = (b: Browser, csv: string) => b.post("/v1/contacts/import/preview", { csv });
  const commit = (b: Browser, csv: string) =>
    b.post("/v1/contacts/import", { csv, duplicates: "skip", confirmLawfulBasis: true });

  it("strips a UTF-8 BOM and handles CRLF line endings (comma)", async () => {
    const { b } = await signedUp(app);
    const csv = "﻿Email,First Name,Last Name\r\na@acme.com,Ann,Lee\r\nb@acme.com,Bo,Ng\r\n";
    const res = await preview(b, csv).expect(200);
    expect(res.body).toMatchObject({ totalRows: 2, newCount: 2, invalidCount: 0, delimiter: "," });
    expect(Object.keys(res.body.mapping as object)[0]).toBe("Email");
    expect(res.body.mapping).toEqual({
      Email: "email",
      "First Name": "firstName",
      "Last Name": "lastName",
    });
    expect(res.body.sample[1]).toMatchObject({ email: "b@acme.com", lastName: "Ng" });
    await commit(b, csv).expect(200);
    const list = await b.get("/v1/contacts").expect(200);
    expect(list.body.items.map((c: { lastName: string }) => c.lastName).sort()).toEqual([
      "Lee",
      "Ng",
    ]);
  });

  it("detects a tab-separated file, including quoted fields with tabs", async () => {
    const { b } = await signedUp(app);
    const csv = 'email\ttitle\tcompany\nt@acme.com\t"VP\tSales"\t"Acme, Inc."\n';
    const res = await preview(b, csv).expect(200);
    expect(res.body).toMatchObject({ delimiter: "\t", totalRows: 1, newCount: 1 });
    expect(res.body.sample[0]).toMatchObject({
      email: "t@acme.com",
      title: "VP\tSales",
      companyName: "Acme, Inc.",
    });
  });

  it("parses quoted fields with embedded CRLF line breaks and doubled quotes (RFC 4180)", async () => {
    const { b } = await signedUp(app);
    const csv = 'email,title\r\nq@acme.com,"He said ""hi""\r\nthen left"\r\nr@acme.com,"a,b"\r\n';
    const res = await preview(b, csv).expect(200);
    expect(res.body).toMatchObject({ totalRows: 2, newCount: 2, invalidCount: 0 });
    expect(res.body.sample[0].title).toBe('He said "hi"\r\nthen left');
    expect(res.body.sample[1].title).toBe("a,b");
  });

  it("accepts exactly 10,000 data rows (header excluded)", async () => {
    const { b } = await signedUp(app);
    const rows = Array.from({ length: 10_000 }, (_, i) => `ok${i}@acme.com`);
    const res = await preview(b, ["email", ...rows].join("\n")).expect(200);
    expect(res.body.totalRows).toBe(10_000);
    expect(res.body.newCount).toBe(10_000);
  });

  it("rejects 10,001 rows with too_many_rows before preview, and saves nothing", async () => {
    const { b } = await signedUp(app);
    const rows = Array.from({ length: 10_001 }, (_, i) => `big${i}@acme.com`);
    const csv = ["email", ...rows].join("\n");
    const res = await preview(b, csv).expect(400);
    expect(res.body.code).toBe("too_many_rows");
    expect(res.body.message).toContain("10,001");
    expect(res.body.message).toContain("10,000");
    await commit(b, csv).expect(400);
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(0);
  });

  it("rejects a file over 5 MB (400) and a request over the body limit (413)", async () => {
    const { b } = await signedUp(app);
    const header = "email,notes\n";
    const filler = "x".repeat(5 * 1024 * 1024 + 1 - header.length - "a@acme.com,".length);
    const csv = `${header}a@acme.com,${filler}`;
    expect(csv.length).toBe(5 * 1024 * 1024 + 1);
    const res = await preview(b, csv);
    expect([400, 413]).toContain(res.status);
    if (res.status === 400) expect(res.body.code).toBe("validation_error");
    const commitRes = await commit(b, csv);
    expect([400, 413]).toContain(commitRes.status);

    const huge = await preview(b, "email\n" + "y".repeat(7 * 1024 * 1024));
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe("payload_too_large");
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(0);
  });

  it("a binary (.xlsx-like) file is rejected with 400, not 500", async () => {
    const { b } = await signedUp(app);
    const xlsx =
      "PK\u0003\u0004\u0014\u0000\u0006\u0000\b\u0000\u0000\u0000!\u0000[Content_Types].xml";
    const res = await preview(b, xlsx);
    expect(res.status).toBe(400);
  });

  it("an empty csv is a validation error", async () => {
    const { b } = await signedUp(app);
    const res = await preview(b, "").expect(400);
    expect(res.body.code).toBe("validation_error");
  });

  it("an in-file duplicate is reported against the first row and counted once", async () => {
    const { b } = await signedUp(app);
    const csv = "email\nJane@acme.com\nx1@acme.com\njane@ACME.com\n";
    const res = await preview(b, csv).expect(200);
    expect(res.body).toMatchObject({ totalRows: 3, newCount: 2, invalidCount: 1 });
    expect(res.body.invalid).toEqual([{ row: 3, reason: "Duplicate of row 1" }]);
  });

  it("import requires confirmLawfulBasis to be exactly true", async () => {
    const { b } = await signedUp(app);
    for (const confirmLawfulBasis of ["true", 1, null]) {
      await b
        .post("/v1/contacts/import", {
          csv: "email\nl@acme.com",
          duplicates: "skip",
          confirmLawfulBasis,
        })
        .expect(400);
    }
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(0);
  });

  it("an unknown duplicates mode is a validation error", async () => {
    const { b } = await signedUp(app);
    await b
      .post("/v1/contacts/import", {
        csv: "email\nm@acme.com",
        duplicates: "overwrite",
        confirmLawfulBasis: true,
      })
      .expect(400);
  });

  it("concurrent identical imports never create duplicates", async () => {
    const { b } = await signedUp(app);
    const csv = "email\nrace1@acme.com\nrace2@acme.com\n";
    const [r1, r2] = await Promise.all([commit(b, csv), commit(b, csv)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.created + r2.body.created).toBe(2);
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(2);
  });
});

// =====================================================================================
// Suppressions.
// =====================================================================================

describe("acceptance: suppressions", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("trims and lower-cases domains; rejects unknown reasons", async () => {
    const { b } = await signedUp(app);
    const res = await b
      .post("/v1/suppressions", { value: "  @ACME.com ", reason: "competitor" })
      .expect(201);
    expect(res.body.value).toBe("@acme.com");
    const bad = await b
      .post("/v1/suppressions", { value: "x@acme.com", reason: "because" })
      .expect(400);
    expect(bad.body.code).toBe("validation_error");
  });

  it.each(["bounced", "competitor", "other"])(
    "an entry with reason %s can be removed",
    async (reason) => {
      const { b } = await signedUp(app);
      const s = await b.post("/v1/suppressions", { value: "r@acme.com", reason }).expect(201);
      await b.delete(`/v1/suppressions/${s.body.id as string}`).expect(200);
    },
  );

  it("an admin cannot remove a locked opt-out either", async () => {
    const { b: owner } = await signedUp(app);
    const admin = await joinAs(app, owner, "admin");
    const s = await owner
      .post("/v1/suppressions", { value: "optout@acme.com", reason: "unsubscribed" })
      .expect(201);
    const res = await admin.delete(`/v1/suppressions/${s.body.id as string}`).expect(409);
    expect(res.body.code).toBe("suppression_locked");
  });
});
