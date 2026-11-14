-- Row-level security: a second wall between tenants, in case application code has a bug.
-- The API sets the current workspace at the start of every request/transaction:
--   SELECT set_config('app.workspace_id', '<uuid>', true);
-- Applied as a migration after the tables exist. The app connects as a role WITHOUT BYPASSRLS.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','companies','contacts','consents','suppressions','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'')::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'')::uuid)',
      t
    );
  END LOOP;
END $$;

-- The audit log is append-only for the application role.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
