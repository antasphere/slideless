/**
 * Which columns the share links table shows: the reader's choice, kept in
 * this browser (per variant). One object, so the menu that edits the choice
 * can live away from the table that reads it: the deck page's section owns
 * the View button and hands it to the table's toolbar beside "New share
 * link", while the master page's share sheet lets the table render it itself.
 *
 * The lean defaults keep who, which version, what a reader may send back,
 * and how much it was read; the link's panel holds everything else. The
 * status column is hidden there because the row already says it: a link
 * that no longer opens is faded, its name struck, a state tag beside it.
 */
import { t, type MessageKey } from '$lib/i18n';

export type LinkColumnId =
  | 'pinnedVersion'
  | 'canDownload'
  | 'showBar'
  | 'canAnnotate'
  | 'canSubmitForms'
  | 'canUploadFiles'
  | 'remembersResponses'
  | 'accessCount'
  | 'lastAccessedAt'
  | 'revokedAt';

/** The columns a reader may hide, in table order: everything but the recipient and the acts. */
const CHOICES: { id: LinkColumnId; title: MessageKey }[] = [
  { id: 'pinnedVersion', title: 'tokens.colVersion' },
  { id: 'canDownload', title: 'tokens.colDownloads' },
  { id: 'showBar', title: 'tokens.colBar' },
  { id: 'canAnnotate', title: 'tokens.colNotes' },
  { id: 'canSubmitForms', title: 'tokens.colForms' },
  { id: 'canUploadFiles', title: 'tokens.colUploads' },
  { id: 'remembersResponses', title: 'tokens.colRemembers' },
  { id: 'accessCount', title: 'tokens.colViews' },
  { id: 'lastAccessedAt', title: 'tokens.colLastAccess' },
  { id: 'revokedAt', title: 'tokens.colStatus' }
];

const LEAN_HIDDEN: LinkColumnId[] = [
  'canDownload',
  'showBar',
  'canUploadFiles',
  'remembersResponses',
  'revokedAt'
];

export class LinkColumns {
  hidden = $state<LinkColumnId[]>([]);
  readonly #storageKey: string;

  /** `full` is every column, `lean` hides the least telling ones; each keeps its own remembered choice. */
  constructor(defaults: 'full' | 'lean') {
    this.#storageKey = `slideless.shareLinks.columns.${defaults}`;
    this.hidden = this.#read(defaults === 'lean' ? LEAN_HIDDEN : []);
  }

  #read(fallback: LinkColumnId[]): LinkColumnId[] {
    try {
      const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(this.#storageKey) ?? 'null');
      if (Array.isArray(stored)) return stored.filter((id): id is LinkColumnId => typeof id === 'string');
    } catch {
      // privacy modes, a hand-edited record: the defaults
    }
    return fallback;
  }

  get choices(): { id: LinkColumnId; title: string }[] {
    return CHOICES.map((choice) => ({ id: choice.id, title: t(choice.title) }));
  }

  shows(id: LinkColumnId): boolean {
    return !this.hidden.includes(id);
  }

  set(id: LinkColumnId, visible: boolean): void {
    this.hidden = visible
      ? this.hidden.filter((h) => h !== id)
      : [...this.hidden.filter((h) => h !== id), id];
    try {
      globalThis.localStorage?.setItem(this.#storageKey, JSON.stringify(this.hidden));
    } catch {
      // the choice then lasts for this page only
    }
  }
}
