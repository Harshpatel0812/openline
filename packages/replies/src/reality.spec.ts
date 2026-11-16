import { randomUUID } from "node:crypto";
import { FakeProvider, type LlmRequest } from "@openline/ai";
import {
  aiActions,
  aiUsage,
  and,
  contacts,
  createDatabase,
  dealChecks,
  dealContacts,
  deals,
  eq,
  messages,
  migrate,
  pipelineStages,
  seedDefaultStages,
  users,
  withIdentity,
  withTenant,
  workspaces,
  type DatabaseHandle,
} from "@openline/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealityChecker, REALITY_FEATURE } from "./reality";

const quiet = { warn: () => undefined, error: () => undefined };
const HOUR = 3_600_000;

let handle: DatabaseHandle;
beforeAll(async () => {
  handle = createDatabase("pglite://memory");
  await migrate(handle);
});
afterAll(async () => {
  await handle.close();
});

const NEED = "We need a better way to track our outreach.";
const NO_BUDGET = "We haven't talked about budget yet.";

async function seed(opts: { scoutEnabled?: boolean; credits?: number; stage?: string } = {}) {
  const workspaceId = randomUUID();
  const userId = await withIdentity(handle.db, async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `rep-${randomUUID()}@acme.com`, name: "Riley", passwordHash: "x" })
      .returning();
    return u!.id;
  });
  return withTenant(handle.db, { workspaceId }, async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: "Acme",
      trialEndsAt: new Date(),
      scoutEnabled: opts.scoutEnabled ?? true,
      scoutMonthlyCredits: opts.credits ?? 2000,
    });
    await seedDefaultStages(tx, workspaceId);
    const stages = await tx.select().from(pipelineStages);
    const stage = (name: string) => stages.find((s) => s.name === name)!;
    const [contact] = await tx
      .insert(contacts)
      .values({ workspaceId, email: "jane@buyer.com", firstName: "Jane", title: "Ops lead" })
      .returning();
    const [deal] = await tx
      .insert(deals)
      .values({
        workspaceId,
        name: "Buyer — new deal",
        ownerId: userId,
        stageId: stage(opts.stage ?? "Proposal").id,
        currency: "USD",
        nextStep: "Call",
        nextStepDate: "2099-01-01",
      })
      .returning();
    await tx.insert(dealContacts).values({ workspaceId, dealId: deal!.id, contactId: contact!.id });
    return { workspaceId, userId, dealId: deal!.id, contactId: contact!.id, stage };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function email(s: Seeded, text: string, at = new Date(Date.now() - HOUR)) {
  return withTenant(handle.db, { workspaceId: s.workspaceId }, async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        direction: "inbound",
        messageIdHeader: `<${randomUUID()}@buyer.com>`,
        subject: "Re: Intro",
        fromEmail: "jane@buyer.com",
        bodyText: text,
        status: "received",
        receivedAt: at,
        sentAt: at,
      })
      .returning();
    return m!.id;
  });
}

const latestCheck = (s: Seeded) =>
  withTenant(handle.db, { workspaceId: s.workspaceId }, async (tx) => {
    const rows = await tx
      .select()
      .from(dealChecks)
      .where(eq(dealChecks.dealId, s.dealId))
      .orderBy(dealChecks.ranAt);
    return rows[rows.length - 1]!;
  });

const proposals = (s: Seeded) =>
  withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
    tx
      .select()
      .from(aiActions)
      .where(and(eq(aiActions.dealId, s.dealId), eq(aiActions.kind, "deal_stage_move")))
      .orderBy(aiActions.createdAt),
  );

const run = (
  s: Seeded,
  provider: FakeProvider | null,
  trigger: "manual" | "scheduled" = "manual",
) =>
  createRealityChecker({ db: handle.db, provider, logger: quiet }).check({
    workspaceId: s.workspaceId,
    dealId: s.dealId,
    trigger,
    userId: s.userId,
  });

describe("reality check runner", () => {
  it("model evidence → flags, evidence stage, a stage-move proposal and reality_check usage", async () => {
    const s = await seed();
    const messageId = await email(s, `Hi Riley,\n\n${NEED} ${NO_BUDGET}\n\nJane`);
    const provider = new FakeProvider();
    const result = await run(s, provider);
    expect(result).toMatchObject({ deterministicOnly: false });
    expect(provider.calls).toHaveLength(1);
    // The email is fenced as untrusted data in the prompt.
    expect(provider.calls[0]!.messages[0]!.content).toContain("UNTRUSTED");

    const check = await latestCheck(s);
    expect(check.model).toBe("fake-small");
    expect(check.inputTokens).toBeGreaterThan(0);
    expect(check.evidence.need_confirmed).toEqual({ present: "yes", quote: NEED, messageId });
    expect(check.evidence.budget_discussed).toMatchObject({ present: "no", messageId });
    expect(check.evidenceStageId).toBe(s.stage("Discovery").id);
    expect(check.stageId).toBe(s.stage("Proposal").id);
    expect(check.flags.map((f) => f.code).sort()).toEqual([
      "criterion_missing",
      "stage_ahead_of_evidence",
    ]);
    // Only short quotes are stored, never the email's other text.
    expect(JSON.stringify(check.evidence)).not.toContain("Hi Riley");

    const [p] = await proposals(s);
    expect(p).toMatchObject({ status: "proposed", userId: s.userId, id: result!.proposalId });
    expect(p!.proposal.stageMove).toMatchObject({
      checkId: check.id,
      fromStageId: s.stage("Proposal").id,
      toStageId: s.stage("Discovery").id,
    });

    const usage = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.select().from(aiUsage),
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: REALITY_FEATURE, userId: s.userId });
    const deal = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.select().from(deals),
    );
    expect(deal[0]!.realityCheckedAt).toBeInstanceOf(Date);
  });

  it("keeps only quotes that are verbatim in the named message", async () => {
    const s = await seed();
    await email(s, NEED);
    const provider = new FakeProvider([
      JSON.stringify({
        evidence: {
          need_confirmed: { present: "yes", quote: NEED, messageId: "m1" },
          budget_discussed: { present: "yes", quote: "Budget approved at $50k", messageId: "m1" },
          verbal_yes: { present: "yes", quote: null, messageId: "m1" },
          proposal_sent: { present: "yes", quote: NEED, messageId: "m9" },
        },
      }),
    ]);
    await run(s, provider);
    const check = await latestCheck(s);
    expect(check.evidence.need_confirmed!.present).toBe("yes");
    expect(check.evidence.budget_discussed).toEqual({ present: "unclear" });
    expect(check.evidence.verbal_yes).toEqual({ present: "unclear" });
    expect(check.evidence.proposal_sent).toEqual({ present: "unclear" });
    expect(JSON.stringify(check)).not.toContain("50k");
  });

  it("falls back to deterministic flags: Scout off, no provider, no emails", async () => {
    const off = await seed({ scoutEnabled: false });
    await email(off, NEED);
    const provider = new FakeProvider();
    expect(await run(off, provider)).toMatchObject({
      deterministicOnly: true,
      deterministicReason: "scout_off",
    });
    expect(provider.calls).toHaveLength(0);

    const none = await seed();
    await email(none, NEED);
    expect(await run(none, null)).toMatchObject({ deterministicReason: "no_provider" });

    const quiet = await seed();
    expect(await run(quiet, provider)).toMatchObject({ deterministicReason: "no_emails" });
    expect(provider.calls).toHaveLength(0);

    const check = await latestCheck(off);
    expect(check).toMatchObject({ deterministicOnly: true, model: null, evidence: {} });
    expect(check.evidenceStageId).toBeNull();
    expect(await proposals(off)).toHaveLength(0);
  });

  it("deterministic flags still run without the model (overdue next step, stale)", async () => {
    const s = await seed({ scoutEnabled: false });
    await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx
        .update(deals)
        .set({ nextStepDate: "2020-01-01", lastActivityAt: new Date(Date.now() - 60 * 24 * HOUR) })
        .where(eq(deals.id, s.dealId)),
    );
    await run(s, new FakeProvider());
    const codes = (await latestCheck(s)).flags.map((f) => f.code).sort();
    expect(codes).toEqual(["next_step_overdue", "stale"]);
  });

  it("the Reality Check uses at most 25 % of the month's credits, and none past the budget", async () => {
    const s = await seed({ credits: 1000 });
    await email(s, NEED);
    const spend = (credits: number, feature = REALITY_FEATURE) =>
      withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
        tx.insert(aiUsage).values({
          workspaceId: s.workspaceId,
          feature,
          model: "x",
          inputTokens: 0,
          outputTokens: 0,
          credits,
        }),
      );
    const provider = new FakeProvider();
    await spend(249);
    expect(await run(s, provider)).toMatchObject({ deterministicOnly: false });
    // That run spent ≥ 1 credit: 250 of 1,000 = the share is used up.
    expect(await run(s, provider)).toMatchObject({ deterministicReason: "budget" });
    expect(provider.calls).toHaveLength(1);

    const other = await seed({ credits: 1000 });
    await email(other, NEED);
    await withTenant(handle.db, { workspaceId: other.workspaceId }, (tx) =>
      tx.insert(aiUsage).values({
        workspaceId: other.workspaceId,
        feature: "draft_email",
        model: "x",
        inputTokens: 0,
        outputTokens: 0,
        credits: 1000,
      }),
    );
    expect(await run(other, provider)).toMatchObject({ deterministicReason: "budget" });
  });

  it("a failing or invalid model never fails the check; spent tokens still count", async () => {
    const s = await seed();
    await email(s, NEED);
    const failing = new FakeProvider([new Error("boom")]);
    expect(await run(s, failing)).toMatchObject({
      deterministicOnly: true,
      deterministicReason: "model_error",
    });
    const invalid = new FakeProvider(["not json", "still not json"]);
    expect(await run(s, invalid)).toMatchObject({ deterministicReason: "model_error" });
    const usage = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx.select().from(aiUsage),
    );
    expect(usage).toHaveLength(1); // the invalid answers' tokens
    expect(await proposals(s)).toHaveLength(0);
  });

  it("proposal lifecycle: refreshed, replaced when superseded, closed, not re-asked after a dismissal", async () => {
    const s = await seed();
    await email(s, `${NEED} ${NO_BUDGET}`, new Date(Date.now() - 3 * HOUR));
    const provider = new FakeProvider();
    const first = await run(s, provider);
    const again = await run(s, provider);
    expect(again!.proposalId).toBe(first!.proposalId);
    expect((await proposals(s)).filter((p) => p.status === "proposed")).toHaveLength(1);

    // New evidence: decision maker and budget → the evidence stage is Qualified now.
    const answer = (req: LlmRequest) => {
      void req;
      return JSON.stringify({
        evidence: {
          need_confirmed: { present: "yes", quote: NEED, messageId: "m1" },
          decision_maker_engaged: { present: "yes", quote: NEED, messageId: "m1" },
          budget_discussed: { present: "yes", quote: NEED, messageId: "m1" },
        },
      });
    };
    provider.push(answer);
    const replaced = await run(s, provider);
    expect(replaced!.proposalId).not.toBe(first!.proposalId);
    const list = await proposals(s);
    expect(list.map((p) => [p.status, p.proposal.stageMove?.toStageId])).toEqual([
      ["rejected", s.stage("Discovery").id],
      ["proposed", s.stage("Qualified").id],
    ]);
    expect(list[0]!.inputSummary).toMatchObject({ closedBy: "superseded" });

    // Everything Proposal needs → no suggestion: the open proposal is closed.
    provider.push(() =>
      JSON.stringify({
        evidence: Object.fromEntries(
          [
            "need_confirmed",
            "decision_maker_engaged",
            "budget_discussed",
            "proposal_sent",
            "timeline_discussed",
          ].map((t) => [t, { present: "yes", quote: NEED, messageId: "m1" }]),
        ),
      }),
    );
    expect((await run(s, provider))!.proposalId).toBeUndefined();
    expect((await proposals(s)).every((p) => p.status === "rejected")).toBe(true);

    // The owner dismisses the Discovery move; it isn't proposed again without new activity.
    const back = await run(s, provider);
    await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
      tx
        .update(aiActions)
        .set({ status: "rejected", decidedAt: new Date(), inputSummary: { closedBy: "user" } })
        .where(eq(aiActions.id, back!.proposalId!)),
    );
    expect((await run(s, provider))!.proposalId).toBeUndefined();
    await email(s, "Following up on our chat.", new Date(Date.now() + 1_000));
    expect((await run(s, provider))!.proposalId).toBeTruthy();
  });

  it("closed deals get no flags and no model call", async () => {
    const s = await seed({ stage: "Won" });
    await email(s, NEED);
    const provider = new FakeProvider();
    await run(s, provider);
    expect(provider.calls).toHaveLength(0);
    expect((await latestCheck(s)).flags).toEqual([]);
  });
});

describe("reality check scheduler", () => {
  it("checks open deals with activity at most once a day; closed or quiet deals are skipped", async () => {
    const active = await seed();
    await email(active, NEED);
    const won = await seed({ stage: "Won" });
    const quietDeal = await seed();
    // Checked two days ago, nothing since.
    await withTenant(handle.db, { workspaceId: quietDeal.workspaceId }, (tx) =>
      tx
        .update(deals)
        .set({
          lastActivityAt: new Date(Date.now() - 72 * HOUR),
          realityCheckedAt: new Date(Date.now() - 48 * HOUR),
        })
        .where(eq(deals.id, quietDeal.dealId)),
    );
    const provider = new FakeProvider();
    const checker = createRealityChecker({ db: handle.db, provider, logger: quiet });
    const ids = async () => {
      const out: string[] = [];
      for (const s of [active, won, quietDeal]) {
        const rows = await withTenant(handle.db, { workspaceId: s.workspaceId }, (tx) =>
          tx.select().from(dealChecks),
        );
        if (rows.some((r) => r.trigger === "scheduled")) out.push(s.dealId);
      }
      return out;
    };
    const first = await checker.runOnce(200);
    expect(first.failed).toBe(0);
    expect(await ids()).toEqual([active.dealId]);
    expect((await latestCheck(active)).trigger).toBe("scheduled");

    // Same day, new activity: still not again (daily cap).
    await email(active, "Another note from Jane.", new Date());
    const before = provider.calls.length;
    await checker.runOnce(200);
    const rows = await withTenant(handle.db, { workspaceId: active.workspaceId }, (tx) =>
      tx.select().from(dealChecks),
    );
    expect(rows).toHaveLength(1);
    expect(provider.calls.length).toBe(before);

    // A day later it is due again.
    await withTenant(handle.db, { workspaceId: active.workspaceId }, (tx) =>
      tx
        .update(deals)
        .set({ realityCheckedAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(deals.id, active.dealId)),
    );
    await checker.runOnce(200);
    const after = await withTenant(handle.db, { workspaceId: active.workspaceId }, (tx) =>
      tx.select().from(dealChecks),
    );
    expect(after).toHaveLength(2);
  });

  it("a model failure doesn't fail the batch", async () => {
    const a = await seed();
    await email(a, NEED);
    const checker = createRealityChecker({
      db: handle.db,
      provider: new FakeProvider([new Error("down"), new Error("down"), new Error("down")]),
      logger: quiet,
    });
    const summary = await checker.runOnce(200);
    expect(summary.failed).toBe(0);
    expect((await latestCheck(a)).deterministicReason).toBe("model_error");
  });
});
