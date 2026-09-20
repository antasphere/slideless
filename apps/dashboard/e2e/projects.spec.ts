import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signInAsOwner } from './accounts';

/**
 * PRDCT-2582 / PRDCT-2584 — the Projects section, end to end against the real
 * stack (`dependencies: ['smoke']`, so the instance and the owner exist).
 *
 * The section is the SHELL's: every tool built on the chassis gets the list,
 * the create dialog, the project page with its members and roles, and the
 * archive. The tool contributes what a project HOLDS through one door
 * (`project.Resources`, here `ProjectDecks`); this spec asserts only that its
 * section is present, never its content — the decks are PRDCT-2584's own.
 *
 * Four people walk the section, plus the owner:
 *
 *   OWNER      workspace owner: a manager on EVERY project (the operator
 *              view, ADR 006), member row or not.
 *   MANAGER    a plain workspace member given `manager` on the project.
 *   EDITOR     `editor`: writes what is linked, never the project itself.
 *   VIEWER     `viewer`: reads.
 *   OUTSIDER   a plain workspace member who is in NO project: the list is
 *              empty and the project's own address is the calm not-found page
 *              (404, never 403 — the ADR 013 posture the chassis router
 *              applies to `GET /projects/{id}`).
 *
 * Every assertion is a PAIR: a control is asserted PRESENT for whoever may
 * use it and ABSENT (`toHaveCount(0)`) for whoever may not. The dashboard's
 * reading of the rules is `$lib/projects/can.ts`; the server's is the tiered
 * 404 / 403 / 409 of `packages/chassis-server/src/api/projects.ts`.
 *
 * GUESTS ARE OUT OF SCOPE, deliberately: the e2e suite has no guest fixture
 * (a guest is minted by the per-deck collaborator claim path, D2), so the
 * "Projects are not available to a guest" branch of the page and the
 * `guest_target` refusal of the add route are left to the integration tests.
 *
 * BUDGET — the sign-in throttle is shared by the whole suite (LESSONS): each
 * person signs in ONCE, in `beforeAll`, on their own browser context, and
 * every test reuses that context's page. Five logins for the whole file. All
 * the seeding (the people, the project, its members, the archived project) is
 * done through the API on the owner's cookie, each call asserting its own
 * status, so a broken fixture fails loudly instead of passing as a 4xx.
 */

const PROJECT_NAME = 'E2E Autumn launch';
const PROJECT_DESCRIPTION = 'Every deck of the October launch.';
const ARCHIVED_NAME = 'E2E Retired project';
const CREATED_NAME = 'E2E Created from the dialog';

/**
 * One person of the walk. The accounts are made through the invitation API,
 * which takes the ONE `name` the account form sends joined — no first/last
 * split is needed here (accounts.ts carries that split for the UI forms).
 */
interface Person {
  name: string;
  email: string;
  password: string;
}

const person = (slug: string, first: string): Person => ({
  name: `${first} Proj`,
  email: `${slug}@example.com`,
  password: `${slug}-password-123`
});

const MANAGER = person('proj-manager', 'Mona');
const EDITOR = person('proj-editor', 'Edie');
const VIEWER = person('proj-viewer', 'Vera');
const OUTSIDER = person('proj-outsider', 'Otto');

/** Desk and phone, the two widths the section is walked at. */
const DESK = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };

/**
 * Sign in through the login page: the shape of `signInAsOwner`, throttle wait
 * included (the e2e projects run back to back on one worker, so the sign-in
 * throttle can answer here). accounts.ts has no generic helper and is not
 * this lane's to edit, so it lives here.
 */
async function signInAs(page: Page, who: Person): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // isVisible() does not wait, and the refusal lands a beat after the click.
  const throttled = await page
    .getByText('Too many attempts')
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (throttled) {
    await page.waitForTimeout(12_000);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
}

/**
 * Make one workspace member, the way smoke.spec.ts and brands.spec.ts do it:
 * the owner mints an invitation through the API, the person accepts it in a
 * CLEAN context (the accept endpoint is public and takes no cookies), and the
 * account exists. Both calls assert their own status.
 */
async function createMember(owner: Page, browser: Browser, who: Person): Promise<void> {
  const invite = await owner.request.post('/api/v1/invitations', {
    data: { email: who.email, role: 'member' }
  });
  expect(invite.status(), `invite ${who.email}`).toBe(201);
  const { acceptUrl } = await invite.json();
  const token = new URL(acceptUrl).pathname.split('/invite/')[1];
  expect(token, `invite token for ${who.email}`).toBeTruthy();

  const clean = await browser.newContext();
  const accepted = await clean.request.post('/api/v1/invitations/accept', {
    data: { token, name: who.name, password: who.password }
  });
  expect(accepted.status(), `accept ${who.email}`).toBe(200);
  await clean.close();
}

/** Open a DataTable row's "…" menu — the `Open menu` button of DataTableActions. */
function rowMenu(scope: Page, email: string) {
  return scope.getByRole('row', { name: new RegExp(email.replace('.', '\\.')) });
}

/** The project's page, read through the API as one person: `myRole` and the status. */
async function readProject(page: Page, id: string): Promise<{ status: number; myRole?: string }> {
  const res = await page.request.get(`/api/v1/projects/${id}`);
  if (res.status() !== 200) return { status: res.status() };
  return { status: 200, myRole: (await res.json()).myRole };
}

// The five contexts, opened once and reused by every test in the file.
let ownerContext: BrowserContext;
let owner: Page;
const sessions: Record<string, { context: BrowserContext; page: Page }> = {};

let projectId = '';
let archivedId = '';
const userIds: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.describe('Projects — the shell section, four people and two widths', () => {
  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({ viewport: DESK });
    owner = await ownerContext.newPage();
    await signInAsOwner(owner);

    // ── The people ───────────────────────────────────────────────────────
    for (const who of [MANAGER, EDITOR, VIEWER, OUTSIDER]) {
      await createMember(owner, browser, who);
    }

    // Their user ids, from the workspace roster the owner reads.
    const roster = await owner.request.get('/api/v1/members?limit=100');
    expect(roster.status(), 'roster').toBe(200);
    const { members } = await roster.json();
    for (const who of [MANAGER, EDITOR, VIEWER, OUTSIDER]) {
      const row = members.find((m: { email: string }) => m.email.toLowerCase() === who.email);
      expect(row, `roster row for ${who.email}`).toBeTruthy();
      userIds[who.email] = row.userId;
    }

    // ── The seeded project, and the archived one ─────────────────────────
    const created = await owner.request.post('/api/v1/projects', {
      data: { name: PROJECT_NAME, description: PROJECT_DESCRIPTION }
    });
    expect(created.status(), 'create project').toBe(201);
    const project = await created.json();
    projectId = project.id;
    // The creator is its first manager, in the same transaction.
    expect(project.myRole).toBe('manager');
    expect(project.archivedAt).toBeNull();

    for (const [who, role] of [
      [MANAGER, 'manager'],
      [EDITOR, 'editor'],
      [VIEWER, 'viewer']
    ] as const) {
      const added = await owner.request.post(`/api/v1/projects/${projectId}/members`, {
        data: { userId: userIds[who.email], role }
      });
      expect(added.status(), `add ${who.email} as ${role}`).toBe(201);
      expect((await added.json()).role).toBe(role);
    }

    const retired = await owner.request.post('/api/v1/projects', {
      data: { name: ARCHIVED_NAME, description: 'Kept for the record.' }
    });
    expect(retired.status(), 'create the project to archive').toBe(201);
    archivedId = (await retired.json()).id;
    const archived = await owner.request.post(`/api/v1/projects/${archivedId}/archive`);
    expect(archived.status(), 'archive it').toBe(200);
    expect((await archived.json()).archivedAt).not.toBeNull();

    // ── One sign-in per person, on their own context ─────────────────────
    for (const who of [MANAGER, EDITOR, VIEWER, OUTSIDER]) {
      const context = await browser.newContext({ viewport: DESK });
      const page = await context.newPage();
      await signInAs(page, who);
      sessions[who.email] = { context, page };
    }
  });

  test.afterAll(async () => {
    for (const { context } of Object.values(sessions)) await context.close();
    await ownerContext?.close();
  });

  // ──────────────────────────────────────────────────────────────────────
  // The owner: a manager on every project, and the one who creates
  // ──────────────────────────────────────────────────────────────────────

  test('the owner: the list, the archived filter, the create dialog', async () => {
    await owner.goto('/projects');
    await expect(owner.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({
      timeout: 20_000
    });

    await test.step('the active list holds the seeded project as Manager, not the archived one', async () => {
      const row = owner.getByRole('row', { name: new RegExp(PROJECT_NAME) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText(PROJECT_DESCRIPTION);
      await expect(row).toContainText('Manager');
      await expect(row).toContainText('Active');
      // The default filter is the live projects: the archived one is absent.
      await expect(owner.getByRole('row', { name: new RegExp(ARCHIVED_NAME) })).toHaveCount(0);
    });

    await test.step('Archived shows the archived one, and only it', async () => {
      await owner.getByRole('combobox', { name: 'Which projects to show' }).click();
      await owner.getByRole('option', { name: 'Archived', exact: true }).click();
      const row = owner.getByRole('row', { name: new RegExp(ARCHIVED_NAME) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText('Archived');
      await expect(owner.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toHaveCount(0);
    });

    await test.step('All shows both', async () => {
      await owner.getByRole('combobox', { name: 'Which projects to show' }).click();
      await owner.getByRole('option', { name: 'All', exact: true }).click();
      await expect(owner.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toBeVisible({
        timeout: 15_000
      });
      await expect(owner.getByRole('row', { name: new RegExp(ARCHIVED_NAME) })).toBeVisible();
      // back to the live list for the rest of the walk
      await owner.getByRole('combobox', { name: 'Which projects to show' }).click();
      await owner.getByRole('option', { name: 'Active', exact: true }).click();
      await expect(owner.getByRole('row', { name: new RegExp(ARCHIVED_NAME) })).toHaveCount(0);
    });

    await test.step('New project: the dialog creates one and lands on its page', async () => {
      await owner.getByRole('button', { name: 'New project', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'New project' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Name', { exact: true }).fill(CREATED_NAME);
      await dialog.getByLabel('Description', { exact: true }).fill('Made by the e2e walk.');
      await dialog.getByRole('button', { name: 'Create project', exact: true }).click();

      // The page of the project that was just made: its band carries the name…
      await expect(owner).toHaveURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(owner.getByRole('heading', { name: CREATED_NAME, level: 1 })).toBeVisible();
      // …and the creator is its first manager.
      await expect(owner.getByText('Your role')).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    });
  });

  test('the owner on the seeded project: edit, roles, removal, archive and back', async () => {
    await owner.goto(`/projects/${projectId}`);
    await expect(owner.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
      timeout: 20_000
    });

    await test.step('a manager gets Edit, Archive and Add member; the archived notice is absent', async () => {
      await expect(owner.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Add member', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Unarchive', exact: true })).toHaveCount(0);
      await expect(owner.getByText('This project is archived.')).toHaveCount(0);
    });

    await test.step('the members table lists the three people with their roles', async () => {
      await expect(owner.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
      for (const [who, role] of [
        [MANAGER, 'Manager'],
        [EDITOR, 'Editor'],
        [VIEWER, 'Viewer']
      ] as const) {
        const row = rowMenu(owner, who.email);
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row).toContainText(role);
      }
    });

    await test.step('Edit renames the project, and the band follows', async () => {
      await owner.getByRole('button', { name: 'Edit', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Edit project' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Description', { exact: true }).fill('Renamed by the e2e walk.');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(owner.getByText('Project saved')).toBeVisible({ timeout: 15_000 });
      await expect(owner.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible();
    });

    await test.step("the viewer's role is changed to editor, from their row's menu", async () => {
      await rowMenu(owner, VIEWER.email).getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Change role', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Change role' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(VIEWER.email);
      await dialog.getByRole('combobox', { name: 'Role' }).click();
      await owner.getByRole('option', { name: 'Editor' }).click();
      await dialog.getByRole('button', { name: 'Change role', exact: true }).click();
      await expect(rowMenu(owner, VIEWER.email)).toContainText('Editor', { timeout: 15_000 });

      // …and back to viewer, so the rest of the file walks the role it names.
      await rowMenu(owner, VIEWER.email).getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Change role', exact: true }).click();
      const again = owner.getByRole('dialog').filter({ hasText: 'Change role' });
      await again.getByRole('combobox', { name: 'Role' }).click();
      await owner.getByRole('option', { name: 'Viewer' }).click();
      await again.getByRole('button', { name: 'Change role', exact: true }).click();
      await expect(rowMenu(owner, VIEWER.email)).toContainText('Viewer', { timeout: 15_000 });
    });

    await test.step('someone added and then removed from the project', async () => {
      // The outsider joins…
      await owner.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Add a member' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Add by email instead' }).click();
      await dialog.getByLabel('Email', { exact: true }).fill(OUTSIDER.email);
      await dialog.getByRole('button', { name: 'Add to project', exact: true }).click();
      await expect(rowMenu(owner, OUTSIDER.email)).toBeVisible({ timeout: 15_000 });

      // …and is removed again: the row goes, the section stays.
      await rowMenu(owner, OUTSIDER.email).getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Remove from project', exact: true }).click();
      const confirm = owner.getByRole('dialog').filter({ hasText: 'Remove this member?' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Remove from project', exact: true }).click();
      await expect(rowMenu(owner, OUTSIDER.email)).toHaveCount(0, { timeout: 15_000 });
      // The outsider is out again: the whole point of the fourth person.
      expect((await readProject(sessions[OUTSIDER.email].page, projectId)).status).toBe(404);
    });

    await test.step("the owner's own row has no Remove: a manager removes anyone but themselves that way", async () => {
      // The owner is not a member row of this project unless they created it —
      // they did, so the row exists and carries Change role, never Remove.
      const mine = rowMenu(owner, 'owner@example.com');
      await expect(mine).toBeVisible();
      await mine.getByRole('button', { name: 'Open menu' }).click();
      await expect(owner.getByRole('menuitem', { name: 'Change role', exact: true })).toBeVisible();
      await expect(owner.getByRole('menuitem', { name: 'Remove from project', exact: true })).toHaveCount(0);
      await expect(owner.getByRole('menuitem', { name: 'Leave project', exact: true })).toBeVisible();
      await owner.keyboard.press('Escape');
    });

    await test.step('the tool fills its door: the decks section is on the page', async () => {
      // PRDCT-2584's own spec asserts its contents; here: it is rendered.
      await expect(owner.getByTestId('project-decks')).toBeVisible({ timeout: 15_000 });
      await expect(owner.getByTestId('project-decks')).toHaveAttribute('data-project', projectId);
    });
  });

  test('the owner archives the project: the notice, Unarchive alone, then back', async () => {
    await owner.goto(`/projects/${projectId}`);
    await expect(owner.getByRole('button', { name: 'Archive', exact: true })).toBeVisible({
      timeout: 20_000
    });

    await test.step('Archive, confirmed, closes the project to change', async () => {
      await owner.getByRole('button', { name: 'Archive', exact: true }).click();
      const confirm = owner.getByRole('dialog').filter({ hasText: `Archive ${PROJECT_NAME}?` });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Archive', exact: true }).click();

      await expect(owner.getByText('This project is archived.')).toBeVisible({ timeout: 15_000 });
      await expect(owner.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible();
      // The one change an archived project takes is the unarchive: every other
      // control is gone, and the server answers 409 `project_archived` anyway.
      await expect(owner.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(owner.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
      await expect(owner.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
      // Nobody's row keeps an action either, not even Leave.
      await expect(owner.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
    });

    await test.step("the server says the same thing to the page's back", async () => {
      const refused = await owner.request.patch(`/api/v1/projects/${projectId}`, {
        data: { name: 'Renamed while archived' }
      });
      expect(refused.status()).toBe(409);
      expect((await refused.json()).error.code).toBe('project_archived');
    });

    await test.step('a manager who is not the owner reads the archived project and its notice', async () => {
      const manager = sessions[MANAGER.email].page;
      await manager.goto(`/projects/${projectId}`);
      await expect(manager.getByText('This project is archived.')).toBeVisible({ timeout: 20_000 });
      await expect(manager.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible();
    });

    await test.step("an editor sees the notice WITHOUT the Unarchive: it is a manager's act", async () => {
      const editor = sessions[EDITOR.email].page;
      await editor.goto(`/projects/${projectId}`);
      await expect(editor.getByText('This project is archived.')).toBeVisible({ timeout: 20_000 });
      await expect(editor.getByRole('button', { name: 'Unarchive', exact: true })).toHaveCount(0);
      // and the server refuses it too, not just the page
      const refused = await editor.request.post(`/api/v1/projects/${projectId}/unarchive`);
      expect(refused.status()).toBe(403);
      expect((await refused.json()).error.code).toBe('insufficient_project_role');
    });

    await test.step('Unarchive gives the project back, with every control', async () => {
      await owner.goto(`/projects/${projectId}`);
      await owner.getByRole('button', { name: 'Unarchive', exact: true }).click();
      await expect(owner.getByText('This project is archived.')).toHaveCount(0, { timeout: 15_000 });
      await expect(owner.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Add member', exact: true })).toBeVisible();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // The manager, the editor, the viewer: the same page, three sets of controls
  // ──────────────────────────────────────────────────────────────────────

  test('the manager: every control, and Leave on their own row', async () => {
    const page = sessions[MANAGER.email].page;
    expect((await readProject(page, projectId)).myRole).toBe('manager');

    await page.goto('/projects');
    await expect(page.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toContainText('Manager', {
      timeout: 20_000
    });

    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
      timeout: 20_000
    });

    await test.step('Edit, Archive and Add member are all there', async () => {
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeVisible();
    });

    await test.step("someone else's row carries Change role and Remove", async () => {
      await rowMenu(page, EDITOR.email).getByRole('button', { name: 'Open menu' }).click();
      await expect(page.getByRole('menuitem', { name: 'Change role', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Remove from project', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Leave project', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    await test.step('their OWN row carries Leave, and never Remove', async () => {
      await rowMenu(page, MANAGER.email).getByRole('button', { name: 'Open menu' }).click();
      await expect(page.getByRole('menuitem', { name: 'Leave project', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Remove from project', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    await test.step("the tool's section is there for them too", async () => {
      await expect(page.getByTestId('project-decks')).toBeVisible({ timeout: 15_000 });
    });
  });

  test('the editor: no Edit, no Archive, no Add member, no action on anyone else', async () => {
    const page = sessions[EDITOR.email].page;
    expect((await readProject(page, projectId)).myRole).toBe('editor');

    await page.goto('/projects');
    await expect(page.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toContainText('Editor', {
      timeout: 20_000
    });

    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
      timeout: 20_000
    });

    await test.step("the project's own controls are ABSENT", async () => {
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
      // The role is still SAID: what they are is not hidden, only what they may do.
      await expect(page.getByText('Your role')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
    });

    await test.step('the members are readable, and no other row has an action', async () => {
      await expect(rowMenu(page, MANAGER.email)).toBeVisible({ timeout: 15_000 });
      await expect(rowMenu(page, VIEWER.email)).toBeVisible();
      await expect(rowMenu(page, MANAGER.email).getByRole('button', { name: 'Open menu' })).toHaveCount(0);
      await expect(rowMenu(page, VIEWER.email).getByRole('button', { name: 'Open menu' })).toHaveCount(0);
    });

    await test.step('their own row carries exactly one action: Leave', async () => {
      await rowMenu(page, EDITOR.email).getByRole('button', { name: 'Open menu' }).click();
      await expect(page.getByRole('menuitem', { name: 'Leave project', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Change role', exact: true })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Remove from project', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    await test.step('the server refuses what the page does not offer (403, never a silent no-op)', async () => {
      const renamed = await page.request.patch(`/api/v1/projects/${projectId}`, {
        data: { name: 'Renamed by an editor' }
      });
      expect(renamed.status()).toBe(403);
      expect((await renamed.json()).error.code).toBe('insufficient_project_role');

      const added = await page.request.post(`/api/v1/projects/${projectId}/members`, {
        data: { email: OUTSIDER.email, role: 'viewer' }
      });
      expect(added.status()).toBe(403);
    });

    await test.step("the tool's section is present — an editor writes what is linked", async () => {
      await expect(page.getByTestId('project-decks')).toBeVisible({ timeout: 15_000 });
    });
  });

  test('the viewer: the same absences, and Leave on their own row', async () => {
    const page = sessions[VIEWER.email].page;
    expect((await readProject(page, projectId)).myRole).toBe('viewer');

    await page.goto('/projects');
    await expect(page.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toContainText('Viewer', {
      timeout: 20_000
    });

    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
      timeout: 20_000
    });

    await test.step("the project's own controls are ABSENT", async () => {
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
      await expect(page.getByText('Your role')).toBeVisible();
    });

    await test.step('no action on anyone else; Leave on their own row', async () => {
      await expect(rowMenu(page, EDITOR.email).getByRole('button', { name: 'Open menu' })).toHaveCount(0);
      await rowMenu(page, VIEWER.email).getByRole('button', { name: 'Open menu' }).click();
      await expect(page.getByRole('menuitem', { name: 'Leave project', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Change role', exact: true })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Remove from project', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    await test.step("the tool's section is present: a viewer reads what is linked", async () => {
      await expect(page.getByTestId('project-decks')).toBeVisible({ timeout: 15_000 });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // The fourth person: a workspace member who is in no project at all
  // ──────────────────────────────────────────────────────────────────────

  test('a plain member outside the project: an empty list, the calm not-found page, the menu entry', async () => {
    const page = sessions[OUTSIDER.email].page;

    await test.step('the menu still carries Projects: the section is everyone of the workspace’s', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    });

    await test.step('their list holds no project, and says so with the empty state', async () => {
      await page.getByRole('link', { name: 'Projects', exact: true }).click();
      await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      await expect(page.getByText('No project yet')).toBeVisible({ timeout: 20_000 });
      // The seeded project is not theirs to see — neither is the archived one.
      await expect(page.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toHaveCount(0);
      await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
      await expect(page.getByText(ARCHIVED_NAME)).toHaveCount(0);
      // A plain member may still MAKE one: creation is any non-guest member's.
      await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
    });

    await test.step("the project's address is the calm not-found page, never an error", async () => {
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByText('Project not found')).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText('This project does not exist, or you are not one of its members.')
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
      // Nothing of the project leaks: not its name, not its members, not the door.
      await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
      await expect(page.getByText(MANAGER.email)).toHaveCount(0);
      await expect(page.getByTestId('project-decks')).toHaveCount(0);
      // and it is not an error card either
      await expect(page.getByText('Failed to load this project')).toHaveCount(0);
    });

    await test.step('the API says 404, not 403: a project is not probeable', async () => {
      expect((await readProject(page, projectId)).status).toBe(404);
      const members = await page.request.get(`/api/v1/projects/${projectId}/members`);
      expect(members.status()).toBe(404);
      const renamed = await page.request.patch(`/api/v1/projects/${projectId}`, {
        data: { name: 'Renamed by an outsider' }
      });
      expect(renamed.status()).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // The phone: the same section under the thumb
  // ──────────────────────────────────────────────────────────────────────

  test('a phone: the tab bar, the list, the project page and its members', async () => {
    // On a phone a DataTable is a list of cards, not a table (DataTable.svelte,
    // PRDCT-2436): the rows are <li>, with no `row` role — so the phone's
    // assertions read the cards' text, never getByRole('row').
    const page = sessions[MANAGER.email].page;
    await page.setViewportSize(PHONE);

    try {
      await test.step('the tab bar carries Projects, and the sidebar is gone', async () => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
        const tabbar = page.getByRole('navigation', { name: 'Main navigation' });
        await expect(tabbar).toBeVisible();
        await expect(tabbar.getByRole('link', { name: 'Projects' })).toBeVisible();
      });

      await test.step('the tab opens the list, and the seeded project is a card on it', async () => {
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Projects' })
          .click();
        await expect(page).toHaveURL(/\/projects$/);
        await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
        const card = page.getByRole('listitem').filter({ hasText: PROJECT_NAME });
        await expect(card).toBeVisible({ timeout: 20_000 });
        await expect(card).toContainText('Manager');
        // the card layout is the phone's, not the desk's table
        await expect(page.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toHaveCount(0);
        await card.click();
      });

      await test.step("the project's page renders, with its controls and its members", async () => {
        await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`), { timeout: 20_000 });
        await expect(page.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();

        // the members are reachable: the table is a card list here too
        await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
        const mine = page.getByRole('listitem').filter({ hasText: MANAGER.email });
        await expect(mine).toBeVisible({ timeout: 15_000 });
        await expect(mine).toContainText('Manager');
        await expect(page.getByRole('listitem').filter({ hasText: EDITOR.email })).toBeVisible();

        // and the row's actions still open under the thumb
        await mine.getByRole('button', { name: 'Open menu' }).click();
        await expect(page.getByRole('menuitem', { name: 'Leave project', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');

        // the tool's door is filled at this width too
        await expect(page.getByTestId('project-decks')).toBeVisible({ timeout: 15_000 });
      });

      await test.step('an editor at phone width gets the same absences', async () => {
        const editor = sessions[EDITOR.email].page;
        await editor.setViewportSize(PHONE);
        try {
          await editor.goto(`/projects/${projectId}`);
          await expect(editor.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
            timeout: 20_000
          });
          await expect(editor.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
          await expect(editor.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
          await expect(editor.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
          await expect(editor.getByRole('listitem').filter({ hasText: MANAGER.email })).toBeVisible({
            timeout: 15_000
          });
        } finally {
          await editor.setViewportSize(DESK);
        }
      });

      await test.step('the outsider at phone width: Projects in the bar, the not-found page behind the address', async () => {
        const outsider = sessions[OUTSIDER.email].page;
        await outsider.setViewportSize(PHONE);
        try {
          await outsider.goto('/projects');
          await expect(outsider.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({
            timeout: 20_000
          });
          await expect(
            outsider
              .getByRole('navigation', { name: 'Main navigation' })
              .getByRole('link', { name: 'Projects' })
          ).toBeVisible();
          await expect(outsider.getByText('No project yet')).toBeVisible();

          await outsider.goto(`/projects/${projectId}`);
          await expect(outsider.getByText('Project not found')).toBeVisible({ timeout: 20_000 });
          await expect(outsider.getByText(PROJECT_NAME)).toHaveCount(0);
        } finally {
          await outsider.setViewportSize(DESK);
        }
      });
    } finally {
      await page.setViewportSize(DESK);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Leaving: the one act every member has, and the last read of the rail
  // ──────────────────────────────────────────────────────────────────────

  test('the viewer leaves: the row goes, the list drops the project, the page turns not-found', async () => {
    const page = sessions[VIEWER.email].page;
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
      timeout: 20_000
    });

    await rowMenu(page, VIEWER.email).getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Leave project', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Leave this project?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(PROJECT_NAME);
    await confirm.getByRole('button', { name: 'Leave project', exact: true }).click();

    // Leaving lands on the list, which no longer holds the project.
    await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
    await expect(page.getByRole('row', { name: new RegExp(PROJECT_NAME) })).toHaveCount(0, {
      timeout: 20_000
    });
    // …and the project's own address is the calm not-found page from now on.
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByText('Project not found')).toBeVisible({ timeout: 20_000 });
    expect((await readProject(page, projectId)).status).toBe(404);

    // The owner still reads it, with one member fewer: nothing else moved.
    await owner.goto(`/projects/${projectId}`);
    await expect(owner.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
      timeout: 20_000
    });
    await expect(rowMenu(owner, VIEWER.email)).toHaveCount(0, { timeout: 15_000 });
    await expect(rowMenu(owner, EDITOR.email)).toBeVisible();
  });
});
