CREATE TABLE "form_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"form_name" text NOT NULL,
	"share_token_id" uuid,
	"source" text DEFAULT 'link' NOT NULL,
	"placement" text,
	"respondent_user_id" text,
	"response_secret_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "can_submit_forms" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_respondent_user_id_user_id_fk" FOREIGN KEY ("respondent_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_secret_hash_uniq" ON "form_responses" USING btree ("response_secret_hash");--> statement-breakpoint
CREATE INDEX "form_responses_presentation_form_created_id_idx" ON "form_responses" USING btree ("presentation_id","form_name","created_at","id");--> statement-breakpoint
CREATE INDEX "form_responses_share_token_idx" ON "form_responses" USING btree ("share_token_id");