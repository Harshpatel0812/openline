import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { snippetOf } from "@openline/replies";
import {
  and,
  asc,
  auditLog,
  companies,
  contacts,
  dealContacts,
  deals,
  dealStageHistory,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  mailboxes,
  messages,
  ne,
  or,
  pipelineStages,
  sql,
  tasks,
  users,
  withTenant,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
  type DealRow,
  type PipelineStageRow,
  type Tx,
} from "@openline/db";
import {
  PIPELINE_LIMITS,
  type CreateDealInput,
  type DealAttentionDto,
  type DealAttentionQuery,
  type DealContactRefDto,
  type DealDetailDto,
  type DealDto,
  type DealPageDto,
  type DealPrefillDto,
  type DealQuery,
  type DealStageChangeDto,
  type DealSummaryDto,
  type DealSummaryQuery,
  type DealTimelineDto,
  type DealTimelineItemDto,
  type MoveDealInput,
  type UpdateDealInput,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { crmBadges } from "../integrations/crm-badges";
import { likePattern } from "../companies/companies.service";
import { decodeCursor, encodeCursor } from "../contacts/contacts.service";
import { activeStages } from "../pipeline/pipeline.service";
import { calendarWindow, dealFlags, totalsOf, type MoneyGroup } from "./deal-rules";

/** Managers and above edit every deal; reps edit their own (everyone reads all). */
const MANAGERS = new Set(["owner", "admin", "manager"]);

const utcIso = (expr: ReturnType<typeof sql>) =>
  sql<string>`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The latest email (either direction, any status but an unsent reservation) with any of the
 * deal's contacts. Computed at read time from the existing messages(workspace_id, contact_id,
 * sent_at) index instead of being written by the send/sync paths, so a failure here can never
 * affect sending or reply sync, and adding a contact to a deal counts their history at once.
 */
function emailActivitySql(workspaceId: string) {
  return sql`(SELECT max(m.sent_at) FROM deal_contacts dc
      JOIN messages m ON m.workspace_id = dc.workspace_id AND m.contact_id = dc.contact_id
     WHERE dc.workspace_id = ${workspaceId} AND dc.deal_id = ${deals.id}
       AND m.status <> 'sending')`;
}

/** last_activity_at as defined by the PRD: the deal's own activity merged with email activity. */
function lastActivitySql(workspaceId: string) {
  return sql`greatest(${deals.lastActivityAt}, ${emailActivitySql(workspaceId)})`;
}

/**
 * Undismissed model flags (criterion_missing, stage_ahead_of_evidence) of the deal's latest
 * Reality Check that had model evidence, counted only while the deal is still in the stage it was
 * checked in. A later deterministic-only run (Scout off, budget, model error) doesn't wipe them
 * (QA-L1). A dismissal hides a flag until there is activity after it.
 */
function modelFlagCountSql(workspaceId: string) {
  return sql<number>`(SELECT count(*)::int
      FROM (SELECT c.flags, c.stage_id FROM deal_checks c
             WHERE c.workspace_id = ${workspaceId} AND c.deal_id = ${deals.id}
               AND c.status = 'done' AND NOT c.deterministic_only
             ORDER BY c.ran_at DESC, c.id DESC LIMIT 1) lc,
           jsonb_array_elements(lc.flags) f
     WHERE lc.stage_id = ${deals.stageId}
       AND f->>'code' IN ('criterion_missing', 'stage_ahead_of_evidence')
       AND NOT EXISTS (SELECT 1 FROM deal_flag_dismissals x
                        WHERE x.workspace_id = ${workspaceId} AND x.deal_id = ${deals.id}
                          AND x.flag_id = f->>'id'
                          AND x.dismissed_at >= ${lastActivitySql(workspaceId)}))`;
}

/**
 * The deterministic Reality Check flags ("Not right" works on them too) and the DTO field each
 * one is. A dismissed one stays out of flagCount and the flagged filter until new activity, like
 * the model flags (QA-M1); the facts themselves (isStale, …) are still reported.
 */
const DETERMINISTIC_FLAGS = {
  stale: "isStale",
  next_step_overdue: "nextStepOverdue",
  close_date_passed: "closeDateOverdue",
  no_next_step: "missingNextStep",
} as const;
type DeterministicFlagCode = keyof typeof DETERMINISTIC_FLAGS;

/** Is the deterministic flag `code` dismissed since the deal's latest activity? */
function dismissedSql(workspaceId: string, code: DeterministicFlagCode) {
  return sql`EXISTS (SELECT 1 FROM deal_flag_dismissals x
      WHERE x.workspace_id = ${workspaceId} AND x.deal_id = ${deals.id}
        AND x.code = ${code} AND x.criterion_key IS NULL
        AND x.dismissed_at >= ${lastActivitySql(workspaceId)})`;
}

/** Comma-separated deterministic flag codes dismissed since the latest activity. */
function dismissedCodesSql(workspaceId: string) {
  return sql<string>`(SELECT coalesce(string_agg(DISTINCT x.code, ','), '')
      FROM deal_flag_dismissals x
     WHERE x.workspace_id = ${workspaceId} AND x.deal_id = ${deals.id}
       AND x.criterion_key IS NULL
       AND x.code IN ('stale', 'next_step_overdue', 'close_date_passed', 'no_next_step')
       AND x.dismissed_at >= ${lastActivitySql(workspaceId)})`;
}

/** `days` × 24 h exactly, whatever the session time zone (QA-L2; matches deal-rules isStale). */
function exactDaysSql(days: unknown) {
  return sql`(${days} * interval '24 hours')`;
}

function selectDeals(tx: Tx, ws: string) {
  return tx
    .select({
      d: deals,
      modelFlags: modelFlagCountSql(ws),
      dismissedCodes: dismissedCodesSql(ws),
      createdAtIso: utcIso(sql`${deals.createdAt}`),
      lastActivityIso: utcIso(lastActivitySql(ws)),
      stage: {
        id: pipelineStages.id,
        name: pipelineStages.name,
        kind: pipelineStages.kind,
        probability: pipelineStages.probability,
        position: pipelineStages.position,
        staleAfterDays: pipelineStages.staleAfterDays,
      },
      ownerName: users.name,
      company: { id: companies.id, name: companies.name },
      contact: {
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        title: contacts.title,
      },
    })
    .from(deals)
    .innerJoin(
      pipelineStages,
      and(eq(pipelineStages.id, deals.stageId), eq(pipelineStages.workspaceId, ws)),
    )
    .leftJoin(users, eq(users.id, deals.ownerId))
    .leftJoin(companies, and(eq(companies.id, deals.companyId), eq(companies.workspaceId, ws)))
    .leftJoin(contacts, and(eq(contacts.id, deals.primaryContactId), eq(contacts.workspaceId, ws)));
}

type DealSelectRow = Awaited<ReturnType<ReturnType<typeof selectDeals>["where"]>>[number];

/** Per-request facts the DTO flags need. */
interface Ctx {
  auth: AuthContext;
  now: Date;
  today: string;
  firstOpenPosition: number;
  currency: string;
  timeZone: string;
}

function canEdit(auth: AuthContext, ownerId: string): boolean {
  return ownerId === auth.userId || MANAGERS.has(auth.role);
}

function toDealDto(r: DealSelectRow, ctx: Ctx): DealDto {
  const d = r.d;
  const lastActivityAt = new Date(r.lastActivityIso);
  const flags = dealFlags(
    {
      kind: r.stage.kind,
      stagePosition: r.stage.position,
      firstOpenPosition: ctx.firstOpenPosition,
      staleAfterDays: r.stage.staleAfterDays,
      lastActivityAt,
      nextStep: d.nextStep,
      nextStepDate: d.nextStepDate,
      expectedCloseDate: d.expectedCloseDate,
    },
    ctx.now,
    ctx.today,
  );
  const open = r.stage.kind === "open";
  const dismissed = new Set(
    String(r.dismissedCodes ?? "")
      .split(",")
      .filter(Boolean),
  );
  const deterministicCount = (
    Object.entries(DETERMINISTIC_FLAGS) as [DeterministicFlagCode, keyof typeof flags][]
  ).filter(([code, field]) => flags[field] && !dismissed.has(code)).length;
  return {
    id: d.id,
    name: d.name,
    company: r.company?.id ? { id: r.company.id, name: r.company.name } : null,
    primaryContact: r.contact?.id ? (r.contact as DealContactRefDto) : null,
    owner: { id: d.ownerId, name: r.ownerName ?? "" },
    stage: {
      id: r.stage.id,
      name: r.stage.name,
      kind: r.stage.kind,
      probability: r.stage.probability,
    },
    amountMinor: d.amountMinor === null ? null : Number(d.amountMinor),
    currency: d.currency,
    expectedCloseDate: d.expectedCloseDate,
    nextStep: d.nextStep,
    nextStepDate: d.nextStepDate,
    lostReason: d.lostReason,
    stageEnteredAt: d.stageEnteredAt.toISOString(),
    lastActivityAt: lastActivityAt.toISOString(),
    closedAt: d.closedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    ...flags,
    flagCount: deterministicCount + (open ? Number(r.modelFlags ?? 0) : 0),
    canEdit: canEdit(ctx.auth, d.ownerId),
  };
}

const firstOpen = (stages: PipelineStageRow[]) =>
  stages.find((s) => s.kind === "open")?.position ?? 0;

/** "Acme Tools — new deal" (≤ 120). */
export function suggestedDealName(company: string | null, person: string | null): string {
  const base = (company || person || "New contact").trim();
  const suffix = " — new deal";
  return base.slice(0, PIPELINE_LIMITS.dealName - suffix.length) + suffix;
}

/** Inbox "Create deal": prefill from the reply's contact/company + the contact's open deals. */
export async function dealPrefill(
  tx: Tx,
  workspaceId: string,
  contact: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null,
  company: { id: string; name: string } | null,
): Promise<DealPrefillDto> {
  const person = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email
    : null;
  const openDeals = contact
    ? await tx
        .select({ id: deals.id, name: deals.name, stageName: pipelineStages.name })
        .from(dealContacts)
        .innerJoin(
          deals,
          and(eq(deals.id, dealContacts.dealId), eq(deals.workspaceId, workspaceId)),
        )
        .innerJoin(
          pipelineStages,
          and(eq(pipelineStages.id, deals.stageId), eq(pipelineStages.workspaceId, workspaceId)),
        )
        .where(
          and(
            eq(dealContacts.workspaceId, workspaceId),
            eq(dealContacts.contactId, contact.id),
            eq(pipelineStages.kind, "open"),
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(10)
    : [];
  return {
    name: suggestedDealName(company?.name ?? null, person),
    contactId: contact?.id ?? null,
    companyId: company?.id ?? null,
    openDeals,
  };
}

@Injectable()
export class DealsService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Adds the CRM sync badge (OL-E8) when a CRM is connected. */
  private async withCrm<T extends DealDto>(tx: Tx, workspaceId: string, items: T[]): Promise<T[]> {
    const badges = await crmBadges(
      tx,
      workspaceId,
      "deal",
      items.map((i) => i.id),
      this.config.crm,
    );
    return badges.size
      ? items.map((i) => (badges.has(i.id) ? { ...i, crm: badges.get(i.id) } : i))
      : items;
  }

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  private async context(
    tx: Tx,
    auth: AuthContext,
  ): Promise<{ ctx: Ctx; stages: PipelineStageRow[] }> {
    const [ws] = await tx
      .select({ tz: workspaces.defaultTimeZone, currency: workspaces.currency })
      .from(workspaces)
      .where(eq(workspaces.id, auth.workspaceId));
    if (!ws) throw notFound("Workspace");
    const stages = await activeStages(tx, auth.workspaceId);
    const now = new Date();
    return {
      stages,
      ctx: {
        auth,
        now,
        today: calendarWindow(ws.tz, now).today,
        firstOpenPosition: firstOpen(stages),
        currency: ws.currency,
        timeZone: ws.tz,
      },
    };
  }

  // ---------------------------------------------------------------- reads

  /** WHERE for "stale": open stage with a limit, and no activity for longer than it. */
  private staleSql(ctx: Ctx) {
    return sql`(${pipelineStages.kind} = 'open' AND ${pipelineStages.staleAfterDays} IS NOT NULL
      AND ${lastActivitySql(ctx.auth.workspaceId)}
          < ${ctx.now.toISOString()}::timestamptz - ${exactDaysSql(pipelineStages.staleAfterDays)})`;
  }

  private nextStepOverdueSql(ctx: Ctx) {
    return sql`(${pipelineStages.kind} = 'open' AND ${deals.nextStepDate} < ${ctx.today}::date)`;
  }

  /**
   * "Flagged" = any undismissed deterministic Reality Check flag (stale, next step overdue, close
   * date passed, no next step past the first open stage) or an undismissed model flag of the
   * latest check with evidence. Same rule as flagCount in the DTO.
   */
  private flaggedSql(ctx: Ctx) {
    const ws = ctx.auth.workspaceId;
    const undismissed = (code: DeterministicFlagCode, condition: ReturnType<typeof sql>) =>
      sql`(${condition} AND NOT ${dismissedSql(ws, code)})`;
    // coalesce: NULL dates would make NOT flagged unknown (and drop the row from flagged=0).
    return sql`coalesce((${undismissed("stale", this.staleSql(ctx))}
      OR ${undismissed("next_step_overdue", this.nextStepOverdueSql(ctx))}
      OR ${undismissed(
        "close_date_passed",
        sql`(${pipelineStages.kind} = 'open' AND ${deals.expectedCloseDate} < ${ctx.today}::date)`,
      )}
      OR ${undismissed(
        "no_next_step",
        sql`(${pipelineStages.kind} = 'open' AND ${pipelineStages.position} > ${ctx.firstOpenPosition}
          AND (${deals.nextStep} IS NULL OR ${deals.nextStep} = ''))`,
      )}
      OR (${pipelineStages.kind} = 'open' AND ${modelFlagCountSql(ws)} > 0)), false)`;
  }

  list(auth: AuthContext, query: DealQuery): Promise<DealPageDto> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const { ctx } = await this.context(tx, auth);
      const ownerId = query.ownerId === "me" ? auth.userId : query.ownerId;
      const rows = await selectDeals(tx, ws)
        .where(
          and(
            eq(deals.workspaceId, ws),
            query.stageId ? eq(deals.stageId, query.stageId) : undefined,
            ownerId ? eq(deals.ownerId, ownerId) : undefined,
            query.companyId ? eq(deals.companyId, query.companyId) : undefined,
            query.contactId
              ? sql`EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.workspace_id = ${ws}
                    AND dc.deal_id = ${deals.id} AND dc.contact_id = ${query.contactId})`
              : undefined,
            query.status !== "all" ? eq(pipelineStages.kind, query.status) : undefined,
            query.stale === true ? this.staleSql(ctx) : undefined,
            query.stale === false ? sql`NOT ${this.staleSql(ctx)}` : undefined,
            query.flagged === true ? this.flaggedSql(ctx) : undefined,
            query.flagged === false ? sql`NOT ${this.flaggedSql(ctx)}` : undefined,
            query.closeFrom ? gte(deals.expectedCloseDate, query.closeFrom) : undefined,
            query.closeTo ? lte(deals.expectedCloseDate, query.closeTo) : undefined,
            query.q
              ? or(
                  ilike(deals.name, likePattern(query.q)),
                  ilike(companies.name, likePattern(query.q)),
                )
              : undefined,
            after
              ? sql`(${deals.createdAt}, ${deals.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(deals.createdAt), desc(deals.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return {
        items: await this.withCrm(
          tx,
          ws,
          items.map((r) => toDealDto(r, ctx)),
        ),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAtIso, last.d.id) : null,
      };
    });
  }

  /** Deals of one contact / company (their pages). 404 when it isn't in this workspace. */
  async listFor(auth: AuthContext, what: "contact" | "company", id: string): Promise<DealDto[]> {
    const exists = await this.scope(auth, async (tx) => {
      const table = what === "contact" ? contacts : companies;
      const [row] = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, id), eq(table.workspaceId, auth.workspaceId)));
      return !!row;
    });
    if (!exists) throw notFound(what === "contact" ? "Contact" : "Company");
    const page = await this.list(auth, {
      status: "all",
      limit: 200,
      ...(what === "contact" ? { contactId: id } : { companyId: id }),
    });
    return page.items;
  }

  summary(auth: AuthContext, query: DealSummaryQuery): Promise<DealSummaryDto> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const { ctx, stages } = await this.context(tx, auth);
      const cal = calendarWindow(ctx.timeZone, ctx.now);
      const ownerId = query.ownerId === "me" ? auth.userId : query.ownerId;
      const inMonth = sql<boolean>`(${deals.expectedCloseDate} >= ${cal.monthStart}::date AND ${deals.expectedCloseDate} < ${cal.nextMonthStart}::date)`;
      const inQuarter = sql<boolean>`(${deals.expectedCloseDate} >= ${cal.quarterStart}::date AND ${deals.expectedCloseDate} < ${cal.nextQuarterStart}::date)`;
      const rows = await tx
        .select({
          stageId: deals.stageId,
          currency: deals.currency,
          inMonth: sql<boolean>`coalesce(${inMonth}, false)`,
          inQuarter: sql<boolean>`coalesce(${inQuarter}, false)`,
          count: sql<number>`count(*)::int`,
          withAmount: sql<number>`count(${deals.amountMinor})::int`,
          amount: sql<string>`coalesce(sum(${deals.amountMinor}), 0)::text`,
          weightedRaw: sql<string>`coalesce(sum(${deals.amountMinor}::numeric * ${pipelineStages.probability}), 0)::text`,
        })
        .from(deals)
        .innerJoin(
          pipelineStages,
          and(eq(pipelineStages.id, deals.stageId), eq(pipelineStages.workspaceId, ws)),
        )
        .where(and(eq(deals.workspaceId, ws), ownerId ? eq(deals.ownerId, ownerId) : undefined))
        .groupBy(deals.stageId, deals.currency, sql`3`, sql`4`);
      const groups = rows.map((r) => ({
        stageId: r.stageId,
        inMonth: Boolean(r.inMonth),
        inQuarter: Boolean(r.inQuarter),
        money: {
          currency: r.currency,
          count: Number(r.count),
          withAmount: Number(r.withAmount),
          amount: String(r.amount),
          weightedRaw: String(r.weightedRaw),
        } satisfies MoneyGroup,
      }));
      const openIds = new Set(stages.filter((s) => s.kind === "open").map((s) => s.id));
      const open = groups.filter((g) => openIds.has(g.stageId));
      const cur = ctx.currency;
      return {
        currency: cur,
        multiCurrency: groups.some((g) => g.money.currency !== cur),
        columns: stages.map((s) => ({
          stageId: s.id,
          ...totalsOf(
            groups.filter((g) => g.stageId === s.id).map((g) => g.money),
            cur,
          ),
        })),
        forecast: {
          open: totalsOf(
            open.map((g) => g.money),
            cur,
          ),
          thisMonth: totalsOf(
            open.filter((g) => g.inMonth).map((g) => g.money),
            cur,
          ),
          thisQuarter: totalsOf(
            open.filter((g) => g.inQuarter).map((g) => g.money),
            cur,
          ),
        },
      };
    });
  }

  /** Today: open deals that are stale or whose next-step date has passed, oldest activity first. */
  attention(auth: AuthContext, query: DealAttentionQuery): Promise<DealAttentionDto> {
    if (!query.mine && !MANAGERS.has(auth.role)) {
      throw forbidden("Only managers can see everyone's deals needing attention");
    }
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const { ctx } = await this.context(tx, auth);
      const rows = await selectDeals(tx, ws)
        .where(
          and(
            eq(deals.workspaceId, ws),
            query.mine ? eq(deals.ownerId, auth.userId) : undefined,
            eq(pipelineStages.kind, "open"),
            or(this.staleSql(ctx), this.nextStepOverdueSql(ctx)),
          ),
        )
        .orderBy(asc(lastActivitySql(ws)), asc(deals.id))
        .limit(query.limit);
      return { items: rows.map((r) => toDealDto(r, ctx)) };
    });
  }

  private async row(tx: Tx, ws: string, id: string): Promise<DealSelectRow> {
    const [row] = await selectDeals(tx, ws)
      .where(and(eq(deals.id, id), eq(deals.workspaceId, ws)))
      .limit(1);
    if (!row) throw notFound("Deal");
    return row;
  }

  private async detail(tx: Tx, auth: AuthContext, id: string): Promise<DealDetailDto> {
    const ws = auth.workspaceId;
    const { ctx } = await this.context(tx, auth);
    const row = await this.row(tx, ws, id);
    const people = await tx
      .select({
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        title: contacts.title,
      })
      .from(dealContacts)
      .innerJoin(
        contacts,
        and(eq(contacts.id, dealContacts.contactId), eq(contacts.workspaceId, ws)),
      )
      .where(and(eq(dealContacts.workspaceId, ws), eq(dealContacts.dealId, id)))
      .orderBy(asc(dealContacts.addedAt), asc(contacts.email));
    const [dto] = await this.withCrm(tx, ws, [toDealDto(row, ctx)]);
    return {
      ...dto!,
      contacts: people,
      stageHistory: await this.history(tx, ws, id),
    };
  }

  private async history(tx: Tx, ws: string, dealId: string): Promise<DealStageChangeDto[]> {
    const rows = await tx
      .select({ h: dealStageHistory, byName: users.name })
      .from(dealStageHistory)
      .leftJoin(users, eq(users.id, dealStageHistory.movedBy))
      .where(and(eq(dealStageHistory.workspaceId, ws), eq(dealStageHistory.dealId, dealId)))
      .orderBy(asc(dealStageHistory.movedAt), asc(dealStageHistory.id));
    const names = await this.stageNames(tx, ws);
    return rows.map(({ h, byName }) => ({
      id: h.id,
      from: h.fromStageId ? { id: h.fromStageId, name: names.get(h.fromStageId) ?? "" } : null,
      to: { id: h.toStageId, name: names.get(h.toStageId) ?? "" },
      by: h.movedBy ? { id: h.movedBy, name: byName ?? "" } : null,
      at: h.movedAt.toISOString(),
    }));
  }

  /** Every stage's name, archived ones included (history points at them). */
  private async stageNames(tx: Tx, ws: string): Promise<Map<string, string>> {
    const rows = await tx
      .select({ id: pipelineStages.id, name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.workspaceId, ws));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  get(auth: AuthContext, id: string): Promise<DealDetailDto> {
    return this.scope(auth, (tx) => this.detail(tx, auth, id));
  }

  timeline(auth: AuthContext, id: string): Promise<DealTimelineDto> {
    const ws = auth.workspaceId;
    const seesAll = MANAGERS.has(auth.role);
    return this.scope(auth, async (tx) => {
      await this.row(tx, ws, id);
      const emails = await tx
        .select({
          id: messages.id,
          direction: messages.direction,
          subject: messages.subject,
          sentAt: messages.sentAt,
          bodyText: messages.bodyText,
          contactId: messages.contactId,
          mailboxUserId: mailboxes.userId,
        })
        .from(messages)
        .innerJoin(
          dealContacts,
          and(
            eq(dealContacts.workspaceId, ws),
            eq(dealContacts.dealId, id),
            eq(dealContacts.contactId, messages.contactId),
          ),
        )
        .leftJoin(
          mailboxes,
          and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.workspaceId, ws)),
        )
        .where(and(eq(messages.workspaceId, ws), ne(messages.status, "sending")))
        .orderBy(desc(messages.sentAt))
        .limit(100);
      const dealTasks = await tx
        .select({ t: tasks })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.dealId, id)))
        .orderBy(desc(tasks.createdAt))
        .limit(100);
      const edits = await tx
        .select({ a: auditLog, byName: users.name })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorId))
        .where(
          and(
            eq(auditLog.workspaceId, ws),
            eq(auditLog.entity, "deal"),
            eq(auditLog.entityId, id),
            eq(auditLog.action, "deal.updated"),
          ),
        )
        .orderBy(desc(auditLog.at))
        .limit(100);
      const items: DealTimelineItemDto[] = [
        ...emails.map((m): DealTimelineItemDto => {
          // Same rule as the inbox (SEC-M2): reps read their own mailboxes' mail; of a teammate's
          // they see only that an email went one way or the other, and when.
          const readable = seesAll || m.mailboxUserId === auth.userId;
          return {
            kind: "email",
            id: `email:${m.id}`,
            at: m.sentAt.toISOString(),
            direction: m.direction,
            subject: readable ? m.subject : null,
            teammateMailbox: !readable,
            // Bodies are stored for inbound mail only.
            snippet:
              readable && m.direction === "inbound" && m.bodyText
                ? snippetOf(m.bodyText).slice(0, PIPELINE_LIMITS.snippet)
                : null,
            messageId: m.id,
            contactId: m.contactId,
          };
        }),
        ...(await this.history(tx, ws, id)).map((h): DealTimelineItemDto => ({
          kind: "stage_change",
          id: `stage:${h.id}`,
          at: h.at,
          from: h.from,
          to: h.to,
          by: h.by,
        })),
        ...dealTasks.map(({ t }): DealTimelineItemDto => ({
          kind: "task",
          id: `task:${t.id}`,
          at: (t.completedAt ?? t.createdAt).toISOString(),
          taskId: t.id,
          // Tasks are private to their owner and managers: others see that a task exists.
          title: seesAll || t.ownerId === auth.userId ? t.title : null,
          status: t.status,
        })),
        ...edits.map(({ a, byName }): DealTimelineItemDto => ({
          kind: "edit",
          id: `edit:${a.id}`,
          at: a.at.toISOString(),
          by: a.actorId ? { id: a.actorId, name: byName ?? "" } : null,
          fields: Array.isArray(a.metadata.fields) ? (a.metadata.fields as string[]) : [],
        })),
      ];
      items.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id.localeCompare(y.id)));
      return { items: items.slice(0, 200) };
    });
  }

  // ---------------------------------------------------------------- writes

  private async assertOwner(tx: Tx, auth: AuthContext, ownerId: string): Promise<void> {
    if (ownerId === auth.userId) return;
    if (!MANAGERS.has(auth.role)) throw forbidden("Only managers can give deals to teammates");
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

  private async assertCompany(tx: Tx, ws: string, companyId: string): Promise<void> {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, ws)));
    if (!company) throw notFound("Company");
  }

  /** Checks every contact is in this workspace; returns their company ids. */
  private async contactsIn(tx: Tx, ws: string, ids: string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await tx
      .select({ id: contacts.id, companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, ids)));
    if (rows.length !== ids.length) throw notFound("Contact");
    return new Map(rows.map((r) => [r.id, r.companyId]));
  }

  private contactSet(primary: string | null | undefined, others: string[] | undefined): string[] {
    const set = [...new Set([...(primary ? [primary] : []), ...(others ?? [])])];
    if (set.length > PIPELINE_LIMITS.maxContacts) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "validation_error",
        "Some fields are invalid",
        [
          {
            path: "contactIds",
            message: `At most ${PIPELINE_LIMITS.maxContacts} contacts per deal`,
          },
        ],
      );
    }
    return set;
  }

  create(auth: AuthContext, input: CreateDealInput): Promise<DealDetailDto> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const { ctx, stages } = await this.context(tx, auth);
      const ownerId = input.ownerId ?? auth.userId;
      await this.assertOwner(tx, auth, ownerId);
      const stage = input.stageId
        ? stages.find((s) => s.id === input.stageId)
        : stages.find((s) => s.kind === "open");
      if (!stage) throw notFound("Stage");
      if (stage.kind !== "open") {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "stage_closed",
          "New deals start in an open stage; move them to won or lost afterwards.",
        );
      }
      const people = this.contactSet(input.primaryContactId, input.contactIds);
      const companyOf = await this.contactsIn(tx, ws, people);
      let companyId = input.companyId ?? null;
      if (companyId) await this.assertCompany(tx, ws, companyId);
      else if (input.companyId === undefined && input.primaryContactId) {
        companyId = companyOf.get(input.primaryContactId) ?? null;
      }
      const now = new Date();
      const [deal] = await tx
        .insert(deals)
        .values({
          workspaceId: ws,
          name: input.name,
          companyId,
          primaryContactId: input.primaryContactId ?? null,
          ownerId,
          stageId: stage.id,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency ?? ctx.currency,
          expectedCloseDate: input.expectedCloseDate ?? null,
          nextStep: input.nextStep || null,
          nextStepDate: input.nextStepDate ?? null,
          stageEnteredAt: now,
          lastActivityAt: now,
          createdBy: auth.userId,
        })
        .returning({ id: deals.id });
      const id = deal!.id;
      if (people.length) {
        await tx
          .insert(dealContacts)
          .values(people.map((contactId) => ({ workspaceId: ws, dealId: id, contactId })));
      }
      await tx.insert(dealStageHistory).values({
        workspaceId: ws,
        dealId: id,
        fromStageId: null,
        toStageId: stage.id,
        movedBy: auth.userId,
        movedAt: now,
      });
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "deal.created",
        entity: "deal",
        entityId: id,
        metadata: {
          stageId: stage.id,
          hasAmount: input.amountMinor !== undefined && input.amountMinor !== null,
          contacts: people.length,
          assigned: ownerId !== auth.userId,
        },
      });
      return this.detail(tx, auth, id);
    });
  }

  /** A deal the caller may change: 404 outside the workspace, 403 when it isn't theirs. */
  private async editable(tx: Tx, auth: AuthContext, id: string): Promise<DealRow> {
    const [deal] = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.workspaceId, auth.workspaceId)))
      .limit(1)
      .for("update");
    if (!deal) throw notFound("Deal");
    if (!canEdit(auth, deal.ownerId))
      throw forbidden("Only the deal's owner or a manager can change it");
    return deal;
  }

  update(auth: AuthContext, id: string, input: UpdateDealInput): Promise<DealDetailDto> {
    const ws = auth.workspaceId;
    return this.scope(auth, async (tx) => {
      const deal = await this.editable(tx, auth, id);
      if (input.ownerId !== undefined && input.ownerId !== deal.ownerId) {
        if (!MANAGERS.has(auth.role)) throw forbidden("Only managers can reassign deals");
        await this.assertOwner(tx, auth, input.ownerId);
      }
      if (input.lostReason !== undefined) {
        const [stage] = await tx
          .select({ kind: pipelineStages.kind })
          .from(pipelineStages)
          .where(and(eq(pipelineStages.id, deal.stageId), eq(pipelineStages.workspaceId, ws)));
        if (stage?.kind !== "lost") {
          throw new ApiException(
            HttpStatus.CONFLICT,
            "deal_not_lost",
            "A lost reason can only be set on a lost deal.",
          );
        }
      }
      if (input.companyId) await this.assertCompany(tx, ws, input.companyId);

      const patch: Partial<typeof deals.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.companyId !== undefined) patch.companyId = input.companyId;
      if (input.ownerId !== undefined) patch.ownerId = input.ownerId;
      if (input.amountMinor !== undefined) patch.amountMinor = input.amountMinor;
      if (input.currency !== undefined) patch.currency = input.currency;
      if (input.expectedCloseDate !== undefined) patch.expectedCloseDate = input.expectedCloseDate;
      if (input.nextStep !== undefined) patch.nextStep = input.nextStep || null;
      if (input.nextStepDate !== undefined) patch.nextStepDate = input.nextStepDate;
      if (input.lostReason !== undefined) patch.lostReason = input.lostReason;
      if (input.primaryContactId !== undefined) patch.primaryContactId = input.primaryContactId;

      // Contacts: replace the set when given; the primary contact is always one of them.
      if (input.contactIds !== undefined || input.primaryContactId) {
        const current = await tx
          .select({ contactId: dealContacts.contactId })
          .from(dealContacts)
          .where(and(eq(dealContacts.workspaceId, ws), eq(dealContacts.dealId, id)));
        const primary =
          input.primaryContactId !== undefined ? input.primaryContactId : deal.primaryContactId;
        const wanted = this.contactSet(
          primary,
          input.contactIds ?? current.map((c) => c.contactId),
        );
        await this.contactsIn(tx, ws, wanted);
        const have = new Set(current.map((c) => c.contactId));
        const drop = [...have].filter((c) => !wanted.includes(c));
        const add = wanted.filter((c) => !have.has(c));
        if (drop.length) {
          await tx
            .delete(dealContacts)
            .where(
              and(
                eq(dealContacts.workspaceId, ws),
                eq(dealContacts.dealId, id),
                inArray(dealContacts.contactId, drop),
              ),
            );
        }
        if (add.length) {
          await tx
            .insert(dealContacts)
            .values(add.map((contactId) => ({ workspaceId: ws, dealId: id, contactId })));
        }
      }
      const now = new Date();
      await tx
        .update(deals)
        .set({ ...patch, updatedAt: now, lastActivityAt: now })
        .where(and(eq(deals.id, id), eq(deals.workspaceId, ws)));
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "deal.updated",
        entity: "deal",
        entityId: id,
        // Field names only: names, next steps and reasons may hold personal data.
        metadata: { fields: Object.keys(input).sort() },
      });
      return this.detail(tx, auth, id);
    });
  }

  /**
   * Moves a deal: history row + audit. Won/lost set closed_at; moving back to an open stage
   * clears it (and the lost reason). Lost needs a reason. Same stage = no-op.
   */
  move(auth: AuthContext, id: string, input: MoveDealInput): Promise<DealDetailDto> {
    return this.scope(auth, (tx) => this.moveIn(tx, auth, id, input));
  }

  /** move() inside the caller's transaction (Reality Check "accept" uses it). */
  async moveIn(
    tx: Tx,
    auth: AuthContext,
    id: string,
    input: MoveDealInput,
    auditExtra: Record<string, unknown> = {},
  ): Promise<DealDetailDto> {
    const ws = auth.workspaceId;
    {
      const deal = await this.editable(tx, auth, id);
      const stages = await activeStages(tx, ws);
      const to = stages.find((s) => s.id === input.stageId);
      if (!to) throw notFound("Stage");
      if (to.id === deal.stageId) {
        if (to.kind === "lost" && input.lostReason && input.lostReason !== deal.lostReason) {
          await tx
            .update(deals)
            .set({ lostReason: input.lostReason, updatedAt: new Date() })
            .where(and(eq(deals.id, id), eq(deals.workspaceId, ws)));
        }
        return this.detail(tx, auth, id);
      }
      if (to.kind === "lost" && !input.lostReason) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "lost_reason_required",
          "Say why the deal was lost.",
          [{ path: "lostReason", message: "Required when moving to a lost stage" }],
        );
      }
      const now = new Date();
      const from = stages.find((s) => s.id === deal.stageId);
      await tx
        .update(deals)
        .set({
          stageId: to.id,
          stageEnteredAt: now,
          lastActivityAt: now,
          updatedAt: now,
          closedAt: to.kind === "open" ? null : now,
          lostReason: to.kind === "lost" ? input.lostReason! : null,
        })
        .where(and(eq(deals.id, id), eq(deals.workspaceId, ws)));
      await tx.insert(dealStageHistory).values({
        workspaceId: ws,
        dealId: id,
        fromStageId: deal.stageId,
        toStageId: to.id,
        movedBy: auth.userId,
        movedAt: now,
      });
      await this.audit.record(tx, {
        workspaceId: ws,
        actorId: auth.userId,
        action: "deal.moved",
        entity: "deal",
        entityId: id,
        metadata: {
          fromStageId: deal.stageId,
          toStageId: to.id,
          fromKind: from?.kind ?? null,
          toKind: to.kind,
          byOwner: deal.ownerId === auth.userId,
          ...auditExtra,
        },
      });
      return this.detail(tx, auth, id);
    }
  }

  /** The deal for a caller who may change it (404 / 403), locked for update. */
  editableIn(tx: Tx, auth: AuthContext, id: string): Promise<DealRow> {
    return this.editable(tx, auth, id);
  }

  /** Deal detail inside the caller's transaction. */
  detailIn(tx: Tx, auth: AuthContext, id: string): Promise<DealDetailDto> {
    return this.detail(tx, auth, id);
  }
}

/** Task completed on a deal = deal activity (called inside the task's transaction). */
export async function touchDealActivity(
  tx: Tx,
  workspaceId: string,
  dealId: string,
  at = new Date(),
): Promise<void> {
  await tx
    .update(deals)
    .set({ lastActivityAt: at })
    .where(
      and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId), lt(deals.lastActivityAt, at)),
    );
}
