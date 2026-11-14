import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { isValidSendWindow } from "@openline/compliance";
import {
  and,
  asc,
  companies,
  contacts,
  count,
  desc,
  enrollments,
  eq,
  inArray,
  messages,
  sequences,
  sequenceSteps,
  sql,
  withTenant,
  type DatabaseHandle,
  type Sequence,
  type SequenceStep,
  type Tx,
} from "@openline/db";
import { renderEmail, unknownVariables, type TemplateVars } from "@openline/email";
import type { SequenceDto, SequenceInput, SequenceStatsDto } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { requireVerified } from "../../common/verified";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { loadWorkspace } from "../workspace/workspace.service";

const DEFAULT_WINDOW = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 };

const PLACEHOLDER: TemplateVars = {
  firstName: "Alex",
  lastName: "Sample",
  email: "alex@example.com",
  company: "Example Co",
  title: "Head of Sales",
};

const emptyStats = (): SequenceStatsDto => ({
  active: 0,
  completed: 0,
  replied: 0,
  unsubscribed: 0,
  bounced: 0,
  stopped: 0,
  error: 0,
  sent: 0,
});

function validationError(details: { path: string; message: string }[]): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    "validation_error",
    "Some fields are invalid",
    details,
  );
}

/** Unknown {{variables}} and invalid windows, reported with field paths like "steps.1.body". */
function validateContent(input: SequenceInput): void {
  const details: { path: string; message: string }[] = [];
  input.steps?.forEach((step, i) => {
    for (const field of ["subject", "body"] as const) {
      const unknown = unknownVariables(step[field]);
      if (unknown.length) {
        details.push({
          path: `steps.${i}.${field}`,
          message: `Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `{{${u}}}`).join(", ")}`,
        });
      }
    }
  });
  if (input.sendWindow && !isValidSendWindow(input.sendWindow)) {
    details.push({ path: "sendWindow", message: "Choose at least one day and a valid time range" });
  }
  if (details.length) throw validationError(details);
}

const conflict = (code: string, message: string) =>
  new ApiException(HttpStatus.CONFLICT, code, message);

@Injectable()
export class SequencesService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  list(auth: AuthContext, includeArchived: boolean): Promise<SequenceDto[]> {
    return this.scope(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(sequences)
        .where(
          and(
            eq(sequences.workspaceId, auth.workspaceId),
            includeArchived ? undefined : sql`${sequences.status} <> 'archived'`,
          ),
        )
        .orderBy(desc(sequences.createdAt), desc(sequences.id));
      return this.toDtos(tx, auth.workspaceId, rows);
    });
  }

  get(auth: AuthContext, id: string): Promise<SequenceDto> {
    return this.scope(auth, async (tx) => {
      const seq = await this.load(tx, auth.workspaceId, id);
      return (await this.toDtos(tx, auth.workspaceId, [seq]))[0]!;
    });
  }

  create(auth: AuthContext, input: SequenceInput): Promise<SequenceDto> {
    if (!input.steps) throw validationError([{ path: "steps", message: "Add at least one step" }]);
    validateContent(input);
    return this.scope(auth, async (tx) => {
      const [created] = await tx
        .insert(sequences)
        .values({
          workspaceId: auth.workspaceId,
          name: input.name,
          sendWindow: input.sendWindow ?? DEFAULT_WINDOW,
          createdBy: auth.userId,
        })
        .returning();
      await this.replaceSteps(tx, auth.workspaceId, created!.id, input.steps!);
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "sequence.created",
        entity: "sequence",
        entityId: created!.id,
      });
      return (await this.toDtos(tx, auth.workspaceId, [created!]))[0]!;
    });
  }

  update(auth: AuthContext, id: string, input: SequenceInput): Promise<SequenceDto> {
    validateContent(input);
    return this.scope(auth, async (tx) => {
      const seq = await this.load(tx, auth.workspaceId, id, true);
      if (input.steps) {
        // Changing what a live (or once-live) sequence sends is a manager decision.
        if (seq.status !== "draft" && auth.role === "rep") {
          throw forbidden(
            "Only managers, admins and owners can change the steps of a live sequence",
          );
        }
        const [inUse] = await tx
          .select({ n: count() })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.workspaceId, auth.workspaceId),
              eq(enrollments.sequenceId, id),
              inArray(enrollments.state, ["active", "paused"]),
            ),
          );
        if (Number(inUse?.n ?? 0) > 0) {
          throw conflict(
            "sequence_in_use",
            "Steps can't be replaced while people are going through this sequence. Pause or stop their enrollments first.",
          );
        }
        await this.replaceSteps(tx, auth.workspaceId, id, input.steps);
      }
      const [row] = await tx
        .update(sequences)
        .set({
          name: input.name,
          sendWindow: input.sendWindow ?? seq.sendWindow,
          updatedAt: new Date(),
        })
        .where(and(eq(sequences.id, id), eq(sequences.workspaceId, auth.workspaceId)))
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "sequence.updated",
        entity: "sequence",
        entityId: id,
        metadata: { stepsReplaced: Boolean(input.steps) },
      });
      return (await this.toDtos(tx, auth.workspaceId, [row!]))[0]!;
    });
  }

  /**
   * draft|paused → active (needs a verified user, ≥1 step and the workspace mailing address),
   * active → paused, anything → archived (stops its active/paused enrollments).
   */
  setStatus(
    auth: AuthContext,
    id: string,
    status: "active" | "paused" | "archived",
  ): Promise<SequenceDto> {
    return this.scope(auth, async (tx) => {
      const seq = await this.load(tx, auth.workspaceId, id, true);
      if (seq.status === status) return (await this.toDtos(tx, auth.workspaceId, [seq]))[0]!;

      if (status === "active") {
        requireVerified(auth);
        if (seq.status === "archived") {
          throw conflict("invalid_transition", "Archived sequences can't be activated");
        }
        const [steps] = await tx
          .select({ n: count() })
          .from(sequenceSteps)
          .where(
            and(eq(sequenceSteps.workspaceId, auth.workspaceId), eq(sequenceSteps.sequenceId, id)),
          );
        if (Number(steps?.n ?? 0) === 0) {
          throw conflict("sequence_empty", "Add at least one step first");
        }
        const ws = await loadWorkspace(tx, auth.workspaceId);
        if (!ws.mailingAddress) {
          throw conflict(
            "mailing_address_required",
            "Add your company's postal address in Settings first — the law requires it in every email.",
          );
        }
      }
      if (status === "paused" && seq.status !== "active") {
        throw conflict("invalid_transition", "Only an active sequence can be paused");
      }

      const [row] = await tx
        .update(sequences)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(sequences.id, id), eq(sequences.workspaceId, auth.workspaceId)))
        .returning();
      if (status === "archived") {
        await tx
          .update(enrollments)
          .set({
            state: "stopped",
            lastDecision: "sequence_archived",
            nextRunAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(enrollments.workspaceId, auth.workspaceId),
              eq(enrollments.sequenceId, id),
              inArray(enrollments.state, ["active", "paused"]),
            ),
          );
      }
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "sequence.status_changed",
        entity: "sequence",
        entityId: id,
        metadata: { from: seq.status, to: status },
      });
      return (await this.toDtos(tx, auth.workspaceId, [row!]))[0]!;
    });
  }

  /** Renders every step as the recipient would see it, footer included. Nothing is sent. */
  preview(
    auth: AuthContext,
    id: string,
    contactId?: string,
  ): Promise<{ steps: { position: number; subject: string; text: string; html: string }[] }> {
    return this.scope(auth, async (tx) => {
      await this.load(tx, auth.workspaceId, id);
      const ws = await loadWorkspace(tx, auth.workspaceId);
      let vars: TemplateVars = PLACEHOLDER;
      if (contactId) {
        const [c] = await tx
          .select({
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            title: contacts.title,
            company: companies.name,
          })
          .from(contacts)
          .leftJoin(
            companies,
            and(eq(companies.id, contacts.companyId), eq(companies.workspaceId, auth.workspaceId)),
          )
          .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, auth.workspaceId)))
          .limit(1);
        if (!c) throw notFound("Contact");
        vars = c;
      }
      vars = { ...vars, senderName: auth.user.name };
      const footer = {
        senderCompany: ws.name,
        mailingAddress: ws.mailingAddress ?? "[Add your postal address in Settings]",
        unsubscribeUrl: `${this.config.WEB_URL}/u/preview`,
      };
      const steps = await this.steps(tx, auth.workspaceId, [id]);
      let firstSubject = "";
      return {
        steps: steps.map((step, i) => {
          const rendered = renderEmail(step.subject, step.body, vars, footer);
          if (i === 0) firstSubject = rendered.subject;
          // Follow-ups in the same thread reply to the first email.
          const subject =
            i > 0 && step.threadWithPrevious ? `Re: ${firstSubject}` : rendered.subject;
          return { position: step.position, subject, text: rendered.text, html: rendered.html };
        }),
      };
    });
  }

  // ---------------------------------------------------------------- helpers

  async load(tx: Tx, workspaceId: string, id: string, forUpdate = false): Promise<Sequence> {
    const q = tx
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)))
      .limit(1);
    const [row] = forUpdate ? await q.for("update") : await q;
    if (!row) throw notFound("Sequence");
    return row;
  }

  private async replaceSteps(
    tx: Tx,
    workspaceId: string,
    sequenceId: string,
    steps: NonNullable<SequenceInput["steps"]>,
  ): Promise<void> {
    await tx
      .delete(sequenceSteps)
      .where(
        and(eq(sequenceSteps.workspaceId, workspaceId), eq(sequenceSteps.sequenceId, sequenceId)),
      );
    await tx.insert(sequenceSteps).values(
      steps.map((s, i) => ({
        workspaceId,
        sequenceId,
        position: i + 1,
        delayDays: s.delayDays,
        subject: s.subject,
        body: s.body,
        threadWithPrevious: s.threadWithPrevious,
      })),
    );
  }

  private steps(tx: Tx, workspaceId: string, ids: string[]): Promise<SequenceStep[]> {
    return tx
      .select()
      .from(sequenceSteps)
      .where(
        and(eq(sequenceSteps.workspaceId, workspaceId), inArray(sequenceSteps.sequenceId, ids)),
      )
      .orderBy(asc(sequenceSteps.sequenceId), asc(sequenceSteps.position));
  }

  private async toDtos(tx: Tx, workspaceId: string, rows: Sequence[]): Promise<SequenceDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [steps, states, sent] = await Promise.all([
      this.steps(tx, workspaceId, ids),
      tx
        .select({ sequenceId: enrollments.sequenceId, state: enrollments.state, n: count() })
        .from(enrollments)
        .where(and(eq(enrollments.workspaceId, workspaceId), inArray(enrollments.sequenceId, ids)))
        .groupBy(enrollments.sequenceId, enrollments.state),
      tx
        .select({ sequenceId: enrollments.sequenceId, n: count() })
        .from(messages)
        .innerJoin(
          enrollments,
          and(eq(enrollments.id, messages.enrollmentId), eq(enrollments.workspaceId, workspaceId)),
        )
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            eq(messages.direction, "outbound"),
            inArray(enrollments.sequenceId, ids),
          ),
        )
        .groupBy(enrollments.sequenceId),
    ]);
    return rows.map((r) => {
      const stats = emptyStats();
      for (const s of states) {
        if (s.sequenceId !== r.id) continue;
        // "paused" enrollments are still in the sequence; they count as active.
        const key = s.state === "paused" ? "active" : s.state;
        stats[key] += Number(s.n);
      }
      stats.sent = Number(sent.find((s) => s.sequenceId === r.id)?.n ?? 0);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        sendWindow: r.sendWindow,
        steps: steps
          .filter((s) => s.sequenceId === r.id)
          .map((s) => ({
            id: s.id,
            position: s.position,
            delayDays: s.delayDays,
            subject: s.subject,
            body: s.body,
            threadWithPrevious: s.threadWithPrevious,
          })),
        stats,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }
}
