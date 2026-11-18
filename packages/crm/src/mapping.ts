/**
 * Field mapping: default mappings per provider, the effective mapping list for a run, and the
 * per-field conversion between Openline rows and canonical CRM values.
 *
 * Values are compared in one "agreement space" per field so that a value we just wrote hashes the
 * same on both sides (echo suppression):
 *  - text: sanitized plain text, cut to Openline limits
 *  - companyId / primaryContactId: the CRM id (local ids resolved through crm_links)
 *  - ownerId: the owner's email (unmatched CRM owners read as the connection's default owner)
 *  - stage: the Openline stage id (CRM stages mapped many-to-one)
 *  - amount: "<minor units> <currency>"
 *  - dates: YYYY-MM-DD
 */
import {
  CRM_LIMITS,
  CRM_STANDARD_FIELDS,
  type CrmDirection,
  type CrmObject,
  type CrmProvider,
  type CrmSourceOfTruth,
} from "@openline/shared";
import { decimalToMinor, isCurrencyCode, minorToDecimal } from "./currency";
import { normalizeDomain } from "./domain";
import { cleanDate, cleanDecimal, cleanExternalId, cleanText } from "./sanitize";
import { LOST, type RemoteRecord } from "./types";

export const SKIP = Symbol("skip");
export type Value = string | null;

export interface MappingRow {
  object: CrmObject;
  localField: string;
  remoteField: string | null;
  direction: CrmDirection;
  sourceOfTruth: CrmSourceOfTruth;
  standard: boolean;
}

export interface EffectiveMapping {
  object: CrmObject;
  /** Openline field (standard name or custom.<key>). */
  field: string;
  /** Canonical CRM key (standard name or custom:<remote key>). */
  remoteKey: string;
  direction: CrmDirection;
  sourceOfTruth: CrmSourceOfTruth;
}

/**
 * CRM properties a mapping may never use: the match key (email) and consent (opt-out) fields.
 * Email is the key and never overwritten; opt-outs travel only by the opt-out rule (never
 * re-subscribed), so no field mapping may write or read them.
 */
export const RESERVED_REMOTE_FIELDS: Record<CrmProvider, Record<CrmObject, readonly string[]>> = {
  hubspot: {
    contact: ["email", "hs_additional_emails", "hs_email_optout", "hs_object_id"],
    company: ["hs_object_id"],
    deal: ["hs_object_id"],
  },
  pipedrive: {
    contact: ["id", "email", "emails", "primary_email", "marketing_status"],
    company: ["id"],
    deal: ["id"],
  },
};

export function reservedRemoteField(
  provider: CrmProvider,
  object: CrmObject,
  remoteField: string,
): boolean {
  return RESERVED_REMOTE_FIELDS[provider][object].includes(remoteField.toLowerCase());
}

/** Standard rows seeded at connect. Pipedrive has no standard job title or company domain. */
export function defaultMappings(provider: CrmProvider): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const object of ["contact", "company", "deal"] as const) {
    for (const localField of CRM_STANDARD_FIELDS[object]) {
      const unmapped =
        provider === "pipedrive" &&
        ((object === "contact" && localField === "title") ||
          (object === "company" && localField === "domain"));
      rows.push({
        object,
        localField,
        remoteField: null,
        direction: unmapped ? "off" : "both",
        sourceOfTruth: "newest",
        standard: true,
      });
    }
  }
  return rows;
}

/** The mappings that sync in a run, with their canonical keys. */
export function effectiveMappings(
  rows: MappingRow[],
  native: (o: CrmObject) => readonly string[],
): EffectiveMapping[] {
  const out: EffectiveMapping[] = [];
  for (const r of rows) {
    if (r.direction === "off") continue;
    let remoteKey: string | null;
    if (r.remoteField) remoteKey = `custom:${r.remoteField}`;
    else if (r.localField.startsWith("custom.")) remoteKey = null;
    else remoteKey = native(r.object).includes(r.localField) ? r.localField : null;
    if (!remoteKey) continue;
    out.push({
      object: r.object,
      field: r.localField,
      remoteKey,
      direction: r.direction,
      sourceOfTruth: r.sourceOfTruth,
    });
  }
  return out;
}

/** The remote custom keys a run must request. */
export function customKeys(
  mappings: EffectiveMapping[],
  object: CrmObject,
  extra: string[] = [],
): string[] {
  return [
    ...new Set([
      ...mappings
        .filter((m) => m.object === object && m.remoteKey.startsWith("custom:"))
        .map((m) => m.remoteKey),
      ...extra,
    ]),
  ];
}

/** Lookups a run resolves once (links, owners, stages, currencies). */
export interface Lookup {
  remoteIdOf(object: CrmObject, localId: string): string | null;
  localIdOf(object: CrmObject, remoteId: string): string | null;
  emailOfUser(userId: string): string | null;
  userOfEmail(email: string): string | null;
  remoteOwnerOfEmail(email: string): string | null;
  emailOfRemoteOwner(remoteId: string): string | null;
  /** CRM stage → Openline stage (null = unmapped). */
  stageFrom(remoteStage: string): string | null;
  /** Openline stage → CRM stage (null = unmapped). */
  stageTo(localStage: string): string | null;
  stageKind(localStage: string): "open" | "won" | "lost" | null;
  defaultOwnerId: string | null;
  /** CRM currencies (null = any). */
  currencies: string[] | null;
  defaultCurrency: string;
  providerLabel: string;
}

export interface LocalContactRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phone: string | null;
  companyId: string | null;
  ownerId: string | null;
  custom: Record<string, unknown>;
  status: string;
  updatedAt: Date;
}
export interface LocalCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  custom: Record<string, unknown>;
  updatedAt: Date;
}
export interface LocalDealRow {
  id: string;
  name: string;
  amountMinor: number | null;
  currency: string;
  stageId: string;
  expectedCloseDate: string | null;
  lostReason: string | null;
  companyId: string | null;
  primaryContactId: string | null;
  ownerId: string;
  updatedAt: Date;
}
export type LocalRow = LocalContactRow | LocalCompanyRow | LocalDealRow;

const TEXT_LIMITS: Record<string, number> = {
  firstName: CRM_LIMITS.nameMax,
  lastName: CRM_LIMITS.nameMax,
  name: CRM_LIMITS.nameMax,
  title: CRM_LIMITS.titleMax,
  phone: CRM_LIMITS.phoneMax,
  lostReason: 500,
};

function customOf(row: LocalRow): Record<string, unknown> {
  return "custom" in row ? row.custom : {};
}

function localText(v: unknown, max: number): Value {
  if (v === null || v === undefined) return null;
  return cleanText(typeof v === "string" ? v : JSON.stringify(v), max);
}

/** The Openline side of a field, in agreement space. */
export function localValue(m: EffectiveMapping, row: LocalRow, lk: Lookup): Value | typeof SKIP {
  const r = row as unknown as Record<string, unknown>;
  if (m.field.startsWith("custom."))
    return localText(customOf(row)[m.field.slice(7)], CRM_LIMITS.customValueMax);
  switch (m.field) {
    case "companyId": {
      const id = r.companyId as string | null;
      return id ? (lk.remoteIdOf("company", id) ?? `local:${id}`) : null;
    }
    case "primaryContactId": {
      const id = r.primaryContactId as string | null;
      return id ? (lk.remoteIdOf("contact", id) ?? `local:${id}`) : null;
    }
    case "ownerId": {
      const id = r.ownerId as string | null;
      return id ? (lk.emailOfUser(id) ?? null) : null;
    }
    case "stage":
      return (row as LocalDealRow).stageId;
    case "amount": {
      const d = row as LocalDealRow;
      return d.amountMinor === null ? null : `${d.amountMinor} ${d.currency}`;
    }
    case "domain":
      return normalizeDomain(r.domain);
    case "expectedCloseDate":
      return cleanDate(r.expectedCloseDate);
    default:
      return localText(r[m.field], TEXT_LIMITS[m.field] ?? CRM_LIMITS.customValueMax);
  }
}

/** The CRM side of a field, in agreement space (sanitized: CRM text is untrusted). */
export function remoteValue(
  m: EffectiveMapping,
  rec: RemoteRecord,
  lk: Lookup,
): Value | typeof SKIP {
  const raw = rec.fields[m.remoteKey] ?? null;
  if (m.remoteKey.startsWith("custom:")) {
    if (m.field === "domain") return normalizeDomain(raw);
    return cleanText(
      raw,
      m.field.startsWith("custom.")
        ? CRM_LIMITS.customValueMax
        : (TEXT_LIMITS[m.field] ?? CRM_LIMITS.customValueMax),
    );
  }
  switch (m.field) {
    case "companyId":
    case "primaryContactId":
      return cleanExternalId(raw);
    case "ownerId": {
      const id = cleanExternalId(raw);
      // Deals always have an owner in Openline: no CRM owner reads as the default owner.
      if (!id && m.object !== "deal") return null;
      // Unmatched CRM owner → the connection's default owner.
      const email = id ? lk.emailOfRemoteOwner(id) : null;
      if (email && lk.userOfEmail(email)) return email;
      return lk.defaultOwnerId ? lk.emailOfUser(lk.defaultOwnerId) : SKIP;
    }
    case "stage": {
      const stage = cleanExternalId(raw) ?? (raw === "@won" || raw === "@lost" ? raw : null);
      if (!stage) return SKIP;
      return lk.stageFrom(stage) ?? SKIP;
    }
    case "amount": {
      const dec = cleanDecimal(raw);
      if (dec === null) return null;
      const cur = isCurrencyCode(rec.fields.currency) ? rec.fields.currency : lk.defaultCurrency;
      const conv = decimalToMinor(dec, cur);
      return conv ? `${conv.minor} ${cur}` : SKIP;
    }
    case "domain":
      return normalizeDomain(raw);
    case "expectedCloseDate":
      return cleanDate(raw);
    default:
      return cleanText(raw, TEXT_LIMITS[m.field] ?? CRM_LIMITS.customValueMax);
  }
}

export type PushResult =
  | { kind: "fields"; fields: Record<string, Value> }
  | { kind: "assoc"; companyId?: string; contactId?: string }
  | { kind: "skip" }
  | { kind: "error"; code: "currency_mismatch" | "validation"; message: string };

/** What to send to the CRM to make it hold the local value. */
export function pushFor(m: EffectiveMapping, value: Value, lk: Lookup): PushResult {
  switch (m.field) {
    case "companyId":
    case "primaryContactId": {
      if (value === null || value.startsWith("local:")) return { kind: "skip" };
      return m.field === "companyId"
        ? { kind: "assoc", companyId: value }
        : { kind: "assoc", contactId: value };
    }
    case "ownerId": {
      if (value === null) return { kind: "skip" };
      // An Openline owner with no CRM user leaves the CRM owner unchanged.
      const remote = lk.remoteOwnerOfEmail(value);
      return remote ? { kind: "fields", fields: { ownerId: remote } } : { kind: "skip" };
    }
    case "stage": {
      if (value === null) return { kind: "skip" };
      const remote = lk.stageTo(value);
      return remote ? { kind: "fields", fields: { stage: remote } } : { kind: "skip" };
    }
    case "amount": {
      if (value === null) return { kind: "fields", fields: { amount: null } };
      const [minor, cur] = value.split(" ");
      if (lk.currencies && !lk.currencies.includes(cur!)) {
        return {
          kind: "error",
          code: "currency_mismatch",
          message: `The ${lk.providerLabel} account can't hold ${cur} amounts; the amount isn't synced (no currency conversion).`,
        };
      }
      return {
        kind: "fields",
        fields: { amount: minorToDecimal(Number(minor), cur!), currency: cur! },
      };
    }
    default:
      return { kind: "fields", fields: { [m.remoteKey]: value } };
  }
}

/** Column patch that makes the local row hold the CRM value. Null result = can't apply. */
export function pullFor(
  m: EffectiveMapping,
  value: Value,
  row: LocalRow | null,
  rec: RemoteRecord,
  lk: Lookup,
): Record<string, unknown> | null {
  if (m.field.startsWith("custom.")) return { [`custom.${m.field.slice(7)}`]: value };
  switch (m.field) {
    case "companyId":
    case "primaryContactId": {
      if (value === null) return { [m.field]: null };
      const local = lk.localIdOf(m.field === "companyId" ? "company" : "contact", value);
      return local ? { [m.field]: local } : null;
    }
    case "ownerId": {
      const user = value ? lk.userOfEmail(value) : null;
      if (!user) return row && "stageId" in row ? null : { ownerId: null };
      return { ownerId: user };
    }
    case "stage": {
      if (!value) return null;
      const patch: Record<string, unknown> = { stageId: value };
      // Pipedrive lost without a reason.
      if (
        lk.stageKind(value) === "lost" &&
        rec.fields.stage === LOST &&
        !cleanText(rec.fields.lostReason, 500)
      ) {
        const current = row && "lostReason" in row ? row.lostReason : null;
        if (!current) patch.lostReason = `Not given (from ${lk.providerLabel})`;
      }
      return patch;
    }
    case "amount": {
      if (value === null) return { amountMinor: null };
      const [minor, cur] = value.split(" ");
      return { amountMinor: Number(minor), currency: cur };
    }
    case "name":
      return value === null ? null : { name: value };
    default:
      return { [m.field]: value };
  }
}
