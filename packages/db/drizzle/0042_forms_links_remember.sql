CREATE TABLE "form_response_mail_state" (
	"presentation_id" uuid PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"pending_new" integer DEFAULT 0 NOT NULL,
	"pending_edited" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_response_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"version" integer NOT NULL,
	"share_token_id" uuid,
	"source" text DEFAULT 'link' NOT NULL,
	"placement" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_responses" ADD COLUMN "remembered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "form_responses" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "notify_on_response" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "remembers_responses" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "form_response_mail_state" ADD CONSTRAINT "form_response_mail_state_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_response_versions" ADD CONSTRAINT "form_response_versions_response_id_form_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."form_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_response_versions" ADD CONSTRAINT "form_response_versions_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_response_versions_response_revision_uniq" ON "form_response_versions" USING btree ("response_id","revision");--> statement-breakpoint
CREATE INDEX "form_responses_presentation_form_updated_id_idx" ON "form_responses" USING btree ("presentation_id","form_name","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_token_form_remembered_uniq" ON "form_responses" USING btree ("share_token_id","form_name") WHERE "form_responses"."remembered";--> statement-breakpoint
INSERT INTO "form_response_versions" ("response_id", "revision", "version", "share_token_id", "source", "placement", "payload", "created_at")
SELECT "id", 1, "version", "share_token_id", "source", "placement", "payload", "updated_at" FROM "form_responses";
