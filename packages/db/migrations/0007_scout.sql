-- 0007_scout: Scout v1 — drafting with approval (OL-E4 §4). Additive only.
--
-- ai_actions   every Scout draft, as a proposal a human approves or rejects (packages/ai state
--              machine). Holds the proposal and the approved text, never raw web page text.
-- ai_usage     append-only token ledger; monthly budgets are SUM(credits) for the month.
-- website_cache company website text fetched for research, kept 7 days per workspace + domain.
-- workspaces   Scout settings and the "about us" / value proposition drafts are written from.

-- ---------------------------------------------------------------- workspace settings

ALTER TABLE workspaces
  ADD COLUMN scout_enabled         boolean NOT NULL DEFAULT true,
  -- 1 credit = 1,000 tokens (input + output).
  ADD COLUMN scout_monthly_credits integer NOT NULL DEFAULT 2000
                                   CHECK (scout_monthly_credits BETWEEN 0 AND 1000000),
  ADD COLUMN scout_web_research    boolean NOT NULL DEFAULT true,
  ADD COLUMN about_us              text CHECK (char_length(about_us) <= 2000),
  ADD COLUMN value_proposition     text CHECK (char_length(value_proposition) <= 1000);

-- ---------------------------------------------------------------- ai_actions

CREATE TABLE ai_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The rep who asked for the draft; only they can approve or reject it.
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('draft_email', 'draft_reply')),
  status         text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed')),
  -- A draft is about a person: deleting the contact (or their reply) deletes the drafts too.
  contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
  message_id     uuid REFERENCES messages(id) ON DELETE CASCADE,
  sequence_id    uuid REFERENCES sequences(id) ON DELETE SET NULL,
  step_position  integer,
  -- What went into the prompt, as ids/flags/lengths only (no page text, no email text).
  input_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- { subject?, body, citations: [{ claim, source }] }
  proposal       jsonb NOT NULL,
  final_subject  text CHECK (char_length(final_subject) <= 200),
  final_text     text CHECK (char_length(final_text) <= 10000),
  -- [{ id, kind, label }] — what the model was allowed to cite.
  sources        jsonb NOT NULL DEFAULT '[]'::jsonb,
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- Characters changed between the proposal and the approved text (the "light edits" metric).
  edit_distance  integer CHECK (edit_distance >= 0),
  reject_reason  text CHECK (char_length(reject_reason) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
CREATE INDEX ai_actions_user_idx ON ai_actions (workspace_id, user_id, created_at DESC);
CREATE INDEX ai_actions_contact_idx ON ai_actions (contact_id);
CREATE INDEX ai_actions_message_idx ON ai_actions (message_id);

-- ---------------------------------------------------------------- ai_usage (ledger)

CREATE TABLE ai_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- draft_email | draft_reply | classify_reply (reply pipeline) | ...
  feature       text NOT NULL CHECK (feature ~ '^[a-z_]{1,40}$'),
  ai_action_id  uuid REFERENCES ai_actions(id) ON DELETE SET NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  credits       integer NOT NULL CHECK (credits >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_month_idx ON ai_usage (workspace_id, created_at);

-- ---------------------------------------------------------------- website_cache

CREATE TABLE website_cache (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain       text NOT NULL CHECK (domain = lower(domain)),
  -- [{ url, title?, text }] — public page text, at most 3 pages.
  pages        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- false = the site couldn't be fetched (cached too, so we don't hammer it).
  ok           boolean NOT NULL DEFAULT true,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, domain)
);

-- ---------------------------------------------------------------- RLS + grants

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_actions', 'ai_usage', 'website_cache']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (workspace_id = app_workspace_id())',
      t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (workspace_id = app_workspace_id())',
      t || '_insert', t);
  END LOOP;
END $$;

CREATE POLICY ai_actions_update ON ai_actions FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY website_cache_update ON website_cache FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY website_cache_delete ON website_cache FOR DELETE
  USING (workspace_id = app_workspace_id());

-- Drafts are kept (approval history); the usage ledger is append-only.
GRANT SELECT, INSERT, UPDATE ON ai_actions TO openline_app;
GRANT SELECT, INSERT ON ai_usage TO openline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON website_cache TO openline_app;
