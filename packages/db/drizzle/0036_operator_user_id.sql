-- CLOUD-3 / PRDCT-1356: the user setup minted as the instance operator. On
-- cloud the operator holds no membership (every cloud workspace is a hub
-- projection), which made them an orphan-purge candidate; the purge now
-- excludes this id by construction, and the cloud local-password door is
-- reserved for this user plus SUPERADMIN_EMAILS. NULL on pre-existing rows:
-- The backfill below recovers the operator of an instance set up BEFORE this
-- column existed from the genesis audit row (`instance.setup`, whose metadata
-- carries ownerUserId) — without it a pre-existing CLOUD instance would lose
-- its operator's local sign-in door on upgrade (the door is reserved for
-- this id + SUPERADMIN_EMAILS). Left NULL only when that row is gone or the
-- user no longer exists; the runbook covers setting it by hand then.
ALTER TABLE "instance_settings" ADD COLUMN "operator_user_id" text;--> statement-breakpoint
UPDATE "instance_settings" s
   SET "operator_user_id" = g.owner_id
  FROM (
    SELECT (metadata->>'ownerUserId') AS owner_id
      FROM "audit_log"
     WHERE action = 'instance.setup'
     ORDER BY created_at ASC
     LIMIT 1
  ) g
 WHERE s."operator_user_id" IS NULL
   AND g.owner_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = g.owner_id);