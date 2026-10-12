import Presentation from '@lucide/svelte/icons/presentation';
import Library from '@lucide/svelte/icons/library';
import LayoutGrid from '@lucide/svelte/icons/layout-grid';
import type { ToolContribution } from '$lib/contribution';
import { api } from '$lib/api';
import { t } from '$lib/i18n';
import { warmList } from '$lib/stores/pagedList.svelte';
import { createDeckOverview, type DeckOverview } from './overview.svelte';
import RecentDecks from './components/overview/RecentDecks.svelte';
import DefaultBrandTile from './components/overview/DefaultBrandTile.svelte';
import ProjectDecks from './components/projects/ProjectDecks.svelte';
import AppsFold from './components/apps/AppsFold.svelte';

/**
 * What Slideless gives the shell: the one door into the tool's half
 * (contribution.ts says what each part is for). The words are the other
 * door, `./i18n`.
 */
export const tool: ToolContribution<DeckOverview> = {
  // The tool's everyday sections under its own rail category, Decks (DESIGN.md, "The rail").
  nav({ origin }) {
    return [
      // The product first: decks are what this instance is for.
      {
        id: 'decks',
        group: t('nav.groupDecks'),
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
      ...(origin === 'guest'
        ? []
        : [
            {
              id: 'library',
              group: t('nav.groupDecks'),
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

  // After the shell's Projects entry: the organization's other tools (the Apps
  // page, `GET /apps`), the last of the tool's entries: Settings follows it.
  // Its fold lists them in the rail. A guest is not offered it.
  navAfter({ origin }) {
    return origin === 'guest'
      ? []
      : [
          {
            id: 'apps',
            group: t('nav.groupApps'),
            fold: AppsFold,
            title: t('apps.nav'),
            blurb: t('apps.navBlurb'),
            href: '/apps',
            icon: LayoutGrid,
            pattern: 'crosses'
          }
        ];
  },

  // The phone's thumbs beside the overview: the decks and the shell's Projects; the Menu
  // thumb opens the rest of the rail (DESIGN.md, "Phone").
  phoneTabs: ['decks', 'projects'],

  // No Workspace and no System group in the rail: People, API keys, Files and
  // the audit log are tabs of Settings, the rail's last entry, under the
  // Workspace category with Projects (DESIGN.md, "The rail").
  workspaceNav: 'none',

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

  project: {
    Resources: ProjectDecks
  },

  overview: {
    // the overview is about the decks: the shell adds no members or files figures
    shellStats: false,
    create: createDeckOverview,
    Recent: RecentDecks,
    Tile: DefaultBrandTile
  }
};
