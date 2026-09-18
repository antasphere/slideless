CREATE TABLE "form_response_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"presentation_id" uuid,
	"response_id" uuid,
	"share_token_id" uuid,
	"form_name" text NOT NULL,
	"field_name" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "form_response_versions" ADD COLUMN "files" jsonb;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "can_upload_files" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "form_response_files" ADD CONSTRAINT "form_response_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_response_files" ADD CONSTRAINT "form_response_files_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_response_files" ADD CONSTRAINT "form_response_files_response_id_form_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."form_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_response_files" ADD CONSTRAINT "form_response_files_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_response_files_response_idx" ON "form_response_files" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "form_response_files_presentation_idx" ON "form_response_files" USING btree ("presentation_id");--> statement-breakpoint
CREATE INDEX "form_response_files_unattached_idx" ON "form_response_files" USING btree ("created_at") WHERE "form_response_files"."response_id" is null;