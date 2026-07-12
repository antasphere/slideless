import { z } from 'zod';
import { apiKeySchema } from './api-keys.js';

/**
 * Browserless CLI/agent sign-in: email OTP → API key. Two PUBLIC (pre-auth)
 * endpoints, mounted like /setup outside the principal machinery:
 *
 *   POST /cli/auth/request  — send a 6-digit sign-in code to the email
 *   POST /cli/auth/complete — verify the code, mint an `slk_` API key
 *
 * Sign-up stays CLOSED: the flow rides the emailOTP plugin with
 * `disableSignUp: true`, so a code only ever signs in an EXISTING account
 * (created via setup, a workspace invitation, or a collaborator claim).
 * `request` answers a generic success for unknown emails (no enumeration);
 * `complete` for an unknown email fails exactly like a wrong code.
 */

export const cliAuthRequestSchema = z.object({
  email: z.email()
});
export type CliAuthRequest = z.infer<typeof cliAuthRequestSchema>;

/** Always `sent: true` on 2xx — deliberately silent about account existence. */
export const cliAuthRequestedSchema = z.object({
  sent: z.literal(true)
});
export type CliAuthRequested = z.infer<typeof cliAuthRequestedSchema>;

export const cliAuthCompleteSchema = z.object({
  email: z.email(),
  otp: z.string().min(4).max(16),
  /** Display name for the minted key (defaults to a CLI-login label). */
  keyName: z.string().min(1).max(120).optional(),
  /** TTL at mint; the server computes the absolute expiry. Omit = never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /**
   * Workspace the key binds (ADR 012) — the account must hold an ACTIVE
   * membership of it. Omit = the deterministic default (oldest active
   * membership), which is the only membership for most accounts.
   */
  workspaceId: z.uuid().optional()
});
export type CliAuthComplete = z.infer<typeof cliAuthCompleteSchema>;

/** The full key appears exactly once, in this response (API-key semantics). */
export const cliAuthCompletedSchema = z.object({
  /** Full key `<prefix>_<keyid>_<secret>` — shown once, never retrievable. */
  key: z.string(),
  apiKey: apiKeySchema,
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string()
  }),
  workspaceId: z.string()
});
export type CliAuthCompleted = z.infer<typeof cliAuthCompletedSchema>;
