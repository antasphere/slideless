import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safe post-login redirect target. A single leading slash is not enough:
 * `//evil.com` and `/\evil.com` are protocol-relative/backslash tricks the
 * browser resolves to an external origin. Only allow a path that starts with
 * exactly one slash and no scheme, else fall back to the app root.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

/**
 * http(s)-only URL gate for OAuth client metadata (client_uri, logo_uri).
 * Registration is unauthenticated and unvalidated upstream, so anything
 * rendered into href/src is treated as hostile: a javascript: client_uri
 * would run in the dashboard origin. Returns null for anything not http(s).
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
