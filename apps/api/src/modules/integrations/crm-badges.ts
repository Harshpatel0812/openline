import { hubspotRecordUrl, pipedriveRecordUrl, type CrmConfig } from "@openline/crm";
import {
  and,
  crmConnections,
  crmLinks,
  crmSyncErrors,
  eq,
  inArray,
  isNull,
  type Tx,
} from "@openline/db";
import type { CrmObject, CrmRecordLinkDto } from "@openline/shared";

/**
 * Per-record CRM badges for contact, company and deal DTOs ("Synced with HubSpot · 4 min ago",
 * "Not synced: <reason>", "Deleted in HubSpot", "Sync paused"). Empty when the workspace has no
 * live connection. Ids only from crm_links; never CRM values.
 */
export async function crmBadges(
  tx: Tx,
  workspaceId: string,
  object: CrmObject,
  ids: string[],
  config: CrmConfig,
): Promise<Map<string, CrmRecordLinkDto>> {
  const out = new Map<string, CrmRecordLinkDto>();
  if (!ids.length) return out;
  const [conn] = await tx
    .select({
      id: crmConnections.id,
      provider: crmConnections.provider,
      status: crmConnections.status,
      apiDomain: crmConnections.apiDomain,
      accountMeta: crmConnections.accountMeta,
      pipelineId: crmConnections.pipelineId,
      stageMappingComplete: crmConnections.stageMappingComplete,
    })
    .from(crmConnections)
    .where(eq(crmConnections.workspaceId, workspaceId));
  if (!conn || conn.status === "disconnected" || conn.status === "needs_setup") return out;
  const col =
    object === "contact"
      ? crmLinks.contactId
      : object === "company"
        ? crmLinks.companyId
        : crmLinks.dealId;
  const links = await tx
    .select()
    .from(crmLinks)
    .where(
      and(
        eq(crmLinks.workspaceId, workspaceId),
        eq(crmLinks.connectionId, conn.id),
        inArray(col, ids),
      ),
    );
  const errors = await tx
    .select({ localId: crmSyncErrors.localId, code: crmSyncErrors.code })
    .from(crmSyncErrors)
    .where(
      and(
        eq(crmSyncErrors.workspaceId, workspaceId),
        eq(crmSyncErrors.connectionId, conn.id),
        eq(crmSyncErrors.object, object),
        isNull(crmSyncErrors.resolvedAt),
        inArray(crmSyncErrors.localId, ids),
      ),
    );
  const errorOf = new Map(errors.map((e) => [e.localId!, e.code]));
  const url = (externalId: string) =>
    conn.provider === "hubspot"
      ? hubspotRecordUrl(
          config.hubspot?.appBase ?? "https://app.hubspot.com",
          conn.accountMeta.portalId,
          object,
          externalId,
        )
      : pipedriveRecordUrl(conn.apiDomain, object, externalId);
  const paused = conn.status === "paused" || conn.status === "error";
  // Deal sync waits while the stage mapping needs attention (a stage added on either side).
  const dealsWaiting = object === "deal" && !!conn.pipelineId && !conn.stageMappingComplete;
  for (const l of links) {
    const id = l.contactId ?? l.companyId ?? l.dealId;
    if (!id) continue;
    const badge: CrmRecordLinkDto = { provider: conn.provider, state: l.state };
    if (l.externalId && l.state !== "tombstone") badge.url = url(l.externalId) ?? undefined;
    if (l.syncedAt) badge.syncedAt = l.syncedAt.toISOString();
    if (l.state === "linked" && paused) badge.state = "paused";
    if (l.reason) badge.reason = l.reason;
    if (l.state === "linked" && dealsWaiting) {
      badge.state = "paused";
      badge.reason = "stage_mapping";
    }
    const err = errorOf.get(id);
    if (err) badge.reason = err;
    out.set(id, badge);
  }
  for (const id of ids) {
    if (!out.has(id)) {
      out.set(id, {
        provider: conn.provider,
        state: "unlinked",
        reason: errorOf.get(id) ?? "not_synced",
      });
    }
  }
  return out;
}
