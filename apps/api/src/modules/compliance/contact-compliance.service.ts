import { Inject, Injectable } from "@nestjs/common";
import {
  DEFAULT_SEND_WINDOW,
  RULESET_VERSION,
  evaluateEmailContact,
  toComplianceProof,
  type SendWindow,
} from "@openline/compliance";
import {
  and,
  asc,
  auditLog,
  consents,
  contacts,
  eq,
  inArray,
  messages,
  sequences,
  suppressions,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type {
  ComplianceProofDto,
  ComplianceQuery,
  CompliancePurpose,
  ComplianceRecordDto,
  ContactComplianceDto,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { toDto as consentToDto } from "../contacts/consent.service";
import { loadEmailFacts } from "./compliance.facts";

const NOTICE =
  "Compliance record exported from Openline: the consent records, suppression state, history and " +
  "the compliance checks stored with every email sent to this contact. It explains what Openline " +
  "checked and why; it is not legal advice.";

/**
 * "Can I email this contact?" and the proof export (OL-E6 §3). Same deterministic engine and the
 * same facts as the sending engine (latest consent record, workspace postal address and time zone).
 */
@Injectable()
export class ContactComplianceService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  evaluate(
    auth: AuthContext,
    contactId: string,
    query: ComplianceQuery,
  ): Promise<ContactComplianceDto> {
    return this.scope(auth, async (tx) => {
      const contact = await this.loadContact(tx, auth.workspaceId, contactId);
      return this.evaluateIn(tx, auth.workspaceId, contact, query.sequenceId, query.purpose);
    });
  }

  record(auth: AuthContext, contactId: string): Promise<ComplianceRecordDto> {
    return this.scope(auth, async (tx) => {
      const ws = auth.workspaceId;
      const contact = await this.loadContact(tx, ws, contactId);
      const currentEvaluation = await this.evaluateIn(tx, ws, contact);

      const consentRows = await tx
        .select()
        .from(consents)
        .where(and(eq(consents.workspaceId, ws), eq(consents.contactId, contact.id)))
        .orderBy(asc(consents.createdAt), asc(consents.id));

      const email = contact.email.toLowerCase();
      const at = email.lastIndexOf("@");
      const values = at > 0 ? [email, email.slice(at)] : [email];
      const entries = await tx
        .select({
          value: suppressions.value,
          reason: suppressions.reason,
          createdAt: suppressions.createdAt,
        })
        .from(suppressions)
        .where(and(eq(suppressions.workspaceId, ws), inArray(suppressions.value, values)))
        .orderBy(asc(suppressions.createdAt));

      const history = await tx
        .select({
          action: auditLog.action,
          at: auditLog.at,
          actorId: auditLog.actorId,
          metadata: auditLog.metadata,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, ws),
            eq(auditLog.entity, "contact"),
            eq(auditLog.entityId, contact.id),
          ),
        )
        .orderBy(asc(auditLog.at));

      const sent = await tx
        .select({
          id: messages.id,
          enrollmentId: messages.enrollmentId,
          status: messages.status,
          sentAt: messages.sentAt,
          subject: messages.subject,
          proof: messages.complianceProof,
        })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, ws),
            eq(messages.contactId, contact.id),
            eq(messages.direction, "outbound"),
          ),
        )
        .orderBy(asc(messages.sentAt), asc(messages.id));

      // Who exported whose record is audited; the metadata holds counts only (no personal data).
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "contact.compliance_exported",
        entity: "contact",
        entityId: contact.id,
        metadata: { consentRecords: consentRows.length, messages: sent.length },
      });

      return {
        kind: "openline.compliance_record",
        exportedAt: new Date().toISOString(),
        rulesetVersion: RULESET_VERSION,
        notice: NOTICE,
        contact: {
          id: contact.id,
          email: contact.email,
          status: contact.status,
          country: contact.country,
          timeZone: contact.timeZone,
          consentBasis: contact.consentBasis,
          createdAt: contact.createdAt.toISOString(),
        },
        consentRecords: consentRows.map(consentToDto),
        suppression: {
          suppressed: entries.length > 0,
          entries: entries.map((e) => ({
            scope: e.value.startsWith("@") ? ("domain" as const) : ("email" as const),
            reason: e.reason,
            addedAt: e.createdAt.toISOString(),
          })),
        },
        history: history.map((h) => ({
          action: h.action,
          at: h.at.toISOString(),
          byUser: h.actorId !== null,
          metadata: h.metadata,
        })),
        messages: sent.map((m) => ({
          id: m.id,
          kind: m.enrollmentId ? ("sequence" as const) : ("reply" as const),
          status: m.status,
          sentAt: m.sentAt.toISOString(),
          subject: m.subject,
          proof: (m.proof as ComplianceProofDto | null) ?? null,
        })),
        currentEvaluation,
      };
    });
  }

  private async evaluateIn(
    tx: Tx,
    workspaceId: string,
    contact: typeof contacts.$inferSelect,
    sequenceId?: string,
    purpose: CompliancePurpose = "send",
  ): Promise<ContactComplianceDto> {
    let sendWindow: SendWindow = DEFAULT_SEND_WINDOW;
    if (sequenceId) {
      const [seq] = await tx
        .select({ sendWindow: sequences.sendWindow })
        .from(sequences)
        .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
      if (!seq) throw notFound("Sequence");
      sendWindow = seq.sendWindow as SendWindow;
    }
    const { workspace, inputs } = await loadEmailFacts(tx, workspaceId, [contact], { sendWindow });
    // purpose=reply: the same input the inbox reply uses (no send window, archived may be answered).
    const input = inputs.get(contact.id)!;
    const evaluation = evaluateEmailContact(
      purpose === "reply" ? { ...input, context: "reply" } : input,
      new Date(),
    );
    return {
      contactId: contact.id,
      ...toComplianceProof(evaluation),
      settings: {
        timeZone: contact.timeZone ?? workspace.defaultTimeZone,
        timeZoneSource: contact.timeZone ? "contact" : "workspace",
        sendWindow: { ...sendWindow, days: [...sendWindow.days] },
        sendWindowSource: sequenceId ? "sequence" : "default",
        sequenceId: sequenceId ?? null,
        purpose,
        mailingAddressOnFile: Boolean(workspace.mailingAddress),
      },
    };
  }

  private async loadContact(tx: Tx, workspaceId: string, id: string) {
    const [c] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!c) throw notFound("Contact");
    return c;
  }
}
