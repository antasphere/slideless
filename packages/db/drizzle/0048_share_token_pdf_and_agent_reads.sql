ALTER TABLE "share_tokens" ADD COLUMN "can_export_pdf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "agent_read_count" integer DEFAULT 0 NOT NULL;