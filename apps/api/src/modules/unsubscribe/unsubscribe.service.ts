import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  consents,
  contacts,
  enrollments,
  eq,
  inArray,
  isNull,
  suppressions,
  withTenant,
  workspaces,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import { verifyUnsubscribeToken, type UnsubscribeClaims } from "@openline/email";
import { notFound } from "../../common/http";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";

/** j***@acme.com — enough for the person to recognise their address, not enough to harvest it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

@Injectable()
export class UnsubscribeService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private claims(token: string): UnsubscribeClaims {
    const claims = verifyUnsubscribeToken(token, this.config.UNSUBSCRIBE_SECRET);
    if (!claims) throw notFound("Link");
    return claims;
  }

  private async loadContact(tx: Tx, claims: UnsubscribeClaims) {
    const [c] = await tx
      .select({ id: contacts.id, email: contacts.email, status: contacts.status })
      .from(contacts)
      .where(and(eq(contacts.id, claims.contactId), eq(contacts.workspaceId, claims.workspaceId)))
      .limit(1);
    if (!c) throw notFound("Link");
    return c;
  }

  lookup(
    token: string,
  ): Promise<{ email: string; workspaceName: string; alreadyUnsubscribed: boolean }> {
    const claims = this.claims(token);
    return withTenant(this.handle.db, { workspaceId: claims.workspaceId }, async (tx) => {
      const contact = await this.loadContact(tx, claims);
      const [ws] = await tx
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, claims.workspaceId));
      return {
        email: maskEmail(contact.email),
        workspaceName: ws?.name ?? "",
        alreadyUnsubscribed: contact.status === "unsubscribed",
      };
    });
  }

  /**
   * Idempotent. Marks the contact unsubscribed, adds a locked suppression, ends active/paused
   * enrollments and withdraws consent records — in one transaction.
   */
  async unsubscribe(token: string): Promise<void> {
    const claims = this.claims(token);
    await withTenant(this.handle.db, { workspaceId: claims.workspaceId }, async (tx) => {
      const contact = await this.loadContact(tx, claims);
      const now = new Date();
      const email = contact.email.toLowerCase();

      const [existing] = await tx
        .select({ id: suppressions.id, reason: suppressions.reason })
        .from(suppressions)
        .where(and(eq(suppressions.workspaceId, claims.workspaceId), eq(suppressions.value, email)))
        .limit(1);
      let changed = false;
      if (!existing) {
        await tx
          .insert(suppressions)
          .values({ workspaceId: claims.workspaceId, value: email, reason: "unsubscribed" })
          .onConflictDoNothing({ target: [suppressions.workspaceId, suppressions.value] });
        changed = true;
      } else if (existing.reason !== "unsubscribed" && existing.reason !== "asked_not_to_contact") {
        // Upgrade to a locked reason: an opt-out must never be removable.
        await tx
          .update(suppressions)
          .set({ reason: "unsubscribed" })
          .where(
            and(eq(suppressions.id, existing.id), eq(suppressions.workspaceId, claims.workspaceId)),
          );
        changed = true;
      }

      if (contact.status !== "unsubscribed") {
        await tx
          .update(contacts)
          .set({ status: "unsubscribed", updatedAt: now })
          .where(and(eq(contacts.id, contact.id), eq(contacts.workspaceId, claims.workspaceId)));
        changed = true;
      }
      const ended = await tx
        .update(enrollments)
        .set({
          state: "unsubscribed",
          lastDecision: "unsubscribed",
          nextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(enrollments.workspaceId, claims.workspaceId),
            eq(enrollments.contactId, contact.id),
            inArray(enrollments.state, ["active", "paused"]),
          ),
        )
        .returning({ id: enrollments.id });
      await tx
        .update(consents)
        .set({ withdrawnAt: now })
        .where(
          and(
            eq(consents.workspaceId, claims.workspaceId),
            eq(consents.contactId, contact.id),
            isNull(consents.withdrawnAt),
          ),
        );

      if (changed || ended.length) {
        await this.audit.record(tx, {
          workspaceId: claims.workspaceId,
          actorId: null,
          action: "contact.unsubscribed",
          entity: "contact",
          entityId: contact.id,
          metadata: { enrollmentsEnded: ended.length },
        });
      }
    });
  }
}
