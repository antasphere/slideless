-- Race-free floor under the app-level last-owner guards (ADR 006): the
-- workspace can never drop to zero ACTIVE owners, whatever the code path —
-- concurrent HTTP surfaces, future code, or operator SQL through the app
-- role. Plain READ COMMITTED visibility is NOT enough (two concurrent
-- removals each see the other's row still present), so the trigger first
-- takes a per-workspace pg_advisory_xact_lock: the second remover blocks
-- until the first commits, then its EXISTS check (a fresh snapshot — the
-- trigger function is VOLATILE) sees the committed truth and raises.
-- Transaction-scoped lock = it can never leak. Key namespace (7432002, hash)
-- is distinct from the migration lock (7432001) and the app's owner-delete
-- serialization lock (7432003, accounts/deletion.ts).
-- Raised SQLSTATE P0409 is mapped to `400 last_owner` at the API surfaces.
-- NOTE for a future workspace-delete flow: deleting a whole workspace
-- cascades member rows through this trigger — remove the trigger (or the
-- members after the owner) inside that flow's transaction.
CREATE FUNCTION enforce_last_active_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.role = 'owner' AND NEW.is_active
     AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NEW; -- still an active owner here (e.g. last_seen_at touch)
  END IF;
  PERFORM pg_advisory_xact_lock(7432002, hashtext(OLD.workspace_id::text));
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
     WHERE workspace_id = OLD.workspace_id
       AND role = 'owner' AND is_active AND id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'workspace % must keep at least one active owner', OLD.workspace_id
      USING ERRCODE = 'P0409';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workspace_members_last_owner_guard
BEFORE DELETE OR UPDATE ON workspace_members
FOR EACH ROW
WHEN (OLD.role = 'owner' AND OLD.is_active)
EXECUTE FUNCTION enforce_last_active_owner();
