CREATE TABLE "project_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_teams_role_check" CHECK ("project_teams"."role" IN ('manager', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "workspace_teams" ALTER COLUMN "hub_team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_team_members" ADD COLUMN "added_by" text;--> statement-breakpoint
ALTER TABLE "workspace_teams" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_team_id_workspace_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."workspace_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_teams_project_team_uniq" ON "project_teams" USING btree ("project_id","team_id");--> statement-breakpoint
CREATE INDEX "project_teams_team_idx" ON "project_teams" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "project_teams_project_created_id_idx" ON "project_teams" USING btree ("project_id","created_at","id");--> statement-breakpoint
ALTER TABLE "workspace_team_members" ADD CONSTRAINT "workspace_team_members_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_teams" ADD CONSTRAINT "workspace_teams_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_teams_workspace_slug_local_uniq" ON "workspace_teams" USING btree ("workspace_id","slug") WHERE "workspace_teams"."hub_team_id" IS NULL;