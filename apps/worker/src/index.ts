import { createDatabase } from "@openline/db";
import { createSequencer } from "@openline/sequencer";
import { loadWorkerConfig } from "./config";

/**
 * Production sending worker. Runs the sequence engine against Postgres; any number of copies can
 * run side by side (claim_due_enrollments leases each enrollment to exactly one worker).
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

  sequencer.start(config.pollIntervalMs);
  console.log(
    `Openline worker started (${config.appEnv}, outreach: ${config.outreach.mode}, every ${config.pollIntervalMs} ms)`,
  );

  const shutdown = async () => {
    await sequencer.stop();
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
