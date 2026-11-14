import type { Job } from "bullmq";
import { isSuppressed, isWithinSendWindow } from "@openline/compliance";
import { SENDING_DEFAULTS } from "@openline/shared";

export interface SequenceSendJob {
  workspaceId: string;
  enrollmentId: string;
  contactEmail: string;
  contactTimeZone: string;
  mailboxSentToday: number;
  mailboxDailyCap?: number;
}

export type PreSendDecision =
  { action: "send" } | { action: "skip"; reason: string } | { action: "defer"; reason: string };

/**
 * Pre-send checks, run for every email in this order. Pure function: easy to test,
 * and the same rules run in the API's "preview" so users see why something won't send.
 */
export function preSendCheck(
  job: SequenceSendJob,
  suppressions: ReadonlySet<string>,
  now: Date = new Date(),
): PreSendDecision {
  if (isSuppressed(job.contactEmail, suppressions)) {
    return { action: "skip", reason: "suppressed" };
  }
  const cap = job.mailboxDailyCap ?? SENDING_DEFAULTS.dailyCapPerMailbox;
  if (job.mailboxSentToday >= cap) {
    return { action: "defer", reason: "mailbox_daily_cap" };
  }
  if (!isWithinSendWindow(now, job.contactTimeZone)) {
    return { action: "defer", reason: "outside_send_window" };
  }
  return { action: "send" };
}

/** Job handler. The actual send through @openline/email adapters lands in Sprint 3 (OL-E4). */
export async function handleSequenceSend(job: Job<SequenceSendJob>): Promise<PreSendDecision> {
  const decision = preSendCheck(job.data, new Set());
  await job.log(`pre-send decision: ${JSON.stringify(decision)}`);
  return decision;
}
