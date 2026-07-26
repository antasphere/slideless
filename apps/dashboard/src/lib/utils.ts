import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The origin `safeNext` resolves candidates against. Any absolute value —
 * `https://evil.example/`, `//evil.example/`, `javascript:…` — resolves to a
 * DIFFERENT origin than this one and is refused; only a same-origin result
 * survives. A constant sentinel rather than `location.origin` so the function
 * behaves identically in SSR, in tests, and in the browser.
 */
const SAFE_NEXT_BASE = 'https://safe-next.invalid';

/**
 * Every C0 control and the space — a superset of what the WHATWG URL parser
 * removes before it parses (leading/trailing C0 + space, and tab/LF/CR
 * anywhere). This is the whole bug class prefix-matching misses:
 * `/\t//evil.example/` does not start with `//`, so a `startsWith('//')` check
 * waves it through, and the browser then strips the tab and navigates to
 * `//evil.example/` — off-origin. `?next=/%09//evil.example/` decodes to
 * exactly that value. Stripping the superset is deliberate: none of these
 * characters belong in a path we generated, so anything carrying one is a
 * smuggling attempt whichever parser eventually reads it.
 */
function stripUrlIgnoredChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) continue;
    out += value[i];
  }
  return out;
}

/**
 * Safe post-login redirect target: a path on THIS origin, or `/`.
 *
 * Three layers, because each catches what the others miss:
 *  1. strip the characters the URL parser would strip, so what we judge is
 *     what the browser will navigate to;
 *  2. reject the protocol-relative (`//host`) and backslash (`/\host`) forms
 *     before parsing — the parser normalizes `\` to `/`, so a parsed result
 *     can still be off-origin while looking like a path;
 *  3. resolve against a sentinel origin and require the result to stay on it,
 *     which catches every scheme, credential (`/@evil`), and encoding trick
 *     that layers 1 and 2 do not enumerate.
 * The value returned is the RE-SERIALIZED path, never the caller's string.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return '/';
  const cleaned = stripUrlIgnoredChars(next);
  if (!cleaned.startsWith('/')) return '/';
  if (cleaned.startsWith('//') || cleaned.startsWith('/\\')) return '/';
  let resolved: URL;
  try {
    resolved = new URL(cleaned, SAFE_NEXT_BASE);
  } catch {
    return '/';
  }
  if (resolved.origin !== SAFE_NEXT_BASE) return '/';
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  // Belt and braces: a path that resolves same-origin can still SERIALIZE to
  // something a browser would re-read as protocol-relative (`/a/..//evil`).
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
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
