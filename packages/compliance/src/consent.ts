/**
 * Consent records for commercial email.
 *
 * CASL (Canada) allows implied consent for a limited time:
 *  - existing business relationship from a purchase or contract: 2 years
 *  - from an inquiry or application: 6 months
 * Express consent does not expire until withdrawn.
 *
 * US (CAN-SPAM) is opt-out based: no prior consent needed, but an unsubscribe
 * must always be honoured. These rules are reviewed by a lawyer every quarter.
 */
export type ConsentBasis =
  "express" | "implied_purchase" | "implied_inquiry" | "legitimate_interest" | "none";

export interface ConsentRecord {
  basis: ConsentBasis;
  obtainedAt: Date;
  withdrawnAt?: Date;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/** When a consent record stops being valid. `null` = no expiry. */
export function consentExpiresAt(record: ConsentRecord): Date | null {
  switch (record.basis) {
    case "implied_purchase":
      return addMonths(record.obtainedAt, 24);
    case "implied_inquiry":
      return addMonths(record.obtainedAt, 6);
    default:
      return null;
  }
}

export type Jurisdiction = "CA" | "US" | "EU" | "OTHER";

export interface EmailPermission {
  allowed: boolean;
  reason: string;
}

/**
 * Can we send a commercial email to this contact right now?
 * Returns a reason so the decision can be shown to the user and logged as proof.
 */
export function canSendCommercialEmail(
  jurisdiction: Jurisdiction,
  consent: ConsentRecord | undefined,
  now: Date = new Date(),
): EmailPermission {
  if (consent?.withdrawnAt && consent.withdrawnAt <= now) {
    return { allowed: false, reason: "Contact withdrew consent (unsubscribed)." };
  }

  if (jurisdiction === "CA") {
    if (!consent || consent.basis === "none" || consent.basis === "legitimate_interest") {
      return { allowed: false, reason: "CASL: no express or implied consent on record." };
    }
    const expiresAt = consentExpiresAt(consent);
    if (expiresAt && expiresAt <= now) {
      return {
        allowed: false,
        reason: `CASL: implied consent expired on ${expiresAt.toISOString().slice(0, 10)}.`,
      };
    }
    return { allowed: true, reason: `CASL: ${consent.basis.replace("_", " ")} consent is valid.` };
  }

  if (jurisdiction === "EU") {
    if (!consent || consent.basis === "none") {
      return {
        allowed: false,
        reason: "GDPR: record a lawful basis (consent or legitimate interest) first.",
      };
    }
    return {
      allowed: true,
      reason: `GDPR: lawful basis recorded (${consent.basis.replace("_", " ")}).`,
    };
  }

  return {
    allowed: true,
    reason: "CAN-SPAM: allowed with sender ID, physical address and a working unsubscribe.",
  };
}
