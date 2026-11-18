-- 0014_crm_sync: two-way CRM sync with HubSpot and Pipedrive (OL-E8, ADR 0006). Expand only.
--
-- crm_connections     one per workspace (UNIQUE workspace_id): provider, status, account, sealed
--                     OAuth tokens (secret_sealed; '' = removed), chosen pipeline, options,
--                     per-object cursors (cursors jsonb), schedule + lease, budget counters.
-- crm_links           the external id map: one row per linked Openline contact / company / deal,
--                     with its state and `shadow` (per-field hash of the last agreed value: the
--                     per-field sync state used for conflicts and echo suppression). Erasure in
--                     Openline sets the local FK to NULL and the trigger below turns the row into
--                     a tombstone (external id only) — the erasure marker that stops re-import.
-- crm_field_mappings  standard + custom field mappings with direction and source of truth.
-- crm_stage_mappings  CRM stage → Openline stage and Openline stage → CRM stage.
-- crm_sync_runs       sync log: kind, counts per object and action, calls / tokens, conflicts.
-- crm_sync_errors     per-record errors (messages written by us, never CRM text or values); the
--                     app may only update resolved_*, attempts and next_retry_at.
-- workspaces.crm_sync_enabled  feature flag: NULL follows the plan (Team and up; trials yes),
--                     true / false force it (there is no billing entitlement system yet).
--
-- Every table: workspace_id, ENABLE + FORCE RLS, split policies, composite (workspace_id, id)
-- foreign keys so no row can point into another workspace (SEC-L3, as in 0011).

ALTER TABLE workspaces ADD COLUMN crm_sync_enabled boolean;

-- ---------------------------------------------------------------- crm_connections

CREATE TABLE crm_connections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider               text NOT NULL CHECK (provider IN ('hubspot', 'pipedrive')),
  status                 text NOT NULL DEFAULT 'needs_setup'
                         CHECK (status IN ('needs_setup', 'previewing', 'importing', 'active',
                                           'paused', 'error', 'disconnected')),
  account_id             text CHECK (char_length(account_id) BETWEEN 1 AND 64),
  account_name           text CHECK (char_length(account_name) <= 200),
  -- Pipedrive only: https://<company>.pipedrive.com, or the loopback fake server (CRM_MODE=fake,
  -- which config refuses in production). Checked in code at callback and again here (SEC-L5).
  api_domain             text CHECK (char_length(api_domain) <= 200 AND (
                           api_domain ~ '^https://[a-z0-9-]+\.pipedrive\.com$' OR
                           api_domain ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/pipedrive$')),
  scopes                 text[] NOT NULL DEFAULT '{}',
  -- sealJson({kind:'oauth', refreshToken, accessToken, accessExpiresAt}); '' = disconnected.
  secret_sealed          text NOT NULL DEFAULT '',
  pipeline_id            text CHECK (char_length(pipeline_id) <= 64),
  default_owner_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at           timestamptz NOT NULL DEFAULT now(),
  options                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  -- { "<object>": { "remote": iso, "local": iso }, "notes": iso, ... }
  cursors                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursors) = 'object'),
  -- Non-personal account facts: currencies the CRM accepts, portal id for record links.
  account_meta           jsonb NOT NULL DEFAULT '{}'::jsonb
                         CHECK (jsonb_typeof(account_meta) = 'object'),
  stage_mapping_complete boolean NOT NULL DEFAULT false,
  warnings               text[] NOT NULL DEFAULT '{}',
  next_sync_at           timestamptz,
  sync_locked_until      timestamptz,
  empty_polls            integer NOT NULL DEFAULT 0 CHECK (empty_polls >= 0),
  failure_count          integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_sync_at           timestamptz,
  last_reconcile_at      timestamptz,
  resumes_at             timestamptz,
  last_error             text CHECK (char_length(last_error) <= 500),
  budget_day             date,
  budget_spent           integer NOT NULL DEFAULT 0 CHECK (budget_spent >= 0),
  reconnect_notified_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- One CRM connection per workspace (a second → 409 crm_already_connected).
  UNIQUE (workspace_id),
  UNIQUE (workspace_id, id)
);

CREATE INDEX crm_connections_due_idx ON crm_connections (next_sync_at)
  WHERE status IN ('previewing', 'importing', 'active', 'paused');

ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_connections_read ON crm_connections FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY crm_connections_insert ON crm_connections FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_connections_update ON crm_connections FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
-- No DELETE: a disconnect keeps the row (status disconnected, secret erased).
GRANT SELECT, INSERT, UPDATE ON crm_connections TO openline_app;

-- ---------------------------------------------------------------- crm_links

CREATE TABLE crm_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL,
  object              text NOT NULL CHECK (object IN ('contact', 'company', 'deal')),
  contact_id          uuid,
  company_id          uuid,
  deal_id             uuid,
  external_id         text CHECK (external_id ~ '^[A-Za-z0-9_:.-]{1,64}$'),
  state               text NOT NULL DEFAULT 'linked'
                      CHECK (state IN ('linked', 'creating', 'unconfirmed', 'unlinked', 'tombstone')),
  -- Why unlinked / tombstone: deleted_in_crm, merged_away, erased_in_openline, ...
  reason              text CHECK (reason ~ '^[a-z_]{1,40}$'),
  -- { "<field>": "<16 hex>" } — hashes only, never values.
  shadow              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(shadow) = 'object'),
  remote_modified_at  timestamptz,
  synced_at           timestamptz,
  -- Set with state 'creating' just before a CRM create (reservation, like send reservations).
  reserved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES crm_connections (workspace_id, id) ON DELETE CASCADE,
  -- Erasure / delete in Openline clears only the local id; the trigger makes it a tombstone.
  CONSTRAINT crm_links_contact_fk FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts (workspace_id, id) ON DELETE SET NULL (contact_id),
  CONSTRAINT crm_links_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES companies (workspace_id, id) ON DELETE SET NULL (company_id),
  CONSTRAINT crm_links_deal_fk FOREIGN KEY (workspace_id, deal_id)
    REFERENCES deals (workspace_id, id) ON DELETE SET NULL (deal_id),
  -- Exactly one local record, of the row's object type; none only for a tombstone.
  CONSTRAINT crm_links_one_record CHECK (num_nonnulls(contact_id, company_id, deal_id) <= 1),
  CONSTRAINT crm_links_object_column CHECK (
    (contact_id IS NULL OR object = 'contact') AND
    (company_id IS NULL OR object = 'company') AND
    (deal_id IS NULL OR object = 'deal')),
  CONSTRAINT crm_links_tombstone_check CHECK (
    (state = 'tombstone') = (num_nonnulls(contact_id, company_id, deal_id) = 0)),
  CONSTRAINT crm_links_external_check CHECK (
    external_id IS NOT NULL OR state IN ('creating', 'unconfirmed', 'unlinked', 'tombstone'))
);

-- Unique both ways per connection.
CREATE UNIQUE INDEX crm_links_external_uidx ON crm_links (connection_id, object, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX crm_links_contact_uidx ON crm_links (connection_id, contact_id)
  WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX crm_links_company_uidx ON crm_links (connection_id, company_id)
  WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX crm_links_deal_uidx ON crm_links (connection_id, deal_id)
  WHERE deal_id IS NOT NULL;
CREATE INDEX crm_links_state_idx ON crm_links (workspace_id, connection_id, object, state);
CREATE INDEX crm_links_contact_idx ON crm_links (workspace_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX crm_links_company_idx ON crm_links (workspace_id, company_id) WHERE company_id IS NOT NULL;
CREATE INDEX crm_links_deal_idx ON crm_links (workspace_id, deal_id) WHERE deal_id IS NOT NULL;

-- When the local record goes (delete or erasure), keep only the external id: a tombstone, so the
-- next pull does not re-create the person. Runs as the caller; no extra rights.
CREATE OR REPLACE FUNCTION crm_links_tombstone_on_erase()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_id IS NULL AND NEW.company_id IS NULL AND NEW.deal_id IS NULL
     AND (OLD.contact_id IS NOT NULL OR OLD.company_id IS NOT NULL OR OLD.deal_id IS NOT NULL) THEN
    NEW.state := 'tombstone';
    NEW.reason := 'erased_in_openline';
    NEW.shadow := '{}'::jsonb;
    NEW.reserved_at := NULL;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER crm_links_tombstone
  BEFORE UPDATE ON crm_links
  FOR EACH ROW EXECUTE FUNCTION crm_links_tombstone_on_erase();

ALTER TABLE crm_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_links FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_links_read ON crm_links FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY crm_links_insert ON crm_links FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_links_update ON crm_links FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
-- DELETE: "Disconnect and forget links" and reconnecting a different account.
CREATE POLICY crm_links_delete ON crm_links FOR DELETE
  USING (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_links TO openline_app;

-- ---------------------------------------------------------------- crm_field_mappings

CREATE TABLE crm_field_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL,
  object           text NOT NULL CHECK (object IN ('contact', 'company', 'deal')),
  local_field      text NOT NULL CHECK (local_field ~ '^(custom\.)?[A-Za-z][A-Za-z0-9_]{0,39}$'),
  remote_field     text CHECK (remote_field ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  direction        text NOT NULL DEFAULT 'both'
                   CHECK (direction IN ('both', 'to_crm', 'from_crm', 'off')),
  source_of_truth  text NOT NULL DEFAULT 'newest'
                   CHECK (source_of_truth IN ('newest', 'openline', 'crm')),
  standard         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, object, local_field),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES crm_connections (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE crm_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_field_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_field_mappings_read ON crm_field_mappings FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY crm_field_mappings_insert ON crm_field_mappings FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_field_mappings_update ON crm_field_mappings FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_field_mappings_delete ON crm_field_mappings FOR DELETE
  USING (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_field_mappings TO openline_app;

-- ---------------------------------------------------------------- crm_stage_mappings

CREATE TABLE crm_stage_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('from_crm', 'to_crm')),
  remote_stage_id  text NOT NULL CHECK (remote_stage_id ~ '^[A-Za-z0-9_:@.-]{1,64}$'),
  stage_id         uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES crm_connections (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, stage_id) REFERENCES pipeline_stages (workspace_id, id)
);

-- Each CRM stage maps to one Openline stage; each Openline stage to one CRM stage.
CREATE UNIQUE INDEX crm_stage_mappings_from_uidx ON crm_stage_mappings (connection_id, remote_stage_id)
  WHERE direction = 'from_crm';
CREATE UNIQUE INDEX crm_stage_mappings_to_uidx ON crm_stage_mappings (connection_id, stage_id)
  WHERE direction = 'to_crm';

ALTER TABLE crm_stage_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_stage_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_stage_mappings_read ON crm_stage_mappings FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY crm_stage_mappings_insert ON crm_stage_mappings FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_stage_mappings_delete ON crm_stage_mappings FOR DELETE
  USING (workspace_id = app_workspace_id());
-- Mappings are replaced as a whole (delete + insert): no UPDATE.
GRANT SELECT, INSERT, DELETE ON crm_stage_mappings TO openline_app;

-- ---------------------------------------------------------------- crm_sync_runs

CREATE TABLE crm_sync_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('preview', 'import', 'incremental', 'reconcile')),
  status         text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  -- { "<object>": { "<action>": n } }
  counts         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  -- Previews: ≤ 20 example ids per bucket. Ids only, never field values.
  examples       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(examples) = 'object'),
  -- [{ object, field, winner, localAt, remoteAt, rule }] — no values; at most 200.
  conflicts      jsonb NOT NULL DEFAULT '[]'::jsonb
                 CHECK (jsonb_typeof(conflicts) = 'array' AND jsonb_array_length(conflicts) <= 200),
  conflict_count integer NOT NULL DEFAULT 0,
  options        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  api_calls      integer NOT NULL DEFAULT 0 CHECK (api_calls >= 0),
  tokens         integer NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  started_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  duration_ms    integer,
  error_code     text CHECK (error_code ~ '^[a-z_]{1,40}$'),
  -- Previews are valid for 1 hour.
  expires_at     timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES crm_connections (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX crm_sync_runs_list_idx ON crm_sync_runs (workspace_id, started_at DESC, id DESC);

ALTER TABLE crm_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_sync_runs_read ON crm_sync_runs FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY crm_sync_runs_insert ON crm_sync_runs FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_sync_runs_update ON crm_sync_runs FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
-- DELETE: retention (runs are kept 90 days).
CREATE POLICY crm_sync_runs_delete ON crm_sync_runs FOR DELETE
  USING (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_sync_runs TO openline_app;

-- ---------------------------------------------------------------- crm_sync_errors

CREATE TABLE crm_sync_errors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  run_id         uuid,
  object         text NOT NULL CHECK (object IN ('contact', 'company', 'deal')),
  -- Openline record id (no FK: the error outlives an erased record, it holds no personal data).
  local_id       uuid,
  external_id    text CHECK (external_id ~ '^[A-Za-z0-9_:.-]{1,64}$'),
  direction      text NOT NULL CHECK (direction IN ('to_crm', 'from_crm')),
  code           text NOT NULL CHECK (code ~ '^[a-z_]{1,40}$'),
  -- Written by us, never CRM text or field values.
  message        text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  attempts       integer NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  next_retry_at  timestamptz,
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution     text CHECK (resolution IN ('fixed', 'dismissed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (local_id IS NOT NULL OR external_id IS NOT NULL),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES crm_connections (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_sync_errors_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES crm_sync_runs (workspace_id, id) ON DELETE SET NULL (run_id)
);

CREATE INDEX crm_sync_errors_open_idx ON crm_sync_errors (workspace_id, connection_id, created_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX crm_sync_errors_retry_idx ON crm_sync_errors (connection_id, next_retry_at)
  WHERE resolved_at IS NULL AND next_retry_at IS NOT NULL;

ALTER TABLE crm_sync_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_sync_errors_read ON crm_sync_errors FOR SELECT
  USING (workspace_id = app_workspace_id());
CREATE POLICY crm_sync_errors_insert ON crm_sync_errors FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY crm_sync_errors_update ON crm_sync_errors FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
-- DELETE: retention (resolved errors are kept 30 days) and disconnect-and-forget.
CREATE POLICY crm_sync_errors_delete ON crm_sync_errors FOR DELETE
  USING (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, DELETE ON crm_sync_errors TO openline_app;
-- The error itself is immutable; only its resolution and retry schedule change.
GRANT UPDATE (resolved_at, resolved_by, resolution, attempts, next_retry_at)
   ON crm_sync_errors TO openline_app;

-- ---------------------------------------------------------------- scheduler entry point

-- Same pattern as claim_due_mailbox_syncs (0006) / claim_due_reality_checks (0013): owned by
-- openline_scheduler (NOLOGIN, no BYPASSRLS), column rights on crm_connections only — never the
-- sealed secret, account, options or cursors — returning ids only, leasing each connection for
-- 10 minutes (renewed by the engine during long runs). previewing = a dry run was requested;
-- paused connections are claimed only for their weekly token refresh (next_sync_at is set a week
-- ahead on pause). Workspaces whose plan doesn't include CRM sync (a downgrade to Solo) are never
-- claimed; their schedule is kept, so sync resumes on upgrade. The rule matches crmSyncEntitled()
-- in packages/shared: crm_sync_enabled forces it, NULL follows the plan (trial, Team and up).
GRANT SELECT (id, workspace_id, status, next_sync_at, sync_locked_until),
      UPDATE (sync_locked_until)
   ON crm_connections TO openline_scheduler;
GRANT SELECT (id, plan, crm_sync_enabled) ON workspaces TO openline_scheduler;
DROP POLICY IF EXISTS workspaces_crm_scheduler_select ON workspaces;
CREATE POLICY workspaces_crm_scheduler_select ON workspaces
  FOR SELECT TO openline_scheduler USING (true);

DROP POLICY IF EXISTS crm_connections_scheduler_select ON crm_connections;
DROP POLICY IF EXISTS crm_connections_scheduler_update ON crm_connections;
CREATE POLICY crm_connections_scheduler_select ON crm_connections
  FOR SELECT TO openline_scheduler USING (true);
CREATE POLICY crm_connections_scheduler_update ON crm_connections
  FOR UPDATE TO openline_scheduler USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION claim_due_crm_syncs(batch integer)
RETURNS TABLE (workspace_id uuid, connection_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE crm_connections c
     SET sync_locked_until = now() + interval '10 minutes'
   WHERE c.id IN (
     SELECT d.id FROM crm_connections d
       JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.status IN ('previewing', 'importing', 'active', 'paused')
        AND d.next_sync_at IS NOT NULL
        AND d.next_sync_at <= now()
        AND (d.sync_locked_until IS NULL OR d.sync_locked_until < now())
        AND (w.crm_sync_enabled IS TRUE
             OR (w.crm_sync_enabled IS NULL AND w.plan IN ('trial', 'team', 'growth', 'scale')))
      ORDER BY d.next_sync_at
      LIMIT least(greatest(batch, 1), 200)
      FOR UPDATE OF d SKIP LOCKED
   )
  RETURNING c.workspace_id, c.id;
$$;

ALTER FUNCTION claim_due_crm_syncs(integer) OWNER TO openline_scheduler;
REVOKE ALL ON FUNCTION claim_due_crm_syncs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_crm_syncs(integer) TO openline_app;

-- Pipedrive's uninstall callback (DELETE, Basic auth with our client credentials) names a company,
-- not a workspace. This is the one other cross-tenant path: it marks every Pipedrive connection
-- for that company disconnected and erases its tokens, returning ids only (the API then audits each
-- inside its own workspace). Column rights only; the role can never read the tokens it erases.
GRANT SELECT (provider, account_id) ON crm_connections TO openline_scheduler;
GRANT UPDATE (status, secret_sealed, next_sync_at) ON crm_connections TO openline_scheduler;
-- (sync_locked_until is granted above: an uninstall also drops the lease, so a running sync stops
-- at its next lease check instead of writing on.)

CREATE OR REPLACE FUNCTION mark_crm_uninstalled(p_provider text, p_account_id text)
RETURNS TABLE (workspace_id uuid, connection_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE crm_connections c
     SET status = 'disconnected', secret_sealed = '', next_sync_at = NULL, sync_locked_until = NULL
   WHERE c.provider = p_provider
     AND c.account_id = p_account_id
     AND c.status <> 'disconnected'
  RETURNING c.workspace_id, c.id;
$$;

ALTER FUNCTION mark_crm_uninstalled(text, text) OWNER TO openline_scheduler;
REVOKE ALL ON FUNCTION mark_crm_uninstalled(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_crm_uninstalled(text, text) TO openline_app;

-- ---------------------------------------------------------------- sync soon after a local change

-- A local write to a linked contact, company or deal, or a new suppression, brings the next sync of
-- an active connection forward to within a minute (least(next_sync_at, now() + 1 min)), so an
-- Openline edit or opt-out reaches the CRM in minutes even when polling has backed off to idle.
-- It writes only when it moves the time (a busy workspace doesn't rewrite the row on every edit).
-- Runs as the caller (openline_app, under RLS); the engine's own end-of-run schedule wins.
CREATE OR REPLACE FUNCTION crm_sync_soon()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  linked boolean;
BEGIN
  -- Only people's edits through the app count; scheduler bookkeeping (leases on deals for
  -- Reality Check, ...) is not a change to sync, and that role can't see crm_links anyway.
  IF current_user = 'openline_scheduler' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'contacts' THEN
    linked := EXISTS (SELECT 1 FROM crm_links l
                       WHERE l.workspace_id = NEW.workspace_id AND l.contact_id = NEW.id);
  ELSIF TG_TABLE_NAME = 'companies' THEN
    linked := EXISTS (SELECT 1 FROM crm_links l
                       WHERE l.workspace_id = NEW.workspace_id AND l.company_id = NEW.id);
  ELSIF TG_TABLE_NAME = 'deals' THEN
    linked := EXISTS (SELECT 1 FROM crm_links l
                       WHERE l.workspace_id = NEW.workspace_id AND l.deal_id = NEW.id);
  ELSE
    linked := true; -- suppressions: opt-outs travel to the CRM
  END IF;
  IF linked THEN
    UPDATE crm_connections c
       SET next_sync_at = now() + interval '1 minute'
     WHERE c.workspace_id = NEW.workspace_id
       AND c.status = 'active'
       AND (c.next_sync_at IS NULL OR c.next_sync_at > now() + interval '1 minute');
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER contacts_crm_sync_soon AFTER UPDATE ON contacts
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION crm_sync_soon();
CREATE TRIGGER companies_crm_sync_soon AFTER UPDATE ON companies
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION crm_sync_soon();
CREATE TRIGGER deals_crm_sync_soon AFTER UPDATE ON deals
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION crm_sync_soon();
CREATE TRIGGER suppressions_crm_sync_soon AFTER INSERT OR UPDATE ON suppressions
  FOR EACH ROW EXECUTE FUNCTION crm_sync_soon();
