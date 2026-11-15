import { Inject, Injectable } from "@nestjs/common";
import { normalizeDomain, researchWebsite, type ResearchResult, type WebPage } from "@openline/ai";
import { and, eq, websiteCache, withTenant, type DatabaseHandle } from "@openline/db";
import type { AuthContext } from "../../common/auth-context";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";

export const WEBSITE_CACHE_DAYS = 7;

/**
 * The domain to research. Companies already get their domain from the contact's email unless it
 * is free-mail (see companyDomainFor), so the company domain is the only input.
 */
export function researchDomain(companyDomain: string | null): string | null {
  return companyDomain ? normalizeDomain(companyDomain) : null;
}

export interface ResearchOutcome {
  pages: WebPage[];
  research: "fetched" | "cached" | "failed";
}

/**
 * Company website research with a 7-day cache per (workspace, domain). Failed fetches are cached
 * too, so a broken site isn't retried on every draft. The network fetch runs outside any
 * database transaction.
 */
@Injectable()
export class ResearchService {
  /** Replaced in tests (no network). */
  fetchSite: (domain: string) => Promise<ResearchResult>;

  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.fetchSite = (domain) =>
      researchWebsite(domain, { allowPrivate: config.ai.allowPrivateResearchHosts });
  }

  async research(auth: AuthContext, domain: string, now = new Date()): Promise<ResearchOutcome> {
    const scope = { workspaceId: auth.workspaceId, userId: auth.userId };
    const [cached] = await withTenant(this.handle.db, scope, (tx) =>
      tx
        .select()
        .from(websiteCache)
        .where(and(eq(websiteCache.workspaceId, auth.workspaceId), eq(websiteCache.domain, domain)))
        .limit(1),
    );
    const fresh =
      cached && now.getTime() - cached.fetchedAt.getTime() < WEBSITE_CACHE_DAYS * 86_400_000;
    if (cached && fresh) {
      return { pages: cached.ok ? cached.pages : [], research: cached.ok ? "cached" : "failed" };
    }

    let result: ResearchResult;
    try {
      result = await this.fetchSite(domain);
    } catch {
      result = { pages: [], failed: true };
    }
    const pages = result.pages.slice(0, 3);
    await withTenant(this.handle.db, scope, (tx) =>
      tx
        .insert(websiteCache)
        .values({
          workspaceId: auth.workspaceId,
          domain,
          pages,
          ok: !result.failed,
          fetchedAt: now,
        })
        .onConflictDoUpdate({
          target: [websiteCache.workspaceId, websiteCache.domain],
          set: { pages, ok: !result.failed, fetchedAt: now },
        }),
    );
    return { pages: result.failed ? [] : pages, research: result.failed ? "failed" : "fetched" };
  }
}
