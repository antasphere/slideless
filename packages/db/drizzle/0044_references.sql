ALTER TABLE "presentation_versions" ADD COLUMN "reference_type" text;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "reference" jsonb;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "reference_warning" text;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "reference_type" text;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "reference" jsonb;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "audience" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "is_default_reference" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "presentations_default_reference_uniq" ON "presentations" USING btree ("workspace_id","reference_type") WHERE "presentations"."is_default_reference" AND "presentations"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_audience_check" CHECK ("presentations"."audience" IN ('private', 'workspace'));