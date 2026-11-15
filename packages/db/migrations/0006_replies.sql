-- 0006_replies: reply detection (OL-E4 §1–3). Additive only (expand): mailboxes gain IMAP settings
-- and a sync cursor; messages gain the fields of an inbound reply. No new tables, so the existing
-- tenant_isolation policies on mailboxes and messages keep covering every new column.

-- ---------------------------------------------------------------- mailboxes: reply detection

ALTER TABLE mailboxes
  -- IMAP for SMTP mailboxes. The IMAP login (username + password) lives in the sealed secret.
  ADD COLUMN imap_host         text,
  ADD COLUMN imap_port         integer CHECK (imap_port IN (993, 143)),
  -- true = TLS from the start (993); false = STARTTLS required (143).
  ADD COLUMN imap_secure       boolean,
  -- off = not set up; on = synced every REPLY_SYNC_INTERVAL_MS; error = needs the user (login
  -- rejected, Google access revoked). Transient failures stay 'on' with last_sync_error set.
  ADD COLUMN reply_detection   text NOT NULL DEFAULT 'off'
                               CHECK (reply_detection IN ('off', 'on', 'error')),
  -- Sync cursor: IMAP UIDVALIDITY + highest UID seen, or the Gmail history id.
  ADD COLUMN sync_uidvalidity  bigint,
  ADD COLUMN sync_last_uid     bigint,
  ADD COLUMN sync_history_id   text,
  ADD COLUMN last_synced_at    timestamptz,
  ADD COLUMN last_sync_error   text,
  ADD COLUMN next_sync_at      timestamptz,
  ADD COLUMN sync_locked_until timestamptz;

CREATE INDEX mailboxes_sync_due_idx ON mailboxes(next_sync_at) WHERE reply_detection = 'on';

-- ---------------------------------------------------------------- messages: inbound replies

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('sending', 'sent', 'unconfirmed', 'received'));

ALTER TABLE messages
  ADD COLUMN from_email         text,
  ADD COLUMN from_name          text,
  ADD COLUMN in_reply_to        text,
  ADD COLUMN references_header  text CHECK (char_length(references_header) <= 4000),
  -- Plain text only (HTML converted), quoted history trimmed, at most 20,000 characters.
  ADD COLUMN body_text          text CHECK (char_length(body_text) <= 20000),
  ADD COLUMN received_at        timestamptz,
  ADD COLUMN provider_thread_id text,
  -- How the reply was tied to our outreach: thread headers, sender address, or sender's company.
  ADD COLUMN match_kind         text CHECK (match_kind IN ('thread', 'sender', 'colleague')),
  -- Inbound: the outbound message it answers. Outbound (inbox reply): the inbound it answers.
  ADD COLUMN reply_to_id        uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN label              text CHECK (label IN ('interested', 'not_now', 'referral',
                                  'not_interested', 'unsubscribe', 'out_of_office', 'bounce', 'other')),
  ADD COLUMN label_source       text CHECK (label_source IN ('rule', 'model', 'user')),
  ADD COLUMN label_confidence   real CHECK (label_confidence BETWEEN 0 AND 1),
  ADD COLUMN summary            text CHECK (char_length(summary) <= 140),
  -- { "name"?: string, "email"?: string } when the reply points to someone else.
  ADD COLUMN referral           jsonb,
  ADD COLUMN handled_at         timestamptz;

-- Idempotency: one row per (mailbox, Message-ID) for inbound mail, however often it is read.
CREATE UNIQUE INDEX messages_inbound_mailbox_msgid_uidx
  ON messages (mailbox_id, message_id_header) WHERE direction = 'inbound';
-- Matching In-Reply-To / References against what we sent.
CREATE INDEX messages_msgid_idx ON messages (workspace_id, message_id_header);
-- The inbox: newest first, keyset-paginated.
CREATE INDEX messages_inbox_idx
  ON messages (workspace_id, received_at DESC, id DESC) WHERE direction = 'inbound';
CREATE INDEX messages_enrollment_idx ON messages (enrollment_id, direction, sent_at DESC);

-- Deleting a contact deletes the replies we stored from them (outbound rows keep SET NULL for the
-- cap and bounce history). Runs as the caller, so row-level security still applies.
CREATE OR REPLACE FUNCTION delete_inbound_messages_of_contact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM messages
   WHERE contact_id = OLD.id AND workspace_id = OLD.workspace_id AND direction = 'inbound';
  RETURN OLD;
END
$$;

CREATE TRIGGER contacts_delete_inbound_messages
  BEFORE DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION delete_inbound_messages_of_contact();

-- ---------------------------------------------------------------- sync scheduler entry point

-- Same pattern as claim_due_enrollments (0004/0005): the one cross-tenant path for reply sync,
-- owned by openline_scheduler (NOLOGIN, no BYPASSRLS), returning ids only and leasing each mailbox
-- for 5 minutes. The role gets column-level rights only: it can never read credentials or
-- settings, just enough to find due mailboxes and set the lease.
GRANT SELECT (id, workspace_id, status, reply_detection, next_sync_at, sync_locked_until),
      UPDATE (sync_locked_until)
   ON mailboxes TO openline_scheduler;

DROP POLICY IF EXISTS mailboxes_scheduler_select ON mailboxes;
DROP POLICY IF EXISTS mailboxes_scheduler_update ON mailboxes;
CREATE POLICY mailboxes_scheduler_select ON mailboxes
  FOR SELECT TO openline_scheduler USING (true);
CREATE POLICY mailboxes_scheduler_update ON mailboxes
  FOR UPDATE TO openline_scheduler USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION claim_due_mailbox_syncs(batch integer)
RETURNS TABLE (workspace_id uuid, mailbox_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE mailboxes m
     SET sync_locked_until = now() + interval '5 minutes'
   WHERE m.id IN (
     SELECT id FROM mailboxes
      WHERE reply_detection = 'on'
        AND status <> 'disconnected'
        AND (next_sync_at IS NULL OR next_sync_at <= now())
        AND (sync_locked_until IS NULL OR sync_locked_until < now())
      ORDER BY next_sync_at NULLS FIRST
      LIMIT least(greatest(batch, 1), 500)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING m.workspace_id, m.id;
$$;

ALTER FUNCTION claim_due_mailbox_syncs(integer) OWNER TO openline_scheduler;
REVOKE ALL ON FUNCTION claim_due_mailbox_syncs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_mailbox_syncs(integer) TO openline_app;
