import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { localDateOf, safeTimeZone, zonedTime } from "@openline/ai";
import {
  and,
  asc,
  companies,
  contacts,
  deals,
  eq,
  isNull,
  sql,
  tasks,
  users,
  withTenant,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
  type TaskRow,
  type Tx,
} from "@openline/db";
import {
  TASK_DUE_SOON_HOURS,
  TASK_UPCOMING_DAYS,
  type CreateTaskInput,
  type TaskCountsDto,
  type TaskDto,
  type TaskQuery,
  type UpdateTaskInput,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { touchDealActivity } from "../deals/deals.service";

/** Managers and above see and edit everyone's tasks; reps only their own. */
export const MANAGERS = new Set(["owner", "admin", "manager"]);

const DAY = 86_400_000;
const addDays = (isoDay: string, n: number) =>
  new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Today's boundaries in the workspace time zone. */
export interface DayWindow {
  now: Date;
  tomorrow: Date;
  upcomingEnd: Date;
}

export function dayWindow(timeZone: string, now = new Date()): DayWindow {
  const tz = safeTimeZone(timeZone);
  const today = localDateOf(now, tz);
  return {
    now,
    tomorrow: zonedTime(addDays(today, 1), 0, 0, tz),
    upcomingEnd: zonedTime(addDays(today, 1 + TASK_UPCOMING_DAYS), 0, 0, tz),
  };
}

type TaskWithRefs = {
  t: TaskRow;
  ownerName: string | null;
  contact: {
    id: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
};

export function toTaskDto(row: TaskWithRefs, now = new Date()): TaskDto {
  const t = row.t;
  const open = t.status === "open";
  const due = t.dueAt?.getTime();
  return {
    id: t.id,
    owner: { id: t.ownerId, name: row.ownerName ?? "" },
    contact:
      row.contact?.id && row.contact.email
        ? {
            id: row.contact.id,
            email: row.contact.email,
            firstName: row.contact.firstName,
            lastName: row.contact.lastName,
          }
        : null,
    companyId: t.companyId,
    dealId: t.dealId,
    title: t.title,
    notes: t.notes,
    dueAt: t.dueAt?.toISOString() ?? null,
    dueDateMissing: t.dueDateMissing,
    kind: t.kind,
    source: t.source,
    sourceMessageId: t.sourceMessageId,
    promiseId: t.aiActionId,
    status: t.status,
    completedAt: t.completedAt?.toISOString() ?? null,
    overdue: open && due !== undefined && due < now.getTime(),
    dueSoon:
      open &&
      due !== undefined &&
      due >= now.getTime() &&
      due < now.getTime() + TASK_DUE_SOON_HOURS * 3_600_000,
    suggestDoneAt: open ? (t.suggestDoneAt?.toISOString() ?? null) : null,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function selectTasks(tx: Tx, workspaceId: string) {
  return tx
    .select({
      t: tasks,
      ownerName: users.name,
      contact: {
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      },
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.ownerId))
    .leftJoin(
      contacts,
      and(eq(contacts.id, tasks.contactId), eq(contacts.workspaceId, workspaceId)),
    );
}

/** The task created by accepting a Promise Keeper proposal, if any. */
export async function taskForPromise(
  tx: Tx,
  workspaceId: string,
  actionId: string,
): Promise<TaskDto | null> {
  const [row] = await selectTasks(tx, workspaceId)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.aiActionId, actionId)))
    .limit(1);
  return row ? toTaskDto(row) : null;
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  private async window(tx: Tx, workspaceId: string): Promise<DayWindow> {
    const [ws] = await tx
      .select({ tz: workspaces.defaultTimeZone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return dayWindow(ws?.tz ?? "UTC");
  }

  /** WHERE for the due filter (open tasks are what the filters are for; any status works). */
  private dueFilter(due: TaskQuery["due"], w: DayWindow) {
    const iso = (d: Date) => d.toISOString();
    switch (due) {
      case "overdue":
        return sql`${tasks.dueAt} < ${iso(w.now)}`;
      case "today":
        return sql`${tasks.dueAt} >= ${iso(w.now)} AND ${tasks.dueAt} < ${iso(w.tomorrow)}`;
      case "upcoming":
        return sql`${tasks.dueAt} >= ${iso(w.tomorrow)} AND ${tasks.dueAt} < ${iso(w.upcomingEnd)}`;
      case "none":
        return isNull(tasks.dueAt);
      default:
        return undefined;
    }
  }

  list(auth: AuthContext, query: TaskQuery): Promise<TaskDto[]> {
    if (query.scope === "all" && !MANAGERS.has(auth.role)) {
      throw forbidden("Only managers can see everyone's tasks");
    }
    return this.scope(auth, async (tx) => {
      const w = await this.window(tx, auth.workspaceId);
      const rows = await selectTasks(tx, auth.workspaceId)
        .where(
          and(
            eq(tasks.workspaceId, auth.workspaceId),
            query.scope === "mine" ? eq(tasks.ownerId, auth.userId) : undefined,
            eq(tasks.status, query.status),
            this.dueFilter(query.due, w),
            query.contactId ? eq(tasks.contactId, query.contactId) : undefined,
            query.dealId ? eq(tasks.dealId, query.dealId) : undefined,
          ),
        )
        .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, asc(tasks.createdAt))
        .limit(query.limit);
      return rows.map((r) => toTaskDto(r, w.now));
    });
  }

  /** The caller's own open tasks (the sidebar badge and Today). */
  counts(auth: AuthContext): Promise<TaskCountsDto> {
    return this.scope(auth, async (tx) => {
      const w = await this.window(tx, auth.workspaceId);
      const now = w.now.toISOString();
      const tomorrow = w.tomorrow.toISOString();
      const end = w.upcomingEnd.toISOString();
      const [row] = await tx
        .select({
          overdue: sql<number>`count(*) filter (where ${tasks.dueAt} < ${now})::int`,
          dueToday: sql<number>`count(*) filter (where ${tasks.dueAt} >= ${now} and ${tasks.dueAt} < ${tomorrow})::int`,
          upcoming: sql<number>`count(*) filter (where ${tasks.dueAt} >= ${tomorrow} and ${tasks.dueAt} < ${end})::int`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, auth.workspaceId),
            eq(tasks.ownerId, auth.userId),
            eq(tasks.status, "open"),
          ),
        );
      return {
        overdue: Number(row?.overdue ?? 0),
        dueToday: Number(row?.dueToday ?? 0),
        upcoming: Number(row?.upcoming ?? 0),
      };
    });
  }

  /** A task the caller may see: in this workspace, and theirs unless they're a manager. */
  private async load(tx: Tx, auth: AuthContext, id: string): Promise<TaskRow> {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row || (row.ownerId !== auth.userId && !MANAGERS.has(auth.role))) throw notFound("Task");
    return row;
  }

  private async dto(tx: Tx, auth: AuthContext, id: string): Promise<TaskDto> {
    const [row] = await selectTasks(tx, auth.workspaceId)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row) throw notFound("Task");
    return toTaskDto(row);
  }

  get(auth: AuthContext, id: string): Promise<TaskDto> {
    return this.scope(auth, async (tx) => {
      await this.load(tx, auth, id);
      return this.dto(tx, auth, id);
    });
  }

  private async assertOwner(tx: Tx, auth: AuthContext, ownerId: string): Promise<void> {
    if (ownerId === auth.userId) return;
    if (!MANAGERS.has(auth.role)) throw forbidden("Only managers can assign tasks to teammates");
    const [member] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, auth.workspaceId),
          eq(workspaceMembers.userId, ownerId),
        ),
      );
    if (!member) throw notFound("Teammate");
  }

  private async contactRef(tx: Tx, auth: AuthContext, contactId: string) {
    const [contact] = await tx
      .select({ id: contacts.id, companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, auth.workspaceId)));
    if (!contact) throw notFound("Contact");
    return contact;
  }

  /**
   * A deal to link a task to: in this workspace, and one the caller may edit (its owner or a
   * manager). Linking makes the task's completion count as deal activity (SEC-L2).
   */
  private async dealRef(tx: Tx, auth: AuthContext, dealId: string) {
    const [deal] = await tx
      .select({ id: deals.id, companyId: deals.companyId, ownerId: deals.ownerId })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, auth.workspaceId)));
    if (!deal) throw notFound("Deal");
    if (deal.ownerId !== auth.userId && !MANAGERS.has(auth.role)) {
      throw forbidden("Only the deal's owner or a manager can link tasks to it");
    }
    return deal;
  }

  /** May this user (by their role in the workspace) edit the deal? */
  private async ownerCanEditDeal(tx: Tx, workspaceId: string, userId: string, dealId: string) {
    const [row] = await tx
      .select({ ownerId: deals.ownerId, role: workspaceMembers.role })
      .from(deals)
      .leftJoin(
        workspaceMembers,
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)));
    if (!row) return false;
    return row.ownerId === userId || (!!row.role && MANAGERS.has(row.role));
  }

  create(auth: AuthContext, input: CreateTaskInput): Promise<TaskDto> {
    return this.scope(auth, async (tx) => {
      const ownerId = input.ownerId ?? auth.userId;
      await this.assertOwner(tx, auth, ownerId);
      const contact = input.contactId ? await this.contactRef(tx, auth, input.contactId) : null;
      const deal = input.dealId ? await this.dealRef(tx, auth, input.dealId) : null;
      let companyId = contact?.companyId ?? deal?.companyId ?? null;
      if (input.companyId) {
        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(eq(companies.id, input.companyId), eq(companies.workspaceId, auth.workspaceId)),
          );
        if (!company) throw notFound("Company");
        companyId = input.companyId;
      }
      const [row] = await tx
        .insert(tasks)
        .values({
          workspaceId: auth.workspaceId,
          ownerId,
          contactId: contact?.id ?? null,
          companyId,
          dealId: deal?.id ?? null,
          title: input.title,
          notes: input.notes || null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          kind: input.kind,
          source: "manual",
          createdBy: auth.userId,
        })
        .returning();
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "task.created",
        entity: "task",
        entityId: row!.id,
        metadata: {
          kind: row!.kind,
          source: "manual",
          hasDueDate: row!.dueAt !== null,
          assigned: ownerId !== auth.userId,
          hasDeal: deal !== null,
        },
      });
      return this.dto(tx, auth, row!.id);
    });
  }

  update(auth: AuthContext, id: string, input: UpdateTaskInput): Promise<TaskDto> {
    return this.scope(auth, async (tx) => {
      const task = await this.load(tx, auth, id);
      if (task.status !== "open") {
        throw new ApiException(HttpStatus.CONFLICT, "task_closed", `This task is ${task.status}.`);
      }
      if (input.ownerId !== undefined && input.ownerId !== task.ownerId) {
        if (!MANAGERS.has(auth.role)) throw forbidden("Only managers can reassign tasks");
        await this.assertOwner(tx, auth, input.ownerId);
      }
      const patch: Partial<typeof tasks.$inferInsert> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.notes !== undefined) patch.notes = input.notes || null;
      if (input.dueAt !== undefined) {
        patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
        patch.dueDateMissing = false;
      }
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.ownerId !== undefined) patch.ownerId = input.ownerId;
      if (input.contactId !== undefined) {
        const contact = input.contactId ? await this.contactRef(tx, auth, input.contactId) : null;
        patch.contactId = contact?.id ?? null;
        patch.companyId = contact?.companyId ?? null;
      }
      // Re-sending the current link (e.g. a form saving every field) needs no edit rights.
      if (input.dealId !== undefined && input.dealId !== task.dealId) {
        patch.dealId = input.dealId ? (await this.dealRef(tx, auth, input.dealId)).id : null;
      }
      if (input.suggestDone === false) {
        patch.suggestDoneAt = null;
        patch.suggestDoneMessageId = null;
      }
      await tx
        .update(tasks)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.workspaceId, auth.workspaceId)));
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "task.updated",
        entity: "task",
        entityId: id,
        // Field names only: titles and notes may hold personal data.
        metadata: { fields: Object.keys(input).sort() },
      });
      return this.dto(tx, auth, id);
    });
  }

  /** Closes a task. Repeating the same close is a no-op; done ↔ dismissed is a conflict. */
  close(auth: AuthContext, id: string, status: "done" | "dismissed"): Promise<TaskDto> {
    return this.scope(auth, async (tx) => {
      const task = await this.load(tx, auth, id);
      if (task.status === status) return this.dto(tx, auth, id);
      if (task.status !== "open") {
        throw new ApiException(HttpStatus.CONFLICT, "task_closed", `This task is ${task.status}.`);
      }
      const now = new Date();
      const [updated] = await tx
        .update(tasks)
        .set({ status, completedAt: now, updatedAt: now })
        .where(
          and(eq(tasks.id, id), eq(tasks.workspaceId, auth.workspaceId), eq(tasks.status, "open")),
        )
        .returning({ id: tasks.id });
      if (!updated) {
        throw new ApiException(HttpStatus.CONFLICT, "task_closed", "This task was just closed.");
      }
      // A task completed on a deal counts as deal activity (OL-E7) — only when the task's owner
      // could edit the deal themselves, so nobody can keep someone else's deal "fresh" (SEC-L2).
      if (
        status === "done" &&
        task.dealId &&
        (await this.ownerCanEditDeal(tx, auth.workspaceId, task.ownerId, task.dealId))
      ) {
        await touchDealActivity(tx, auth.workspaceId, task.dealId, now);
      }
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: status === "done" ? "task.completed" : "task.dismissed",
        entity: "task",
        entityId: id,
        metadata: {
          kind: task.kind,
          source: task.source,
          byOwner: task.ownerId === auth.userId,
          suggested: task.suggestDoneAt !== null,
        },
      });
      return this.dto(tx, auth, id);
    });
  }
}
