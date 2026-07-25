ALTER TABLE "presentation_versions" ADD COLUMN "has_agent_doc" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "has_agent_doc" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "presentation_versions" SET "has_agent_doc" = true WHERE "manifest" @> '[{"path":"AGENT.md"}]'::jsonb;--> statement-breakpoint
UPDATE "presentations" p SET "has_agent_doc" = true FROM "presentation_versions" v WHERE v."presentation_id" = p."id" AND v."version" = p."current_version" AND v."has_agent_doc" = true;
