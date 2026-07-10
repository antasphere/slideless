CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"name" text NOT NULL,
	"setup_completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"telemetry_enabled" boolean DEFAULT false NOT NULL
);
