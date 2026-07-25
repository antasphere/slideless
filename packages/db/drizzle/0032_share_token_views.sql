CREATE TABLE "share_token_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"share_token_id" uuid,
	"version" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"referrer_host" text,
	"placement" text,
	"ua_family" text
);
--> statement-breakpoint
ALTER TABLE "share_token_views" ADD CONSTRAINT "share_token_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_token_views" ADD CONSTRAINT "share_token_views_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_token_views" ADD CONSTRAINT "share_token_views_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_token_views_token_occurred_id_idx" ON "share_token_views" USING btree ("share_token_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "share_token_views_occurred_idx" ON "share_token_views" USING btree ("occurred_at");