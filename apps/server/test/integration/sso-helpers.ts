import { expect } from 'vitest';
import { extractCookie, readJson, type TestApp } from './helpers.js';
import type { FakeHub, HubUserFixture } from '../fake-hub.js';

/**
 * The SSO dance against the FakeHub, shared by the P3 (hub-sso) and P4
 * (hub-entitlements) suites: initiate the sign-in leg, drive the callback
 * with a hub-minted one-shot code, and hand back the session cookie.
 */

export const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let ipCounter = 0;
/** Unique per-dance client IP — the login limiter (10/15min per IP) must never gate a suite. */
export const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/**
 * Initiate the sign-in leg: returns the `state` plus the signed state
 * cookie the callback must present (better-auth's double-submit check —
 * a browser carries it automatically).
 */
export async function ssoInitiate(app: TestApp): Promise<{ state: string; stateCookie: string }> {
  const init = json({ providerId: 'antasphere', callbackURL: '/' });
  const signIn = await app.app.request('/api/v1/auth/sign-in/oauth2', {
    ...init,
    headers: { ...init.headers, 'x-forwarded-for': nextIp() }
  });
  expect(signIn.status).toBe(200);
  const { url } = await readJson(signIn);
  const state = new URL(url).searchParams.get('state')!;
  expect(state).toBeTruthy();
  return { state, stateCookie: extractCookie(signIn) };
}

/** Initiate the SSO dance and drive the callback with a hub-minted code. */
export async function ssoDance(app: TestApp, hub: FakeHub, fixture: HubUserFixture): Promise<Response> {
  const { state, stateCookie } = await ssoInitiate(app);
  const code = hub.mintCode(fixture);
  return app.app.request(
    `/api/v1/auth/oauth2/callback/antasphere?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: stateCookie } }
  );
}

/** A successful dance: 302 to the callbackURL with a live session cookie. */
export async function ssoLogin(app: TestApp, hub: FakeHub, fixture: HubUserFixture): Promise<string> {
  const res = await ssoDance(app, hub, fixture);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/');
  return extractCookie(res);
}

/** Assert a callback response is a session-less redirect carrying an error code. */
export async function expectFailedLogin(app: TestApp, res: Response, errorContains: string): Promise<void> {
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain(errorContains);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    // Whatever cookies the failure path left behind must not resolve a session.
    const me = await app.app.request('/api/v1/me', { headers: { cookie: extractCookie(res) } });
    expect(me.status).toBe(401);
  }
}
