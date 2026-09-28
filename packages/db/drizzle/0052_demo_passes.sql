CREATE TABLE "demo_pass_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"pass_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"target_path" text DEFAULT '/' NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_pass_sessions" ADD CONSTRAINT "demo_pass_sessions_pass_id_demo_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."demo_passes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_passes" ADD CONSTRAINT "demo_passes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_passes" ADD CONSTRAINT "demo_passes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_passes" ADD CONSTRAINT "demo_passes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_passes_secret_hash_uniq" ON "demo_passes" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "demo_passes_workspace_created_idx" ON "demo_passes" USING btree ("workspace_id","created_at");