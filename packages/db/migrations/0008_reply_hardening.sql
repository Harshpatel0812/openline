-- 0008_reply_hardening: Sprint 4 review fixes (OL-E4). Additive only; the existing tenant_isolation
-- policies on messages and ai_usage cover the new columns.
--
-- messages.auto_submitted  the inbound message was machine-generated (Auto-Submitted other than
--                          "no", a bounce report, or a daemon/postmaster sender): never replied to.
-- ai_usage.mailbox_id      which mailbox a reply classification was for, so the per-mailbox daily
--                          classification cap (REPLY_CLASSIFY_DAILY_CAP) can be counted.

ALTER TABLE messages
  ADD COLUMN auto_submitted boolean NOT NULL DEFAULT false;

ALTER TABLE ai_usage
  ADD COLUMN mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL;

CREATE INDEX ai_usage_mailbox_feature_idx
  ON ai_usage (mailbox_id, feature, created_at) WHERE mailbox_id IS NOT NULL;
