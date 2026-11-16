/**
 * Sprint 6 (OL-E7 §1–3): pipeline stages, deals, board data, summary, move rules, timeline,
 * stale / next-step flags, Today's "deals needing attention", and who may do what.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  auditLog,
  dealStageHistory,
  deals,
  eq,
  mailboxes,
  messages,
  sql,
  withTenant,
  type DatabaseHandle,
} from "@openline/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB } from "../src/database/database.module";
import { calendarWindow } from "../src/modules/deals/deal-rules";
import { createTestApp, joinAs, signedUp, uniqueEmail, type Browser } from "./helpers";

const missingId = "00000000-0000-4000-8000-000000000000";
const DAY = 86_400_000;

interface Stage {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
  probability: number;
  position: number;
  staleAfterDays: number | null;
  entryCriteria: { label: string; evidence: string }[];
  dealCount: number;
}

describe("pipeline and deals (Sprint 6)", () => {
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
  const wsOf = async (b: Browser) => (await me(b)).workspace.id as string;
  const userOf = async (b: Browser) => (await me(b)).user.id as string;
  const stagesOf = async (b: Browser) =>
    (await b.get("/v1/pipeline/stages").expect(200)).body as Stage[];
  const stageNamed = async (b: Browser, name: string) =>
    (await stagesOf(b)).find((s) => s.name === name)!;
  const contact = async (b: Browser, email = uniqueEmail("lead"), company?: string) =>
    (
      await b
        .post("/v1/contacts", { email, ...(company ? { companyName: company } : {}) })
        .expect(201)
    ).body as { id: string; company: { id: string; name: string } | null };
  const deal = async (b: Browser, body: object = {}) =>
    (await b.post("/v1/deals", { name: "Acme — new deal", ...body }).expect(201)).body;
  const toInput = (stages: Stage[]) =>
    stages.map(({ id, name, kind, probability, staleAfterDays, entryCriteria }) => ({
      id,
      name,
      kind,
      probability,
      staleAfterDays,
      entryCriteria,
    }));
  const setActivity = (ws: string, id: string, at: Date) =>
    withTenant(handle.db, { workspaceId: ws }, (tx) =>
      tx.update(deals).set({ lastActivityAt: at }).where(eq(deals.id, id)),
    );

  // ---------------------------------------------------------------- stages

  describe("stages", () => {
    it("every new workspace starts with the default stages", async () => {
      const { b } = await signedUp(app);
      const stages = await stagesOf(b);
      expect(stages.map((s) => [s.name, s.probability, s.kind, s.staleAfterDays])).toEqual([
        ["Discovery", 10, "open", 14],
        ["Qualified", 25, "open", 14],
        ["Proposal", 50, "open", 14],
        ["Negotiation", 75, "open", 14],
        ["Won", 100, "won", null],
        ["Lost", 0, "lost", null],
      ]);
      expect(stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(stages[1]!.entryCriteria).toContainEqual({
        label: "Budget discussed",
        evidence: "budget_discussed",
      });
    });

    it("only owners and admins replace stages; everyone reads them", async () => {
      const { b: owner } = await signedUp(app);
      const admin = await joinAs(app, owner, "admin");
      const manager = await joinAs(app, owner, "manager");
      const rep = await joinAs(app, owner, "rep");
      const body = { stages: toInput(await stagesOf(owner)) };
      for (const who of [manager, rep]) {
        await who.get("/v1/pipeline/stages").expect(200);
        expect((await who.put("/v1/pipeline/stages", body).expect(403)).body.code).toBe(
          "forbidden",
        );
      }
      await admin.put("/v1/pipeline/stages", body).expect(200);
    });

    it("validates the list: unique names, one won, one lost, open first, limits", async () => {
      const { b } = await signedUp(app);
      const s = toInput(await stagesOf(b));
      const bad = [
        { stages: s.map((x, i) => (i === 1 ? { ...x, name: "discovery" } : x)) },
        { stages: s.map((x) => (x.kind === "lost" ? { ...x, kind: "won" } : x)) },
        { stages: s.filter((x) => x.kind !== "lost") },
        { stages: [s[4], ...s.slice(0, 4), s[5]] },
        { stages: s.map((x, i) => (i === 0 ? { ...x, name: "x".repeat(41) } : x)) },
        { stages: s.map((x, i) => (i === 0 ? { ...x, probability: 101 } : x)) },
        {
          stages: s.map((x, i) =>
            i === 0
              ? { ...x, entryCriteria: Array.from({ length: 6 }, () => ({ label: "c" })) }
              : x,
          ),
        },
        {
          stages: s.map((x, i) =>
            i === 0 ? { ...x, entryCriteria: [{ label: "c", evidence: "vibes" }] } : x,
          ),
        },
        { stages: s.map((x, i) => (i === 0 ? { ...x, staleAfterDays: 0 } : x)) },
        { stages: [...s.slice(0, 4), { ...s[0], name: "Copy" }, s[4], s[5]] },
        {},
      ];
      for (const body of bad) {
        const res = await b.put("/v1/pipeline/stages", body);
        expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400);
        expect(res.body.code).toBe("validation_error");
      }
      const unknown = [{ ...s[0]!, id: missingId }, ...s.slice(1)];
      await b.put("/v1/pipeline/stages", { stages: unknown }).expect(404);
    });

    it("renames, reorders, adds and archives; archives only empty stages", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const s = toInput(await stagesOf(b));
      const [discovery, qualified, proposal, negotiation, won, lost] = s as [
        (typeof s)[0],
        (typeof s)[0],
        (typeof s)[0],
        (typeof s)[0],
        (typeof s)[0],
        (typeof s)[0],
      ];
      const d = await deal(b, { stageId: proposal.id });
      const res = await b
        .put("/v1/pipeline/stages", {
          stages: [
            { ...qualified, name: "Qualified lead", probability: 20 },
            { ...discovery, staleAfterDays: null },
            { name: "Demo", probability: 40, entryCriteria: [{ label: "Demo booked" }] },
            proposal,
            won,
            lost,
          ],
        })
        .expect(200);
      const after = res.body as Stage[];
      expect(after.map((x) => x.name)).toEqual([
        "Qualified lead",
        "Discovery",
        "Demo",
        "Proposal",
        "Won",
        "Lost",
      ]);
      expect(after[2]).toMatchObject({
        kind: "open",
        staleAfterDays: 14,
        entryCriteria: [{ label: "Demo booked", evidence: "none" }],
      });
      expect(after.find((x) => x.name === "Proposal")!.dealCount).toBe(1);
      expect(after.find((x) => x.id === negotiation.id)).toBeUndefined();

      // Proposal holds a deal: it can't be archived or change kind.
      const withoutProposal = after.filter((x) => x.name !== "Proposal");
      const blocked = await b
        .put("/v1/pipeline/stages", { stages: toInput(withoutProposal) })
        .expect(409);
      expect(blocked.body.code).toBe("stage_has_deals");
      expect(blocked.body.details.stages).toEqual([
        { id: proposal.id, name: "Proposal", deals: 1 },
      ]);
      // Moving the deal out first makes it archivable.
      await b.post(`/v1/deals/${d.id as string}/move`, { stageId: discovery.id }).expect(200);
      await b.put("/v1/pipeline/stages", { stages: toInput(withoutProposal) }).expect(200);
      expect((await stagesOf(b)).map((x) => x.name)).not.toContain("Proposal");

      const audit = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, "pipeline.stages_updated")),
      );
      expect(audit.map((a) => a.metadata)).toContainEqual({
        added: 1,
        updated: 3,
        archived: 1,
        stages: 6,
      });
      expect(audit).toHaveLength(2);
      // The deal's history still names the archived stage.
      const history = (await b.get(`/v1/deals/${d.id as string}`).expect(200)).body.stageHistory;
      expect(history.map((h: { to: { name: string } }) => h.to.name)).toEqual([
        "Proposal",
        "Discovery",
      ]);
    });

    it("can swap which empty stage is won and lost (unique indexes respected)", async () => {
      const { b } = await signedUp(app);
      const s = toInput(await stagesOf(b));
      const swapped = [
        ...s.slice(0, 4),
        { ...s[4]!, name: "Lost now", kind: "lost", probability: 0 },
        { ...s[5]!, name: "Won now", kind: "won", probability: 100 },
      ];
      const res = await b.put("/v1/pipeline/stages", { stages: swapped }).expect(200);
      expect((res.body as Stage[]).slice(4).map((x) => [x.id, x.kind])).toEqual([
        [s[4]!.id, "lost"],
        [s[5]!.id, "won"],
      ]);
      // A stage with deals can't change kind.
      await deal(b, { stageId: s[0]!.id });
      const now = toInput(await stagesOf(b));
      const res2 = await b
        .put("/v1/pipeline/stages", {
          stages: [
            now[1],
            now[2],
            now[3],
            { ...now[4]!, kind: "open" },
            now[5],
            { ...now[0]!, kind: "lost" },
          ],
        })
        .expect(409);
      expect(res2.body.code).toBe("stage_has_deals");
    });
  });

  // ---------------------------------------------------------------- create, read, edit

  describe("deals", () => {
    it("creates a deal with defaults, contacts, history and an audit record", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const lee = await contact(b, "lee@acme.com", "Acme Tools");
      const sam = await contact(b, "sam@acme.com");
      const res = await b
        .post("/v1/deals", {
          name: "Acme Tools — new deal",
          primaryContactId: lee.id,
          contactIds: [sam.id, lee.id],
          amountMinor: 1_250_000,
          expectedCloseDate: "2026-12-31",
          nextStep: "Send the proposal",
          nextStepDate: "2026-12-01",
        })
        .expect(201);
      expect(res.body).toMatchObject({
        name: "Acme Tools — new deal",
        stage: { name: "Discovery", kind: "open", probability: 10 },
        company: { id: lee.company!.id, name: "Acme Tools" },
        primaryContact: { id: lee.id, email: "lee@acme.com" },
        owner: { id: await userOf(b), name: "Test User" },
        amountMinor: 1_250_000,
        currency: "USD",
        expectedCloseDate: "2026-12-31",
        closedAt: null,
        isStale: false,
        canEdit: true,
      });
      expect(res.body.contacts.map((c: { id: string }) => c.id).sort()).toEqual(
        [lee.id, sam.id].sort(),
      );
      expect(res.body.stageHistory).toHaveLength(1);
      expect(res.body.stageHistory[0]).toMatchObject({ from: null, to: { name: "Discovery" } });
      const audit = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, "deal.created")),
      );
      expect(audit[0]!.metadata).toEqual({
        stageId: res.body.stage.id,
        hasAmount: true,
        contacts: 2,
        assigned: false,
      });
      expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/Acme|proposal|lee@/i);
      const got = await b.get(`/v1/deals/${res.body.id as string}`).expect(200);
      expect(got.body.id).toBe(res.body.id);
    });

    it("validates input (money is integer minor units)", async () => {
      const { b } = await signedUp(app);
      const won = await stageNamed(b, "Won");
      for (const body of [
        {},
        { name: "" },
        { name: "x".repeat(121) },
        { name: "ok", amountMinor: 12.5 },
        { name: "ok", amountMinor: -1 },
        { name: "ok", amountMinor: 1_000_000_000_000 },
        { name: "ok", amountMinor: "100" },
        { name: "ok", currency: "XXQ" },
        { name: "ok", currency: "dollars" },
        { name: "ok", expectedCloseDate: "2026-02-30" },
        { name: "ok", nextStepDate: "tomorrow" },
        { name: "ok", nextStep: "x".repeat(201) },
        { name: "ok", contactIds: ["nope"] },
        { name: "ok", contactIds: Array.from({ length: 21 }, () => missingId) },
        { name: "ok", stageId: "nope" },
        { name: "ok", closedAt: "2026-01-01" },
      ]) {
        const res = await b.post("/v1/deals", body);
        expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
        expect(res.body.code).toBe("validation_error");
      }
      expect(
        (await b.post("/v1/deals", { name: "ok", stageId: won.id }).expect(400)).body.code,
      ).toBe("stage_closed");
      await b.post("/v1/deals", { name: "ok", stageId: missingId }).expect(404);
      await b.post("/v1/deals", { name: "ok", companyId: missingId }).expect(404);
      await b.post("/v1/deals", { name: "ok", primaryContactId: missingId }).expect(404);
      // 20 contacts + a different primary = 21.
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push((await contact(b)).id);
      const extra = await contact(b);
      const tooMany = await b
        .post("/v1/deals", { name: "ok", contactIds: ids, primaryContactId: extra.id })
        .expect(400);
      expect(tooMany.body.details[0].path).toBe("contactIds");
      const ok = await deal(b, { contactIds: ids, currency: "eur", amountMinor: 0 });
      expect(ok.contacts).toHaveLength(20);
      expect(ok.currency).toBe("EUR");
      await b.patch(`/v1/deals/${ok.id as string}`, {}).expect(400);
      await b.patch(`/v1/deals/${ok.id as string}`, { stageId: missingId }).expect(400);
      await b.get("/v1/deals/not-a-uuid").expect(400);
      await b.get("/v1/deals?closeFrom=2026-12-01&closeTo=2026-11-01").expect(400);
      await b.get("/v1/deals?stale=maybe").expect(400);
      await b.get("/v1/deals?limit=501").expect(400);
      await b.get("/v1/deals?cursor=garbage").expect(400);
    });

    it("defaults to the workspace currency (a workspace setting)", async () => {
      const { b } = await signedUp(app);
      expect((await b.get("/v1/workspace").expect(200)).body.currency).toBe("USD");
      expect((await b.patch("/v1/workspace", { currency: "eur" }).expect(200)).body.currency).toBe(
        "EUR",
      );
      await b.patch("/v1/workspace", { currency: "EURO" }).expect(400);
      expect((await deal(b)).currency).toBe("EUR");
      const rep = await joinAs(app, b, "rep");
      await rep.patch("/v1/workspace", { currency: "USD" }).expect(403);
    });

    it("reps read every deal but change only their own; managers change all", async () => {
      const { b: owner } = await signedUp(app);
      const manager = await joinAs(app, owner, "manager");
      const rep = await joinAs(app, owner, "rep");
      const rep2 = await joinAs(app, owner, "rep");
      const repId = await userOf(rep);
      const lost = await stageNamed(owner, "Lost");

      const ownerDeal = await deal(owner);
      const repDeal = await deal(rep, { amountMinor: 500 });
      expect(repDeal.owner.id).toBe(repId);

      // Reads: all of them, with canEdit telling the UI what's allowed.
      const asRep = await rep.get(`/v1/deals/${ownerDeal.id as string}`).expect(200);
      expect(asRep.body.canEdit).toBe(false);
      expect((await rep2.get("/v1/deals").expect(200)).body.items).toHaveLength(2);
      await rep.get(`/v1/deals/${ownerDeal.id as string}/timeline`).expect(200);

      // Writes: someone else's deal is 403 for a rep.
      await rep.patch(`/v1/deals/${ownerDeal.id as string}`, { name: "Mine now" }).expect(403);
      await rep
        .post(`/v1/deals/${ownerDeal.id as string}/move`, { stageId: lost.id, lostReason: "x" })
        .expect(403);
      await rep2.patch(`/v1/deals/${repDeal.id as string}`, { name: "x" }).expect(403);
      // Reps can't assign or reassign.
      await rep.post("/v1/deals", { name: "x", ownerId: await userOf(owner) }).expect(403);
      await rep
        .patch(`/v1/deals/${repDeal.id as string}`, { ownerId: await userOf(rep2) })
        .expect(403);
      // Their own deal: fine.
      await rep.patch(`/v1/deals/${repDeal.id as string}`, { name: "Rep deal" }).expect(200);

      // Managers edit, move and reassign anyone's deal (to members only).
      await manager.patch(`/v1/deals/${repDeal.id as string}`, { amountMinor: 900 }).expect(200);
      const reassigned = await manager
        .patch(`/v1/deals/${repDeal.id as string}`, { ownerId: await userOf(rep2) })
        .expect(200);
      expect(reassigned.body.owner.id).toBe(await userOf(rep2));
      await manager.patch(`/v1/deals/${repDeal.id as string}`, { ownerId: missingId }).expect(404);
      const assigned = await manager
        .post("/v1/deals", { name: "For rep", ownerId: repId })
        .expect(201);
      expect(assigned.body.owner.id).toBe(repId);
    });

    it("another workspace's deal looks like 404 everywhere", async () => {
      const { b: a } = await signedUp(app);
      const { b: other } = await signedUp(app);
      const d = await deal(a);
      const lost = await stageNamed(other, "Lost");
      const foreignContact = await contact(other);
      const id = d.id as string;
      await other.get(`/v1/deals/${id}`).expect(404);
      await other.get(`/v1/deals/${id}/timeline`).expect(404);
      await other.patch(`/v1/deals/${id}`, { name: "x" }).expect(404);
      await other.post(`/v1/deals/${id}/move`, { stageId: lost.id, lostReason: "x" }).expect(404);
      expect((await other.get("/v1/deals").expect(200)).body.items).toHaveLength(0);
      // Can't use another workspace's stage, contact or company either.
      await a.post(`/v1/deals/${id}/move`, { stageId: lost.id, lostReason: "x" }).expect(404);
      await a.post("/v1/deals", { name: "x", stageId: (await stagesOf(other))[0]!.id }).expect(404);
      await a.post("/v1/deals", { name: "x", primaryContactId: foreignContact.id }).expect(404);
      await a.patch(`/v1/deals/${id}`, { contactIds: [foreignContact.id] }).expect(404);
      await a.get(`/v1/contacts/${foreignContact.id}/deals`).expect(404);
      await other.post("/v1/tasks", { title: "x", dealId: id }).expect(404);
    });

    it("edits replace contacts, keep the primary, and are audited by field name", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const lee = await contact(b);
      const sam = await contact(b);
      const kim = await contact(b);
      const d = await deal(b, { primaryContactId: lee.id, contactIds: [sam.id] });
      const res = await b
        .patch(`/v1/deals/${d.id as string}`, {
          contactIds: [kim.id],
          nextStep: "Call on Monday",
          amountMinor: null,
        })
        .expect(200);
      expect(res.body.contacts.map((c: { id: string }) => c.id).sort()).toEqual(
        [lee.id, kim.id].sort(),
      );
      expect(res.body).toMatchObject({ amountMinor: null, nextStep: "Call on Monday" });
      const swap = await b
        .patch(`/v1/deals/${d.id as string}`, { primaryContactId: sam.id })
        .expect(200);
      expect(swap.body.primaryContact.id).toBe(sam.id);
      expect(swap.body.contacts).toHaveLength(3);
      await b.patch(`/v1/deals/${d.id as string}`, { lostReason: "x" }).expect(409);
      const audit = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, "deal.updated")),
      );
      expect(audit.map((a) => a.metadata)).toContainEqual({
        fields: ["amountMinor", "contactIds", "nextStep"],
      });
      expect(JSON.stringify(audit.map((a) => a.metadata))).not.toMatch(/Monday/);
    });
  });

  // ---------------------------------------------------------------- move

  describe("move", () => {
    it("records history + audit; won/lost close the deal, reopening clears it", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const [discovery, qualified] = await stagesOf(b);
      const won = await stageNamed(b, "Won");
      const lost = await stageNamed(b, "Lost");
      const d = await deal(b);
      const id = d.id as string;

      const q = await b.post(`/v1/deals/${id}/move`, { stageId: qualified!.id }).expect(200);
      expect(q.body).toMatchObject({ stage: { id: qualified!.id }, closedAt: null });
      expect(Date.parse(q.body.stageEnteredAt)).toBeGreaterThanOrEqual(
        Date.parse(d.stageEnteredAt),
      );

      const noReason = await b.post(`/v1/deals/${id}/move`, { stageId: lost.id }).expect(400);
      expect(noReason.body.code).toBe("lost_reason_required");
      await b.post(`/v1/deals/${id}/move`, { stageId: lost.id, lostReason: "" }).expect(400);

      const l = await b
        .post(`/v1/deals/${id}/move`, { stageId: lost.id, lostReason: "Went with a competitor" })
        .expect(200);
      expect(l.body).toMatchObject({ lostReason: "Went with a competitor", isStale: false });
      expect(l.body.closedAt).not.toBeNull();
      const edited = await b.patch(`/v1/deals/${id}`, { lostReason: "Budget cut" }).expect(200);
      expect(edited.body.lostReason).toBe("Budget cut");

      const reopened = await b.post(`/v1/deals/${id}/move`, { stageId: discovery!.id }).expect(200);
      expect(reopened.body).toMatchObject({ closedAt: null, lostReason: null });

      const w = await b.post(`/v1/deals/${id}/move`, { stageId: won.id }).expect(200);
      expect(w.body.closedAt).not.toBeNull();
      // Same stage again: no-op, no extra history.
      await b.post(`/v1/deals/${id}/move`, { stageId: won.id }).expect(200);

      expect(w.body.stageHistory.map((h: { to: { name: string } }) => h.to.name)).toEqual([
        "Discovery",
        "Qualified",
        "Lost",
        "Discovery",
        "Won",
      ]);
      const history = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.select().from(dealStageHistory).where(eq(dealStageHistory.dealId, id)),
      );
      expect(history).toHaveLength(5);
      const moves = await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, "deal.moved")),
      );
      expect(moves).toHaveLength(4);
      expect(moves.map((m) => m.metadata.toKind)).toEqual(["open", "lost", "open", "won"]);
      expect(JSON.stringify(moves.map((m) => m.metadata))).not.toMatch(/competitor/);
    });

    it("stage history is append-only for the app role", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      await deal(b);
      await expect(
        withTenant(handle.db, { workspaceId: ws }, (tx) =>
          tx.update(dealStageHistory).set({ movedAt: new Date(0) }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(handle.db, { workspaceId: ws }, (tx) => tx.delete(dealStageHistory)),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------- list, summary

  describe("board data", () => {
    it("filters by stage, owner, status, close dates, text, and pages with a cursor", async () => {
      const { b } = await signedUp(app);
      const rep = await joinAs(app, b, "rep");
      const [discovery, qualified] = await stagesOf(b);
      const lost = await stageNamed(b, "Lost");
      const c = await contact(b, uniqueEmail("x"), "Globex Corp");
      const a1 = await deal(b, { name: "Alpha", expectedCloseDate: "2026-12-01" });
      const a2 = await deal(b, { name: "Bravo", stageId: qualified!.id, primaryContactId: c.id });
      const a3 = await deal(rep, { name: "Charlie", expectedCloseDate: "2027-01-15" });
      const a4 = await deal(b, { name: "Delta" });
      await b.post(`/v1/deals/${a4.id as string}/move`, { stageId: lost.id, lostReason: "No" });

      const names = async (q: string, who: Browser = b) =>
        ((await who.get(`/v1/deals${q}`).expect(200)).body.items as { name: string }[]).map(
          (d) => d.name,
        );
      expect(await names("")).toEqual(["Delta", "Charlie", "Bravo", "Alpha"]);
      expect(await names(`?stageId=${discovery!.id}`)).toEqual(["Charlie", "Alpha"]);
      expect(await names("?ownerId=me", rep)).toEqual(["Charlie"]);
      expect(await names(`?ownerId=${await userOf(rep)}`)).toEqual(["Charlie"]);
      expect(await names("?status=open")).toEqual(["Charlie", "Bravo", "Alpha"]);
      expect(await names("?status=lost")).toEqual(["Delta"]);
      expect(await names("?closeFrom=2026-12-01&closeTo=2026-12-31")).toEqual(["Alpha"]);
      expect(await names("?closeFrom=2026-12-02")).toEqual(["Charlie"]);
      expect(await names("?q=globex")).toEqual(["Bravo"]);
      expect(await names("?q=char")).toEqual(["Charlie"]);
      expect(await names("?q=%25")).toEqual([]);
      expect(await names(`?contactId=${c.id}`)).toEqual(["Bravo"]);
      expect(await names(`?companyId=${c.company!.id}`)).toEqual(["Bravo"]);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: { id: string }[]; nextCursor: string | null } = (
          await b.get(`/v1/deals?limit=3${cursor ? `&cursor=${cursor}` : ""}`).expect(200)
        ).body;
        seen.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([a4.id, a3.id, a2.id, a1.id]);

      // Contact and company pages.
      const forContact = await b.get(`/v1/contacts/${c.id}/deals`).expect(200);
      expect(forContact.body.map((d: { id: string }) => d.id)).toEqual([a2.id]);
      const forCompany = await b.get(`/v1/companies/${c.company!.id}/deals`).expect(200);
      expect(forCompany.body.map((d: { id: string }) => d.id)).toEqual([a2.id]);
      await b.get(`/v1/companies/${missingId}/deals`).expect(404);
    });

    it("summary: counts, sums, weighted sums rounded once, per currency, forecast", async () => {
      const { b } = await signedUp(app);
      const rep = await joinAs(app, b, "rep");
      const [discovery, qualified] = await stagesOf(b);
      const won = await stageNamed(b, "Won");
      const lost = await stageNamed(b, "Lost");
      const cal = calendarWindow("America/New_York");
      const nextMonth = cal.nextMonthStart;
      // Discovery (10 %): 1005 + 1005 → weighted 100.5 + 100.5 = 201 (not 202).
      await deal(b, { stageId: discovery!.id, amountMinor: 1005, expectedCloseDate: cal.today });
      await deal(rep, { stageId: discovery!.id, amountMinor: 1005, expectedCloseDate: nextMonth });
      await deal(b, { stageId: discovery!.id }); // no amount: counted, sums 0
      // Qualified (25 %): EUR deal stays out of the USD totals.
      await deal(b, { stageId: qualified!.id, amountMinor: 10_000, currency: "EUR" });
      await deal(b, {
        stageId: qualified!.id,
        amountMinor: 333,
        expectedCloseDate: cal.monthStart,
      });
      const w = await deal(b, { amountMinor: 50_000 });
      await b.post(`/v1/deals/${w.id as string}/move`, { stageId: won.id }).expect(200);
      const l = await deal(b, { amountMinor: 70_000 });
      await b
        .post(`/v1/deals/${l.id as string}/move`, { stageId: lost.id, lostReason: "Price" })
        .expect(200);

      const s = (await b.get("/v1/deals/summary").expect(200)).body;
      expect(s.currency).toBe("USD");
      expect(s.multiCurrency).toBe(true);
      const col = (id: string) => s.columns.find((c: { stageId: string }) => c.stageId === id);
      expect(col(discovery!.id)).toEqual({
        stageId: discovery!.id,
        count: 3,
        amountMinor: 2010,
        weightedMinor: 201,
        byCurrency: [{ currency: "USD", count: 2, amountMinor: 2010, weightedMinor: 201 }],
      });
      expect(col(qualified!.id)).toMatchObject({
        count: 2,
        amountMinor: 333,
        weightedMinor: 83, // 83.25
        byCurrency: [
          { currency: "USD", count: 1, amountMinor: 333, weightedMinor: 83 },
          { currency: "EUR", count: 1, amountMinor: 10_000, weightedMinor: 2500 },
        ],
      });
      expect(col(won.id)).toMatchObject({ count: 1, amountMinor: 50_000, weightedMinor: 50_000 });
      expect(col(lost.id)).toMatchObject({ count: 1, amountMinor: 70_000, weightedMinor: 0 });
      expect(s.columns).toHaveLength(6);
      // Open pipeline: USD 2010 + 333; weighted raw 20100 + 8325 = 28425 → 284 (201 + 83 = 284).
      expect(s.forecast.open).toMatchObject({ count: 5, amountMinor: 2343, weightedMinor: 284 });
      expect(s.forecast.open.byCurrency[1]).toEqual({
        currency: "EUR",
        count: 1,
        amountMinor: 10_000,
        weightedMinor: 2500,
      });
      // This month: today's and month-start deals (closed ones never count).
      expect(s.forecast.thisMonth).toMatchObject({
        count: 2,
        amountMinor: 1338,
        weightedMinor: 184,
      });
      const quarterHasNextMonth = nextMonth < cal.nextQuarterStart;
      expect(s.forecast.thisQuarter.amountMinor).toBe(quarterHasNextMonth ? 2343 : 1338);

      const mine = (await rep.get("/v1/deals/summary?ownerId=me").expect(200)).body;
      expect(mine.multiCurrency).toBe(false);
      expect(mine.forecast.open).toMatchObject({ count: 1, amountMinor: 1005, weightedMinor: 101 });
      await b.get("/v1/deals/summary?ownerId=nope").expect(400);
    });
  });

  // ---------------------------------------------------------------- activity, stale, Today

  describe("activity and attention", () => {
    it("last activity: create, edit, stage change, task done and email with a deal contact", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const [, qualified] = await stagesOf(b);
      const lee = await contact(b);
      const d = await deal(b, { primaryContactId: lee.id });
      const id = d.id as string;
      const old = new Date(Date.now() - 30 * DAY);
      const get = async () => (await b.get(`/v1/deals/${id}`).expect(200)).body;

      await setActivity(ws, id, old);
      expect(await get()).toMatchObject({ lastActivityAt: old.toISOString(), isStale: true });
      await b.patch(`/v1/deals/${id}`, { nextStep: "Call" }).expect(200);
      expect((await get()).isStale).toBe(false);

      await setActivity(ws, id, old);
      await b.post(`/v1/deals/${id}/move`, { stageId: qualified!.id }).expect(200);
      expect((await get()).isStale).toBe(false);

      await setActivity(ws, id, old);
      const task = await b.post("/v1/tasks", { title: "Send pricing", dealId: id }).expect(201);
      expect(task.body.dealId).toBe(id);
      expect((await get()).isStale).toBe(true); // creating a task isn't activity
      await b.post(`/v1/tasks/${task.body.id as string}/complete`).expect(200);
      expect((await get()).isStale).toBe(false);
      const linked = await b.get(`/v1/tasks?dealId=${id}&status=done`).expect(200);
      expect(linked.body.map((t: { id: string }) => t.id)).toEqual([task.body.id]);

      // Email with a deal contact (either direction) counts; an unsent reservation doesn't.
      await setActivity(ws, id, old);
      const sentAt = new Date(Date.now() - 2 * DAY);
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(messages).values({
          workspaceId: ws,
          contactId: lee.id,
          direction: "outbound",
          messageIdHeader: `<${Math.random()}@openline.test>`,
          subject: "Reserved",
          status: "sending",
          sentAt: new Date(),
        });
      });
      expect((await get()).isStale).toBe(true);
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        await tx.insert(messages).values({
          workspaceId: ws,
          contactId: lee.id,
          direction: "outbound",
          messageIdHeader: `<${Math.random()}@openline.test>`,
          subject: "Following up",
          status: "sent",
          sentAt,
        });
      });
      expect(await get()).toMatchObject({ lastActivityAt: sentAt.toISOString(), isStale: false });
    });

    it("stale is strictly past the stage's limit; never-stale stages and closed deals aren't", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const s = await stagesOf(b);
      const won = await stageNamed(b, "Won");
      const edge = await deal(b, { name: "Edge" });
      const past = await deal(b, { name: "Past" });
      const never = await deal(b, { name: "Never", stageId: s[1]!.id });
      const closed = await deal(b, { name: "Closed" });
      await b.post(`/v1/deals/${closed.id as string}/move`, { stageId: won.id }).expect(200);
      const body = toInput(s).map((x, i) => (i === 1 ? { ...x, staleAfterDays: null } : x));
      await b.put("/v1/pipeline/stages", { stages: body }).expect(200);

      const now = Date.now();
      // 1 minute either side of exactly 14 days (requests take well under a minute).
      await setActivity(ws, edge.id, new Date(now - 14 * DAY + 60_000));
      await setActivity(ws, past.id, new Date(now - 14 * DAY - 60_000));
      await setActivity(ws, never.id, new Date(now - 300 * DAY));
      await setActivity(ws, closed.id, new Date(now - 300 * DAY));

      const list = (await b.get("/v1/deals").expect(200)).body.items as {
        name: string;
        isStale: boolean;
      }[];
      expect(Object.fromEntries(list.map((d) => [d.name, d.isStale]))).toEqual({
        Edge: false,
        Past: true,
        Never: false,
        Closed: false,
      });
      const staleOnly = (await b.get("/v1/deals?stale=1").expect(200)).body.items;
      expect(staleOnly.map((d: { name: string }) => d.name)).toEqual(["Past"]);
      const fresh = (await b.get("/v1/deals?stale=0").expect(200)).body.items;
      expect(fresh.map((d: { name: string }) => d.name).sort()).toEqual([
        "Closed",
        "Edge",
        "Never",
      ]);
    });

    it("next-step dates are judged in the workspace time zone; Today lists my deals needing attention", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const rep = await joinAs(app, b, "rep");
      const manager = await joinAs(app, b, "manager");
      const [, qualified] = await stagesOf(b);
      // Far-east zone: "today" there can differ from UTC; the API must use it.
      await b.patch("/v1/workspace", { defaultTimeZone: "Pacific/Kiritimati" }).expect(200);
      const cal = calendarWindow("Pacific/Kiritimati");
      const yesterday = new Date(Date.parse(`${cal.today}T00:00:00Z`) - DAY)
        .toISOString()
        .slice(0, 10);

      const due = await deal(b, { name: "Due today", nextStepDate: cal.today, nextStep: "Call" });
      const late = await deal(b, { name: "Late", nextStepDate: yesterday, nextStep: "Call" });
      const stale = await deal(b, { name: "Stale" });
      await setActivity(ws, stale.id, new Date(Date.now() - 20 * DAY));
      const repLate = await deal(rep, { name: "Rep late", nextStepDate: yesterday });
      const noStep = await deal(b, { name: "No step", stageId: qualified!.id });

      const byName = Object.fromEntries(
        ((await b.get("/v1/deals").expect(200)).body.items as Record<string, unknown>[]).map(
          (d) => [d.name, d],
        ),
      );
      expect(byName["Due today"]).toMatchObject({ nextStepOverdue: false });
      expect(byName["Late"]).toMatchObject({ nextStepOverdue: true });
      expect(byName["No step"]).toMatchObject({ missingNextStep: true, nextStepOverdue: false });

      const mine = (await b.get("/v1/deals/attention?mine=1").expect(200)).body.items;
      // Oldest activity first.
      expect(mine.map((d: { id: string }) => d.id)).toEqual([stale.id, late.id]);
      const repMine = (await rep.get("/v1/deals/attention").expect(200)).body.items;
      expect(repMine.map((d: { id: string }) => d.id)).toEqual([repLate.id]);
      await rep.get("/v1/deals/attention?mine=0").expect(403);
      const all = (await manager.get("/v1/deals/attention?mine=0").expect(200)).body.items;
      expect(all).toHaveLength(3);
      expect(all.map((d: { id: string }) => d.id)).not.toContain(due.id);

      const flagged = (await b.get("/v1/deals?flagged=1").expect(200)).body.items;
      expect(flagged.map((d: { name: string }) => d.name).sort()).toEqual([
        "Late",
        "No step",
        "Rep late",
        "Stale",
      ]);
      expect(noStep.missingNextStep).toBe(true);
    });

    it("timeline: emails both ways, stage changes, tasks and edits, newest first", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const ownerId = await userOf(b);
      const rep = await joinAs(app, b, "rep");
      const [, qualified] = await stagesOf(b);
      const lee = await contact(b);
      const stranger = await contact(b);
      const d = await deal(b, { primaryContactId: lee.id });
      const id = d.id as string;
      const t0 = Date.now() - 10 * DAY;
      await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        const [mb] = await tx
          .insert(mailboxes)
          .values({
            workspaceId: ws,
            userId: ownerId,
            provider: "smtp",
            email: uniqueEmail("mbox"),
            secretSealed: "sealed",
          })
          .returning();
        await tx.insert(messages).values([
          {
            workspaceId: ws,
            contactId: lee.id,
            mailboxId: mb!.id,
            direction: "outbound",
            messageIdHeader: "<out-1@openline.test>",
            subject: "Quick question",
            status: "sent",
            sentAt: new Date(t0),
          },
          {
            workspaceId: ws,
            contactId: lee.id,
            mailboxId: mb!.id,
            direction: "inbound",
            messageIdHeader: "<in-1@buyer.test>",
            subject: "Re: Quick question",
            fromEmail: "lee@buyer.test",
            bodyText: `${"Yes, send pricing please. ".repeat(20)}`,
            status: "received",
            receivedAt: new Date(t0 + DAY),
            sentAt: new Date(t0 + DAY),
          },
          {
            workspaceId: ws,
            contactId: stranger.id,
            mailboxId: mb!.id,
            direction: "inbound",
            messageIdHeader: "<in-2@buyer.test>",
            subject: "Not about this deal",
            fromEmail: "x@buyer.test",
            bodyText: "Unrelated",
            status: "received",
            receivedAt: new Date(t0 + 2 * DAY),
            sentAt: new Date(t0 + 2 * DAY),
          },
        ]);
      });
      await b.post(`/v1/deals/${id}/move`, { stageId: qualified!.id }).expect(200);
      const task = await b.post("/v1/tasks", { title: "Send pricing", dealId: id }).expect(201);
      await b.post(`/v1/tasks/${task.body.id as string}/complete`).expect(200);
      await b.patch(`/v1/deals/${id}`, { amountMinor: 100 }).expect(200);

      const items = (await b.get(`/v1/deals/${id}/timeline`).expect(200)).body.items as {
        kind: string;
        at: string;
        [k: string]: unknown;
      }[];
      expect(items.map((i) => i.kind)).toEqual([
        "edit",
        "task",
        "stage_change",
        "stage_change",
        "email",
        "email",
      ]);
      const sorted = [...items].sort((x, y) => (x.at < y.at ? 1 : -1));
      expect(items.map((i) => i.at)).toEqual(sorted.map((i) => i.at));
      expect(items[0]).toMatchObject({ fields: ["amountMinor"], by: { id: ownerId } });
      expect(items[1]).toMatchObject({ title: "Send pricing", status: "done" });
      const inbound = items.find((i) => i.kind === "email" && i.direction === "inbound")!;
      expect(inbound.subject).toBe("Re: Quick question");
      expect((inbound.snippet as string).length).toBeLessThanOrEqual(200);
      expect(inbound.snippet).toMatch(/^Yes, send pricing please/);
      const outbound = items.find((i) => i.kind === "email" && i.direction === "outbound")!;
      expect(outbound).toMatchObject({
        subject: "Quick question",
        snippet: null,
        contactId: lee.id,
      });
      expect(JSON.stringify(items)).not.toMatch(/Not about this deal/);

      // A rep sees that emails and tasks exist, but not another mailbox's text or another's task.
      const asRep = (await rep.get(`/v1/deals/${id}/timeline`).expect(200)).body.items as {
        kind: string;
        [k: string]: unknown;
      }[];
      expect(
        asRep.find((i) => i.kind === "email" && i.direction === "inbound")!.snippet,
      ).toBeNull();
      expect(asRep.find((i) => i.kind === "task")!.title).toBeNull();
    });

    it("inbox message carries a Create deal prefill and the contact's open deals", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      const ownerId = await userOf(b);
      const lee = await contact(b, uniqueEmail("lee"), "Acme Tools");
      const existing = await deal(b, { name: "Acme renewal", primaryContactId: lee.id });
      const messageId = await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        const [mb] = await tx
          .insert(mailboxes)
          .values({
            workspaceId: ws,
            userId: ownerId,
            provider: "smtp",
            email: uniqueEmail("mbox"),
            secretSealed: "sealed",
          })
          .returning();
        const [m] = await tx
          .insert(messages)
          .values({
            workspaceId: ws,
            contactId: lee.id,
            mailboxId: mb!.id,
            direction: "inbound",
            messageIdHeader: `<${Math.random()}@buyer.test>`,
            subject: "Re: hello",
            fromEmail: "lee@buyer.test",
            bodyText: "Interested!",
            status: "received",
            receivedAt: new Date(),
          })
          .returning();
        return m!.id;
      });
      const res = await b.get(`/v1/inbox/${messageId}`).expect(200);
      expect(res.body.dealPrefill).toEqual({
        name: "Acme Tools — new deal",
        contactId: lee.id,
        companyId: lee.company!.id,
        openDeals: [{ id: existing.id, name: "Acme renewal", stageName: "Discovery" }],
      });
      // Two clicks: the prefill is a valid create body.
      const created = await b
        .post("/v1/deals", {
          name: res.body.dealPrefill.name,
          primaryContactId: res.body.dealPrefill.contactId,
          companyId: res.body.dealPrefill.companyId,
        })
        .expect(201);
      expect(created.body.company.name).toBe("Acme Tools");
    });

    it("seeds stages lazily for a workspace that somehow has none", async () => {
      const { b } = await signedUp(app);
      const ws = await wsOf(b);
      await handle.db.execute(sql`DELETE FROM pipeline_stages WHERE workspace_id = ${ws}`);
      expect(await stagesOf(b)).toHaveLength(6);
      expect((await deal(b)).stage.name).toBe("Discovery");
    });
  });
});
