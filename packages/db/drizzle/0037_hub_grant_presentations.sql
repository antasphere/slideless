CREATE TABLE "hub_grant_presentations" (
	"account_id" text PRIMARY KEY NOT NULL,
	"refresh_token" text NOT NULL,
	"presented_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_grant_presentations" ADD CONSTRAINT "hub_grant_presentations_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;