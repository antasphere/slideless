import { z } from 'zod';

/**
 * API conventions (fixed): plain resource JSON on success — no
 * `{ success, data }` envelope; errors are `{ error: { code, message,
 * details? } }`; cursor pagination.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/**
 * Generic scopes; products define their own (e.g. products:read).
 * `data:export` is a deliberate opt-in for the full-workspace export — it
 * never rides `presentations:read`, or any admin read key would be a whole-tenant
 * exfiltration tool.
 */
export const scopeSchema = z.enum(['presentations:read', 'presentations:write', 'data:export']);
export type Scope = z.infer<typeof scopeSchema>;

export const cursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
/**
 * Free text a client may send that ends up in a Postgres `text`/`varchar`
 * column, a filename, or a log line.
 *
 * Postgres cannot store a NUL byte in a text value: it raises SQLSTATE 22021
 * from deep inside the driver, which surfaces as an unhandled 500 whose
 * error-level log line prints the failing statement AND its bound parameters.
 * An anonymous client can drive that on any free-text sink (`/setup`, the
 * invitation accept, the CLI key mint). NUL is never meaningful in a name, a
 * label, or a title, so the contract refuses it and the caller gets the
 * ordinary 400 validation_error instead.
 *
 * The other C0 controls are rejected with it: they are invisible in every UI,
 * they are the raw material of log-injection and terminal-escape tricks, and
 * no legitimate name contains one. Newlines and tabs are ALLOWED — multi-line
 * free text is a real thing; a sink that must stay single-line adds its own
 * `.regex()`.
 */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Tab / LF / CR are legitimate in multi-line free text.
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function noControlChars<T extends z.ZodType<string>>(schema: T): T {
  return schema.refine((v) => !hasControlChars(v), {
    error: 'must not contain NUL or other control characters'
  }) as unknown as T;
}

/**
 * The one free-text string builder: length-bounded and NUL-free.
 * Every user-supplied name/label/title in this contract goes through it.
 */
export function plainText(min: number, max: number) {
  return noControlChars(z.string().min(min).max(max));
}
