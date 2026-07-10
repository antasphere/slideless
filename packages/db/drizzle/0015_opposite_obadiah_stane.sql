ALTER TABLE "presentations" ADD COLUMN "total_views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "presentations" ADD COLUMN "last_viewed_at" timestamp with time zone;