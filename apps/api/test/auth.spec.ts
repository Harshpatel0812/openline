import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, createTestApp, PASSWORD, signedUp, uniqueEmail } from "./helpers";

describe("auth", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("signs up, creates a workspace with the user as owner, and starts a session", async () => {
    const { b, email } = await signedUp(app, { workspaceName: "Jersey Widgets" });
    const me = await b.get("/v1/auth/me").expect(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.role).toBe("owner");
    expect(me.body.workspace.name).toBe("Jersey Widgets");
    expect(me.body.workspace.plan).toBe("trial");
    expect(me.body.workspaces).toHaveLength(1);
  });

  it("sets an httpOnly, SameSite=Lax session cookie", async () => {
    const res = await browser(app).post("/v1/auth/signup", {
      name: "Cookie",
      email: uniqueEmail(),
      password: PASSWORD,
      workspaceName: "W",
    });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects weak passwords and invalid emails with field errors", async () => {
    const res = await browser(app)
      .post("/v1/auth/signup", { name: "X", email: "nope", password: "short", workspaceName: "W" })
      .expect(400);
    expect(res.body.code).toBe("validation_error");
    const fields = res.body.details.map((d: { path: string }) => d.path);
    expect(fields).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("treats emails case-insensitively and refuses duplicate accounts", async () => {
    const email = uniqueEmail("Dup");
    await signedUp(app, { email });
    const res = await browser(app)
      .post("/v1/auth/signup", {
        name: "X",
        email: email.toUpperCase(),
        password: PASSWORD,
        workspaceName: "W",
      })
      .expect(409);
    expect(res.body.code).toBe("email_taken");
  });

  it("logs out, then logs back in", async () => {
    const { b, email } = await signedUp(app);
    await b.post("/v1/auth/logout").expect(200);
    await b.get("/v1/auth/me").expect(401);
    await b.post("/v1/auth/login", { email, password: PASSWORD }).expect(200);
    await b.get("/v1/auth/me").expect(200);
  });

  it("gives the same error for unknown email and wrong password", async () => {
    const { email } = await signedUp(app);
    const wrong = await browser(app)
      .post("/v1/auth/login", { email, password: "wrong password!!" })
      .expect(401);
    const unknown = await browser(app)
      .post("/v1/auth/login", { email: uniqueEmail("ghost"), password: "wrong password!!" })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe("invalid_credentials");
  });

  it("rate-limits repeated failed logins for one account", async () => {
    const { email } = await signedUp(app);
    const b = browser(app);
    for (let i = 0; i < 10; i += 1) {
      await b.post("/v1/auth/login", { email, password: "wrong password!!" }).expect(401);
    }
    const res = await b.post("/v1/auth/login", { email, password: PASSWORD }).expect(429);
    expect(res.body.code).toBe("rate_limited");
  });

  it("blocks state-changing requests without the CSRF header", async () => {
    const { b } = await signedUp(app);
    const res = await b.agent.post("/v1/auth/logout").expect(403);
    expect(res.body.code).toBe("csrf");
  });

  it("requires a session for protected routes", async () => {
    const res = await browser(app).get("/v1/members").expect(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("ignores a forged session cookie", async () => {
    await browser(app)
      .agent.get("/v1/auth/me")
      .set("Cookie", "ol_session=forged-token-forged-token-forged-token")
      .expect(401);
  });

  it("sends security headers", async () => {
    const res = await browser(app).get("/health").expect(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
