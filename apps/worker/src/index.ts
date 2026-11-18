import { createProvider } from "@openline/ai";
import { createDatabase } from "@openline/db";
import {
  createPromiseKeeper,
  createRealityChecker,
  createReplySync,
  createScoutReplyClassifier,
} from "@openline/replies";
import { createSequencer } from "@openline/sequencer";
import { loadWorkerConfig } from "./config";

/**
 * Production worker. Runs the sequence engine, reply sync and the daily Reality Check against
 * Postgres; any number of copies can run side by side (claim_due_enrollments /
 * claim_due_mailbox_syncs / claim_due_reality_checks lease each enrollment, mailbox and deal to
 * exactly one worker).
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const handle = createDatabase(config.databaseUrl);
  const sequencer = createSequencer({
    db: handle.db,
    secretsKey: config.secretsKey,
    unsubscribeSecret: config.unsubscribeSecret,
    webUrl: config.webUrl,
    google: config.google,
    outreach: config.outreach,
    allowPrivateSmtpHosts: config.allowPrivateSmtpHosts,
  });

  const provider = createProvider(config.ai);
  // Promise Keeper: proposals from stored human replies, in the background (rules without a model).
  const promiseKeeper = createPromiseKeeper({
    db: handle.db,
    provider,
    dailyCapPerMailbox: config.replyClassifyDailyCap,
  });
  const replySync = createReplySync({
    db: handle.db,
    secretsKey: config.secretsKey,
    google: config.google,
    // Scout's model when configured (per-workspace on/off + budget), else the keyword fallback.
    classifier: provider
      ? createScoutReplyClassifier({
          db: handle.db,
          provider,
          dailyCapPerMailbox: config.replyClassifyDailyCap,
        })
      : undefined,
    promiseKeeper,
    allowPrivateHosts: config.allowPrivateSmtpHosts,
    intervalMs: config.replySyncIntervalMs,
  });

  // Pipeline Reality Check: at most once a day per open deal with new activity, within the
  // workspace's Scout budget (deterministic flags only otherwise). Its own loop and lease.
  const reality = createRealityChecker({ db: handle.db, provider });

  sequencer.start(config.pollIntervalMs);
  replySync.start(config.pollIntervalMs);
  reality.start();
  console.log(
    `Openline worker started (${config.appEnv}, outreach: ${config.outreach.mode}, every ${config.pollIntervalMs} ms; replies every ${config.replySyncIntervalMs} ms, classifier: ${provider ? config.ai.provider : "keywords"})`,
  );

  const shutdown = async () => {
    await Promise.all([sequencer.stop(), replySync.stop(), reality.stop()]);
    await promiseKeeper.idle();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
