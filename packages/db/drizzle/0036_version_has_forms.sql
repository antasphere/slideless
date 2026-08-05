-- ADR 022 / PRDCT-1333: whether a deck version actually carries a marked
-- `data-slideless-form`, detected once at commit (presentations/service.ts)
-- exactly like has_agent_doc in 0031, and denormalized onto the deck row.
--
-- The viewer's injection seam reads it: without it the seam armed the
-- transform for EVERY share link (can_submit_forms defaults ON), which took
-- every deck off the streaming, ETag-carrying serve path.
--
-- Backfill is deliberately FALSE for existing rows: detection needs the blob
-- bytes, which SQL cannot reach, and the forms feature has never shipped, so
-- no existing version can hold a working form to regress. A deck authored
-- before this migration stamps the flag on its next push.
ALTER TABLE "presentation_versions" ADD COLUMN "has_forms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "has_forms" boolean DEFAULT false NOT NULL;