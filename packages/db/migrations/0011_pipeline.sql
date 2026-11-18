-- 0011_pipeline: pipeline stages, deals and stage history (OL-E7 §1–2). Additive only (expand).
--
-- pipeline_stages     one pipeline per workspace: ordered stages, each open | won | lost, with a
--                     probability, a stale limit and up to 5 entry criteria. Stages are archived,
--                     never deleted (history points at them). Exactly one active won and one
--                     active lost stage (partial unique indexes below; the API checks it too).
-- deals               money as integer minor units (amount_minor) + ISO 4217 currency; never
--                     floats. last_activity_at holds the deal's own activity (created, edit, stage
--                     change, task completed); email activity with the deal's contacts is added
--                     at read time from messages (see apps/api deals module).
-- deal_contacts       the deal's people (the primary contact included), ≤ 20 per deal (API).
-- deal_stage_history  append-only: the app role may only SELECT and INSERT.
-- tasks.deal_id       a task may be linked to a deal.
-- workspaces.currency the default currency for new deals.
--
-- Default stages are seeded here for every existing workspace (before RLS is switched on for the
-- new table, so the seed works whatever role runs migrations) and by the API when a workspace is
-- created (seedDefaultStages in packages/db/src/pipeline.ts, same list).

-- Same-workspace references (SEC-L3): every link from a deal (company, primary contact, contacts)
-- and from a task to a deal is a composite foreign key on (workspace_id, id), so a row can never
-- point into another workspace even if application code forgets a check. Nullable links use
-- ON DELETE SET NULL (column) (PostgreSQL 15+) so deleting a company / contact / deal clears only
-- the link, never workspace_id. deals.owner_id stays a plain key to users: removing a member must
-- neither be blocked by nor delete the deals they own (reassigning them is a manager's job).

-- ---------------------------------------------------------------- composite key targets

ALTER TABLE companies ADD CONSTRAINT companies_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE contacts ADD CONSTRAINT contacts_workspace_id_id_key UNIQUE (workspace_id, id);

-- ---------------------------------------------------------------- workspaces.currency

ALTER TABLE workspaces
  ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------- pipeline_stages

CREATE TABLE pipeline_stages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  position          integer NOT NULL CHECK (position >= 0),
  probability       integer NOT NULL CHECK (probability BETWEEN 0 AND 100),
  kind              text NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  -- NULL = never stale.
  stale_after_days  integer CHECK (stale_after_days BETWEEN 1 AND 365),
  -- [{ "label": "...", "evidence": "budget_discussed" | ... | "none" }], at most 5.
  entry_criteria    jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(entry_criteria) = 'array'
                           AND jsonb_array_length(entry_criteria) <= 5),
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite foreign keys below (a deal's stage is in the deal's workspace).
  UNIQUE (workspace_id, id)
);

CREATE INDEX pipeline_stages_workspace_idx ON pipeline_stages (workspace_id, archived_at, position);
-- Exactly one active won and one active lost stage per workspace.
CREATE UNIQUE INDEX pipeline_stages_one_won_uidx ON pipeline_stages (workspace_id)
  WHERE kind = 'won' AND archived_at IS NULL;
CREATE UNIQUE INDEX pipeline_stages_one_lost_uidx ON pipeline_stages (workspace_id)
  WHERE kind = 'lost' AND archived_at IS NULL;

INSERT INTO pipeline_stages
  (workspace_id, name, position, probability, kind, stale_after_days, entry_criteria)
SELECT w.id, s.name, s.position, s.probability, s.kind, s.stale_after_days, s.criteria::jsonb
FROM workspaces w
CROSS JOIN (VALUES
  ('Discovery',   0,  10, 'open', 14,
   '[{"label":"Need confirmed","evidence":"need_confirmed"}]'),
  ('Qualified',   1,  25, 'open', 14,
   '[{"label":"Decision maker engaged","evidence":"decision_maker_engaged"},{"label":"Budget discussed","evidence":"budget_discussed"}]'),
  ('Proposal',    2,  50, 'open', 14,
   '[{"label":"Proposal sent","evidence":"proposal_sent"},{"label":"Timeline discussed","evidence":"timeline_discussed"}]'),
  ('Negotiation', 3,  75, 'open', 14,
   '[{"label":"Verbal yes","evidence":"verbal_yes"},{"label":"Next step dated","evidence":"next_step_dated"}]'),
  ('Won',         4, 100, 'won',  NULL, '[]'),
  ('Lost',        5,   0, 'lost', NULL, '[]')
) AS s (name, position, probability, kind, stale_after_days, criteria);

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stages_read ON pipeline_stages FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY pipeline_stages_insert ON pipeline_stages FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY pipeline_stages_update ON pipeline_stages FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
-- No DELETE: stages are archived.
GRANT SELECT, INSERT, UPDATE ON pipeline_stages TO openline_app;

-- ---------------------------------------------------------------- deals

CREATE TABLE deals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  company_id           uuid,
  primary_contact_id   uuid,
  owner_id             uuid NOT NULL REFERENCES users(id),
  stage_id             uuid NOT NULL,
  -- Integer minor units (cents); NULL = no amount yet. Cap keeps column sums exact in JS numbers.
  amount_minor         bigint CHECK (amount_minor BETWEEN 0 AND 999999999999),
  currency             char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expected_close_date  date,
  next_step            text CHECK (char_length(next_step) <= 200),
  next_step_date       date,
  lost_reason          text CHECK (char_length(lost_reason) <= 500),
  stage_entered_at     timestamptz NOT NULL DEFAULT now(),
  -- The deal's own activity; email activity is merged in at read time.
  last_activity_at     timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, stage_id) REFERENCES pipeline_stages (workspace_id, id),
  CONSTRAINT deals_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES companies (workspace_id, id) ON DELETE SET NULL (company_id),
  CONSTRAINT deals_primary_contact_fk FOREIGN KEY (workspace_id, primary_contact_id)
    REFERENCES contacts (workspace_id, id) ON DELETE SET NULL (primary_contact_id)
);

-- Board / list: by stage, by owner, newest first (cursor), close-date forecast.
CREATE INDEX deals_stage_idx ON deals (workspace_id, stage_id);
CREATE INDEX deals_owner_stage_idx ON deals (workspace_id, owner_id, stage_id);
CREATE INDEX deals_created_idx ON deals (workspace_id, created_at DESC, id DESC);
CREATE INDEX deals_close_date_idx ON deals (workspace_id, expected_close_date)
  WHERE closed_at IS NULL;
CREATE INDEX deals_company_idx ON deals (workspace_id, company_id);
CREATE INDEX deals_primary_contact_idx ON deals (workspace_id, primary_contact_id);

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;
CREATE POLICY deals_read ON deals FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
-- No DELETE in this release (deals are closed as won/lost).
GRANT SELECT, INSERT, UPDATE ON deals TO openline_app;

-- ---------------------------------------------------------------- deal_contacts

CREATE TABLE deal_contacts (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL,
  contact_id    uuid NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, contact_id),
  FOREIGN KEY (workspace_id, deal_id) REFERENCES deals (workspace_id, id) ON DELETE CASCADE,
  -- Erasure: deleting the contact removes them from the deal.
  CONSTRAINT deal_contacts_contact_fk FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX deal_contacts_contact_idx ON deal_contacts (workspace_id, contact_id);

ALTER TABLE deal_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_contacts_read ON deal_contacts FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY deal_contacts_insert ON deal_contacts FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY deal_contacts_delete ON deal_contacts FOR DELETE
  USING (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, DELETE ON deal_contacts TO openline_app;

-- ---------------------------------------------------------------- deal_stage_history

CREATE TABLE deal_stage_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id        uuid NOT NULL,
  -- NULL = the deal was created in to_stage_id.
  from_stage_id  uuid,
  to_stage_id    uuid NOT NULL,
  moved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  moved_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, deal_id) REFERENCES deals (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, from_stage_id) REFERENCES pipeline_stages (workspace_id, id),
  FOREIGN KEY (workspace_id, to_stage_id) REFERENCES pipeline_stages (workspace_id, id)
);

CREATE INDEX deal_stage_history_deal_idx ON deal_stage_history (workspace_id, deal_id, moved_at);

ALTER TABLE deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_history FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_stage_history_read ON deal_stage_history FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY deal_stage_history_insert ON deal_stage_history FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
-- Append-only: no UPDATE or DELETE for the app.
GRANT SELECT, INSERT ON deal_stage_history TO openline_app;

-- ---------------------------------------------------------------- tasks.deal_id

ALTER TABLE tasks ADD COLUMN deal_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_deal_fk FOREIGN KEY (workspace_id, deal_id)
  REFERENCES deals (workspace_id, id) ON DELETE SET NULL (deal_id);
CREATE INDEX tasks_deal_idx ON tasks (workspace_id, deal_id);
