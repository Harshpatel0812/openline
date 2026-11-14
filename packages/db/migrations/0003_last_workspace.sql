-- 0003_last_workspace: remember the workspace a user used last, so login returns them there.
ALTER TABLE users ADD COLUMN last_workspace_id uuid;
