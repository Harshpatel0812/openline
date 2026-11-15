/**
 * Scout never acts on its own. Anything that sends, calls or changes data becomes a
 * proposed action that a human must approve. Every transition is written to the audit log.
 */
export type AiActionStatus = "proposed" | "approved" | "rejected" | "executed" | "failed";

/** Sprint 4 (Scout v1) only proposes drafts; the other kinds arrive with later Scout features. */
export type AiActionKind =
  "draft_email" | "draft_reply" | "send_email" | "create_segment" | "update_deal" | "create_task";

export interface AiAction {
  id: string;
  workspaceId: string;
  userId: string;
  kind: AiActionKind;
  proposal: unknown;
  /** Record IDs the model used, shown to the user as citations. */
  sources: string[];
  status: AiActionStatus;
}

const ALLOWED: Record<AiActionStatus, AiActionStatus[]> = {
  proposed: ["approved", "rejected"],
  approved: ["executed", "failed"],
  rejected: [],
  executed: [],
  failed: [],
};

/** Enforces the approval flow: nothing can jump from "proposed" to "executed". */
export function transition(action: AiAction, next: AiActionStatus): AiAction {
  if (!ALLOWED[action.status].includes(next)) {
    throw new Error(`Invalid AI action transition: ${action.status} -> ${next}`);
  }
  return { ...action, status: next };
}
