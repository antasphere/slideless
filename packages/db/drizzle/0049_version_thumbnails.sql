CREATE TABLE "presentation_version_thumbnails" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_token_hash" text,
	"storage_key" text,
	"size_bytes" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_version_thumbnails_state_check" CHECK ("presentation_version_thumbnails"."state" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "presentation_version_thumbnails" ADD CONSTRAINT "presentation_version_thumbnails_version_id_presentation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."presentation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_version_thumbnails" ADD CONSTRAINT "presentation_version_thumbnails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_version_thumbnails" ADD CONSTRAINT "presentation_version_thumbnails_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_version_thumbnails_state_idx" ON "presentation_version_thumbnails" USING btree ("state","created_at");