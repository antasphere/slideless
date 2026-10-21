ALTER TABLE "presentation_versions" ADD COLUMN "data_schema" jsonb;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "data_sample" jsonb;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "data_bindings" jsonb;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "document_data" jsonb;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "schema_version" text;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "data_source" text;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "data_changed" jsonb;--> statement-breakpoint
ALTER TABLE "presentation_versions" ADD COLUMN "data_answered_by" text;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "schema_version" text;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "document_data" jsonb;--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_template_id_presentations_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."presentations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentations_template_id_idx" ON "presentations" USING btree ("template_id") WHERE "presentations"."template_id" IS NOT NULL;