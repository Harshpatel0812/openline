-- 0002_harden_policies: tighten write access found in the Sprint 1–2 security review.
--
-- 1. A user could DELETE/UPDATE their own membership rows in OTHER workspaces, because the
--    single policy also covered writes. Reads of one's own memberships stay allowed (login);
--    writes now require the current workspace.
-- 2. The invite-token holder only needs to READ the invite.
-- 3. The app must not delete workspaces (that would also cascade-delete the audit log).
-- 4. The audit log must survive workspace deletion: RESTRICT instead of CASCADE.

DROP POLICY tenant_isolation ON workspace_members;
CREATE POLICY members_read ON workspace_members FOR SELECT
  USING (workspace_id = app_workspace_id() OR user_id = app_user_id());
CREATE POLICY members_insert ON workspace_members FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY members_update ON workspace_members FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY members_delete ON workspace_members FOR DELETE
  USING (workspace_id = app_workspace_id());

DROP POLICY tenant_isolation ON invites;
CREATE POLICY invites_read ON invites FOR SELECT
  USING (workspace_id = app_workspace_id()
         OR token_hash = nullif(current_setting('app.invite_token_hash', true), ''));
CREATE POLICY invites_insert ON invites FOR INSERT
  WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY invites_update ON invites FOR UPDATE
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY invites_delete ON invites FOR DELETE
  USING (workspace_id = app_workspace_id());

DROP POLICY tenant_isolation ON workspaces;
CREATE POLICY workspaces_read ON workspaces FOR SELECT
  USING (id = app_workspace_id()
         OR id IN (SELECT m.workspace_id FROM workspace_members m WHERE m.user_id = app_user_id()));
CREATE POLICY workspaces_insert ON workspaces FOR INSERT
  WITH CHECK (id = app_workspace_id());
CREATE POLICY workspaces_update ON workspaces FOR UPDATE
  USING (id = app_workspace_id()) WITH CHECK (id = app_workspace_id());

REVOKE DELETE ON workspaces FROM openline_app;

ALTER TABLE audit_log DROP CONSTRAINT audit_log_workspace_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
