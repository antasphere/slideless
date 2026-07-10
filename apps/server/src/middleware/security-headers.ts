import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { RuntimeState } from '../state.js';

/**
 * Baseline headers on every response (brief §2.6). The CSP applies to HTML
 * we serve (the dashboard SPA) and locks it to self — with hashes for the
 * inline bootstrap script SvelteKit bakes into index.html, computed once at
 * boot. User-uploaded content never renders on this origin (the files
 * module forces attachment for active types), so this CSP is the only HTML
 * policy the origin needs. frame-ancestors 'none' replaces X-Frame-Options.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? '';
    if (body.trim().length === 0) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  }
  return hashes;
}

export function buildCsp(scriptHashes: string[]): string {
  const script = ["'self'", ...scriptHashes].join(' ');
  return [
    "default-src 'self'",
    `script-src ${script}`,
    // Svelte injects component styles at runtime; hashes are impractical there.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
}

export interface SecurityHeaderOptions {
  csp: string;
  state: RuntimeState;
}

export function securityHeaders({ csp, state }: SecurityHeaderOptions): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    // Draining: ask keep-alive clients to reconnect elsewhere (rolling deploy).
    if (state.draining) c.header('connection', 'close');
    const contentType = c.res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      c.header('content-security-policy', csp);
    }
  };
}
