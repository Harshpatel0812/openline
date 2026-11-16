import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from "@nestjs/common";
import type { DatabaseHandle } from "@openline/db";
import { createPromiseKeeper, type PromiseKeeper } from "@openline/replies";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { ScoutModelService } from "../scout/scout-model.service";

/**
 * The background Promise Keeper (packages/replies) for this process: reply sync tells it about
 * stored human replies, the inbox about sent replies. Scout's model when AI_PROVIDER is set
 * (gated per workspace), else the rule-based extractor.
 */
@Injectable()
export class PromiseKeeperService implements OnApplicationShutdown {
  private readonly logger = new Logger("PromiseKeeper");
  readonly keeper: PromiseKeeper;

  constructor(
    @Inject(DB) handle: DatabaseHandle,
    @Inject(CONFIG) config: AppConfig,
    @Optional() model?: ScoutModelService,
  ) {
    this.keeper = createPromiseKeeper({
      db: handle.db,
      provider: model?.provider ?? null,
      dailyCapPerMailbox: config.REPLY_CLASSIFY_DAILY_CAP,
      logger: {
        warn: (m: string) => this.logger.warn(m),
        error: (m: string) => this.logger.error(m),
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.keeper.idle();
  }
}
