import { failed, firstBlockingCheck, type EmailEvaluation } from "@openline/compliance";

export interface ReplyRefusal {
  /** Stable error code (409). */
  code: string;
  message: string;
}

/**
 * Why an inbox reply must not be sent, or null. The named codes first (unchanged API), then —
 * so a rule added later can never be skipped — any other "blocked" decision, coded with the
 * first failing check's rule id.
 */
export function replyRefusal(
  evaluation: EmailEvaluation,
  contactStatus: string | null,
  hasMailingAddress: boolean,
): ReplyRefusal | null {
  const status = failed(evaluation, "contact_status");
  if (status && contactStatus === "unsubscribed") {
    return { code: "unsubscribed", message: "This contact unsubscribed; you can't email them" };
  }
  if (status && contactStatus === "bounced") {
    return { code: "bounced", message: "Emails to this address bounce" };
  }
  if (failed(evaluation, "suppression")) {
    return { code: "suppressed", message: "This address is on your suppression list" };
  }
  const noConsent = failed(evaluation, "consent_ca") ?? failed(evaluation, "basis_eu");
  if (noConsent) return { code: "no_consent", message: noConsent.detail };
  if (failed(evaluation, "sender_identity") || !hasMailingAddress) {
    return {
      code: "mailing_address_missing",
      message: "Add your postal address in Workspace settings first (required in every email)",
    };
  }
  if (evaluation.decision === "blocked") {
    const check =
      evaluation.checks.find((c) => c.outcome === "fail") ?? firstBlockingCheck(evaluation);
    return check
      ? { code: check.rule, message: check.detail }
      : { code: "compliance_blocked", message: "Compliance rules don't allow this email" };
  }
  return null;
}
