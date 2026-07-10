ALTER TABLE "invitations" ADD COLUMN "email_token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_email_token_hash_uniq" ON "invitations" USING btree ("email_token_hash");