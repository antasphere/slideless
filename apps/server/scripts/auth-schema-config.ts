import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, jwt, twoFactor } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';

/**
 * CLI-only Better Auth config used by `@better-auth/cli generate` to emit the
 * canonical Drizzle schema for the auth-owned tables, and by the CI drift
 * guard to detect when a Better Auth upgrade changes the expected shape.
 *
 * Keep the plugin list in sync with the runtime config in
 * src/identity/better-auth.ts — plugins add tables (jwt → jwks, oauthProvider
 * → oauth*, twoFactor → two_factor + user.two_factor_enabled), and the drift
 * guard only covers what is declared here.
 */
export const auth = betterAuth({
  baseURL: 'http://localhost:3000',
  basePath: '/api/v1/auth',
  secret: 'schema-generation-only-not-a-real-secret',
  database: drizzleAdapter({} as never, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  // Mirrors the runtime config (src/identity/better-auth.ts): pins the
  // assumption that token encryption at rest is CONFIG-ONLY — if a Better
  // Auth bump ever grows schema for it, the drift guard catches it here.
  account: { encryptOAuthTokens: true },
  plugins: [
    jwt({
      disableSettingJwtHeader: true,
      jwks: { keyPairConfig: { alg: 'RS256' } }
    }),
    oauthProvider({
      loginPage: '/login',
      consentPage: '/oauth/consent'
    }),
    twoFactor(),
    // Cloud edition only at runtime (conditional on EDITION=cloud); declared
    // here unconditionally to pin the assumption that genericOAuth adds NO
    // tables (it rides the existing account/verification rows) — if a Better
    // Auth bump ever changes that, this drift guard catches it before an
    // unmigrated cloud boot does.
    genericOAuth({
      config: [
        {
          providerId: 'antasphere',
          clientId: 'schema-generation-only',
          discoveryUrl: 'http://hub.invalid/.well-known/openid-configuration'
        }
      ]
    })
  ]
});
