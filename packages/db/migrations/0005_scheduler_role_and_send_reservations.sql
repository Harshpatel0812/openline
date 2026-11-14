-- 0005: make the sending queue correct under production roles, and make double sends impossible.
--
-- 1. claim_due_enrollments() is SECURITY DEFINER. Owned by the migration role it ran as the table
--    owner, and FORCE ROW LEVEL SECURITY hid every row from it in production (where the owner is
--    not a superuser), so nothing was ever claimed. It now belongs to openline_scheduler: a NOLOGIN
--    role with no BYPASSRLS, whose only rights are SELECT/UPDATE on enrollments plus a policy that
--    lets it see all rows. Nobody logs in as it and openline_app is not a member.
--
-- 2. Send reservations: before the network send the engine inserts the outbound message row with
--    status 'sending'. A unique index on (enrollment_id, step_position) means a second worker that
--    picks up the same enrollment (e.g. after a lease ran out during a slow send) can't reserve —
--    and therefore can't send — the same step again. 'unconfirmed' marks a reservation whose worker
--    died mid-send: we don't know if it went out, so we never retry it automatically.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openline_scheduler') THEN
    CREATE ROLE openline_scheduler NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
-- The migration role must be able to hand the function over to it.
GRANT openline_scheduler TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO openline_scheduler;
GRANT SELECT, UPDATE ON enrollments TO openline_scheduler;

DROP POLICY IF EXISTS enrollments_scheduler_select ON enrollments;
DROP POLICY IF EXISTS enrollments_scheduler_update ON enrollments;
CREATE POLICY enrollments_scheduler_select ON enrollments
  FOR SELECT TO openline_scheduler USING (true);
CREATE POLICY enrollments_scheduler_update ON enrollments
  FOR UPDATE TO openline_scheduler USING (true) WITH CHECK (true);

ALTER FUNCTION claim_due_enrollments(integer) OWNER TO openline_scheduler;
REVOKE ALL ON FUNCTION claim_due_enrollments(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_enrollments(integer) TO openline_app;

ALTER TABLE messages
  ADD COLUMN status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sending', 'sent', 'unconfirmed'));

CREATE UNIQUE INDEX messages_enrollment_step_uidx
  ON messages (enrollment_id, step_position)
  WHERE direction = 'outbound' AND enrollment_id IS NOT NULL;
