import { Injectable } from "@nestjs/common";
import { auditLog, type Tx } from "@openline/db";

export interface AuditEvent {
  workspaceId: string;
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only record of security-relevant actions (the DB role cannot UPDATE or DELETE it).
 * Always written inside the same transaction as the change it describes.
 * Never put secrets, tokens or message bodies in metadata.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, event: AuditEvent): Promise<void> {
    await tx.insert(auditLog).values({
      workspaceId: event.workspaceId,
      actorId: event.actorId ?? null,
      action: event.action,
      entity: event.entity,
      entityId: event.entityId ?? null,
      metadata: event.metadata ?? {},
    });
  }
}
