/**
 * Sprint 6 (OL-E7 §4): Pipeline Reality Check endpoints — run now (owner or manager, 10 per deal
 * per day), latest check (everyone, quotes private to the mailbox owner and managers), flag
 * dismissals, and accepting / dismissing the stage-move suggestion.
 */
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  auditLog,
  and,
  dealStageHistory,
  eq,
  mailboxes,
  messages,
  withTenant,
  type DatabaseHandle,
} from "@openline/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB } from "../src/database/database.module";
import { createTestApp, joinAs, signedUp, uniqueEmail, type Browser } from "./helpers";

const missingId = "00000000-0000-4000-8000-000000000000";
const NEED = "We need a better way to track our outreach.";
const NO_BUDGET = "We haven't talked about budget yet.";
const HOUR = 3_600_000;

interface Flag {
  id: string;
  code: string;
  quote?: string;
  quoteHidden?: boolean;
  dismissed?: { reason: string };
}

describe("pipeline reality check (Sprint 6)", () => {
  let app: NestExpressApplication;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    app = await createTestApp({ AI_PROVIDER: "fake" });
    handle = app.get<DatabaseHandle>(DB);
  });
  afterAll(async () => {
    await app.close();
  });

  const me = async (b: Browser) => (await b.get("/v1/auth/me").expect(200)).body;

  /** Owner, the deal's rep, another rep and a manager; one deal in Proposal with Jane's email. */
  async function team() {
    const { b: owner } = await signedUp(app);
    const rep = await joinAs(app, owner, "rep");
    const rep2 = await joinAs(app, owner, "rep");
    const manager = await joinAs(app, owner, "manager");
    const ws = (await me(owner)).workspace.id as string;
    const repId = (await me(rep)).user.id as string;
    const stages = (await owner.get("/v1/pipeline/stages").expect(200)).body as {
      id: string;
      name: string;
    }[];
    const stage = (name: string) => stages.find((s) => s.name === name)!.id;
    const jane = (await rep.post("/v1/contacts", { email: uniqueEmail("jane") }).expect(201))
      .body as { id: string };
    const deal = (
      await rep
        .post("/v1/deals", {
          name: "Buyer — new deal",
          stageId: stage("Proposal"),
          primaryContactId: jane.id,
          nextStep: "Call",
          nextStepDate: "2099-01-01",
        })
        .expect(201)
    ).body as { id: string };
    const mailbox = await withTenant(handle.db, { workspaceId: ws }, async (tx) => {
      const [mb] = await tx
        .insert(mailboxes)
        .values({
          workspaceId: ws,
          userId: repId,
          provider: "smtp",
          email: uniqueEmail("mbox"),
          secretSealed: "sealed",
        })
        .returning();
      return mb!.id;
    });
    const email = (text: string, at = new Date(Date.now() - HOUR)) =>
      withTenant(handle.db, { workspaceId: ws }, async (tx) => {
        const [m] = await tx
          .insert(messages)
          .values({
            workspaceId: ws,
            contactId: jane.id,
            mailboxId: mailbox,
            direction: "inbound",
            messageIdHeader: `<${Math.random()}@buyer.test>`,
            subject: "Re: Intro",
            fromEmail: "jane@buyer.test",
            bodyText: text,
            status: "received",
            receivedAt: at,
            sentAt: at,
          })
          .returning();
        return m!.id;
      });
    await email(`Hi Riley,\n\n${NEED} ${NO_BUDGET}\n\nJane`, new Date(Date.now() - 2 * HOUR));
    return { owner, rep, rep2, manager, ws, repId, deal, stage, email };
  }

  const url = (id: string, rest = "") => `/v1/deals/${id}/reality-check${rest}`;

  it("runs on demand: verified quotes, flags, evidence stage and a suggestion", async () => {
    const t = await team();
    const res = await t.rep.post(url(t.deal.id)).expect(200);
    expect(res.body).toMatchObject({
      dealId: t.deal.id,
      deterministicOnly: false,
      model: "fake-small",
      stageId: t.stage("Proposal"),
      evidenceStageId: t.stage("Discovery"),
      trigger: "manual",
      runsLeftToday: 9,
    });
    expect(res.body.evidence.need_confirmed).toMatchObject({ present: "yes", quote: NEED });
    expect((res.body.flags as Flag[]).map((f) => f.code).sort()).toEqual([
      "criterion_missing",
      "stage_ahead_of_evidence",
    ]);
    expect(res.body.suggestion).toMatchObject({
      toStageId: t.stage("Discovery"),
      toStageName: "Discovery",
      status: "proposed",
    });
    const get = await t.owner.get(url(t.deal.id)).expect(200);
    expect(get.body.check.ranAt).toBe(res.body.ranAt);
  });

  it("GET before any run returns check: null; other workspaces get 404", async () => {
    const t = await team();
    expect((await t.rep.get(url(t.deal.id)).expect(200)).body).toEqual({ check: null });
    const { b: stranger } = await signedUp(app);
    await stranger.get(url(t.deal.id)).expect(404);
    await stranger.post(url(t.deal.id)).expect(404);
    await stranger.post(url(t.deal.id, "/suggestion/accept")).expect(404);
    await t.rep.get(url(missingId)).expect(404);
  });

  it("only the owner or a manager runs it; other reps read it with other mailboxes' quotes hidden", async () => {
    const t = await team();
    expect((await t.rep2.post(url(t.deal.id)).expect(403)).body.code).toBe("forbidden");
    await t.manager.post(url(t.deal.id)).expect(200);

    const asRep2 = (await t.rep2.get(url(t.deal.id)).expect(200)).body.check;
    expect(asRep2.evidence.need_confirmed).toMatchObject({ present: "yes", quoteHidden: true });
    expect(asRep2.evidence.need_confirmed.quote).toBeUndefined();
    const flag = (asRep2.flags as Flag[]).find((f) => f.code === "criterion_missing")!;
    expect(flag.quote).toBeUndefined();
    expect(flag.quoteHidden).toBe(true);
    expect(JSON.stringify(asRep2)).not.toContain("budget yet");

    for (const who of [t.rep, t.manager, t.owner]) {
      const check = (await who.get(url(t.deal.id)).expect(200)).body.check;
      expect(check.evidence.need_confirmed.quote).toBe(NEED);
    }
    // rep2 can't dismiss or accept either.
    const id = (asRep2.flags as Flag[])[0]!.id;
    await t.rep2.post(url(t.deal.id, `/flags/${id}/dismiss`), { reason: "No" }).expect(403);
    await t.rep2.post(url(t.deal.id, "/suggestion/accept")).expect(403);
    await t.rep2.post(url(t.deal.id, "/suggestion/dismiss")).expect(403);
  });

  it("is rate-limited to 10 runs per deal per day", async () => {
    const t = await team();
    for (let i = 0; i < 10; i++) await t.rep.post(url(t.deal.id)).expect(200);
    const res = await t.manager.post(url(t.deal.id)).expect(429);
    expect(res.body.code).toBe("rate_limited");
    expect((await t.rep.get(url(t.deal.id)).expect(200)).body.check.runsLeftToday).toBe(0);
  });

  it("falls back to deterministic flags with Scout off", async () => {
    const t = await team();
    await t.owner.patch("/v1/workspace/scout", { enabled: false }).expect(200);
    const res = await t.rep.post(url(t.deal.id)).expect(200);
    expect(res.body).toMatchObject({ deterministicOnly: true, deterministicReason: "scout_off" });
    expect(res.body.evidence).toEqual({});
    expect(res.body.suggestion).toBeUndefined();
  });

  it("accepting the suggestion moves the deal with history and audit", async () => {
    const t = await team();
    await t.rep.post(url(t.deal.id)).expect(200);
    const res = await t.rep.post(url(t.deal.id, "/suggestion/accept")).expect(200);
    expect(res.body.deal.stage.id).toBe(t.stage("Discovery"));
    expect(res.body.check.suggestion.status).toBe("executed");
    const history = await withTenant(handle.db, { workspaceId: t.ws }, (tx) =>
      tx.select().from(dealStageHistory).where(eq(dealStageHistory.dealId, t.deal.id)),
    );
    expect(history.map((h) => h.toStageId)).toEqual([t.stage("Proposal"), t.stage("Discovery")]);
    const audits = await withTenant(handle.db, { workspaceId: t.ws }, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.workspaceId, t.ws), eq(auditLog.action, "deal.moved"))),
    );
    expect(audits[0]!.metadata).toMatchObject({ viaRealityCheck: true });
    // Nothing left to accept; the deal no longer counts the old check's model flags.
    await t.rep.post(url(t.deal.id, "/suggestion/accept")).expect(404);
    const listed = (await t.rep.get("/v1/deals").expect(200)).body.items[0];
    expect(listed.flagCount).toBe(0);
  });

  it("a suggestion for a deal that moved since is stale (409)", async () => {
    const t = await team();
    await t.rep.post(url(t.deal.id)).expect(200);
    await t.rep.post(`/v1/deals/${t.deal.id}/move`, { stageId: t.stage("Qualified") }).expect(200);
    expect((await t.rep.post(url(t.deal.id, "/suggestion/accept")).expect(409)).body.code).toBe(
      "suggestion_stale",
    );
  });

  it("dismissing the suggestion persists until new activity", async () => {
    const t = await team();
    await t.rep.post(url(t.deal.id)).expect(200);
    const res = await t.rep
      .post(url(t.deal.id, "/suggestion/dismiss"), { reason: "Pricing was on a call" })
      .expect(200);
    expect(res.body.suggestion.status).toBe("rejected");
    expect((await t.rep.post(url(t.deal.id)).expect(200)).body.suggestion).toBeUndefined();
    await t.email("Following up after our call.", new Date(Date.now() + 1_000));
    expect((await t.rep.post(url(t.deal.id)).expect(200)).body.suggestion.status).toBe("proposed");
  });

  it("flag dismissals: validated, shown as dismissed, out of the counts until new activity", async () => {
    const t = await team();
    const check = (await t.rep.post(url(t.deal.id)).expect(200)).body;
    const flag = (check.flags as Flag[]).find((f) => f.code === "criterion_missing")!;
    let listed = (await t.rep.get("/v1/deals?flagged=1").expect(200)).body.items;
    expect(listed).toHaveLength(1);
    expect(listed[0].flagCount).toBe(2);

    await t.rep.post(url(t.deal.id, `/flags/${flag.id}/dismiss`), { reason: "" }).expect(400);
    await t.rep
      .post(url(t.deal.id, `/flags/${flag.id}/dismiss`), { reason: "x".repeat(301) })
      .expect(400);
    await t.rep.post(url(t.deal.id, "/flags/not-a-flag/dismiss"), { reason: "x" }).expect(400);
    await t.rep
      .post(url(t.deal.id, "/flags/0123456789abcdef/dismiss"), { reason: "x" })
      .expect(404);

    const after = (
      await t.rep
        .post(url(t.deal.id, `/flags/${flag.id}/dismiss`), {
          reason: "Not right — we discussed this on a call",
        })
        .expect(200)
    ).body;
    const dismissed = (after.flags as Flag[]).find((f) => f.id === flag.id)!;
    expect(dismissed.dismissed).toMatchObject({
      reason: "Not right — we discussed this on a call",
    });
    listed = (await t.rep.get("/v1/deals").expect(200)).body.items;
    expect(listed[0].flagCount).toBe(1);

    // Dismissing the stage flag too: no longer flagged; the suggestion is withdrawn.
    const stageFlag = (check.flags as Flag[]).find((f) => f.code === "stage_ahead_of_evidence")!;
    const both = (
      await t.rep.post(url(t.deal.id, `/flags/${stageFlag.id}/dismiss`), { reason: "On a call" })
    ).body;
    expect(both.suggestion.status).toBe("rejected");
    expect((await t.rep.get("/v1/deals?flagged=1").expect(200)).body.items).toHaveLength(0);
    expect((await t.rep.get("/v1/deals?flagged=0").expect(200)).body.items).toHaveLength(1);
    // The audit keeps no reason text.
    const audits = await withTenant(handle.db, { workspaceId: t.ws }, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.workspaceId, t.ws), eq(auditLog.action, "deal.reality_flag_dismissed")),
        ),
    );
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain("call");

    // New activity brings them back.
    await t.email("One more thing.", new Date(Date.now() + 1_000));
    const back = (await t.rep.get(url(t.deal.id)).expect(200)).body.check;
    expect((back.flags as Flag[]).every((f) => !f.dismissed)).toBe(true);
    expect((await t.rep.get("/v1/deals?flagged=1").expect(200)).body.items).toHaveLength(1);
  });
});
