ALTER TABLE "audit_log" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;