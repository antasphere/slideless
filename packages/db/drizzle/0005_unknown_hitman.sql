DROP INDEX "api_keys_workspace_idx";--> statement-breakpoint
DROP INDEX "files_workspace_idx";--> statement-breakpoint
DROP INDEX "invitations_workspace_idx";--> statement-breakpoint
CREATE INDEX "api_keys_workspace_created_id_idx" ON "api_keys" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "files_workspace_created_id_idx" ON "files" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "invitations_workspace_created_id_idx" ON "invitations" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_created_id_idx" ON "workspace_members" USING btree ("workspace_id","created_at","id");