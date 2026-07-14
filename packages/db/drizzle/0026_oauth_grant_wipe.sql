-- Forced re-consent for the user-scoped credential model (no real users yet —
-- breaking is fine): OAuth grants stop binding a workspace ("act as you"), so
-- every consent recorded under the old per-workspace model must die rather
-- than short-circuit a future authorize into an org-free grant it never
-- approved. Refresh tokens minted under the old model die with their
-- consents; the oauth_access_token rows hanging off a refresh token cascade
-- with it (FK ON DELETE CASCADE), and any standalone opaque access-token rows
-- are already dead at the bearer gate (looksLikeJwt). Parked consent-page
-- workspace selections use a deleted identifier scheme — sweep them too.
DELETE FROM "oauth_consent";--> statement-breakpoint
DELETE FROM "oauth_refresh_token";--> statement-breakpoint
DELETE FROM "verification" WHERE "identifier" LIKE 'oauth-workspace:%';
