CREATE TABLE "share_token_view_windows" (
	"share_token_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"window_until" timestamp with time zone NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"count_at_start" integer NOT NULL,
	"pending" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_token_view_windows" ADD CONSTRAINT "share_token_view_windows_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_token_view_windows" ADD CONSTRAINT "share_token_view_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_token_view_windows" ADD CONSTRAINT "share_token_view_windows_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;