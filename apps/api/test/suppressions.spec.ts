import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, joinAs, signedUp } from "./helpers";

describe("suppression list", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("owners add emails and domains; duplicates are a conflict", async () => {
    const { b } = await signedUp(app);
    const res = await b
      .post("/v1/suppressions", { value: "  Jane@Acme.com ", reason: "competitor" })
      .expect(201);
    expect(res.body).toMatchObject({ value: "jane@acme.com", reason: "competitor" });
    await b.post("/v1/suppressions", { value: "@globex.io", reason: "other" }).expect(201);

    const dup = await b
      .post("/v1/suppressions", { value: "jane@acme.com", reason: "other" })
      .expect(409);
    expect(dup.body.code).toBe("conflict");

    const bad = await b.post("/v1/suppressions", { value: "nope", reason: "other" }).expect(400);
    expect(bad.body.code).toBe("validation_error");

    const list = await b.get("/v1/suppressions").expect(200);
    expect(list.body.map((s: { value: string }) => s.value).sort()).toEqual([
      "@globex.io",
      "jane@acme.com",
    ]);
  });

  it("removes ordinary entries but locks opt-outs", async () => {
    const { b } = await signedUp(app);
    const other = await b.post("/v1/suppressions", { value: "a@acme.com", reason: "other" });
    const unsub = await b.post("/v1/suppressions", { value: "b@acme.com", reason: "unsubscribed" });
    const asked = await b.post("/v1/suppressions", {
      value: "c@acme.com",
      reason: "asked_not_to_contact",
    });

    await b.delete(`/v1/suppressions/${other.body.id as string}`).expect(200);
    const locked = await b.delete(`/v1/suppressions/${unsub.body.id as string}`).expect(409);
    expect(locked.body.code).toBe("suppression_locked");
    await b.delete(`/v1/suppressions/${asked.body.id as string}`).expect(409);
    await b.delete(`/v1/suppressions/${other.body.id as string}`).expect(404);

    const list = await b.get("/v1/suppressions").expect(200);
    expect(list.body).toHaveLength(2);
  });

  it("reps and managers can list but not add or remove", async () => {
    const { b: owner } = await signedUp(app);
    const entry = await owner
      .post("/v1/suppressions", { value: "x@acme.com", reason: "other" })
      .expect(201);
    const rep = await joinAs(app, owner, "rep");
    const manager = await joinAs(app, owner, "manager");
    const admin = await joinAs(app, owner, "admin");

    await rep.post("/v1/suppressions", { value: "y@acme.com", reason: "other" }).expect(403);
    await manager.post("/v1/suppressions", { value: "y@acme.com", reason: "other" }).expect(403);
    await rep.delete(`/v1/suppressions/${entry.body.id as string}`).expect(403);
    expect((await rep.get("/v1/suppressions").expect(200)).body).toHaveLength(1);

    await admin.post("/v1/suppressions", { value: "y@acme.com", reason: "other" }).expect(201);
    await admin.delete(`/v1/suppressions/${entry.body.id as string}`).expect(200);
  });

  it("keeps workspaces isolated", async () => {
    const { b: a } = await signedUp(app);
    const { b: other } = await signedUp(app);
    const entry = await a.post("/v1/suppressions", { value: "z@acme.com", reason: "other" });
    expect((await other.get("/v1/suppressions").expect(200)).body).toEqual([]);
    await other.delete(`/v1/suppressions/${entry.body.id as string}`).expect(404);
    // The same value can be listed independently in another workspace.
    await other.post("/v1/suppressions", { value: "z@acme.com", reason: "other" }).expect(201);
  });
});
