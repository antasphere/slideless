import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';

/**
 * The cloud landing after a hub demo link (28 September 2026): in ONE browser
 * already signed in to this instance as person A, a hub demo link for person
 * B redeems at the hub (the hub's session becomes B) and sends the browser to
 * this instance's `/login?next=…&relogin=1`. The page must end its OWN
 * session (A's) and sign in again through the hub, so the browser lands as B
 * on both sides. Before the fix the page saw a signed-in visitor and sent
 * them on to `next` as A, silently.
 *
 * Needs a running pair (playwright.pair.config.ts says which variables); the
 * hub's demo sign-in must be on (`DEMO_SIGN_IN=true` there) and the two
 * people must be members of the organization with demonstration addresses.
 */

const HUB = process.env.PW_PAIR_HUB;
const SL = process.env.PW_PAIR_SL;
const OWNER = process.env.PW_PAIR_OWNER_EMAIL ?? 'owner@example.com';
const OWNER_PASSWORD = process.env.PW_PAIR_OWNER_PASSWORD;
const ORG = process.env.PW_PAIR_ORG ?? 'Northwind';
const TOOL = process.env.PW_PAIR_TOOL ?? 'slideless-cloud';
const A = process.env.PW_PAIR_PERSON_A ?? 'jonas.peeters@example.com';
const B = process.env.PW_PAIR_PERSON_B ?? 'sam.leaver@drill.test';

test.skip(!HUB || !SL || !OWNER_PASSWORD, 'PW_PAIR_HUB, PW_PAIR_SL and PW_PAIR_OWNER_PASSWORD name the pair');

/** The signed-in person on one side, read through the context's own cookie jar. */
async function whoAmI(request: APIRequestContext, base: string): Promise<string | null> {
  const r = await request.get(`${base}/api/v1/me`, { headers: { origin: base } });
  if (r.status() !== 200) return null;
  const d = (await r.json()) as { user?: { email?: string } };
  return d.user?.email ?? null;
}

/** An owner's hub session in a request context of its own (never the browser's). */
async function mintTwoLinks(request: APIRequestContext): Promise<{ a: string; b: string }> {
  const signIn = await request.post(`${HUB}/api/v1/auth/sign-in/email`, {
    headers: { origin: HUB!, 'content-type': 'application/json' },
    data: { email: OWNER, password: OWNER_PASSWORD }
  });
  expect(signIn.status(), 'the owner signs in at the hub').toBe(200);
  const orgs = await request.get(`${HUB}/api/v1/orgs`, { headers: { origin: HUB! } });
  const list = (await orgs.json()) as { orgs?: { id: string; name: string }[] };
  const org = (list.orgs ?? []).find((o) => o.name === ORG);
  expect(org, `the organization ${ORG} is the owner's`).toBeTruthy();
  const mint = async (email: string) => {
    const r = await request.post(`${HUB}/api/v1/demo/passes`, {
      headers: { origin: HUB!, 'content-type': 'application/json', 'x-workspace-id': org!.id },
      data: { email, path: '/', toolSlug: TOOL, expiresInMinutes: 30 }
    });
    expect(r.status(), `a demo link for ${email}`).toBe(201);
    return ((await r.json()) as { url: string }).url;
  };
  return { a: await mint(A), b: await mint(B) };
}

async function openLink(context: BrowserContext, link: string): Promise<string> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(link);
  // The hub redeems, sends the browser to this instance's /login, which signs
  // in through the hub and lands on `next`: wait for the landing off /login.
  await page.waitForURL((u) => u.origin === new URL(SL!).origin && !u.pathname.startsWith('/login'), {
    timeout: 30_000
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  return page.url();
}

test('two demo links in one browser: the second lands as its own person on the tool and at the hub', async ({
  browser,
  playwright
}) => {
  const owner = await playwright.request.newContext();
  const links = await mintTwoLinks(owner);
  await owner.dispose();

  const context = await browser.newContext();
  try {
    await openLink(context, links.a);
    expect(await whoAmI(context.request, SL!), 'the tool after A’s link').toBe(A);
    expect(await whoAmI(context.request, HUB!), 'the hub after A’s link').toBe(A);

    await openLink(context, links.b);
    expect(await whoAmI(context.request, HUB!), 'the hub after B’s link').toBe(B);
    expect(await whoAmI(context.request, SL!), 'the tool after B’s link').toBe(B);
  } finally {
    await context.close();
  }
});

test('a relogin landing with no hub session ends the tool session and shows the form: the wrong person is never sent on', async ({
  browser,
  playwright
}) => {
  // The failure branch of the relogin landing (verifier round 2, G3): the
  // tool holds A, the hub holds nobody. The page must end A's session before
  // the silent start, so a refused start lands on the form with nobody signed
  // in; before the fix the page kept A and gate E sent them on to `next`.
  const owner = await playwright.request.newContext();
  const links = await mintTwoLinks(owner);
  await owner.dispose();

  const context = await browser.newContext();
  try {
    await openLink(context, links.a);
    expect(await whoAmI(context.request, SL!), 'the tool after A’s link').toBe(A);
    // The hub's own session cookie only: the parent-domain hint stays, so the
    // page takes the silent path and meets the hub's refusal.
    await context.clearCookies({ domain: new URL(HUB!).hostname });
    expect(await whoAmI(context.request, HUB!), 'the hub holds nobody').toBeNull();

    const page = context.pages()[0]!;
    await page.goto(`${SL}/login?next=%2Fdecks&relogin=1`);
    await expect(page.getByRole('button', { name: 'Sign in with Antasphere' })).toBeVisible({
      timeout: 30_000
    });
    expect(new URL(page.url()).pathname, 'still on the sign-in page').toBe('/login');
    expect(await whoAmI(context.request, SL!), 'the tool holds nobody').toBeNull();
  } finally {
    await context.close();
  }
});

test('a signed-in visitor on /login without the relogin key goes on to next, as before', async ({
  browser,
  playwright
}) => {
  const owner = await playwright.request.newContext();
  const links = await mintTwoLinks(owner);
  await owner.dispose();

  const context = await browser.newContext();
  try {
    await openLink(context, links.a);
    const page = context.pages()[0]!;
    await page.goto(`${SL}/login?next=%2F`);
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
    expect(await whoAmI(context.request, SL!), 'still A: no relogin key, no sign-out').toBe(A);
  } finally {
    await context.close();
  }
});
