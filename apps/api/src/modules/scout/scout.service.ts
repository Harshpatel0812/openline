import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  creditsFor,
  draftFirstTouch,
  draftReply,
  editDistance,
  transition,
  type DraftContact,
  type DraftResult,
  type LlmUsage,
  type WebPage,
} from "@openline/ai";
import {
  aiActions,
  and,
  companies,
  contacts,
  enrollments,
  eq,
  mailboxes,
  messages,
  sequences,
  sequenceSteps,
  withTenant,
  workspaces,
  type AiActionRow,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type {
  AiActionDto,
  ApproveAiActionInput,
  FirstTouchDraftInput,
  RejectAiActionInput,
  ReplyDraftInput,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { RateLimiter } from "../../common/rate-limit";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { ScoutBudgetService } from "./budget.service";
import { researchDomain, ResearchService } from "./research.service";
import { ScoutModelService, toApiError } from "./scout-model.service";

type Research = AiActionDto["research"];

const MANAGERS = new Set(["owner", "admin", "manager"]);

export const scoutDisabled = () =>
  new ApiException(
    HttpStatus.FORBIDDEN,
    "scout_disabled",
    "Scout is turned off for this workspace. An admin can turn it on in Workspace settings.",
  );

export function toAiActionDto(row: AiActionRow): AiActionDto {
  const usage: LlmUsage = { inputTokens: row.inputTokens, outputTokens: row.outputTokens };
  const research = (row.inputSummary as { research?: Research }).research ?? "none";
  return {
    id: row.id,
    // Only drafts reach this DTO: loadAction filters to the draft kinds (promises: PromisesService).
    kind: row.kind as AiActionDto["kind"],
    status: row.status,
    createdBy: row.userId,
    contactId: row.contactId,
    messageId: row.messageId,
    sequenceId: row.sequenceId,
    stepPosition: row.stepPosition,
    proposal: row.proposal,
    sources: row.sources,
    research,
    finalSubject: row.finalSubject,
    finalText: row.finalText,
    editDistance: row.editDistance,
    rejectReason: row.rejectReason,
    model: row.model,
    usage: { ...usage, credits: creditsFor(usage) },
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

interface DraftContext {
  aboutUs: string | null;
  valueProposition: string | null;
  webResearch: boolean;
}

/**
 * Scout v1: drafts are proposals. Every draft becomes an `ai_actions` row in `proposed`; only the
 * rep who asked can approve (with edits) or reject it. Nothing is sent or applied by Scout.
 */
@Injectable()
export class ScoutService {
  private readonly drafts: RateLimiter;

  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) config: AppConfig,
    private readonly model: ScoutModelService,
    private readonly budget: ScoutBudgetService,
    private readonly research: ResearchService,
    private readonly audit: AuditService,
  ) {
    this.drafts = new RateLimiter(config.ai.draftsPerUserPerHour, 60 * 60 * 1000);
  }

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  /** Availability, rate limit, workspace switch and budget — in that order. */
  private async preflight(auth: AuthContext): Promise<DraftContext> {
    this.model.require();
    this.drafts.consume(`${auth.workspaceId}:${auth.userId}`);
    try {
      return await this.scope(auth, async (tx) => {
        const [ws] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, auth.workspaceId))
          .limit(1);
        if (!ws) throw notFound("Workspace");
        if (!ws.scoutEnabled) throw scoutDisabled();
        await this.budget.assertAvailable(tx, auth.workspaceId, ws.scoutMonthlyCredits);
        return {
          aboutUs: ws.aboutUs,
          valueProposition: ws.valueProposition,
          webResearch: ws.scoutWebResearch,
        };
      });
    } catch (err) {
      throw toApiError(err);
    }
  }

  private async loadContact(
    tx: Tx,
    auth: AuthContext,
    contactId: string,
  ): Promise<{ contact: DraftContact; email: string; companyDomain: string | null }> {
    const [row] = await tx
      .select({
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        title: contacts.title,
        country: contacts.country,
        company: companies.name,
        companyDomain: companies.domain,
      })
      .from(contacts)
      .leftJoin(
        companies,
        and(eq(companies.id, contacts.companyId), eq(companies.workspaceId, auth.workspaceId)),
      )
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row) throw notFound("Contact");
    return {
      email: row.email,
      companyDomain: row.companyDomain,
      contact: {
        firstName: row.firstName,
        lastName: row.lastName,
        title: row.title,
        country: row.country,
        company: row.company,
        companyDomain: row.companyDomain,
      },
    };
  }

  private async runModel(
    auth: AuthContext,
    kind: "draft_email" | "draft_reply",
    call: () => Promise<DraftResult>,
  ): Promise<DraftResult> {
    try {
      return await call();
    } catch (err) {
      // Tokens spent on a failed draft still count to the budget.
      const usage = (err as { details?: { usage?: LlmUsage; model?: string } })?.details;
      if (usage?.usage) {
        await this.scope(auth, (tx) =>
          this.budget.record(tx, {
            workspaceId: auth.workspaceId,
            userId: auth.userId,
            feature: kind,
            model: usage.model ?? "",
            usage: usage.usage!,
          }),
        );
      }
      throw toApiError(err);
    }
  }

  private async saveProposal(
    auth: AuthContext,
    values: {
      kind: "draft_email" | "draft_reply";
      contactId: string | null;
      messageId?: string | null;
      sequenceId?: string | null;
      stepPosition?: number | null;
      inputSummary: Record<string, unknown>;
      draft: DraftResult;
      research: Research;
    },
  ): Promise<AiActionDto> {
    const { draft } = values;
    return this.scope(auth, async (tx) => {
      const [row] = await tx
        .insert(aiActions)
        .values({
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          kind: values.kind,
          status: "proposed",
          contactId: values.contactId,
          messageId: values.messageId ?? null,
          sequenceId: values.sequenceId ?? null,
          stepPosition: values.stepPosition ?? null,
          inputSummary: { ...values.inputSummary, research: values.research },
          proposal: {
            ...(draft.subject ? { subject: draft.subject } : {}),
            body: draft.body,
            citations: draft.citations,
          },
          sources: draft.sources,
          model: draft.model,
          inputTokens: draft.usage.inputTokens,
          outputTokens: draft.usage.outputTokens,
        })
        .returning();
      const credits = await this.budget.record(tx, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        feature: values.kind,
        aiActionId: row!.id,
        model: draft.model,
        usage: draft.usage,
      });
      // Ids, counts and flags only — never the draft or the prospect's text.
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "scout.action_proposed",
        entity: "ai_action",
        entityId: row!.id,
        metadata: {
          kind: values.kind,
          model: draft.model,
          credits,
          citations: draft.citations.length,
          research: values.research,
        },
      });
      return toAiActionDto(row!);
    });
  }

  async draftFirstTouch(auth: AuthContext, input: FirstTouchDraftInput): Promise<AiActionDto> {
    const ctx = await this.preflight(auth);
    const loaded = await this.scope(auth, async (tx) => {
      const contact = await this.loadContact(tx, auth, input.contactId);
      if (input.sequenceId) {
        const [seq] = await tx
          .select({ id: sequences.id })
          .from(sequences)
          .where(
            and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, auth.workspaceId)),
          )
          .limit(1);
        if (!seq) throw notFound("Sequence");
      }
      return contact;
    });

    let pages: WebPage[] = [];
    let research: Research = "off";
    if (ctx.webResearch) {
      const domain = researchDomain(loaded.companyDomain);
      if (domain) ({ pages, research } = await this.research.research(auth, domain));
      else research = "none";
    }

    const provider = this.model.require();
    const draft = await this.runModel(auth, "draft_email", () =>
      draftFirstTouch(provider, {
        contact: loaded.contact,
        purpose: input.purpose,
        pages,
        aboutUs: ctx.aboutUs,
        valueProposition: ctx.valueProposition,
        senderName: auth.user.name,
      }),
    );
    return this.saveProposal(auth, {
      kind: "draft_email",
      contactId: input.contactId,
      sequenceId: input.sequenceId ?? null,
      stepPosition: input.stepPosition ?? null,
      inputSummary: {
        contactFields: draft.sources.filter((s) => s.kind === "contact_field").map((s) => s.id),
        pageUrls: pages.map((p) => p.url),
        purposeChars: input.purpose.length,
        aboutUs: Boolean(ctx.aboutUs),
        valueProposition: Boolean(ctx.valueProposition),
      },
      draft,
      research,
    });
  }

  /**
   * Draft a reply to an inbound message. Reps may only draft for replies to their own mailboxes
   * (the inbox rule); managers and above for any.
   */
  async draftReply(auth: AuthContext, input: ReplyDraftInput): Promise<AiActionDto> {
    const ctx = await this.preflight(auth);
    const loaded = await this.scope(auth, async (tx) => {
      const [msg] = await tx
        .select({
          id: messages.id,
          contactId: messages.contactId,
          subject: messages.subject,
          fromEmail: messages.fromEmail,
          fromName: messages.fromName,
          bodyText: messages.bodyText,
          replyToId: messages.replyToId,
          mailboxOwner: mailboxes.userId,
        })
        .from(messages)
        .leftJoin(
          mailboxes,
          and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, auth.workspaceId)),
        )
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.workspaceId, auth.workspaceId),
            eq(messages.direction, "inbound"),
          ),
        )
        .limit(1);
      if (!msg) throw notFound("Message");
      if (!MANAGERS.has(auth.role) && msg.mailboxOwner !== auth.userId) throw notFound("Message");

      const contact = msg.contactId
        ? (await this.loadContact(tx, auth, msg.contactId)).contact
        : {};
      const originalStep = msg.replyToId ? await this.originalStep(tx, auth, msg.replyToId) : null;
      return { msg, contact, originalStep };
    });

    const provider = this.model.require();
    const { msg } = loaded;
    const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail ?? ""}>` : (msg.fromEmail ?? "");
    const draft = await this.runModel(auth, "draft_reply", () =>
      draftReply(provider, {
        thread: { text: msg.bodyText ?? "", subject: msg.subject, from },
        contact: loaded.contact,
        originalStep: loaded.originalStep,
        instructions: input.instructions,
        aboutUs: ctx.aboutUs,
        valueProposition: ctx.valueProposition,
        senderName: auth.user.name,
      }),
    );
    return this.saveProposal(auth, {
      kind: "draft_reply",
      contactId: msg.contactId,
      messageId: msg.id,
      inputSummary: {
        contactFields: draft.sources.filter((s) => s.kind === "contact_field").map((s) => s.id),
        threadChars: (msg.bodyText ?? "").length,
        originalStep: Boolean(loaded.originalStep),
        instructions: Boolean(input.instructions),
      },
      draft,
      research: "none",
    });
  }

  /** The sequence step our outbound message was sent from (subject + body template). */
  private async originalStep(
    tx: Tx,
    auth: AuthContext,
    outboundId: string,
  ): Promise<{ subject: string; body: string } | null> {
    const [row] = await tx
      .select({ subject: sequenceSteps.subject, body: sequenceSteps.body })
      .from(messages)
      .innerJoin(
        enrollments,
        and(
          eq(enrollments.id, messages.enrollmentId),
          eq(enrollments.workspaceId, auth.workspaceId),
        ),
      )
      .innerJoin(
        sequenceSteps,
        and(
          eq(sequenceSteps.sequenceId, enrollments.sequenceId),
          eq(sequenceSteps.position, messages.stepPosition),
          eq(sequenceSteps.workspaceId, auth.workspaceId),
        ),
      )
      .where(
        and(
          eq(messages.id, outboundId),
          eq(messages.workspaceId, auth.workspaceId),
          eq(messages.direction, "outbound"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async loadAction(tx: Tx, auth: AuthContext, id: string): Promise<AiActionRow> {
    const [row] = await tx
      .select()
      .from(aiActions)
      .where(and(eq(aiActions.id, id), eq(aiActions.workspaceId, auth.workspaceId)))
      .limit(1);
    // Other reps' drafts look like 404; managers+ may see them. Promise proposals are decided
    // through /v1/promises only (accepting creates a task), never approved as a draft here.
    const isDraft = row?.kind === "draft_email" || row?.kind === "draft_reply";
    if (!row || !isDraft || (row.userId !== auth.userId && !MANAGERS.has(auth.role))) {
      throw notFound("Scout draft");
    }
    return row;
  }

  get(auth: AuthContext, id: string): Promise<AiActionDto> {
    return this.scope(auth, async (tx) => toAiActionDto(await this.loadAction(tx, auth, id)));
  }

  private async decide(
    auth: AuthContext,
    id: string,
    next: "approved" | "rejected",
    patch: (row: AiActionRow) => Partial<typeof aiActions.$inferInsert>,
    metadata: (row: AiActionRow, updated: AiActionRow) => Record<string, unknown>,
  ): Promise<AiActionDto> {
    return this.scope(auth, async (tx) => {
      const row = await this.loadAction(tx, auth, id);
      if (row.userId !== auth.userId) {
        throw forbidden("Only the person who asked Scout for this draft can approve or reject it.");
      }
      try {
        transition(
          {
            id: row.id,
            workspaceId: row.workspaceId,
            userId: row.userId,
            kind: row.kind,
            proposal: row.proposal,
            sources: row.sources.map((s) => s.id),
            status: row.status,
          },
          next,
        );
      } catch {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "invalid_transition",
          `This draft is already ${row.status}.`,
        );
      }
      const [updated] = await tx
        .update(aiActions)
        .set({ ...patch(row), status: next, decidedAt: new Date() })
        // Guard against a concurrent decision.
        .where(
          and(
            eq(aiActions.id, row.id),
            eq(aiActions.workspaceId, auth.workspaceId),
            eq(aiActions.status, "proposed"),
          ),
        )
        .returning();
      if (!updated) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "invalid_transition",
          "This draft was decided.",
        );
      }
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: next === "approved" ? "scout.action_approved" : "scout.action_rejected",
        entity: "ai_action",
        entityId: row.id,
        metadata: { kind: row.kind, ...metadata(row, updated) },
      });
      return toAiActionDto(updated);
    });
  }

  approve(auth: AuthContext, id: string, input: ApproveAiActionInput): Promise<AiActionDto> {
    return this.decide(
      auth,
      id,
      "approved",
      (row) => {
        const finalText = input.finalText ?? row.proposal.body;
        const finalSubject =
          row.kind === "draft_email" ? (input.finalSubject ?? row.proposal.subject ?? null) : null;
        const distance =
          editDistance(row.proposal.body, finalText) +
          (row.kind === "draft_email"
            ? editDistance(row.proposal.subject ?? "", finalSubject ?? "")
            : 0);
        return { finalText, finalSubject, editDistance: distance };
      },
      (_row, updated) => ({
        edited: (updated.editDistance ?? 0) > 0,
        editDistance: updated.editDistance,
      }),
    );
  }

  reject(auth: AuthContext, id: string, input: RejectAiActionInput): Promise<AiActionDto> {
    return this.decide(
      auth,
      id,
      "rejected",
      () => ({ rejectReason: input.reason || null }),
      // The reason is free text a rep typed: keep it out of the audit log.
      () => ({ hasReason: Boolean(input.reason) }),
    );
  }
}
