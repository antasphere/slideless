import { z } from 'zod';

/**
 * CLI cross-tool connect (cloud edition only — docs/federation.md P5):
 *
 *   POST /sso/cli-connect — exchange a hub-minted 120 s JWT for an `slk_` key
 *
 * The counterpart of the hub's H3 `POST /sso/tool-token`: `antasphere login`
 * mints a hub API key once; the hub exchanges it for a short-lived RS256 JWT
 * (`aud` = THIS instance's resource URL, `purpose: 'sso-connect'`, unique
 * `jti`), and this endpoint turns that JWT into an ordinary local API key —
 * no tool-specific login. PUBLIC path (the hub JWT IS the credential),
 * rate-limited, jti one-time-use. Registered ONLY on EDITION=cloud; an oss
 * instance answers 404 (the route does not exist there).
 *
 * The response reuses the CLI-auth completion shape (`CliAuthCompleted`) —
 * the mint semantics are identical: presentations:read + presentations:write,
 * never data:export, full key shown exactly once.
 */

export const ssoCliConnectSchema = z.object({
  /** The hub-minted exchange JWT (compact JWS — three base64url segments). */
  token: z.string().min(20).max(4096)
});
export type SsoCliConnect = z.infer<typeof ssoCliConnectSchema>;
