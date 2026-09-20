import type { Project } from '$lib/projects/types';
import { projectCan } from '$lib/projects/can';
import type { MeResponse, Presentation } from '@slideless/contract';
import type { DeckProjectRef } from './projects-client';

/**
 * The project filter of the deck lists (PRDCT-2584): the decks page, the
 * brands and the templates each remember the project they were last narrowed
 * to, so the choice survives a reload and a change of page. Pure functions,
 * unit-tested in project-filter.test.ts; the rune half is
 * project-filter.svelte.ts.
 */
export type ProjectFilterPage = 'decks' | 'brands' | 'templates';

export function projectFilterKey(page: ProjectFilterPage): string {
  return `slideless.${page}.project`;
}

/** The project the browser remembers for a page; none when nothing is remembered or storage is off. */
export function readProjectFilter(
  page: ProjectFilterPage,
  storage: Pick<Storage, 'getItem'> | null = storageOrNull()
): string | null {
  try {
    return storage?.getItem(projectFilterKey(page)) || null;
  } catch {
    return null;
  }
}

/** Remember the project, or forget it (`null`); a browser that refuses storage keeps the choice for the visit only. */
export function writeProjectFilter(
  page: ProjectFilterPage,
  projectId: string | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = storageOrNull()
): void {
  try {
    if (projectId) storage?.setItem(projectFilterKey(page), projectId);
    else storage?.removeItem(projectFilterKey(page));
  } catch {
    /* not persisted, still applied */
  }
}

function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The name a filtered list is remembered under (pagedList's `remember`): one
 * per project, and the bare name with no filter, which is the name the shell
 * warms.
 */
export function rememberedListName(base: string, projectId: string | null): string {
  return projectId ? `${base}.${projectId}` : base;
}

/** A remembered project the reader no longer reads (gone, left, archived) is no filter at all. */
export function standingFilter(projectId: string | null, readable: Pick<Project, 'id'>[]): string | null {
  return projectId && readable.some((p) => p.id === projectId) ? projectId : null;
}

// ── Who may do what (the page hides; the server rules) ──────────────────

/**
 * Whoever administers the deck links it to a project: its owner, a workspace
 * admin or owner. The same people who manage its collaborators, since linking
 * widens who reads the deck.
 */
export function administersDeck(
  me: Pick<MeResponse, 'role' | 'user'>,
  deck: Pick<Presentation, 'ownerUserId'>
): boolean {
  return me.role === 'owner' || me.role === 'admin' || deck.ownerUserId === me.user.id;
}

/** The projects a deck can still be added to: where the reader writes, the deck's own left out. */
export function projectsToAddTo<P extends Pick<Project, 'id' | 'myRole' | 'archivedAt'>>(
  readable: P[],
  linked: Pick<DeckProjectRef, 'id'>[]
): P[] {
  return readable.filter((p) => projectCan.write(p) && !linked.some((l) => l.id === p.id));
}

/**
 * Whether the deck's page offers to take the deck out of one project: to who
 * administers the deck, archived project or not (taking one's own deck back
 * is not a change of the project, and the route allows it), and to the
 * project's manager while the project is open. `readable` holds no archived
 * project, so a manager's grant on one missing from it takes no change.
 */
export function canUnlinkFrom(
  projectId: string,
  readable: Pick<Project, 'id' | 'myRole' | 'archivedAt'>[],
  administers: boolean
): boolean {
  if (administers) return true;
  const project = readable.find((p) => p.id === projectId);
  return project !== undefined && projectCan.edit(project);
}
