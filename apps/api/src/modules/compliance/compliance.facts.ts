/**
 * Loads the facts the compliance engine needs (suppressions, consent, workspace settings) for a set
 * of contacts in one workspace, with a fixed number of queries. Run inside withTenant(); every
 * query also filters by workspace_id.
 */
import {
  currentConsent,
  DEFAULT_SEND_WINDOW,
  evaluateEmailContact,
  firstBlockingCheck,
  type EmailContactInput,
  type EmailEvaluation,
  type SendWindow,
} from "@openline/compliance";
import {
  and,
  consents,
  eq,
  inArray,
  suppressions,
  workspaces,
  type Contact,
  type Tx,
} from "@openline/db";
import type { ContactComplianceSummaryDto } from "@openline/shared";

export type FactsContact = Pick<Contact, "id" | "email" | "status" | "country" | "timeZone">;

export interface FactsOptions {
  sendWindow?: SendWindow;
}

export interface WorkspaceFacts {
  mailingAddress: string | null;
  defaultTimeZone: string;
}

export async function loadEmailFacts(
  tx: Tx,
  workspaceId: string,
  list: FactsContact[],
  options: FactsOptions = {},
): Promise<{ workspace: WorkspaceFacts; inputs: Map<string, EmailContactInput> }> {
  const [ws] = await tx
    .select({
      mailingAddress: workspaces.mailingAddress,
      defaultTimeZone: workspaces.defaultTimeZone,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const workspace: WorkspaceFacts = {
    mailingAddress: ws?.mailingAddress ?? null,
    defaultTimeZone: ws?.defaultTimeZone ?? "America/New_York",
  };
  const inputs = new Map<string, EmailContactInput>();
  if (!list.length) return { workspace, inputs };

  // Only the suppression values that could match these contacts (emails and @domains).
  const candidates = new Set<string>();
  for (const c of list) {
    const email = c.email.toLowerCase();
    candidates.add(email);
    const at = email.lastIndexOf("@");
    if (at > 0) candidates.add(email.slice(at));
  }
  const suppressed = new Set(
    (
      await tx
        .select({ value: suppressions.value })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.workspaceId, workspaceId),
            inArray(suppressions.value, [...candidates]),
          ),
        )
    ).map((r) => r.value),
  );

  const consentRows = await tx
    .select()
    .from(consents)
    .where(
      and(
        eq(consents.workspaceId, workspaceId),
        inArray(
          consents.contactId,
          list.map((c) => c.id),
        ),
      ),
    );
  // The same consent fact as the sending engine and inbox replies (packages/compliance).
  const byContact = new Map<string, (typeof consentRows)[number][]>();
  for (const row of consentRows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push(row);
    byContact.set(row.contactId, list);
  }

  for (const c of list) {
    inputs.set(c.id, {
      email: c.email,
      country: c.country,
      status: c.status,
      timeZone: c.timeZone ?? workspace.defaultTimeZone,
      consent: currentConsent(byContact.get(c.id) ?? []),
      suppressions: suppressed,
      mailingAddress: workspace.mailingAddress,
      sendWindow: options.sendWindow ?? DEFAULT_SEND_WINDOW,
    });
  }
  return { workspace, inputs };
}

/** Evaluates every loaded contact at `at`. */
export function evaluateAll(
  inputs: Map<string, EmailContactInput>,
  at: Date,
): Map<string, EmailEvaluation> {
  const out = new Map<string, EmailEvaluation>();
  for (const [id, input] of inputs) out.set(id, evaluateEmailContact(input, at));
  return out;
}

/** The compact form shown next to a contact in the enroll dialog. */
export function summarise(evaluation: EmailEvaluation): ContactComplianceSummaryDto {
  const check = firstBlockingCheck(evaluation);
  return {
    decision: evaluation.decision,
    ...(evaluation.nextAllowedAt ? { nextAllowedAt: evaluation.nextAllowedAt.toISOString() } : {}),
    ...(check ? { check: { ...check } } : {}),
  };
}
