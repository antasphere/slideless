import { THEMES } from '$lib/brand/recipe.js';
import { createPagedList } from '$lib/stores/pagedList.svelte';
import { api } from '$lib/api';
import { t } from '$lib/i18n';
import type { Presentation } from '@slideless/contract';
import type { OverviewFacts, OverviewStat, ToolOverview } from '$lib/contribution';
import { swatchesOf } from './references';

/** What the overview page shows of the decks: the model its three pieces read. */
export interface DeckOverview extends ToolOverview {
  readonly recentDecks: Presentation[];
  /** undefined while it loads, null when the workspace has none. */
  readonly brand: Presentation | null | undefined;
  readonly brandSwatches: ReturnType<typeof swatchesOf>;
  readonly isGuest: boolean;
}

export function createDeckOverview(facts: OverviewFacts): DeckOverview {
  const decksList = createPagedList<Presentation>(
    async (p) => {
      const { presentations, nextCursor } = await api.presentations(p);
      return { items: presentations, nextCursor };
    },
    { limit: 100, remember: 'overview.decksList' }
  );

  // The workspace's default brand (PRDCT-2421), one call; undefined while
  // it loads, null when the workspace has none. A guest reads no workspace
  // reference, so the card is not offered.
  let brand = $state<Presentation | null | undefined>(undefined);
  const brandSwatches = $derived(
    brand
      ? swatchesOf(brand.reference)
          .filter((s) => s.hex)
          .slice(0, 5)
      : []
  );

  // Counts come from one page (limit 100); a trailing "+" keeps them honest
  // when the list is truncated.
  const deckCount = $derived(
    decksList.loading || (decksList.error && !decksList.items.length)
      ? null
      : `${decksList.items.length}${decksList.nextCursor ? '+' : ''}`
  );

  // Opens are counted per deck today (PRDCT-2438 will bring the workspace's
  // own figures); the sum of the loaded page is honest with the same "+".
  const openCount = $derived(
    decksList.loading || (decksList.error && !decksList.items.length)
      ? null
      : `${decksList.items.reduce((n, d) => n + d.totalViews, 0)}${decksList.nextCursor ? '+' : ''}`
  );
  const recentDecks = $derived(
    [...decksList.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3)
  );

  const lede = $derived(
    deckCount === null
      ? null
      : decksList.items.length
        ? t('overview.lede', { decks: deckCount, workspace: facts.workspaceName(), opens: openCount ?? '0' })
        : t('overview.ledeEmpty')
  );

  // One drawing and one colour per figure, each colour one of the brand's own themes.
  const stats = $derived<OverviewStat[]>([
    {
      id: 'decks',
      label: t('overview.decksCard'),
      value: deckCount,
      href: '/decks',
      // the link under the recent decks carries its own arrow; the card draws one on hover
      hint: t('overview.browseDecks').replace(/\s*→$/, ''),
      drawing: 'decks',
      color: THEMES.dawn.accent
    },
    {
      id: 'opens',
      label: t('overview.opensCard'),
      value: openCount,
      href: '/decks',
      hint: t('overview.opensHint'),
      drawing: 'opens',
      color: THEMES.solar.accent
    }
  ]);

  return {
    load() {
      void decksList.load();
      if (!facts.isGuest()) {
        api
          .defaultReference('brand')
          .then((b) => (brand = b))
          .catch(() => (brand = null));
      }
    },
    get lede() {
      return lede;
    },
    get stats() {
      return stats;
    },
    get recentDecks() {
      return recentDecks;
    },
    get brand() {
      return brand;
    },
    get brandSwatches() {
      return brandSwatches;
    },
    get isGuest() {
      return facts.isGuest();
    }
  };
}
