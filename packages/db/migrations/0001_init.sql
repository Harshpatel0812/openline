-- 0001_init: core identity, workspaces, contacts, compliance and audit tables.
--
-- Security model
--  * Global identity tables (users, sessions) have no tenant column and are only reachable
--    through the API's auth service.
--  * Every tenant table has workspace_id and a row-level security policy keyed on
--    current_setting('app.workspace_id'). FORCE makes the policy apply to the table owner too.
--  * The API runs every request inside a transaction that does
--      SET LOCAL ROLE openline_app;  set_config('app.workspace_id', ..., true)
--    so even a bug in application code cannot read another workspace's rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openline_app') THEN
    CREATE ROLE openline_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT openline_app TO CURRENT_USER;

-- Helper: the current tenant, or NULL when unset (NULL never matches, so nothing is visible).
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- identity (global)

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL UNIQUE CHECK (email = lower(email)),
  name              text NOT NULL,
  password_hash     text NOT NULL,
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ---------------------------------------------------------------- tenants

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'trial',
  data_region   text NOT NULL DEFAULT 'us',
  trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'rep')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL CHECK (email = lower(email)),
  role         text NOT NULL CHECK (role IN ('admin', 'manager', 'rep')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_workspace_idx ON invites(workspace_id);

CREATE TABLE companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  domain       text,
  custom       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, domain)
);

CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id       uuid REFERENCES companies(id) ON DELETE SET NULL,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  email            text NOT NULL CHECK (email = lower(email)),
  first_name       text,
  last_name        text,
  title            text,
  phone            text,
  time_zone        text,
  country          text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bounced', 'unsubscribed', 'archived')),
  health_score     integer NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  consent_basis    text NOT NULL DEFAULT 'none'
                   CHECK (consent_basis IN ('express', 'implied_purchase', 'implied_inquiry', 'legitimate_interest', 'none')),
  custom           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);
CREATE INDEX contacts_workspace_company_idx ON contacts(workspace_id, company_id);
CREATE INDEX contacts_workspace_created_idx ON contacts(workspace_id, created_at DESC, id);

CREATE TABLE consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel      text NOT NULL DEFAULT 'email',
  basis        text NOT NULL CHECK (basis IN ('express', 'implied_purchase', 'implied_inquiry', 'legitimate_interest', 'none')),
  source       text NOT NULL,
  obtained_at  timestamptz NOT NULL,
  expires_at   timestamptz,
  withdrawn_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_contact_idx ON consents(workspace_id, contact_id);

CREATE TABLE suppressions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  value        text NOT NULL CHECK (value = lower(value)),
  reason       text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, value)
);

CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  entity       text NOT NULL,
  entity_id    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_workspace_at_idx ON audit_log(workspace_id, at DESC);

-- ---------------------------------------------------------------- row-level security

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (id = app_workspace_id()
         OR id IN (SELECT m.workspace_id FROM workspace_members m WHERE m.user_id = app_user_id()))
  WITH CHECK (id = app_workspace_id());

-- Members: visible inside the current workspace, plus the current user's own memberships
-- (needed at login to list the workspaces a user belongs to).
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_members
  USING (workspace_id = app_workspace_id() OR user_id = app_user_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Invites: visible inside the workspace, or by the holder of the invite token.
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invites
  USING (workspace_id = app_workspace_id()
         OR token_hash = nullif(current_setting('app.invite_token_hash', true), ''))
  WITH CHECK (workspace_id = app_workspace_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'contacts', 'consents', 'suppressions', 'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------- privileges

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions TO openline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, workspace_members, invites,
  companies, contacts, consents, suppressions TO openline_app;
-- The audit log is append-only for the application.
GRANT SELECT, INSERT ON audit_log TO openline_app;
GRANT EXECUTE ON FUNCTION app_workspace_id(), app_user_id() TO openline_app;
