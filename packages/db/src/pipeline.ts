import { eq, sql } from "drizzle-orm";
import { pipelineStages, type StageCriterionJson } from "./schema";
import type { Tx } from "./tenant";

/** The stages every new workspace starts with (same list as the 0011 backfill). */
export const DEFAULT_STAGES: readonly {
  name: string;
  probability: number;
  kind: "open" | "won" | "lost";
  staleAfterDays: number | null;
  entryCriteria: StageCriterionJson[];
}[] = [
  {
    name: "Discovery",
    probability: 10,
    kind: "open",
    staleAfterDays: 14,
    entryCriteria: [{ label: "Need confirmed", evidence: "need_confirmed" }],
  },
  {
    name: "Qualified",
    probability: 25,
    kind: "open",
    staleAfterDays: 14,
    entryCriteria: [
      { label: "Decision maker engaged", evidence: "decision_maker_engaged" },
      { label: "Budget discussed", evidence: "budget_discussed" },
    ],
  },
  {
    name: "Proposal",
    probability: 50,
    kind: "open",
    staleAfterDays: 14,
    entryCriteria: [
      { label: "Proposal sent", evidence: "proposal_sent" },
      { label: "Timeline discussed", evidence: "timeline_discussed" },
    ],
  },
  {
    name: "Negotiation",
    probability: 75,
    kind: "open",
    staleAfterDays: 14,
    entryCriteria: [
      { label: "Verbal yes", evidence: "verbal_yes" },
      { label: "Next step dated", evidence: "next_step_dated" },
    ],
  },
  { name: "Won", probability: 100, kind: "won", staleAfterDays: null, entryCriteria: [] },
  { name: "Lost", probability: 0, kind: "lost", staleAfterDays: null, entryCriteria: [] },
];

/**
 * Creates the default stages for a workspace that has none (inside its withTenant transaction).
 * Idempotent and safe under concurrency: a transaction-scoped advisory lock per workspace
 * serialises seeders, and the check runs after the lock. Returns true when it seeded.
 */
export async function seedDefaultStages(tx: Tx, workspaceId: string): Promise<boolean> {
  await lockPipeline(tx, workspaceId);
  const existing = await tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, workspaceId))
    .limit(1);
  if (existing.length > 0) return false;
  await tx.insert(pipelineStages).values(
    DEFAULT_STAGES.map((s, position) => ({
      workspaceId,
      position,
      name: s.name,
      probability: s.probability,
      kind: s.kind,
      staleAfterDays: s.staleAfterDays,
      entryCriteria: s.entryCriteria,
    })),
  );
  return true;
}

/** Serialises changes to one workspace's stage list until the transaction ends. */
export async function lockPipeline(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pipeline:${workspaceId}`}))`);
}
