CREATE TABLE "sso_connect_jtis" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
