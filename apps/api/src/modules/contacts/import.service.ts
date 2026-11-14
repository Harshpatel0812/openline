import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, contacts, eq, inArray, withTenant, type DatabaseHandle, type Tx } from "@openline/db";
import {
  ContactCreateSchema,
  IMPORT_MAX_ROWS,
  type ContactCreate,
  type ImportField,
  type ImportPreviewDto,
  type ImportResultDto,
} from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { ApiException } from "../../common/http";
import { DB } from "../../database/database.module";
import { AuditService } from "../audit/audit.service";
import { CompaniesService, companyDomainFor } from "../companies/companies.service";
import { isValidTimeZone } from "./contacts.service";
import { mapHeaders, normalizeDomain, parseCsv, type Delimiter } from "./csv";

const LOOKUP_CHUNK = 1000;
const INSERT_BATCH = 500;
const INVALID_LIMIT = 100;
const SAMPLE_SIZE = 5;

const FIELD_LABELS: Record<string, string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  title: "Title",
  phone: "Phone",
  timeZone: "Time zone",
  country: "Country",
  companyDomain: "Company domain",
  companyName: "Company name",
};

interface ReadRow {
  /** 1-based data row number (header excluded). */
  row: number;
  input: ContactCreate;
}

interface ValidRow extends ReadRow {
  existingId: string | null;
}

export interface ReadResult {
  delimiter: Delimiter;
  mapping: Record<string, ImportField | null>;
  totalRows: number;
  /** Valid rows, first occurrence of each email only. */
  valid: ReadRow[];
  /** Every invalid row (including in-file duplicates). */
  invalid: { row: number; reason: string }[];
}

/** Parses and validates a CSV. Throws 400 for a missing email column or too many rows. */
export function readRows(csv: string): ReadResult {
  const { delimiter, header, rows } = parseCsv(csv);
  const fields = mapHeaders(header);
  if (!fields.includes("email")) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      "missing_email_column",
      "We couldn't find an email column. Name a column 'Email' and try again.",
    );
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      "too_many_rows",
      `This file has ${rows.length.toLocaleString("en-US")} rows. The limit is ${IMPORT_MAX_ROWS.toLocaleString("en-US")} — split it and import the parts.`,
      { rows: rows.length, limit: IMPORT_MAX_ROWS },
    );
  }

  const mapping: Record<string, ImportField | null> = {};
  header.forEach((h, i) => {
    if (h !== "" && !(h in mapping)) mapping[h] = fields[i] ?? null;
  });

  const valid: ReadRow[] = [];
  const invalid: { row: number; reason: string }[] = [];
  const firstRowByEmail = new Map<string, number>();

  rows.forEach((cells, index) => {
    const row = index + 1;
    const raw: Partial<Record<ImportField, string>> = {};
    fields.forEach((field, i) => {
      const value = cells[i];
      if (!field || !value) return;
      raw[field] = field === "companyDomain" ? normalizeDomain(value) : value;
    });
    if (!raw.email) {
      invalid.push({ row, reason: "Missing email" });
      return;
    }
    const parsed = ContactCreateSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const label = FIELD_LABELS[String(issue.path[0])] ?? "Value";
      invalid.push({ row, reason: `${label}: ${issue.message}` });
      return;
    }
    if (parsed.data.timeZone && !isValidTimeZone(parsed.data.timeZone)) {
      invalid.push({ row, reason: "Time zone: Use an IANA time zone like America/New_York" });
      return;
    }
    const first = firstRowByEmail.get(parsed.data.email);
    if (first !== undefined) {
      invalid.push({ row, reason: `Duplicate of row ${first}` });
      return;
    }
    firstRowByEmail.set(parsed.data.email, row);
    valid.push({ row, input: parsed.data });
  });

  return { delimiter, mapping, totalRows: rows.length, valid, invalid };
}

@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly companies: CompaniesService,
  ) {}

  private scope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, { workspaceId: auth.workspaceId, userId: auth.userId }, fn);
  }

  /** What an import would do. Nothing is written. */
  async preview(auth: AuthContext, csv: string): Promise<ImportPreviewDto> {
    const read = readRows(csv);
    const valid = await this.scope(auth, (tx) => this.withExisting(tx, auth, read.valid));
    const duplicateCount = valid.filter((v) => v.existingId).length;
    return {
      totalRows: read.totalRows,
      newCount: valid.length - duplicateCount,
      duplicateCount,
      invalidCount: read.invalid.length,
      invalid: read.invalid.slice(0, INVALID_LIMIT),
      mapping: read.mapping,
      delimiter: read.delimiter,
      sample: valid.slice(0, SAMPLE_SIZE).map((v) => v.input),
    };
  }

  /** Saves the import in one transaction: all valid rows or none. */
  async commit(
    auth: AuthContext,
    csv: string,
    duplicates: "skip" | "update",
  ): Promise<ImportResultDto> {
    const read = readRows(csv);
    return this.scope(auth, async (tx) => {
      // Re-checked inside the transaction so concurrent changes are respected.
      const rows = await this.withExisting(tx, auth, read.valid);
      const fresh = rows.filter((r) => !r.existingId);
      const dupes = rows.filter((r) => r.existingId);

      const companyNames = new Map<string, string | null | undefined>();
      for (const r of duplicates === "update" ? rows : fresh) {
        // On update, only an explicit company domain re-links the company.
        if (r.existingId && !r.input.companyDomain) continue;
        const domain = companyDomainFor(r.input.email, r.input.companyDomain);
        if (domain && !companyNames.get(domain)) companyNames.set(domain, r.input.companyName);
      }
      const companyIds = await this.companies.resolve(tx, auth.workspaceId, companyNames);
      const companyOf = (input: ContactCreate) => {
        const domain = companyDomainFor(input.email, input.companyDomain);
        return domain ? (companyIds.get(domain) ?? null) : null;
      };

      let created = 0;
      let skipped = 0;
      for (let i = 0; i < fresh.length; i += INSERT_BATCH) {
        const batch = fresh.slice(i, i + INSERT_BATCH);
        const inserted = await tx
          .insert(contacts)
          .values(
            batch.map(({ input }) => ({
              workspaceId: auth.workspaceId,
              ownerId: auth.userId,
              companyId: companyOf(input),
              email: input.email,
              firstName: input.firstName ?? null,
              lastName: input.lastName ?? null,
              title: input.title ?? null,
              phone: input.phone ?? null,
              timeZone: input.timeZone ?? null,
              country: input.country ?? null,
            })),
          )
          .onConflictDoNothing({ target: [contacts.workspaceId, contacts.email] })
          .returning({ id: contacts.id });
        created += inserted.length;
        skipped += batch.length - inserted.length;
      }

      let updated = 0;
      if (duplicates === "skip") {
        skipped += dupes.length;
      } else {
        for (const { input, existingId } of dupes) {
          // Only non-empty cells overwrite; a blank cell never erases data; email never changes.
          const patch: Partial<typeof contacts.$inferInsert> = {};
          if (input.firstName) patch.firstName = input.firstName;
          if (input.lastName) patch.lastName = input.lastName;
          if (input.title) patch.title = input.title;
          if (input.phone) patch.phone = input.phone;
          if (input.timeZone) patch.timeZone = input.timeZone;
          if (input.country) patch.country = input.country;
          if (input.companyDomain) {
            const companyId = companyOf(input);
            if (companyId) patch.companyId = companyId;
          }
          if (Object.keys(patch).length === 0) {
            skipped += 1;
            continue;
          }
          await tx
            .update(contacts)
            .set({ ...patch, updatedAt: new Date() })
            .where(and(eq(contacts.id, existingId!), eq(contacts.workspaceId, auth.workspaceId)));
          updated += 1;
        }
      }

      const result = { created, updated, skipped, invalid: read.invalid.length };
      // Counts only: no personal data in the audit log metadata.
      await this.audit.record(tx, {
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: "contacts.imported",
        entity: "contact",
        metadata: {
          ...result,
          totalRows: read.totalRows,
          duplicates,
          lawfulBasisConfirmed: true,
        },
      });
      return result;
    });
  }

  /** Marks rows whose email already belongs to a contact in this workspace. */
  private async withExisting(tx: Tx, auth: AuthContext, rows: ReadRow[]): Promise<ValidRow[]> {
    const existing = new Map<string, string>();
    const emails = rows.map((r) => r.input.email);
    for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
      const found = await tx
        .select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, auth.workspaceId),
            inArray(contacts.email, emails.slice(i, i + LOOKUP_CHUNK)),
          ),
        );
      for (const f of found) existing.set(f.email, f.id);
    }
    return rows.map((r) => ({ ...r, existingId: existing.get(r.input.email) ?? null }));
  }
}
