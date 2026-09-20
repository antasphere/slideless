import Presentation from '@lucide/svelte/icons/presentation';
import Library from '@lucide/svelte/icons/library';
import type { ToolContribution } from '$lib/contribution';
import { api } from '$lib/api';
import { t } from '$lib/i18n';
import { warmList } from '$lib/stores/pagedList.svelte';
import { createDeckOverview, type DeckOverview } from './overview.svelte';
import RecentDecks from './components/overview/RecentDecks.svelte';
import DefaultBrandTile from './components/overview/DefaultBrandTile.svelte';

/**
 * What Slideless gives the shell: the one door into the tool's half
 * (contribution.ts says what each part is for). The words are the other
 * door, `./i18n`.
 */
export const tool: ToolContribution<DeckOverview> = {
  nav({ origin }) {
    const isGuest = origin === 'guest';
    return [
      // The product first: decks are what this instance is for.
      {
        id: 'decks',
        title: t('nav.decks'),
        blurb: t('nav.blurb.decks'),
        href: '/decks',
        icon: Presentation,
        pattern: 'slides'
      },
      // The library (PRDCT-2583): the decks the workspace keeps to make other
      // decks from, brands and templates as the two tabs of one entry, each at
      // the address it always had. A guest reads no workspace reference (a guest
      // invited on one reads it at /decks/{id}), so the entry is not offered.
      ...(isGuest
        ? []
        : [
            {
              id: 'library',
              title: t('nav.library'),
              blurb: t('nav.blurb.library'),
              href: '/brands',
              also: ['/templates'],
              tabs: [
                { href: '/brands', label: t('nav.brands') },
                { href: '/templates', label: t('nav.templates') }
              ],
              icon: Library,
              pattern: 'aurora'
            }
          ])
    ];
  },

  // The library folds behind the phone's workspace entry: the bar keeps the everyday sections.
  phoneTabs: ['decks'],

  // The collaborator's claim page, /collab/{token}.
  gateRoutes: ['collab'],

  warm() {
    void warmList('decks', async () => {
      const { presentations, nextCursor } = await api.presentations({});
      return { items: presentations, nextCursor };
    });
  },

  audit: {
    // Kept in step with the `c.set('audit', { action })` calls of the deck routes by hand.
    actions: [
      'collaborator.claim',
      'presentation.annotation_create',
      'presentation.annotation_delete',
      'presentation.annotation_update',
      'presentation.asset_upload',
      'presentation.collaborator_invite',
      'presentation.collaborator_revoke',
      'presentation.create',
      'presentation.delete',
      'presentation.duplicate',
      'presentation.form_response_delete',
      'presentation.form_response_files_download',
      'presentation.preview_token_create',
      'presentation.share_token_create',
      'presentation.share_token_revoke',
      'presentation.share_token_send',
      'presentation.share_token_update',
      'presentation.update',
      'presentation.upload_session_create',
      'presentation.version_commit'
    ],
    resourceTypes: [
      'annotation',
      'collaborator',
      'form_response',
      'presentation',
      'share_token',
      'upload_session'
    ],
    glyphs: [{ test: /present|deck|share|version/, icon: Presentation }]
  },

  overview: {
    create: createDeckOverview,
    Recent: RecentDecks,
    Tile: DefaultBrandTile
  }
};
