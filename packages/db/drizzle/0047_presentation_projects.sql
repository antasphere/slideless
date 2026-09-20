CREATE TABLE "presentation_projects" (
	"presentation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"is_brand" boolean DEFAULT false NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_projects_presentation_id_project_id_pk" PRIMARY KEY("presentation_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "presentation_projects" ADD CONSTRAINT "presentation_projects_presentation_id_presentations_id_fk" FOREIGN KEY ("presentation_id") REFERENCES "public"."presentations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_projects" ADD CONSTRAINT "presentation_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_projects" ADD CONSTRAINT "presentation_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_projects" ADD CONSTRAINT "presentation_projects_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_projects_project_idx" ON "presentation_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_projects_brand_uniq" ON "presentation_projects" USING btree ("project_id") WHERE "presentation_projects"."is_brand";