/**
 * Plan picked on /pricing survives sign-up and can be set or changed later (PUT
 * /v1/workspace/plan-choice). Billing isn't switched on: this is intent only.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import { auditLog, eq, workspaces, type DatabaseHandle } from "@openline/db";
import { PLAN_IDS } from "@openline/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB } from "../src/database/database.module";
import { browser, createTestApp, joinAs, PASSWORD, signedUp, uniqueEmail } from "./helpers";

describe("plan choice", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function signupWith(extra: Record<string, unknown>) {
    const b = browser(app);
    const res = await b.post("/v1/auth/signup", {
      name: "Plan Picker",
      email: uniqueEmail("plan"),
      password: PASSWORD,
      workspaceName: "Picked Co",
      ...extra,
    });
    return { b, res };
  }

  async function auditRows(workspaceId: string) {
    const handle = app.get<DatabaseHandle>(DB);
    return handle.db.select().from(auditLog).where(eq(auditLog.workspaceId, workspaceId));
  }

  it("keeps the database enum in step with the shared plan ids", () => {
    expect(workspaces.chosenPlan.enumValues).toEqual([...PLAN_IDS]);
  });

  it("stores the plan picked at sign-up and returns it from /auth/me", async () => {
    const { b, res } = await signupWith({ plan: "team", billing: "annual" });
    expect(res.status).toBe(201);
    const me = await b.get("/v1/auth/me").expect(200);
    expect(me.body.workspace).toMatchObject({
      plan: "trial",
      chosenPlan: "team",
      chosenBilling: "annual",
    });
    const created = (await auditRows(me.body.workspace.id)).find(
      (r) => r.action === "workspace.created",
    );
    expect(created?.metadata).toEqual({ chosenPlan: "team", chosenBilling: "annual" });
  });

  it("defaults billing to monthly when only a plan is given", async () => {
    const { b } = await signupWith({ plan: "solo" });
    const me = await b.get("/v1/auth/me").expect(200);
    expect(me.body.workspace).toMatchObject({ chosenPlan: "solo", chosenBilling: "monthly" });
  });

  it("leaves the choice empty when no plan was picked", async () => {
    const { b } = await signedUp(app);
    const me = await b.get("/v1/auth/me").expect(200);
    expect(me.body.workspace).toMatchObject({ chosenPlan: null, chosenBilling: null });
  });

  it("rejects an unknown plan or a billing period without a plan at sign-up", async () => {
    const bad = await signupWith({ plan: "enterprise" });
    expect(bad.res.status).toBe(400);
    expect(bad.res.body.code).toBe("validation_error");
    const orphan = await signupWith({ billing: "annual" });
    expect(orphan.res.status).toBe(400);
  });

  it("owner sets and changes the plan choice, audited, without touching the trial", async () => {
    const { b } = await signedUp(app);
    const before = await b.get("/v1/auth/me").expect(200);

    const first = await b
      .put("/v1/workspace/plan-choice", { plan: "growth", billing: "monthly" })
      .expect(200);
    expect(first.body).toEqual({ chosenPlan: "growth", chosenBilling: "monthly" });
    await b.put("/v1/workspace/plan-choice", { plan: "team", billing: "annual" }).expect(200);

    const after = await b.get("/v1/auth/me").expect(200);
    expect(after.body.workspace).toMatchObject({
      plan: "trial",
      trialEndsAt: before.body.workspace.trialEndsAt,
      chosenPlan: "team",
      chosenBilling: "annual",
    });

    const changes = (await auditRows(after.body.workspace.id)).filter(
      (r) => r.action === "workspace.plan_choice_changed",
    );
    expect(changes.map((r) => r.metadata)).toEqual([
      { from: null, to: { plan: "growth", billing: "monthly" } },
      {
        from: { plan: "growth", billing: "monthly" },
        to: { plan: "team", billing: "annual" },
      },
    ]);
  });

  it("validates the body", async () => {
    const { b } = await signedUp(app);
    const res = await b.put("/v1/workspace/plan-choice", { plan: "free", billing: "monthly" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation_error");
    await b.put("/v1/workspace/plan-choice", { plan: "team" }).expect(400);
  });

  it("admin may change it; manager and rep may not", async () => {
    const { b: owner } = await signedUp(app);
    const admin = await joinAs(app, owner, "admin");
    await admin.put("/v1/workspace/plan-choice", { plan: "scale", billing: "annual" }).expect(200);
    for (const role of ["manager", "rep"] as const) {
      const member = await joinAs(app, owner, role);
      const res = await member.put("/v1/workspace/plan-choice", {
        plan: "solo",
        billing: "monthly",
      });
      expect(res.status).toBe(403);
      // They can still see the choice.
      const me = await member.get("/v1/auth/me").expect(200);
      expect(me.body.workspace.chosenPlan).toBe("scale");
    }
  });

  it("only changes the caller's own workspace", async () => {
    const { b: a } = await signedUp(app, { workspaceName: "Tenant A" });
    const { b: other } = await signedUp(app, { workspaceName: "Tenant B" });
    await a.put("/v1/workspace/plan-choice", { plan: "growth", billing: "annual" }).expect(200);
    const meB = await other.get("/v1/auth/me").expect(200);
    expect(meB.body.workspace).toMatchObject({ chosenPlan: null, chosenBilling: null });
  });

  it("needs a session and the CSRF header", async () => {
    await browser(app)
      .put("/v1/workspace/plan-choice", { plan: "team", billing: "annual" })
      .expect(401);
    const { b } = await signedUp(app);
    await b.agent
      .put("/v1/workspace/plan-choice")
      .send({ plan: "team", billing: "annual" })
      .expect(403);
  });
});
