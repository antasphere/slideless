CREATE TABLE "share_token_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"share_token_id" uuid,
	"version" integer NOT NULL,
	"name" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "has_downloads" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "has_downloads" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "can_download" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "download_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_token_downloads" ADD CONSTRAINT "share_token_downloads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_token_downloads" ADD CONSTRAINT "share_token_downloads_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_token_downloads" ADD CONSTRAINT "share_token_downloads_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_token_downloads_token_occurred_id_idx" ON "share_token_downloads" USING btree ("share_token_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "share_token_downloads_occurred_idx" ON "share_token_downloads" USING btree ("occurred_at");--> statement-breakpoint
-- Backfill (PRDCT-2278): the `downloads/` convention is new, but a deck pushed
-- before it may already carry that folder. Stamp those versions so the mirror
-- never lies about an older deck; the deck row mirrors its CURRENT version.
-- `downloads/_%` requires at least one character after the slash, the same
-- rule as the contract's isAttachmentPath.
UPDATE "presentation_versions" SET "has_downloads" = true
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("manifest") e
  WHERE e->>'path' LIKE 'downloads/_%'
);--> statement-breakpoint
UPDATE "presentations" p SET "has_downloads" = true
FROM "presentation_versions" v
WHERE v."presentation_id" = p."id" AND v."version" = p."current_version" AND v."has_downloads" = true;
