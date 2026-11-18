import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { createCrmSync, type CrmSync } from "@openline/crm";
import {
  and,
  eq,
  inArray,
  users,
  withTenant,
  workspaceMembers,
  type DatabaseHandle,
} from "@openline/db";
import { CRM_PROVIDER_LABELS, type CrmProvider } from "@openline/shared";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { TransactionalMailService } from "../mail/transactional-mail.service";

/**
 * Runs the CRM sync engine in the API process when RUN_SCHEDULER=true (PGlite, ADR 0004), beside
 * the sending engine. Its own loop and lease: it never blocks sending, reply sync or Reality Check.
 * Unit tests drive `engine.syncConnection()` directly.
 */
@Injectable()
export class CrmSchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger("CrmSync");
  readonly engine: CrmSync;
  private started = false;

  constructor(
    @Inject(DB) private readonly handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly mail: TransactionalMailService,
  ) {
    this.engine = createCrmSync({
      db: handle.db,
      secretsKey: config.secretsKey,
      config: config.crm,
      logger: { warn: (m) => this.logger.warn(m), error: (m) => this.logger.error(m) },
      notifyReconnect: (p) => this.notifyReconnect(p.workspaceId, p.provider),
    });
  }

  /** One email to the workspace's owners and admins. */
  async notifyReconnect(workspaceId: string, provider: CrmProvider): Promise<void> {
    const admins = await withTenant(this.handle.db, { workspaceId }, (tx) =>
      tx
        .select({ email: users.email })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            inArray(workspaceMembers.role, ["owner", "admin"]),
          ),
        ),
    );
    const url = `${this.config.WEB_URL.replace(/\/$/, "")}/app/settings/integrations`;
    for (const a of admins)
      await this.mail.sendCrmReconnect(a.email, CRM_PROVIDER_LABELS[provider], url);
  }

  onModuleInit(): void {
    if (!this.config.RUN_SCHEDULER) return;
    this.engine.start(15_000);
    this.started = true;
    this.logger.log(`CRM sync running in-process (${this.config.crm.mode})`);
  }

  /** Runs a pass soon (preview, import, Sync now) when the loop is running. */
  kick(): void {
    if (this.started) this.engine.kick();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.started) await this.engine.stop();
  }
}
