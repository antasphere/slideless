import type { MeResponse } from '@slideless/contract';
import type { ProjectArchivedFilter } from './types';

/**
 * Which projects the list shows (active, archived, or all), as the browser
 * remembers it (PRDCT-2582). Someone who works in the archive for a while
 * comes back to it, and everyone else opens on the active projects. What is
 * remembered is one person's in one workspace, as the remembered lists are
 * (`listScope`): the next person at the same browser opens on their own.
 */
const KEY = 'projects.archived';

/** Whose choice a remembered filter is: the person, in the workspace they have open. */
export function filterScope(me: Pick<MeResponse, 'user' | 'activeWorkspaceId'>): string {
  return `${me.user.id}:${me.activeWorkspaceId ?? ''}`;
}

const CHOICES: readonly ProjectArchivedFilter[] = ['false', 'true', 'all'];

/** The remembered choice; the active projects when nothing is remembered or storage is off. */
export function readArchivedFilter(
  scope: string,
  storage: Pick<Storage, 'getItem'> | null = storageOrNull()
): ProjectArchivedFilter {
  try {
    const kept = storage?.getItem(`${KEY}:${scope}`);
    return CHOICES.find((choice) => choice === kept) ?? 'false';
  } catch {
    return 'false';
  }
}

/** Remember the choice; a browser that refuses storage keeps it for the visit only. */
export function writeArchivedFilter(
  scope: string,
  filter: ProjectArchivedFilter,
  storage: Pick<Storage, 'setItem'> | null = storageOrNull()
): void {
  try {
    storage?.setItem(`${KEY}:${scope}`, filter);
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
