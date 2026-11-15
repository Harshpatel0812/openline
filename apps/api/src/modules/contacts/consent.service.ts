import { Inject, Injectable } from "@nestjs/common";
import { consentExpiresAt } from "@openline/compliance";
import {
  and,
  consents,
  contacts,
  desc,
  eq,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type { ConsentDto, ConsentInput } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";

export const toDto = (r: typeof consents.$inferSelect): ConsentDto => ({
  basis: r.basis,
  source: r.source,
  obtainedAt: r.obtainedAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  recordedAt: r.createdAt.toISOString(),
  withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
});

/**
 * Consent is legal evidence (CASL burden of proof): every change appends a record with its source
 * and date — history is never overwritten — and contacts.consent_basis mirrors the latest one.
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  latest(auth: AuthContext, contactId: string): Promise<ConsentDto | null> {
    return this.scope(auth, async (tx) => {
      await this.loadContact(tx, auth.workspaceId, contactId);
      const [row] = await tx
        .select()
        .from(consents)
        .where(and(eq(consents.workspaceId, auth.workspaceId), eq(consents.contactId, contactId)))
        .orderBy(desc(consents.createdAt), desc(consents.id))
        .limit(1);
      return row ? toDto(row) : null;
    });
  }

  record(auth: AuthContext, contactId: string, input: ConsentInput): Promise<ConsentDto> {
    return this.scope(auth, async (tx) => {
      const contact = await this.loadContact(tx, auth.workspaceId, contactId);
      const row = await recordConsent(tx, this.audit, auth, contact, {
        basis: input.basis,
        source: input.source ?? "Consent cleared",
        obtainedAt: input.obtainedAt ?? new Date(),
      });
      return toDto(row);
    });
  }

  private async loadContact(tx: Tx, workspaceId: string, id: string) {
    const [c] = await tx
      .select({ id: contacts.id, consentBasis: contacts.consentBasis })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!c) throw notFound("Contact");
    return c;
  }
}

/** Appends a consent record, mirrors it on the contact and audits from → to (in `tx`). */
export async function recordConsent(
  tx: Tx,
  audit: AuditService,
  auth: AuthContext,
  contact: { id: string; consentBasis: ConsentInput["basis"] },
  record: { basis: ConsentInput["basis"]; source: string; obtainedAt: Date },
): Promise<typeof consents.$inferSelect> {
  const [row] = await tx
    .insert(consents)
    .values({
      workspaceId: auth.workspaceId,
      contactId: contact.id,
      basis: record.basis,
      source: record.source,
      obtainedAt: record.obtainedAt,
      expiresAt: consentExpiresAt({ basis: record.basis, obtainedAt: record.obtainedAt }),
    })
    .returning();
  await tx
    .update(contacts)
    .set({ consentBasis: record.basis, updatedAt: new Date() })
    .where(and(eq(contacts.id, contact.id), eq(contacts.workspaceId, auth.workspaceId)));
  await audit.record(tx, {
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action: "contact.consent_changed",
    entity: "contact",
    entityId: contact.id,
    metadata: { from: contact.consentBasis, to: record.basis },
  });
  return row!;
}
