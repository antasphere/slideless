<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import FieldCanvas from '$lib/components/brand/FieldCanvas.svelte';
  import PatternCanvas from '$lib/components/brand/PatternCanvas.svelte';
  import DeckCard from '$lib/components/decks/DeckCard.svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { PALETTES, RECIPE } from '$lib/brand/recipe.js';
  import { seedOf } from '$lib/brand/seed';
  import { paletteFor, theme } from '$lib/theme.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { t } from '$lib/i18n';
  import type { FileInfo, Member, Presentation } from '@slideless/contract';

  let { data } = $props();

  // The roster and the generic files surface are guest-forbidden (D2, 403
  // guest_forbidden) — skip the doomed fetches and their cards entirely.
  const isGuest = $derived(data.me.origin === 'guest');
  // P7: membership of a hub-origin workspace is managed at the hub — the
  // team card points at the members page (which links out) instead of the
  // local invitation flow.
  const hubManaged = $derived(data.me.workspace.hubOrigin);
  // "Your self-hosted instance at a glance" is wrong on cloud. Keyed off
  // the PUBLIC discovery edition (instance.edition, already rendered on the
  // instance card below) — the P7 never-edition-sniff invariant is scoped
  // to the membership surfaces, which keep keying off /me's hubOrigin.
  const overviewDescription = $derived(
    data.instance.edition === 'cloud' ? t('overview.descriptionCloud') : t('overview.description')
  );

  const workspaceName = $derived(
    data.me.workspaces.find((w) => w.id === data.me.activeWorkspaceId)?.name ?? data.instance.name
  );
  const firstName = $derived(
    (data.me.user.name || data.me.user.email.split('@')[0] || '').split(' ')[0] ?? ''
  );
  const hour = new Date().getHours();
  const greeting = $derived(
    t(
      hour < 12
        ? 'overview.greetingMorning'
        : hour < 18
          ? 'overview.greetingAfternoon'
          : 'overview.greetingEvening',
      { name: firstName }
    )
  );

  $effect(() => theme.start());
  const heroPalette = $derived(paletteFor('dawn', theme.dark, PALETTES));

  const decksList = createPagedList<Presentation>(
    async (p) => {
      const { presentations, nextCursor } = await api.presentations(p);
      return { items: presentations, nextCursor };
    },
    { limit: 100 }
  );
  const membersList = createPagedList<Member>(
    async (p) => {
      const { members, nextCursor } = await api.members(p);
      return { items: members, nextCursor };
    },
    { limit: 100 }
  );
  const filesList = createPagedList<FileInfo>(
    async (p) => {
      const { files, nextCursor } = await api.files(p);
      return { items: files, nextCursor };
    },
    { limit: 100 }
  );

  $effect(() => {
    void decksList.load();
    if (!isGuest) {
      void membersList.load();
      void filesList.load();
    }
  });

  // Counts come from one page (limit 100); a trailing "+" keeps them honest
  // when the list is truncated.
  const memberCount = $derived(
    membersList.loading || (membersList.error && !membersList.items.length)
      ? null
      : `${membersList.items.filter((m) => m.isActive).length}${membersList.nextCursor ? '+' : ''}`
  );
  const fileCount = $derived(
    filesList.loading || (filesList.error && !filesList.items.length)
      ? null
      : `${filesList.items.length}${filesList.nextCursor ? '+' : ''}`
  );
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

  const stats = $derived([
    {
      id: 'decks',
      label: t('overview.decksCard'),
      value: deckCount,
      href: '/decks',
      hint: t('overview.browseDecks'),
      pattern: 'slides'
    },
    {
      id: 'opens',
      label: t('overview.opensCard'),
      value: openCount,
      href: '/decks',
      hint: t('overview.opensHint'),
      pattern: 'sonar'
    },
    ...(isGuest
      ? []
      : [
          {
            id: 'members',
            label: t('overview.activeMembers'),
            value: memberCount,
            href: '/members',
            hint: t('overview.manageMembers'),
            pattern: 'blooms'
          },
          {
            id: 'files',
            label: t('overview.filesCard'),
            value: fileCount,
            href: '/files',
            hint: t('overview.browseFiles'),
            pattern: 'panes'
          }
        ])
  ]);
  let played = $state<string | null>(null);
</script>

<svelte:head><title>{t('overview.title')} · {data.instance.name}</title></svelte:head>

<!-- The opening: the workspace on its own field, the sphere of the brand's
     presentations turning slowly behind the greeting. Decoration only; the
     field never moves for a reader who asked for no motion. -->
<section class="hero plate-window">
  <div class="hero-field">
    <FieldCanvas palette={heroPalette} shape="latitudes" seed={RECIPE.seed} animate />
  </div>
  <div class="hero-text on-field">
    <p class="overline !text-current opacity-70">{workspaceName}</p>
    <!-- the page keeps its name for a screen reader and for the browser
         suite; what a person sees in its place is the greeting -->
    <h1 class="sr-only">{t('overview.title')}</h1>
    <p class="hero-title">{greeting}</p>
    <p class="hero-lede">
      {#if deckCount === null}
        {overviewDescription}
      {:else if decksList.items.length}
        {t('overview.lede', { decks: deckCount, workspace: workspaceName, opens: openCount ?? '0' })}
      {:else}
        {t('overview.ledeEmpty')}
      {/if}
    </p>
  </div>
</section>

<div class="mt-4 grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
  {#each stats as stat (stat.id)}
    <a
      href={stat.href}
      class="sheet tile stat"
      onpointerenter={() => (played = stat.id)}
      onpointerleave={() => (played = null)}
      onfocus={() => (played = stat.id)}
      onblur={() => (played = null)}
    >
      <div class="stat-plate plate-window">
        <PatternCanvas pattern={stat.pattern} seed={seedOf('stat:' + stat.id)} active={played === stat.id} />
      </div>
      <p class="overline">{stat.label}</p>
      <p class="figure stat-figure">{stat.value ?? '—'}</p>
      <p class="stat-hint">{stat.hint}</p>
    </a>
  {/each}
</div>

{#if recentDecks.length}
  <div class="section-head mt-10 !mb-5 items-center justify-between">
    <h2>{t('overview.recentDecks')}</h2>
    <a
      href="/decks"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      {t('overview.allDecks')}<ArrowRight class="size-3.5" />
    </a>
  </div>
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each recentDecks as deck (deck.id)}
      <DeckCard {deck} compact />
    {/each}
  </div>
{/if}

<div class="mt-10 grid gap-4 md:grid-cols-2">
  <Card.Root>
    <Card.Header>
      <Card.Title class="font-display text-base font-normal">{t('overview.apiAccessTitle')}</Card.Title>
      <Card.Description>
        {t('overview.apiAccessBody')}
        <code class="rounded bg-muted px-1 py-0.5 text-xs">/api/v1</code>.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <a class="text-sm underline-offset-4 hover:underline" href="/api-keys">{t('overview.manageKeys')}</a>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="font-display text-base font-normal">{t('overview.teamTitle')}</Card.Title>
      <Card.Description>
        {t('overview.teamDescription')}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if data.me.role === 'owner' || data.me.role === 'admin'}
        {#if hubManaged}
          <a class="text-sm underline-offset-4 hover:underline" href="/members">
            {t('overview.manageMembers')}
          </a>
        {:else}
          <a class="text-sm underline-offset-4 hover:underline" href="/invitations">
            {t('overview.inviteMembers')}
          </a>
        {/if}
      {:else}
        <p class="text-sm text-muted-foreground">{t('overview.askAdmin')}</p>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<!-- what runs this workspace, for whoever needs it: one quiet line -->
<p class="mt-8 text-center text-xs text-muted-foreground">
  {t('overview.aboutInstance')} · {data.instance.name} · v{data.instance.version} · {data.instance.edition} · API
  {data.instance.apiVersion}
</p>

<style>
  .hero {
    position: relative;
    min-height: 210px;
    display: flex;
    align-items: flex-end;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  /* the field is wider than the band, so the sphere it centres sits to the
     right of the greeting (above it on a phone) and never under the words */
  .hero-field {
    position: absolute;
    inset: -38% -34% 0 0;
  }
  .hero-text {
    position: relative;
    padding: 24px 22px;
    max-width: 640px;
  }
  .hero-title {
    font-family: var(--display);
    font-weight: 300;
    font-size: clamp(28px, 5.4vw, 42px);
    line-height: 1.08;
    letter-spacing: -0.015em;
    margin-top: 8px;
  }
  .hero-lede {
    margin-top: 10px;
    font-size: 15px;
    line-height: 1.45;
    opacity: 0.82;
  }
  @media (min-width: 768px) {
    .hero {
      min-height: 250px;
    }
    .hero-field {
      inset: 0 -52% 0 0;
    }
    .hero-text {
      padding: 32px 34px;
    }
  }

  .stat {
    position: relative;
    display: block;
    padding: 16px 16px 14px;
    overflow: hidden;
  }
  .stat-plate {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 54px;
    height: 54px;
    border-radius: 999px;
    opacity: 0.9;
  }
  .stat-figure {
    font-size: clamp(34px, 7vw, 44px);
    margin-top: 14px;
  }
  .stat-hint {
    margin-top: 10px;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--muted);
  }
</style>
