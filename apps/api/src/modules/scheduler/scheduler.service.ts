import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { DatabaseHandle } from "@openline/db";
import { createSequencer, type Sequencer } from "@openline/sequencer";
import { CONFIG, type AppConfig } from "../../config";
import { DB } from "../../database/database.module";

export const POLL_INTERVAL_MS = 15_000;

/**
 * Runs the sending engine inside the API process when RUN_SCHEDULER=true (needed with on-disk
 * PGlite, which only one process can open). Off unless RUN_SCHEDULER=true is set explicitly (the
 * e2e journeys set it); unit tests call `sequencer.runOnce()` directly.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger("Scheduler");
  readonly sequencer: Sequencer;
  private started = false;

  constructor(
    @Inject(DB) handle: DatabaseHandle,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.sequencer = createSequencer({
      db: handle.db,
      secretsKey: config.secretsKey,
      unsubscribeSecret: config.UNSUBSCRIBE_SECRET,
      webUrl: config.WEB_URL,
      google: config.google,
      outreach: config.outreach,
      allowPrivateSmtpHosts: config.allowPrivateSmtpHosts,
      logger: {
        warn: (m: string) => this.logger.warn(m),
        error: (m: string) => this.logger.error(m),
      },
    });
  }

  onModuleInit(): void {
    if (!this.config.RUN_SCHEDULER) return;
    this.sequencer.start(POLL_INTERVAL_MS);
    this.started = true;
    this.logger.log(`Sending engine running in-process (${this.config.outreach.mode})`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.started) await this.sequencer.stop();
  }
}
