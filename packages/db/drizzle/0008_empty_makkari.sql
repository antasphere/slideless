ALTER TABLE "files" DROP CONSTRAINT "files_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;