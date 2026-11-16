import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { DatabaseHandle } from "@openline/db";
import {
  createReplySync,
  createScoutReplyClassifier,
  type ReplyClassifier,
  type ReplySync,
} from "@openline/replies";
import { createSequencer, type Sequencer } from "@openline/sequencer";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";
import { ScoutModelService } from "../scout/scout-model.service";
import { PromiseKeeperService } from "../promises/promise-keeper.service";

export const POLL_INTERVAL_MS = 15_000;

/**
 * Optional provider overriding the reply classifier (tests). Otherwise: Scout's model when
 * AI_PROVIDER is configured (gated per workspace by scout_enabled and the monthly budget), else
 * the deterministic keyword fallback (labels shown as "(rule)").
 */
export const REPLY_CLASSIFIER = Symbol("REPLY_CLASSIFIER");

/**
 * Runs the sending engine and reply sync inside the API process when RUN_SCHEDULER=true (needed
 * with on-disk PGlite, which only one process can open). Off unless RUN_SCHEDULER=true is set
 * explicitly (the e2e journeys set it); unit tests call `runOnce()` / `syncMailbox()` directly.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger("Scheduler");
  readonly sequencer: Sequencer;
  readonly replySync: ReplySync;
  private started = false;

  constructor(
    @Inject(DB) handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(REPLY_CLASSIFIER) override?: ReplyClassifier,
    @Optional() model?: ScoutModelService,
    @Optional() promises?: PromiseKeeperService,
  ) {
    const classifier =
      override ??
      (model?.provider
        ? createScoutReplyClassifier({
            db: handle.db,
            provider: model.provider,
            dailyCapPerMailbox: config.REPLY_CLASSIFY_DAILY_CAP,
          })
        : undefined);
    const logger = {
      warn: (m: string) => this.logger.warn(m),
      error: (m: string) => this.logger.error(m),
    };
    this.sequencer = createSequencer({
      db: handle.db,
      secretsKey: config.secretsKey,
      unsubscribeSecret: config.UNSUBSCRIBE_SECRET,
      webUrl: config.WEB_URL,
      google: config.google,
      outreach: config.outreach,
      allowPrivateSmtpHosts: config.allowPrivateSmtpHosts,
      logger,
    });
    this.replySync = createReplySync({
      db: handle.db,
      secretsKey: config.secretsKey,
      google: config.google,
      classifier,
      promiseKeeper: promises?.keeper,
      allowPrivateHosts: config.allowPrivateSmtpHosts,
      intervalMs: config.REPLY_SYNC_INTERVAL_MS,
      logger,
    });
  }

  onModuleInit(): void {
    if (!this.config.RUN_SCHEDULER) return;
    this.sequencer.start(POLL_INTERVAL_MS);
    this.replySync.start(POLL_INTERVAL_MS);
    this.started = true;
    this.logger.log(
      `Sending engine and reply sync running in-process (${this.config.outreach.mode}, replies every ${this.config.REPLY_SYNC_INTERVAL_MS} ms)`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.started) await Promise.all([this.sequencer.stop(), this.replySync.stop()]);
  }
}
