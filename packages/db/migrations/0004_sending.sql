-- 0004_sending: mailboxes, sequences, enrollments, sent messages, email tokens, workspace
-- sending settings. Same tenancy model as 0001: workspace_id + RLS on every tenant table.

-- ---------------------------------------------------------------- workspace settings

-- CAN-SPAM requires a valid physical postal address in every commercial email.
ALTER TABLE workspaces ADD COLUMN mailing_address text;
ALTER TABLE workspaces ADD COLUMN default_time_zone text NOT NULL DEFAULT 'America/New_York';

-- ---------------------------------------------------------------- email tokens (global)

-- Email verification and password reset. Only the SHA-256 of the token is stored.
CREATE TABLE email_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens(user_id, kind);
GRANT SELECT, INSERT, UPDATE, DELETE ON email_tokens TO openline_app;

-- ---------------------------------------------------------------- mailboxes

CREATE TABLE mailboxes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('smtp', 'gmail', 'graph')),
  email         text NOT NULL CHECK (email = lower(email)),
  display_name  text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error', 'disconnected')),
  daily_cap     integer NOT NULL DEFAULT 50 CHECK (daily_cap BETWEEN 1 AND 500),
  smtp_host     text,
  smtp_port     integer,
  smtp_secure   boolean,
  -- Sealed (AES-256-GCM) JSON: SMTP username/password or OAuth refresh token. Never returned by the API.
  secret_sealed text NOT NULL,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

-- ---------------------------------------------------------------- sequences

CREATE TABLE sequences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  -- { "days": [1..7], "startHour": 9, "endHour": 18 }
  send_window  jsonb NOT NULL DEFAULT '{"days":[1,2,3,4,5],"startHour":9,"endHour":18}'::jsonb,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id         uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position            integer NOT NULL CHECK (position >= 1),
  -- Days to wait after the previous step (0 for the first step = send at the next allowed slot).
  delay_days          integer NOT NULL DEFAULT 0 CHECK (delay_days BETWEEN 0 AND 60),
  subject             text NOT NULL,
  body                text NOT NULL,
  -- Follow-ups reply in the same thread ("Re: <first subject>").
  thread_with_previous boolean NOT NULL DEFAULT true,
  UNIQUE (sequence_id, position)
);

CREATE TABLE enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id       uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  mailbox_id        uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  state             text NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'paused', 'completed', 'replied', 'bounced', 'unsubscribed', 'stopped', 'error')),
  -- The next step to send (1-based).
  next_position     integer NOT NULL DEFAULT 1,
  next_run_at       timestamptz,
  locked_until      timestamptz,
  attempts          integer NOT NULL DEFAULT 0,
  -- Why the last run sent nothing ("outside_send_window", "mailbox_daily_cap", ...).
  last_decision     text,
  last_error        text,
  thread_message_id text,
  thread_subject    text,
  enrolled_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id)
);
CREATE INDEX enrollments_due_idx ON enrollments(next_run_at) WHERE state = 'active';
CREATE INDEX enrollments_contact_idx ON enrollments(workspace_id, contact_id);

-- Sent emails. Bodies are not stored (privacy, size); the subject is kept for the timeline.
CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enrollment_id       uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  mailbox_id          uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  step_position       integer,
  direction           text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  message_id_header   text NOT NULL,
  provider_message_id text,
  subject             text NOT NULL,
  sent_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_mailbox_sent_idx ON messages(mailbox_id, sent_at DESC);
CREATE INDEX messages_contact_idx ON messages(workspace_id, contact_id, sent_at DESC);

-- ---------------------------------------------------------------- RLS + grants

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mailboxes', 'sequences', 'sequence_steps', 'enrollments', 'messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO openline_app', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- scheduler entry point

-- The sending worker must find due work across ALL workspaces, which RLS forbids by design.
-- This single function is the only cross-tenant path: it returns ids only (no personal data),
-- and leases each row for 5 minutes so two workers never send the same step. Everything else the
-- worker does runs inside withTenant() for that row's workspace.
CREATE OR REPLACE FUNCTION claim_due_enrollments(batch integer)
RETURNS TABLE (workspace_id uuid, enrollment_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE enrollments e
     SET locked_until = now() + interval '5 minutes'
   WHERE e.id IN (
     SELECT id FROM enrollments
      WHERE state = 'active'
        AND next_run_at <= now()
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY next_run_at
      LIMIT least(greatest(batch, 1), 500)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING e.workspace_id, e.id;
$$;

REVOKE ALL ON FUNCTION claim_due_enrollments(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_enrollments(integer) TO openline_app;
