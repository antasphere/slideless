import { safeNext } from '$lib/utils';

/**
 * The demo link's pure rules (the demo pass spec, section 7). A link reads
 * `<instance>/demo#pass=<secret>&to=<encoded path>`: the secret rides the
 * fragment so it never reaches a server log, and the `/demo` page takes it
 * out of the address bar before it asks anything.
 */

export interface DemoFragment {
  /** The pass's secret, or null when the fragment carries none. */
  pass: string | null;
  /** The page the link names, as written (not yet checked), or null. */
  to: string | null;
}

/** `pass` and `to` from a `location.hash`, read as URL search params after the `#`. */
export function parseDemoFragment(hash: string): DemoFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  return { pass: params.get('pass') || null, to: params.get('to') || null };
}

/**
 * Where a redeemed link lands: the link's own `to` when it is present and
 * safe, else the pass's page from the redeem's answer, else `/`. Both go
 * through `safeNext`, so every target is a path on this origin. `safeNext`
 * answers `/` for anything it refuses; only a `to` that is `/` itself keeps
 * that answer, any other refused `to` falls back to the pass's page.
 */
export function demoTarget(to: string | null, answerPath: string | null | undefined): string {
  if (to) {
    const target = safeNext(to);
    if (target !== '/' || to === '/') return target;
  }
  return safeNext(answerPath);
}

/**
 * Whether the instance says its demo sign-in is on (`GET /instance` carries
 * `demoSignIn: true` while the operator's switch is on, and no key
 * otherwise). Anything but `true` reads as off.
 */
export function demoSignInOn(instance: { demoSignIn?: boolean }): boolean {
  return instance.demoSignIn === true;
}
