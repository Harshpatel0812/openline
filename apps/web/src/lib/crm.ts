/**
 * CRM sync (OL-E8): the DTOs come from `@openline/shared` (packages/shared/src/crm.ts); this file
 * holds the labels and pure helpers the Integrations pages, sync log and record badges share.
 */
import {
  CRM_LIMITS,
  CRM_PROVIDER_LABELS,
  type CrmConnectionDto,
  type CrmDirection,
  type CrmFieldMappingDto,
  type CrmObject,
  type CrmPreviewBucket,
  type CrmProvider,
  type CrmRecordLinkDto,
  type CrmRemoteFieldDto,
  type CrmRemoteStageDto,
  type CrmRunKind,
  type CrmSourceOfTruth,
  type CrmStageMappingsDto,
} from "@openline/shared";

export {
  CRM_OBJECTS,
  CRM_PROVIDERS,
  CRM_PROVIDER_LABELS,
  type CrmConnectionDto,
  type CrmDirection,
  type CrmFieldMappingDto,
  type CrmObject,
  type CrmPage,
  type CrmPipelineDto,
  type CrmProvider,
  type CrmRecordLinkDto,
  type CrmRemoteFieldDto,
  type CrmRunDto,
  type CrmSourceOfTruth,
  type CrmStageMappingsDto,
  type CrmStatusDto,
  type CrmSyncErrorDto,
} from "@openline/shared";

export type CrmFieldType = CrmRemoteFieldDto["type"];
export type CrmLocalType = Exclude<CrmFieldType, "enumeration">;

export const CRM_OBJECT_LABELS: Record<CrmObject, string> = {
  contact: "Contacts",
  company: "Companies",
  deal: "Deals",
};

// ------------------------------------------------------------------ labels

type Status = CrmConnectionDto["status"];

export const CRM_STATUS_LABELS: Record<Status, string> = {
  needs_setup: "Needs setup",
  previewing: "Preview ready",
  importing: "Importing",
  active: "Syncing",
  paused: "Paused",
  error: "Reconnect needed",
  disconnected: "Disconnected",
};

export const CRM_STATUS_TONES: Record<
  Status,
  "neutral" | "accent" | "success" | "warning" | "danger" | "info"
> = {
  needs_setup: "info",
  previewing: "info",
  importing: "accent",
  active: "success",
  paused: "warning",
  error: "danger",
  disconnected: "neutral",
};

export const DIRECTION_LABELS: Record<CrmDirection, string> = {
  both: "Both ways",
  to_crm: "Openline → CRM",
  from_crm: "CRM → Openline",
  off: "Off",
};

export const SOURCE_OF_TRUTH_LABELS: Record<CrmSourceOfTruth, string> = {
  newest: "Newest change wins",
  openline: "Openline wins",
  crm: "CRM wins",
};

export const RUN_KIND_LABELS: Record<CrmRunKind, string> = {
  preview: "Preview",
  import: "Import",
  incremental: "Sync",
  reconcile: "Daily check",
};

export const SKIPPED_BUCKETS: { key: CrmPreviewBucket; label: string }[] = [
  { key: "skipped_no_email", label: "no valid email" },
  { key: "skipped_other_pipeline", label: "in another pipeline" },
  { key: "skipped_suppressed_new", label: "suppressed and not in Openline" },
  { key: "skipped_invalid", label: "invalid data" },
];

const ERROR_CODE_LABELS: Record<string, string> = {
  validation: "Rejected as invalid",
  currency_mismatch: "Currency not available in the CRM",
  missing_property: "CRM property missing",
  merge_conflict: "Two Openline records point at one CRM record",
  unconfirmed: "Couldn't confirm the CRM record was created",
  not_found: "Record not found in the CRM",
  remote_rejected: "Rejected by the CRM",
  invalid_email: "No valid email",
  deleted_in_crm: "Deleted in the CRM",
  stage_unmapped: "Stage not mapped",
  stage_mapping: "Stage mapping needs attention",
  domain_taken: "Domain already used by another company",
  duplicate_value: "Duplicates another Openline record",
  time_budget: "Stopped early (took too long)",
};

/** Upgrade note for Settings → Integrations when the plan doesn't include CRM sync. */
export function crmPlanNote(connected: boolean): string {
  return connected
    ? "Your plan doesn't include CRM sync, so sync has stopped: nothing changes in either system. You can still see the connection, keep it paused or disconnect it. Move to the Team plan or higher to resume."
    : "Two-way HubSpot and Pipedrive sync is included in Team, Growth and Scale.";
}

/** A note for a preview whose counts are incomplete (cut short by its time budget). */
export function previewNote(run: { status: string }): string | null {
  return run.status === "partial"
    ? "This preview stopped before it had read the whole account (it took too long), so these counts cover part of it. The import itself reads everything."
    : null;
}

/** Shown in the disconnect dialog under "Disconnect and forget links". */
export const DISCONNECT_FORGET_WARNING =
  "After forgetting links, a reconnect matches contacts by email, companies by domain and deals by exact name in the pipeline; deals with changed or repeated names may be created twice. People erased in Openline stay erased: they are never imported again.";

export function errorCodeLabel(code: string): string {
  return ERROR_CODE_LABELS[code] ?? code.replace(/_/g, " ");
}

/** Messages for `?error=` on the OAuth return and for authorize errors. */
const CALLBACK_ERRORS: Record<string, string> = {
  state_invalid: "The sign-in link was not valid. Please start connecting again.",
  state_expired: "The sign-in took longer than 10 minutes. Please start connecting again.",
  state_mismatch: "The sign-in was started by someone else. Please start it yourself.",
  access_denied: "Access wasn't granted in the CRM, so nothing was connected.",
  crm_already_connected: "This workspace is already connected to a CRM. Disconnect it first.",
  crm_account_not_allowed: "Only sandbox CRM accounts can be connected on this server.",
  missing_scope: "The CRM didn't grant the permissions Openline needs.",
  plan_upgrade_required: "CRM sync is included in the Team plan and up.",
  crm_not_configured: "This CRM connection isn't set up on this server yet.",
  signed_out: "You were signed out during the sign-in. Sign in and connect again.",
  forbidden: "Only owners and admins can connect a CRM.",
  email_not_verified:
    "Verify your email address first — use “Resend email” in the banner at the top of the page.",
  crm_failed: "The CRM didn't complete the sign-in. Please try again.",
  invalid_request: "The CRM sent back an incomplete answer. Please try again.",
};

export function crmCallbackErrorMessage(code: string): string {
  return CALLBACK_ERRORS[code] ?? "The CRM wasn't connected. Please try again.";
}

// ------------------------------------------------------------------ time

/** "just now", "4 min ago", "3 h ago", "2 days ago"; future: "in 6 min". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (Number.isNaN(diff)) return "";
  const min = Math.round(Math.abs(diff) / 60_000);
  const future = diff > 0;
  if (min < 1) return future ? "in under a minute" : "just now";
  let text: string;
  if (min < 60) text = `${min} min`;
  else if (min < 60 * 24) text = `${Math.round(min / 60)} h`;
  else {
    const days = Math.round(min / (60 * 24));
    text = `${days} day${days === 1 ? "" : "s"}`;
  }
  return future ? `in ${text}` : `${text} ago`;
}

// ------------------------------------------------------------------ record badge

export interface CrmBadgeView {
  text: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  /** Link to the CRM record, only for safe URLs. */
  href: string | null;
}

/** Hosts a CRM record link may point at: HubSpot's app hosts and Pipedrive company domains. */
const CRM_LINK_HOSTS = [
  "app.hubspot.com",
  "app-eu1.hubspot.com",
  "app-na2.hubspot.com",
  "app-ap1.hubspot.com",
];
const PIPEDRIVE_HOST = /^[a-z0-9-]+\.pipedrive\.com$/;

export interface LinkEnv {
  /** Production build: loopback links (the fake CRM) are refused. */
  production: boolean;
  /** Extra allowed https hosts from config (NEXT_PUBLIC_CRM_LINK_HOSTS, comma-separated). */
  extraHosts: string[];
}

function linkEnv(): LinkEnv {
  return {
    production: process.env.NEXT_PUBLIC_APP_ENV === "production",
    extraHosts: (process.env.NEXT_PUBLIC_CRM_LINK_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Only links to the CRM become links: https to HubSpot's app hosts, a *.pipedrive.com company
 * domain or a configured extra host; http on localhost only outside production (the fake CRM).
 */
export function safeExternalUrl(
  url: string | null | undefined,
  env: LinkEnv = linkEnv(),
): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol === "https:" && !u.port) {
      if (CRM_LINK_HOSTS.includes(host) || PIPEDRIVE_HOST.test(host)) return u.href;
      if (env.extraHosts.includes(host)) return u.href;
      return null;
    }
    if (
      !env.production &&
      u.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1")
    ) {
      return u.href;
    }
  } catch {
    return null;
  }
  return null;
}

function providerName(p: string): string {
  return CRM_PROVIDER_LABELS[p as CrmProvider] ?? p;
}

export function crmBadge(crm: CrmRecordLinkDto, now: number = Date.now()): CrmBadgeView {
  const name = providerName(crm.provider);
  const href = safeExternalUrl(crm.url);
  const deleted = crm.reason === "deleted_in_crm" || crm.reason === "deleted";
  switch (crm.state) {
    case "linked":
      return {
        text:
          `Synced with ${name}${crm.syncedAt ? ` · ${relativeTime(crm.syncedAt, now)}` : ""}` +
          (crm.reason && !deleted ? ` · ${errorCodeLabel(crm.reason)}` : ""),
        tone: crm.reason ? "warning" : "success",
        href,
      };
    case "creating":
      return { text: `Creating in ${name}…`, tone: "info", href: null };
    case "paused":
      return {
        text:
          crm.reason === "stage_mapping"
            ? "Sync paused · Stage mapping needs attention"
            : "Sync paused",
        tone: "warning",
        href,
      };
    case "unconfirmed":
      return { text: "Not synced: needs attention", tone: "danger", href };
    case "unlinked":
      if (deleted) return { text: `Deleted in ${name}`, tone: "neutral", href: null };
      if (!crm.reason || crm.reason === "not_synced") {
        return { text: "Not synced", tone: "neutral", href: null };
      }
      return { text: `Not synced: ${errorCodeLabel(crm.reason)}`, tone: "danger", href };
    default:
      return {
        text: deleted ? `Deleted in ${name}` : "Not synced",
        tone: "neutral",
        href: null,
      };
  }
}

/** The `crm` field of a contact, company or deal, checked before use. */
export function crmOf(record: { crm?: unknown }): CrmRecordLinkDto | null {
  const value = record.crm;
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<CrmRecordLinkDto>;
  if (typeof v.provider !== "string" || typeof v.state !== "string") return null;
  return v as CrmRecordLinkDto;
}

// ------------------------------------------------------------------ stage mapping

/** Editable stage mapping: a stage may still be unmapped (null) while the admin works. */
export interface StageMappingDraft {
  toCrm: { stageId: string; remoteStageId: string | null }[];
  fromCrm: { remoteStageId: string; stageId: string | null }[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pre-fills a stage mapping: saved choices that still exist, then same name, then won/lost kind
 * (the PRD's default). Anything else is left null for the admin.
 */
export function prefillStageMapping(
  openline: { id: string; name: string; kind: "open" | "won" | "lost" }[],
  crm: CrmRemoteStageDto[],
  existing?: Pick<CrmStageMappingsDto, "toCrm" | "fromCrm"> | null,
): StageMappingDraft {
  const crmIds = new Set(crm.map((s) => s.id));
  const olIds = new Set(openline.map((s) => s.id));
  const prevTo = new Map(existing?.toCrm.map((m) => [m.stageId, m.remoteStageId]));
  const prevFrom = new Map(existing?.fromCrm.map((m) => [m.remoteStageId, m.stageId]));
  const crmByName = (name: string) => crm.find((s) => norm(s.name) === norm(name));
  const olByName = (name: string) => openline.find((s) => norm(s.name) === norm(name));

  return {
    toCrm: openline.map((s) => {
      const prev = prevTo.get(s.id);
      const guess =
        (prev && crmIds.has(prev) ? prev : null) ??
        crmByName(s.name)?.id ??
        (s.kind !== "open" ? crm.find((c) => c.kind === s.kind)?.id : undefined) ??
        null;
      return { stageId: s.id, remoteStageId: guess };
    }),
    fromCrm: crm.map((s) => {
      const prev = prevFrom.get(s.id);
      const guess =
        (prev && olIds.has(prev) ? prev : null) ??
        olByName(s.name)?.id ??
        (s.kind !== "open" ? openline.find((o) => o.kind === s.kind)?.id : undefined) ??
        null;
      return { remoteStageId: s.id, stageId: guess };
    }),
  };
}

export function stageMappingComplete(m: StageMappingDraft): boolean {
  return m.toCrm.every((r) => r.remoteStageId !== null) && m.fromCrm.every((r) => r.stageId);
}

/** The PUT body; only call when complete. */
export function stageMappingInput(m: StageMappingDraft) {
  return {
    toCrm: m.toCrm.flatMap((r) =>
      r.remoteStageId ? [{ stageId: r.stageId, remoteStageId: r.remoteStageId }] : [],
    ),
    fromCrm: m.fromCrm.flatMap((r) =>
      r.stageId ? [{ remoteStageId: r.remoteStageId, stageId: r.stageId }] : [],
    ),
  };
}

// ------------------------------------------------------------------ field mapping

export const MAX_CUSTOM_MAPPINGS_PER_OBJECT = CRM_LIMITS.maxCustomMappings;

/** A row in the field-mapping editor: the DTO plus the custom field's type (UI only). */
export interface FieldMappingRow extends Omit<CrmFieldMappingDto, "id"> {
  id?: string;
  localType?: CrmLocalType;
}

const COMPATIBLE: Record<CrmLocalType, CrmFieldType[]> = {
  text: ["text", "enumeration"],
  number: ["number"],
  date: ["date"],
  boolean: ["boolean"],
};

export function compatibleTypes(localType: CrmLocalType): CrmFieldType[] {
  return COMPATIBLE[localType];
}

/** Picklists and read-only CRM properties only map from the CRM in v1. */
export function allowedDirections(field: Pick<CrmRemoteFieldDto, "type" | "readOnly">) {
  if (field.readOnly || field.type === "enumeration") return ["from_crm", "off"] as CrmDirection[];
  return ["both", "to_crm", "from_crm", "off"] as CrmDirection[];
}

/** `custom.<key>`: lower-case letter first, then letters, digits or _, up to 40. */
export function customKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

/** Problems with a set of field mappings, keyed by row index (empty = valid). */
export function validateFieldMappings(
  rows: FieldMappingRow[],
  remote: Partial<Record<CrmObject, CrmRemoteFieldDto[]>>,
): Record<number, string> {
  const out: Record<number, string> = {};
  const seenLocal = new Set<string>();
  const seenRemote = new Set<string>();
  const customCount: Record<CrmObject, number> = { contact: 0, company: 0, deal: 0 };
  rows.forEach((row, i) => {
    if (!row.standard) {
      customCount[row.object] += 1;
      if (customCount[row.object] > MAX_CUSTOM_MAPPINGS_PER_OBJECT) {
        out[i] = `At most ${MAX_CUSTOM_MAPPINGS_PER_OBJECT} extra mappings per object`;
        return;
      }
      if (!/^custom\.[a-z][a-z0-9_]{0,39}$/.test(row.localField) || !row.remoteField) {
        out[i] = "Name the Openline field and choose the CRM field";
        return;
      }
    }
    const localKey = `${row.object}:${row.localField}`;
    if (seenLocal.has(localKey)) out[i] = "This Openline field is already mapped";
    seenLocal.add(localKey);
    if (row.remoteField) {
      const remoteKey = `${row.object}:${row.remoteField}`;
      if (!out[i] && seenRemote.has(remoteKey)) out[i] = "This CRM field is already mapped";
      seenRemote.add(remoteKey);
    }
    if (out[i] || row.standard) return;
    const field = remote[row.object]?.find((f) => f.key === row.remoteField);
    if (field && !allowedDirections(field).includes(row.direction)) {
      out[i] = field.readOnly
        ? "Read-only in the CRM: can only sync from the CRM"
        : "Picklists sync from the CRM only";
    }
  });
  return out;
}

/** The PUT body (drops UI-only fields). */
export function fieldMappingsInput(rows: FieldMappingRow[]) {
  return {
    mappings: rows.map((r) => ({
      object: r.object,
      localField: r.localField,
      remoteField: r.remoteField,
      direction: r.direction,
      sourceOfTruth: r.sourceOfTruth,
    })),
  };
}

// ------------------------------------------------------------------ preview

export interface PreviewCounts {
  create: number;
  link: number;
  update: number;
  skipped: number;
  skippedReasons: { label: string; count: number }[];
  matchedByName: number;
  onlyInOpenline: number;
}

export function previewCounts(counts: Record<string, number> | undefined): PreviewCounts {
  const c = counts ?? {};
  const n = (k: string) => (typeof c[k] === "number" ? c[k] : 0);
  const skippedReasons = SKIPPED_BUCKETS.map((b) => ({ label: b.label, count: n(b.key) })).filter(
    (r) => r.count > 0,
  );
  return {
    create: n("create"),
    link: n("link"),
    update: n("update"),
    skipped: skippedReasons.reduce((s, r) => s + r.count, 0),
    skippedReasons,
    matchedByName: n("matched_by_name"),
    onlyInOpenline: n("only_in_openline"),
  };
}
