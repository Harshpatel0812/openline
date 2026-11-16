-- 0009_tasks_promises: Tasks and Promise Keeper (OL-E6 §1–2). Additive only (expand).
--
-- tasks        a rep's to-dos: manual, or created when a rep accepts a promise Scout found in an
--              email. Never deleted by the app (closed as done / dismissed); deleting the contact
--              deletes the tasks about them.
-- ai_actions   two new proposal kinds: promise_task (create a task) and pause_enrollments (hold the
--              contact's active enrollments until a date the prospect asked for). Nothing happens
--              until the rep accepts (Scout rule 1).

-- ---------------------------------------------------------------- tasks

CREATE TABLE tasks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A task is about a person: deleting the contact deletes it (it may quote their email).
  contact_id               uuid REFERENCES contacts(id) ON DELETE CASCADE,
  company_id               uuid REFERENCES companies(id) ON DELETE SET NULL,
  title                    text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  notes                    text CHECK (char_length(notes) <= 2000),
  due_at                   timestamptz,
  -- The promise named no date: due_at is a default (+2 business days), shown as "no date given".
  due_date_missing         boolean NOT NULL DEFAULT false,
  kind                     text NOT NULL DEFAULT 'other'
                           CHECK (kind IN ('follow_up', 'send_promised', 'call', 'other')),
  source                   text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'promise')),
  -- The email the promise was found in (inbound reply or outbound inbox reply).
  source_message_id        uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- The accepted proposal; UNIQUE makes accepting idempotent (one task per proposal).
  ai_action_id             uuid UNIQUE REFERENCES ai_actions(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'done', 'dismissed')),
  -- When the task was closed (done or dismissed).
  completed_at             timestamptz,
  -- "Looks like you sent it — mark done?": the rep replied in the promise's thread afterwards.
  suggest_done_at          timestamptz,
  suggest_done_message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open') = (completed_at IS NULL))
);

-- Today / counts: one owner's open tasks by due date; managers: everyone's.
CREATE INDEX tasks_owner_due_idx ON tasks (workspace_id, owner_id, status, due_at);
CREATE INDEX tasks_workspace_due_idx ON tasks (workspace_id, status, due_at);
CREATE INDEX tasks_contact_idx ON tasks (contact_id);
CREATE INDEX tasks_source_message_idx ON tasks (source_message_id);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_read ON tasks FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

-- No DELETE: tasks are closed, not deleted (contact deletion cascades as the table owner).
GRANT SELECT, INSERT, UPDATE ON tasks TO openline_app;

-- ---------------------------------------------------------------- ai_actions: promise kinds

-- Expand only: every existing kind stays allowed.
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_kind_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_kind_check
  CHECK (kind IN ('draft_email', 'draft_reply', 'promise_task', 'pause_enrollments'));

-- Proposed promises per person (inbox badge, Today) and per message (the inbox message view).
CREATE INDEX ai_actions_promises_idx ON ai_actions (workspace_id, user_id, status, created_at DESC)
  WHERE kind IN ('promise_task', 'pause_enrollments');
