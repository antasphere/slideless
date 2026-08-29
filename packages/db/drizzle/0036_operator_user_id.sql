-- CLOUD-3 / PRDCT-1356: the user setup minted as the instance operator. On
-- cloud the operator holds no membership (every cloud workspace is a hub
-- projection), which made them an orphan-purge candidate; the purge now
-- excludes this id by construction, and the cloud local-password door is
-- reserved for this user plus SUPERADMIN_EMAILS. NULL on pre-existing rows:
-- an instance set up before this column keeps its allowlist-based shelter.
ALTER TABLE "instance_settings" ADD COLUMN "operator_user_id" text;