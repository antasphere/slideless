CREATE TABLE "file_uploaders" (
	"file_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_uploaders_file_id_user_id_pk" PRIMARY KEY("file_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "file_uploaders" ADD CONSTRAINT "file_uploaders_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_uploaders" ADD CONSTRAINT "file_uploaders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_uploaders_user_idx" ON "file_uploaders" USING btree ("user_id");--> statement-breakpoint
-- SL-B1 backfill: the first uploader of every existing blob keeps possession
-- of it once /files reads become per-deck authorized. Rows whose uploader was
-- already anonymized (created_by NULL, GDPR account delete) have no uploader
-- to credit — those blobs stay reachable through the decks that reference
-- them, and through the operator view. ON CONFLICT keeps the backfill
-- re-runnable.
INSERT INTO "file_uploaders" ("file_id", "user_id", "created_at")
SELECT "id", "created_by", "created_at" FROM "files" WHERE "created_by" IS NOT NULL
ON CONFLICT ("file_id", "user_id") DO NOTHING;