-- 0010_compliance_proof: Compliance Copilot proof (OL-E6). Additive only.
--
-- messages.compliance_proof  the compliance evaluation that allowed an outbound email (ruleset
--                            version, decision, every check with its citation, evaluated at).
--                            Never the message body or the address. NULL for inbound messages and
--                            for emails sent before this migration.
--
-- The existing tenant_isolation policy and table grants on messages cover the new column.
--
-- Proof is evidence, so triggers guard it:
--   * it is written only on an outbound row, when the send is reserved (INSERT with status
--     'sending') or on that row's sending → sent/unconfirmed step; never on inbound mail and
--     never added to an email that already went out;
--   * once written it can't be changed or cleared;
--   * a row with proof can't go back to 'sending' and can't be deleted once it left 'sending'.
--     A failed send still deletes its own reservation row (status 'sending'), as before.
--
-- Erasure: deleting a contact (the documented path, DELETE /v1/contacts/:id) sets
-- messages.contact_id to NULL (ON DELETE SET NULL) — an UPDATE that touches neither the proof nor
-- the status, so it passes and the proof stays as evidence without the person's id. Deleting a
-- whole workspace (operator only; the app role can't delete workspaces) cascades to its messages:
-- a DELETE fired by that foreign-key cascade runs at trigger depth > 1 and is allowed. A direct
-- DELETE on messages, by any role, runs at depth 1 and is checked.

ALTER TABLE messages
  ADD COLUMN compliance_proof jsonb;

CREATE OR REPLACE FUNCTION messages_proof_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.compliance_proof IS NOT NULL
       AND (NEW.direction <> 'outbound' OR NEW.status <> 'sending') THEN
      RAISE EXCEPTION 'compliance_proof is recorded only when an outbound send is reserved'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.compliance_proof IS NOT NULL THEN
    IF NEW.compliance_proof IS DISTINCT FROM OLD.compliance_proof THEN
      RAISE EXCEPTION 'compliance_proof is immutable once recorded'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'sending' AND NEW.status = 'sending' THEN
      RAISE EXCEPTION 'an email with compliance_proof cannot return to sending'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.direction <> 'outbound' THEN
      RAISE EXCEPTION 'compliance_proof belongs to outbound email only'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.compliance_proof IS NOT NULL
        AND (OLD.direction <> 'outbound' OR NEW.direction <> 'outbound'
             OR OLD.status <> 'sending') THEN
    RAISE EXCEPTION 'compliance_proof is recorded only when an outbound send is reserved'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION messages_proof_no_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Depth 1 = a DELETE statement on messages itself; deeper = a foreign-key cascade (only the
  -- workspace's ON DELETE CASCADE deletes messages; contact/enrollment/mailbox use SET NULL).
  IF OLD.compliance_proof IS NOT NULL AND OLD.status <> 'sending' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'an email with compliance_proof cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS messages_proof_immutable ON messages;
DROP FUNCTION IF EXISTS messages_proof_immutable();
DROP TRIGGER IF EXISTS messages_proof_guard ON messages;
CREATE TRIGGER messages_proof_guard
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_proof_guard();

DROP TRIGGER IF EXISTS messages_proof_no_delete ON messages;
CREATE TRIGGER messages_proof_no_delete
  BEFORE DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_proof_no_delete();
