import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  companies,
  contacts,
  eq,
  ilike,
  inArray,
  or,
  sql,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from "@openline/db";
import { FREE_MAIL_DOMAINS, type CompanyDto } from "@openline/shared";
import type { AuthContext } from "../../common/auth-context";
import { DB } from "../../database/database.module";

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);
const CHUNK = 1000;

/** Escapes LIKE wildcards so `%` and `_` in a search match literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The company domain for a contact: the explicit domain if given, else the email's domain.
 * Free-mail domains (gmail.com, ...) never become companies.
 */
export function companyDomainFor(email: string, explicit?: string | null): string | null {
  const domain = (explicit ?? email.split("@")[1] ?? "").toLowerCase();
  if (!DOMAIN_RE.test(domain) || FREE_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** "acme-tools.com" → "Acme Tools", "shop.example.co.uk" → "Example". */
export function companyNameFromDomain(domain: string): string {
  const labels = domain.split(".");
  const n = labels.length;
  const suffix = n > 2 && labels[n - 1]!.length === 2 && SECOND_LEVEL.has(labels[n - 2]!) ? 2 : 1;
  const label = labels[n - suffix - 1] ?? domain;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

@Injectable()
export class CompaniesService {
  constructor(@Inject(DB) private readonly handle: DatabaseHandle) {}

  list(auth: AuthContext, q?: string): Promise<{ items: CompanyDto[] }> {
    return withTenant(
      this.handle.db,
      { workspaceId: auth.workspaceId, userId: auth.userId },
      async (tx) => {
        const search = q
          ? or(ilike(companies.name, likePattern(q)), ilike(companies.domain, likePattern(q)))
          : undefined;
        const rows = await tx
          .select({
            id: companies.id,
            name: companies.name,
            domain: companies.domain,
            createdAt: companies.createdAt,
            contactCount: sql<number>`count(${contacts.id})::int`,
          })
          .from(companies)
          .leftJoin(
            contacts,
            and(eq(contacts.companyId, companies.id), eq(contacts.workspaceId, auth.workspaceId)),
          )
          .where(and(eq(companies.workspaceId, auth.workspaceId), search))
          .groupBy(companies.id)
          .orderBy(asc(companies.name), asc(companies.id))
          .limit(200);
        return {
          items: rows.map((r) => ({
            ...r,
            contactCount: Number(r.contactCount),
            createdAt: r.createdAt.toISOString(),
          })),
        };
      },
    );
  }

  /**
   * Finds or creates one company per domain and returns domain → company id.
   * `names` gives the name to use when a company is created (default: readable domain).
   * Safe against concurrent creators thanks to ON CONFLICT (workspace_id, domain).
   */
  async resolve(
    tx: Tx,
    workspaceId: string,
    names: Map<string, string | null | undefined>,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const domains = [...names.keys()];
    const lookup = async (list: string[]) => {
      for (let i = 0; i < list.length; i += CHUNK) {
        const rows = await tx
          .select({ id: companies.id, domain: companies.domain })
          .from(companies)
          .where(
            and(
              eq(companies.workspaceId, workspaceId),
              inArray(companies.domain, list.slice(i, i + CHUNK)),
            ),
          );
        for (const r of rows) if (r.domain) result.set(r.domain, r.id);
      }
    };

    await lookup(domains);
    const missing = domains.filter((d) => !result.has(d));
    for (let i = 0; i < missing.length; i += 500) {
      const values = missing.slice(i, i + 500).map((domain) => ({
        workspaceId,
        domain,
        name: names.get(domain) || companyNameFromDomain(domain),
      }));
      const inserted = await tx
        .insert(companies)
        .values(values)
        .onConflictDoNothing({ target: [companies.workspaceId, companies.domain] })
        .returning({ id: companies.id, domain: companies.domain });
      for (const r of inserted) if (r.domain) result.set(r.domain, r.id);
    }
    // Anything created concurrently by another transaction.
    const stillMissing = domains.filter((d) => !result.has(d));
    if (stillMissing.length) await lookup(stillMissing);
    return result;
  }

  /** Single-contact convenience: the company id for this email/domain, or null. */
  async resolveFor(
    tx: Tx,
    workspaceId: string,
    email: string,
    companyDomain?: string | null,
    companyName?: string | null,
  ): Promise<string | null> {
    const domain = companyDomainFor(email, companyDomain);
    if (!domain) return null;
    const ids = await this.resolve(tx, workspaceId, new Map([[domain, companyName]]));
    return ids.get(domain) ?? null;
  }
}
