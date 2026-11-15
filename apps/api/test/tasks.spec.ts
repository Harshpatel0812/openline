/**
 * Sprint 5 (OL-E6 §1): tasks — list filters, counts, create/edit/close, who sees what, audit.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import { auditLog, eq, tasks, withTenant, type DatabaseHandle } from "@openline/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB } from "../src/database/database.module";
import { dayWindow } from "../src/modules/tasks/tasks.service";
import { browser, createTestApp, joinAs, signedUp, type Browser } from "./helpers";

const missingId = "00000000-0000-4000-8000-000000000000";
const HOUR = 3_600_000;

describe("tasks (Sprint 5)", () => {
  let app: NestExpressApplication;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    app = await createTestApp();
    handle = app.get<DatabaseHandle>(DB);
  });
  afterAll(async () => {
    await app.close();
  });

  const me = async (b: Browser) => (await b.get("/v1/auth/me").expect(200)).body;
  const create = (b: Browser, body: object) => b.post("/v1/tasks", body);

  it("creates, edits, completes and dismisses a task (audited, no personal data)", async () => {
    const { b } = await signedUp(app);
    const contact = await b.post("/v1/contacts", { email: "lee@buyer.com" }).expect(201);
    const dueAt = new Date(Date.now() + 2 * HOUR).toISOString();
    const res = await create(b, {
      title: "Call Lee about pricing",
      notes: "Mention the 8-seat plan",
      dueAt,
      kind: "call",
      contactId: contact.body.id,
    }).expect(201);
    const ws = (await me(b)).workspace.id as string;
    expect(res.body).toMatchObject({
      title: "Call Lee about pricing",
      kind: "call",
      source: "manual",
      status: "open",
      dueAt,
      overdue: false,
      dueSoon: true,
      contact: { id: contact.body.id, email: "lee@buyer.com" },
      owner: { id: (await me(b)).user.id, name: "Test User" },
      promiseId: null,
    });
    const id = res.body.id as string;

    const edited = await b
      .patch(`/v1/tasks/${id}`, { title: "Call Lee", dueAt: null, notes: null })
      .expect(200);
    expect(edited.body).toMatchObject({ title: "Call Lee", dueAt: null, notes: null });
    expect((await b.get(`/v1/tasks/${id}`).expect(200)).body.title).toBe("Call Lee");

    const done = await b.post(`/v1/tasks/${id}/complete`).expect(200);
    expect(done.body).toMatchObject({ status: "done" });
    expect(done.body.completedAt).not.toBeNull();
    // Idempotent; but a done task can't be dismissed or edited.
    await b.post(`/v1/tasks/${id}/complete`).expect(200);
    expect((await b.post(`/v1/tasks/${id}/dismiss`).expect(409)).body.code).toBe("task_closed");
    expect((await b.patch(`/v1/tasks/${id}`, { title: "x" }).expect(409)).body.code).toBe(
      "task_closed",
    );

    const other = await create(b, { title: "Something" }).expect(201);
    await b.post(`/v1/tasks/${other.body.id as string}/dismiss`).expect(200);
    await b.post(`/v1/tasks/${other.body.id as string}/dismiss`).expect(200);

    const audit = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entity, "task")),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "task.completed",
      "task.created",
      "task.created",
      "task.dismissed",
      "task.updated",
    ]);
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toMatch(/Lee|pricing|8-seat/);
  });

  it("validates input", async () => {
    const { b } = await signedUp(app);
    for (const body of [
      {},
      { title: "" },
      { title: "x".repeat(201) },
      { title: "ok", notes: "x".repeat(2001) },
      { title: "ok", dueAt: "tomorrow" },
      { title: "ok", kind: "meeting" },
      { title: "ok", contactId: "nope" },
      { title: "ok", source: "promise" },
    ]) {
      const res = await create(b, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("validation_error");
    }
    const t = await create(b, { title: "ok" }).expect(201);
    await b.patch(`/v1/tasks/${t.body.id as string}`, {}).expect(400);
    await b.patch(`/v1/tasks/${t.body.id as string}`, { status: "done" }).expect(400);
    await b.get("/v1/tasks?due=someday").expect(400);
    await b.get("/v1/tasks/not-a-uuid").expect(400);
  });

  it("lists by due window in the workspace time zone, and counts my open tasks", async () => {
    const { b } = await signedUp(app);
    const now = Date.now();
    const w = dayWindow("America/New_York", new Date(now));
    const at = (ms: number) => new Date(ms).toISOString();
    await create(b, { title: "late", dueAt: at(now - HOUR) }).expect(201);
    await create(b, {
      title: "today",
      dueAt: at(Math.min(now + 60_000, w.tomorrow.getTime() - 1)),
    });
    await create(b, { title: "soon", dueAt: at(w.tomorrow.getTime() + HOUR) }).expect(201);
    await create(b, { title: "far", dueAt: at(w.upcomingEnd.getTime() + HOUR) }).expect(201);
    await create(b, { title: "undated" }).expect(201);
    const closed = await create(b, { title: "closed", dueAt: at(now - HOUR) }).expect(201);
    await b.post(`/v1/tasks/${closed.body.id as string}/complete`).expect(200);

    const titles = async (q: string) =>
      ((await b.get(`/v1/tasks${q}`).expect(200)).body as { title: string }[]).map((t) => t.title);
    expect(await titles("?due=overdue")).toEqual(["late"]);
    expect(await titles("?due=today")).toEqual(["today"]);
    expect(await titles("?due=upcoming")).toEqual(["soon"]);
    expect(await titles("?due=none")).toEqual(["undated"]);
    expect(await titles("")).toEqual(["late", "today", "soon", "far", "undated"]);
    expect(await titles("?status=done")).toEqual(["closed"]);
    const late = (await b.get("/v1/tasks?due=overdue").expect(200)).body[0];
    expect(late).toMatchObject({ overdue: true, dueSoon: false });

    expect((await b.get("/v1/tasks/counts").expect(200)).body).toEqual({
      overdue: 1,
      dueToday: 1,
      upcoming: 1,
    });
  });

  it("reps see and edit only their own tasks; managers see and assign everyone's", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await joinAs(app, owner, "rep");
    const rep2 = await joinAs(app, owner, "rep");
    const manager = await joinAs(app, owner, "manager");
    const repId = (await me(rep)).user.id as string;

    const mine = await create(rep, { title: "rep's own" }).expect(201);
    const id = mine.body.id as string;
    // Another rep: invisible (404) for every operation; can't list everyone's.
    await rep2.get(`/v1/tasks/${id}`).expect(404);
    await rep2.patch(`/v1/tasks/${id}`, { title: "mine now" }).expect(404);
    await rep2.post(`/v1/tasks/${id}/complete`).expect(404);
    await rep2.post(`/v1/tasks/${id}/dismiss`).expect(404);
    expect((await rep2.get("/v1/tasks?scope=all").expect(403)).body.code).toBe("forbidden");
    expect((await rep2.get("/v1/tasks").expect(200)).body).toEqual([]);
    // Reps can't assign or reassign.
    await create(rep2, { title: "for you", ownerId: repId }).expect(403);
    await rep.patch(`/v1/tasks/${id}`, { ownerId: (await me(rep2)).user.id }).expect(403);

    // Managers: everyone's, assign to a member, reassign, close.
    const all = (await manager.get("/v1/tasks?scope=all").expect(200)).body as { id: string }[];
    expect(all.map((t) => t.id)).toContain(id);
    expect((await manager.get("/v1/tasks").expect(200)).body).toEqual([]);
    const assigned = await create(manager, { title: "for the rep", ownerId: repId }).expect(201);
    expect(assigned.body.owner.id).toBe(repId);
    expect(((await rep.get("/v1/tasks").expect(200)).body as unknown[]).length).toBe(2);
    await create(manager, { title: "x", ownerId: missingId }).expect(404);
    await manager.patch(`/v1/tasks/${id}`, { title: "edited by manager" }).expect(200);
    await manager.post(`/v1/tasks/${id}/complete`).expect(200);
  });

  it("another workspace's tasks, contacts and members look like 404", async () => {
    const { b: a } = await signedUp(app);
    const { b: other } = await signedUp(app);
    const task = await create(other, { title: "theirs" }).expect(201);
    const theirContact = await other.post("/v1/contacts", { email: "x@y.com" }).expect(201);
    const theirUser = (await me(other)).user.id as string;
    const id = task.body.id as string;

    await a.get(`/v1/tasks/${id}`).expect(404);
    await a.patch(`/v1/tasks/${id}`, { title: "hacked" }).expect(404);
    await a.post(`/v1/tasks/${id}/complete`).expect(404);
    await a.post(`/v1/tasks/${id}/dismiss`).expect(404);
    expect((await a.get("/v1/tasks?scope=all").expect(200)).body).toEqual([]);
    await create(a, { title: "x", contactId: theirContact.body.id }).expect(404);
    await create(a, { title: "x", ownerId: theirUser }).expect(404);
    await a.get(`/v1/tasks/${missingId}`).expect(404);

    const ws = (await me(other)).workspace.id as string;
    const [row] = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
      tx.select().from(tasks).where(eq(tasks.id, id)),
    );
    expect(row).toMatchObject({ title: "theirs", status: "open" });
  });

  it("needs a session", async () => {
    const anon = browser(app);
    await anon.get("/v1/tasks").expect(401);
    await anon.get("/v1/tasks/counts").expect(401);
    await anon.post("/v1/tasks", { title: "x" }).expect(401);
  });
});
