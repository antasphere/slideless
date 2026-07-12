-- D11 (slideless-cloud-binding-plan): the last-owner guard applies ONLY to
-- workspaces this instance owns (central_account_id IS NULL). A projected
-- (hub-origin) workspace asserts ownership hub-side — its local membership
-- rows are a re-syncable projection (re-created at every SSO login), so a
-- zero-local-owner state there is legal, recoverable, and must not block
-- the hub re-assertion from deactivating/removing rows. Inert until the
-- cloud edition creates the first projection (no row has a
-- central_account_id today); the non-projected path is byte-identical to
-- migration 0009's function.
CREATE OR REPLACE FUNCTION enforce_last_active_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.role = 'owner' AND NEW.is_active
     AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NEW; -- still an active owner here (e.g. last_seen_at touch)
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspaces
     WHERE id = OLD.workspace_id AND central_account_id IS NOT NULL
  ) THEN
    -- Projected workspace: ownership is hub truth, no local floor to hold.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
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
$$;
