-- 0013_reality_check: Pipeline Reality Check (OL-E7 §4). Additive only (expand).
--
-- deal_checks            one row per Reality Check run: evidence per type (present + a verbatim
--                        quote of at most 300 characters + the message id; no other email text),
--                        flags, the evidence stage, model and tokens. Append-only for the app.
-- deal_flag_dismissals   "Not right — we discussed this on a call": hides a flag (by its stable
--                        id) until there is activity after the dismissal. Append-only.
-- ai_actions             new kind deal_stage_move (the "Move to <evidence stage>" proposal) and a
--                        deal_id column; at most one open (proposed) stage move per deal.
-- deals                  reality_checked_at (last run, for the daily schedule) and
--                        reality_locked_until (worker lease).
-- claim_due_reality_checks(batch)  the scheduler's one cross-tenant path: open deals not checked
--                        in the last 24 h with activity since their last check. Ids only.

-- ---------------------------------------------------------------- deals: schedule columns

ALTER TABLE deals
  ADD COLUMN reality_checked_at   timestamptz,
  ADD COLUMN reality_locked_until timestamptz;

-- ---------------------------------------------------------------- deal_checks

CREATE TABLE deal_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id             uuid NOT NULL,
  -- The deal's stage when checked: model flags only count while the deal is still there.
  stage_id            uuid NOT NULL,
  ran_at              timestamptz NOT NULL DEFAULT now(),
  -- manual = "Check now"; scheduled = the daily worker run.
  trigger             text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  -- Who pressed "Check now" (NULL for scheduled runs).
  ran_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  -- NULL when only the deterministic rules ran.
  model               text CHECK (char_length(model) <= 100),
  input_tokens        integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- { "<type>": { "present": "yes|no|unclear", "quote"?: "≤300 chars", "messageId"?: uuid } }
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  -- [{ id, code, severity, message, criterionKey?, criterion?, quote?, messageId? }]
  flags               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(flags) = 'array'),
  evidence_stage_id   uuid,
  deterministic_only  boolean NOT NULL DEFAULT true,
  -- scout_off | no_provider | budget | no_emails | model_error (when deterministic_only).
  deterministic_reason text CHECK (deterministic_reason ~ '^[a-z_]{1,40}$'),
  FOREIGN KEY (workspace_id, deal_id) REFERENCES deals (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, stage_id) REFERENCES pipeline_stages (workspace_id, id),
  FOREIGN KEY (workspace_id, evidence_stage_id) REFERENCES pipeline_stages (workspace_id, id)
);

CREATE INDEX deal_checks_deal_idx ON deal_checks (workspace_id, deal_id, ran_at DESC);

ALTER TABLE deal_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_checks_read ON deal_checks FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY deal_checks_insert ON deal_checks FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
-- Append-only for the app: no UPDATE or DELETE (a deal's deletion cascades as the table owner).
GRANT SELECT, INSERT ON deal_checks TO openline_app;

-- ---------------------------------------------------------------- deal_flag_dismissals

CREATE TABLE deal_flag_dismissals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL,
  -- Stable flag id (sha256(code:criterion) prefix, packages/ai realityFlagId()).
  flag_id       text NOT NULL CHECK (flag_id ~ '^[0-9a-f]{16}$'),
  code          text NOT NULL CHECK (code ~ '^[a-z_]{1,40}$'),
  criterion_key text CHECK (criterion_key ~ '^[a-z_]{1,40}$'),
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  dismissed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, deal_id) REFERENCES deals (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX deal_flag_dismissals_deal_idx
  ON deal_flag_dismissals (workspace_id, deal_id, dismissed_at DESC);

ALTER TABLE deal_flag_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_flag_dismissals FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_flag_dismissals_read ON deal_flag_dismissals FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY deal_flag_dismissals_insert ON deal_flag_dismissals FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
-- Append-only (feeds the evaluation set): no UPDATE or DELETE for the app.
GRANT SELECT, INSERT ON deal_flag_dismissals TO openline_app;

-- ---------------------------------------------------------------- ai_actions: deal_stage_move

-- Expand only: every existing kind stays allowed.
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_kind_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_kind_check
  CHECK (kind IN ('draft_email', 'draft_reply', 'promise_task', 'pause_enrollments',
                  'deal_stage_move'));

ALTER TABLE ai_actions ADD COLUMN deal_id uuid;
-- Same-workspace deal; deleting the deal deletes its proposals.
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_deal_fk
  FOREIGN KEY (workspace_id, deal_id) REFERENCES deals (workspace_id, id) ON DELETE CASCADE;

-- One open stage-move proposal per deal (a newer check replaces it).
CREATE UNIQUE INDEX ai_actions_one_open_stage_move_uidx ON ai_actions (deal_id)
  WHERE kind = 'deal_stage_move' AND status = 'proposed';
CREATE INDEX ai_actions_deal_idx ON ai_actions (workspace_id, deal_id, created_at DESC)
  WHERE deal_id IS NOT NULL;

-- ---------------------------------------------------------------- scheduler entry point

-- Same pattern as claim_due_mailbox_syncs (0006): owned by openline_scheduler (NOLOGIN, no
-- BYPASSRLS), column-level rights only — ids, stage kinds and timestamps; never names, amounts,
-- subjects or bodies — returning ids only and leasing each deal for 10 minutes.
GRANT SELECT (id, workspace_id, stage_id, last_activity_at, reality_checked_at,
              reality_locked_until),
      UPDATE (reality_locked_until)
   ON deals TO openline_scheduler;
GRANT SELECT (id, workspace_id, kind) ON pipeline_stages TO openline_scheduler;
GRANT SELECT (workspace_id, deal_id, contact_id) ON deal_contacts TO openline_scheduler;
GRANT SELECT (workspace_id, contact_id, sent_at, status) ON messages TO openline_scheduler;

DROP POLICY IF EXISTS deals_scheduler_select ON deals;
DROP POLICY IF EXISTS deals_scheduler_update ON deals;
DROP POLICY IF EXISTS pipeline_stages_scheduler_select ON pipeline_stages;
DROP POLICY IF EXISTS deal_contacts_scheduler_select ON deal_contacts;
DROP POLICY IF EXISTS messages_scheduler_select ON messages;
CREATE POLICY deals_scheduler_select ON deals FOR SELECT TO openline_scheduler USING (true);
CREATE POLICY deals_scheduler_update ON deals
  FOR UPDATE TO openline_scheduler USING (true) WITH CHECK (true);
CREATE POLICY pipeline_stages_scheduler_select ON pipeline_stages
  FOR SELECT TO openline_scheduler USING (true);
CREATE POLICY deal_contacts_scheduler_select ON deal_contacts
  FOR SELECT TO openline_scheduler USING (true);
CREATE POLICY messages_scheduler_select ON messages
  FOR SELECT TO openline_scheduler USING (true);

-- Due = open stage, not leased, never checked or checked over 24 h ago, and some activity after
-- the last check: the deal's own activity, or an email (either direction) with a deal contact.
CREATE OR REPLACE FUNCTION claim_due_reality_checks(batch integer)
RETURNS TABLE (workspace_id uuid, deal_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE deals d
     SET reality_locked_until = now() + interval '10 minutes'
   WHERE d.id IN (
     SELECT x.id FROM deals x
       JOIN pipeline_stages s ON s.id = x.stage_id AND s.workspace_id = x.workspace_id
      WHERE s.kind = 'open'
        AND (x.reality_locked_until IS NULL OR x.reality_locked_until < now())
        AND (x.reality_checked_at IS NULL OR x.reality_checked_at < now() - interval '1 day')
        AND (x.reality_checked_at IS NULL
             OR x.last_activity_at > x.reality_checked_at
             OR EXISTS (SELECT 1 FROM deal_contacts dc
                          JOIN messages m ON m.workspace_id = dc.workspace_id
                                         AND m.contact_id = dc.contact_id
                         WHERE dc.workspace_id = x.workspace_id AND dc.deal_id = x.id
                           AND m.status <> 'sending'
                           AND m.sent_at > x.reality_checked_at))
      ORDER BY x.reality_checked_at NULLS FIRST, x.id
      LIMIT least(greatest(batch, 1), 200)
      FOR UPDATE OF x SKIP LOCKED
   )
  RETURNING d.workspace_id, d.id;
$$;

ALTER FUNCTION claim_due_reality_checks(integer) OWNER TO openline_scheduler;
REVOKE ALL ON FUNCTION claim_due_reality_checks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_reality_checks(integer) TO openline_app;
