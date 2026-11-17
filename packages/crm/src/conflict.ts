/**
 * Per-field conflict rule (ADR 0006): compare each side with the shadow (hash of the last agreed
 * value). Changed on one side only → it flows; changed on both → last writer wins per field
 * (CRM modified time vs Openline updated_at, ties to the CRM), unless the mapping pins a source of
 * truth. Direction limits what may flow at all. Consent is outside this rule (see optouts.ts).
 */
import type { CrmDirection, CrmSourceOfTruth } from "@openline/shared";

export type FieldAction = "none" | "push" | "pull" | "adopt";

export interface FieldState {
  /** Hash of the last agreed value; undefined = never synced (first link). */
  shadow?: string;
  localHash: string;
  remoteHash: string;
  /** Whether the local / remote value is empty (first-link rule). */
  localEmpty: boolean;
  remoteEmpty: boolean;
  direction: CrmDirection;
  sourceOfTruth: CrmSourceOfTruth;
  localAt: Date;
  remoteAt: Date;
  /**
   * Clock resolution of the comparison in ms (Pipedrive reports whole seconds: 1000). Both times
   * are cut to it first, so an Openline edit later within the CRM's second is a tie (→ CRM).
   */
  resolutionMs?: number;
}

export interface FieldDecision {
  action: FieldAction;
  /** Set when both sides changed and both directions were allowed. */
  conflict?: { winner: "openline" | "crm"; rule: CrmSourceOfTruth };
}

export function decideField(s: FieldState): FieldDecision {
  if (s.direction === "off") return { action: "none" };
  const canPush = s.direction === "both" || s.direction === "to_crm";
  const canPull = s.direction === "both" || s.direction === "from_crm";

  // Same value on both sides: nothing to write; remember it as agreed if it isn't yet.
  if (s.localHash === s.remoteHash) {
    return { action: s.shadow === s.localHash ? "none" : "adopt" };
  }

  let localChanged: boolean;
  let remoteChanged: boolean;
  if (s.shadow === undefined) {
    // First link: the import is CRM → Openline, so the CRM's value wins unless it is empty (or
    // the field is pinned to Openline).
    if (s.sourceOfTruth === "openline" || (s.remoteEmpty && !s.localEmpty)) {
      localChanged = true;
      remoteChanged = false;
    } else {
      localChanged = false;
      remoteChanged = true;
    }
  } else {
    localChanged = s.localHash !== s.shadow;
    remoteChanged = s.remoteHash !== s.shadow;
  }

  if (localChanged && !remoteChanged) return { action: canPush ? "push" : "none" };
  if (remoteChanged && !localChanged) return { action: canPull ? "pull" : "none" };

  // Both changed.
  if (!canPush) return { action: canPull ? "pull" : "none" };
  if (!canPull) return { action: "push" };
  let winner: "openline" | "crm";
  if (s.sourceOfTruth === "openline") winner = "openline";
  else if (s.sourceOfTruth === "crm") winner = "crm";
  else {
    const res = Math.max(1, s.resolutionMs ?? 1);
    const local = Math.floor(s.localAt.getTime() / res);
    const remote = Math.floor(s.remoteAt.getTime() / res);
    winner = local > remote ? "openline" : "crm";
  }
  return {
    action: winner === "openline" ? "push" : "pull",
    conflict: { winner, rule: s.sourceOfTruth },
  };
}
