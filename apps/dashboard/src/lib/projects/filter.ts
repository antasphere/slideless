import type { ProjectArchivedFilter } from './types';

/**
 * Which projects the list shows (active, archived, or all), as the browser
 * remembers it (PRDCT-2582). Someone who works in the archive for a while
 * comes back to it, and everyone else opens on the active projects.
 */
const KEY = 'projects.archived';

const CHOICES: readonly ProjectArchivedFilter[] = ['false', 'true', 'all'];

/** The remembered choice; the active projects when nothing is remembered or storage is off. */
export function readArchivedFilter(
  storage: Pick<Storage, 'getItem'> | null = storageOrNull()
): ProjectArchivedFilter {
  try {
    const kept = storage?.getItem(KEY);
    return CHOICES.find((choice) => choice === kept) ?? 'false';
  } catch {
    return 'false';
  }
}

/** Remember the choice; a browser that refuses storage keeps it for the visit only. */
export function writeArchivedFilter(
  filter: ProjectArchivedFilter,
  storage: Pick<Storage, 'setItem'> | null = storageOrNull()
): void {
  try {
    storage?.setItem(KEY, filter);
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
