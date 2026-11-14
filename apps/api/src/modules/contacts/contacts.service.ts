import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  and,
  companies,
  contacts,
  count,
  desc,
  eq,
  ilike,
  or,
  sql,
  suppressions,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import type { ContactCreate, ContactDto, ContactListDto, ContactUpdate } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException, forbidden, notFound } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { CompaniesService, likePattern } from "../companies/companies.service";

/** True when `tz` is an IANA time zone the runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(tz: string | null | undefined): void {
  if (tz && !isValidTimeZone(tz)) {
    throw new ApiException(HttpStatus.BAD_REQUEST, "validation_error", "Some fields are invalid", [
      { path: "timeZone", message: "Use an IANA time zone like America/New_York" },
    ]);
  }
}

export const contactExists = (contactId: string) =>
  new ApiException(
    HttpStatus.CONFLICT,
    "contact_exists",
    "A contact with this email already exists.",
    { contactId },
  );

// Full-precision (microsecond) ISO timestamp, so keyset cursors never skip rows.
const createdAtIso = sql<string>`to_char(${contacts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const contactColumns = {
  id: contacts.id,
  email: contacts.email,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  title: contacts.title,
  phone: contacts.phone,
  timeZone: contacts.timeZone,
  country: contacts.country,
  status: contacts.status,
  consentBasis: contacts.consentBasis,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
  createdAtIso,
  companyId: companies.id,
  companyName: companies.name,
  companyDomain: companies.domain,
};

const companyJoin = (workspaceId: string) =>
  and(eq(companies.id, contacts.companyId), eq(companies.workspaceId, workspaceId));

/** Contacts with their company, always scoped to one workspace's companies. */
function selectContacts(tx: Tx, workspaceId: string) {
  return tx
    .select(contactColumns)
    .from(contacts)
    .leftJoin(companies, companyJoin(workspaceId))
    .$dynamic();
}

type ContactRow = Awaited<ReturnType<typeof selectContacts>>[number];

function toDto(r: ContactRow): ContactDto {
  return {
    id: r.id,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    title: r.title,
    phone: r.phone,
    timeZone: r.timeZone,
    country: r.country,
    status: r.status,
    consentBasis: r.consentBasis,
    company: r.companyId
      ? { id: r.companyId, name: r.companyName!, domain: r.companyDomain }
      : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function encodeCursor(createdAtIso: string, id: string): string {
  return Buffer.from(`${createdAtIso}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const match = CURSOR_RE.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) {
    throw new ApiException(HttpStatus.BAD_REQUEST, "validation_error", "Some fields are invalid", [
      { path: "cursor", message: "Invalid cursor" },
    ]);
  }
  if (Number.isNaN(Date.parse(match[1]!))) {
    throw new ApiException(HttpStatus.BAD_REQUEST, "validation_error", "Some fields are invalid", [
      { path: "cursor", message: "Invalid cursor" },
    ]);
  }
  return { createdAt: match[1]!, id: match[2]! };
}

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly companies: CompaniesService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  list(
    auth: AuthContext,
    query: { q?: string; limit: number; cursor?: string },
  ): Promise<ContactListDto> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    return this.scope(auth, async (tx) => {
      const search = query.q
        ? or(
            ilike(contacts.firstName, likePattern(query.q)),
            ilike(contacts.lastName, likePattern(query.q)),
            ilike(
              sql`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`,
              likePattern(query.q),
            ),
            ilike(contacts.email, likePattern(query.q)),
            ilike(companies.name, likePattern(query.q)),
            ilike(companies.domain, likePattern(query.q)),
          )
        : undefined;
      const filter = and(eq(contacts.workspaceId, auth.workspaceId), search);
      const page = after
        ? sql`(${contacts.createdAt}, ${contacts.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
        : undefined;

      const rows = await selectContacts(tx, auth.workspaceId)
        .where(and(filter, page))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(query.limit + 1);
      const [totalRow] = await tx
        .select({ n: count() })
        .from(contacts)
        .leftJoin(companies, companyJoin(auth.workspaceId))
        .where(filter);

      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toDto),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAtIso, last.id) : null,
        total: Number(totalRow?.n ?? 0),
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<ContactDto> {
    return this.scope(auth, async (tx) => toDto(await this.load(tx, auth, id)));
  }

  async create(auth: AuthContext, input: ContactCreate): Promise<ContactDto> {
    assertTimeZone(input.timeZone);
    assertCanSetConsent(auth, input.consentBasis);
    return this.scope(auth, async (tx) => {
      const existing = await this.findByEmail(tx, auth.workspaceId, input.email);
      if (existing) throw contactExists(existing);
      const companyId = await this.companies.resolveFor(
        tx,
        auth.workspaceId,
        input.email,
        input.companyDomain,
        input.companyName,
      );
      const [created] = await tx
        .insert(contacts)
        .values({
          workspaceId: auth.workspaceId,
          ownerId: auth.userId,
          companyId,
          email: input.email,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          title: input.title ?? null,
          phone: input.phone ?? null,
          timeZone: input.timeZone ?? null,
          country: input.country ?? null,
          consentBasis: input.consentBasis ?? "none",
        })
        .returning({ id: contacts.id });
      if (input.consentBasis && input.consentBasis !== "none") {
        await this.audit.record(tx, {
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          action: "contact.consent_changed",
          entity: "contact",
          entityId: created!.id,
          metadata: { from: null, to: input.consentBasis },
        });
      }
      return toDto(await this.load(tx, auth, created!.id));
    });
  }

  async update(auth: AuthContext, id: string, input: ContactUpdate): Promise<ContactDto> {
    assertTimeZone(input.timeZone);
    assertCanSetConsent(auth, input.consentBasis);
    return this.scope(auth, async (tx) => {
      const current = await this.load(tx, auth, id);
      const email = input.email ?? current.email;
      if (email !== current.email) {
        const other = await this.findByEmail(tx, auth.workspaceId, email);
        if (other && other !== id) throw contactExists(other);
      }

      const patch: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() };
      if (input.email !== undefined) patch.email = input.email;
      if (input.firstName !== undefined) patch.firstName = input.firstName;
      if (input.lastName !== undefined) patch.lastName = input.lastName;
      if (input.title !== undefined) patch.title = input.title;
      if (input.phone !== undefined) patch.phone = input.phone;
      if (input.timeZone !== undefined) patch.timeZone = input.timeZone;
      if (input.country !== undefined) patch.country = input.country;
      if (input.consentBasis !== undefined && input.consentBasis !== current.consentBasis) {
        patch.consentBasis = input.consentBasis;
        await this.audit.record(tx, {
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          action: "contact.consent_changed",
          entity: "contact",
          entityId: id,
          metadata: { from: current.consentBasis, to: input.consentBasis },
        });
      }
      // Changing the email or company re-links the company (same rule as create).
      if (
        input.email !== undefined ||
        input.companyDomain !== undefined ||
        input.companyName !== undefined
      ) {
        patch.companyId = await this.companies.resolveFor(
          tx,
          auth.workspaceId,
          email,
          input.companyDomain,
          input.companyName,
        );
      }

      await tx
        .update(contacts)
        .set(patch)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, auth.workspaceId)));
      return toDto(await this.load(tx, auth, id));
    });
  }

  async remove(auth: AuthContext, id: string, suppress: boolean): Promise<void> {
    // Adding to the suppression list is owner/admin only, however it's done.
    if (suppress && auth.role !== "owner" && auth.role !== "admin") {
      throw forbidden("Only owners and admins can add to the suppression list");
    }
    await this.scope(auth, async (tx) => {
      const [deleted] = await tx
        .delete(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, auth.workspaceId)))
        .returning({ id: contacts.id, email: contacts.email });
      if (!deleted) throw notFound("Contact");
      if (suppress) {
        await tx
          .insert(suppressions)
          .values({
            workspaceId: auth.workspaceId,
            value: deleted.email,
            reason: "other",
            createdBy: auth.userId,
          })
          .onConflictDoNothing({ target: [suppressions.workspaceId, suppressions.value] });
      }
      // Ids only: the email is personal data and the contact is being erased.
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "contact.deleted",
        entity: "contact",
        entityId: id,
        metadata: { suppressed: suppress },
      });
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(tx: Tx, auth: AuthContext, id: string): Promise<ContactRow> {
    const [row] = await selectContacts(tx, auth.workspaceId)
      .where(and(eq(contacts.id, id), eq(contacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row) throw notFound("Contact");
    return row;
  }

  private async findByEmail(tx: Tx, workspaceId: string, email: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email.toLowerCase())))
      .limit(1);
    return row?.id ?? null;
  }
}

/**
 * Consent is legal evidence (Compliance Copilot relies on it): reps can't assert it, and every
 * change is audited.
 */
function assertCanSetConsent(auth: AuthContext, basis: string | undefined): void {
  if (basis !== undefined && basis !== "none" && auth.role === "rep") {
    throw forbidden("Only owners, admins and managers can record consent");
  }
}
