import { createProvider } from "@openline/ai";
import { createCrmSync } from "@openline/crm";
import {
  and,
  createDatabase,
  eq,
  inArray,
  users,
  withTenant,
  workspaceMembers,
} from "@openline/db";
import { newMessageId, SmtpAdapter } from "@openline/email";
import { CRM_PROVIDER_LABELS } from "@openline/shared";
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

  // CRM sync (OL-E8): polling per connection, its own loop and lease (claim_due_crm_syncs).
  const mailer = config.smtpUrl ? SmtpAdapter.fromUrl(config.smtpUrl) : null;
  const fromEmail = /<([^>]+)>/.exec(config.mailFrom)?.[1] ?? config.mailFrom;
  const crm = createCrmSync({
    db: handle.db,
    secretsKey: config.secretsKey,
    config: config.crm,
    notifyReconnect: async ({ workspaceId, provider: crmProvider }) => {
      if (!mailer) return;
      const admins = await withTenant(handle.db, { workspaceId }, (tx) =>
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
      const label = CRM_PROVIDER_LABELS[crmProvider];
      const url = `${config.webUrl.replace(/\/$/, "")}/app/settings/integrations`;
      for (const a of admins) {
        await mailer.send({
          from: { email: fromEmail, name: "Openline" },
          to: a.email,
          subject: `Reconnect ${label} to keep Openline in sync`,
          text: `Hello,\n\nOpenline can no longer reach your ${label} account: access was revoked or expired. Sync is stopped until an admin reconnects it. Nothing was deleted on either side.\n\nReconnect ${label}: ${url}\n\n— Openline\n`,
          html: `<p>Openline can no longer reach your ${label} account: access was revoked or expired. Sync is stopped until an admin reconnects it.</p><p><a href="${url}">Reconnect ${label}</a></p>`,
          headers: { "Auto-Submitted": "auto-generated" },
          messageId: newMessageId(fromEmail),
        });
      }
    },
  });

  sequencer.start(config.pollIntervalMs);
  replySync.start(config.pollIntervalMs);
  reality.start();
  crm.start(config.pollIntervalMs);
  console.log(
    `Openline worker started (${config.appEnv}, outreach: ${config.outreach.mode}, every ${config.pollIntervalMs} ms; replies every ${config.replySyncIntervalMs} ms, classifier: ${provider ? config.ai.provider : "keywords"}, crm: ${config.crm.mode})`,
  );

  const shutdown = async () => {
    await Promise.all([sequencer.stop(), replySync.stop(), reality.stop(), crm.stop()]);
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
