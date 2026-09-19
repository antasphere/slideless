<script lang="ts">
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import StatTile from '$lib/components/brand/StatTile.svelte';
  import Palette from '@lucide/svelte/icons/palette';
  import { descriptionOf, swatchesOf } from '$lib/tool/references';
  import DeckCard from '$lib/tool/components/decks/DeckCard.svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { THEMES } from '$lib/brand/recipe.js';
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

  const decksList = createPagedList<Presentation>(
    async (p) => {
      const { presentations, nextCursor } = await api.presentations(p);
      return { items: presentations, nextCursor };
    },
    { limit: 100, remember: 'overview.decksList' }
  );
  const membersList = createPagedList<Member>(
    async (p) => {
      const { members, nextCursor } = await api.members(p);
      return { items: members, nextCursor };
    },
    { limit: 100, remember: 'overview.membersList' }
  );
  const filesList = createPagedList<FileInfo>(
    async (p) => {
      const { files, nextCursor } = await api.files(p);
      return { items: files, nextCursor };
    },
    { limit: 100, remember: 'overview.filesList' }
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

  $effect(() => {
    void decksList.load();
    if (!isGuest) {
      void membersList.load();
      void filesList.load();
      api
        .defaultReference('brand')
        .then((b) => (brand = b))
        .catch(() => (brand = null));
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

  // One drawing and one colour per figure, each colour one of the brand's own themes.
  const stats = $derived([
    {
      id: 'decks',
      label: t('overview.decksCard'),
      value: deckCount,
      href: '/decks',
      // the link under the recent decks carries its own arrow; the card draws one on hover
      hint: t('overview.browseDecks').replace(/\s*→$/, ''),
      drawing: 'decks' as const,
      color: THEMES.dawn.accent
    },
    {
      id: 'opens',
      label: t('overview.opensCard'),
      value: openCount,
      href: '/decks',
      hint: t('overview.opensHint'),
      drawing: 'opens' as const,
      color: THEMES.solar.accent
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
            drawing: 'members' as const,
            color: THEMES.reef.accent
          },
          {
            id: 'files',
            label: t('overview.filesCard'),
            value: fileCount,
            href: '/files',
            hint: t('overview.browseFiles'),
            drawing: 'files' as const,
            color: THEMES.iris.accent
          }
        ])
  ]);
  const initialsOf = (name: string) =>
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  const faces = $derived(membersList.items.filter((m) => m.isActive).slice(0, 4));
  const isAdmin = $derived(data.me.role === 'owner' || data.me.role === 'admin');
</script>

<svelte:head>
  <title>{t('overview.title')} · {data.instance.name}</title>
</svelte:head>

<!-- The opening: the workspace on its own field, the sphere of the brand's
     presentations turning slowly beside the greeting. -->
<HeroBand>
  <p class="hero-eyebrow">{workspaceName}</p>
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
</HeroBand>

<div class="mt-4 grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
  {#each stats as stat (stat.id)}
    <StatTile
      label={stat.label}
      value={stat.value}
      hint={stat.hint}
      href={stat.href}
      drawing={stat.drawing}
      color={stat.color}
    />
  {/each}
</div>

{#if recentDecks.length}
  <div class="section-head mt-10 !mb-5 items-center justify-between">
    <h2>{t('overview.allDecks')}</h2>
    <a
      href="/decks"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      {t('overview.browseDecks')}
    </a>
  </div>
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each recentDecks as deck (deck.id)}
      <DeckCard {deck} compact />
    {/each}
  </div>
{/if}

<div class="mt-10 grid gap-4 lg:grid-cols-2">
  <!-- The workspace's brand: the default brand, or the invitation to make one -->
  {#if !isGuest}
    <a href="/brands" class="sheet tile lower" data-testid="default-brand">
      <div class="fan" aria-hidden="true">
        {#if brandSwatches.length}
          {#each brandSwatches as swatch, i (swatch.name + swatch.hex)}
            <div class="fan-slide" style="--i: {i}; background: {swatch.hex}"></div>
          {/each}
        {:else}
          <div class="fan-slide fan-empty" style="--i: 0"><Palette class="size-6" strokeWidth={1.5} /></div>
        {/if}
      </div>
      <div class="lower-copy">
        {#if brand}
          <p class="hero-eyebrow lower-eyebrow">{t('overview.defaultBrandTitle')}</p>
          <h2 class="lower-title">{brand.title}</h2>
          <p class="lower-body">{descriptionOf(brand.reference) || t('overview.defaultBrandBody')}</p>
        {:else if brand === null}
          <h2 class="lower-title">{t('overview.noBrandTitle')}</h2>
          <p class="lower-body">{t('overview.noBrandBody')}</p>
        {:else}
          <h2 class="lower-title">{t('overview.defaultBrandTitle')}</h2>
          <p class="lower-body">{t('overview.defaultBrandBody')}</p>
        {/if}
        <span class="lower-cta">{t('overview.brandsCta')}<ArrowRight class="size-3.5" /></span>
      </div>
    </a>
  {/if}

  <!-- P7: a hub workspace's membership is managed at the hub; the members page links out -->
  <a href={isAdmin && !hubManaged ? '/invitations' : '/members'} class="sheet tile lower">
    <div class="faces" aria-hidden="true">
      {#each faces as member, i (member.id)}
        <span class="face" style="--i: {i}">{initialsOf(member.name || member.email)}</span>
      {/each}
      {#each [0, 1, 2].slice(0, Math.max(1, 4 - faces.length)) as n (n)}
        <span class="face seat" style="--i: {faces.length + n}">+</span>
      {/each}
    </div>
    <div class="lower-copy">
      <h2 class="lower-title">{t('overview.teamTitle')}</h2>
      <p class="lower-body">{isAdmin ? t('overview.teamLede') : t('overview.askAdmin')}</p>
      <span class="lower-cta">
        {isAdmin && !hubManaged ? t('overview.teamCta') : t('overview.manageMembers')}<ArrowRight
          class="size-3.5"
        />
      </span>
    </div>
  </a>
</div>

<!-- what runs this workspace, for whoever needs it: one quiet line -->
<p class="mt-8 text-center text-xs text-muted-foreground">
  {t('overview.aboutInstance')} · {data.instance.name} · v{data.instance.version} · {data.instance.edition} · API
  {data.instance.apiVersion}
</p>

<style>
  .lower {
    display: grid;
    grid-template-columns: 1fr;
    gap: 18px;
    align-items: center;
    padding: 20px;
    overflow: hidden;
  }
  @media (min-width: 640px) {
    .lower {
      grid-template-columns: 210px 1fr;
      gap: 24px;
      padding: 22px 24px;
    }
  }
  .lower-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .lower-title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 20px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .lower-body {
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }
  .lower:hover .lower-cta :global(svg) {
    transform: translateX(3px);
  }
  .lower-cta :global(svg) {
    transition: transform var(--motion-duration) var(--motion-ease);
  }
  .lower-cta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 13.5px;
    color: var(--accent-deep);
  }
  /* the brand's colours as slides, fanned like the Slideless mark */
  .fan {
    position: relative;
    height: 128px;
  }
  .fan-slide {
    position: absolute;
    left: calc(8px + var(--i) * 18px);
    top: calc(26px - var(--i) * 7px);
    width: 120px;
    aspect-ratio: 16 / 9;
    transform: rotate(calc(-9deg + var(--i) * 4.5deg));
    box-shadow: var(--shadow-md);
    border: 1px solid var(--plate-edge);
    border-radius: 6px;
    transition: transform 320ms var(--motion-ease);
  }
  .fan-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    left: 30px;
    width: 150px;
    border: 1.5px dashed color-mix(in oklab, var(--accent) 50%, var(--hairline));
    background: var(--ground);
    color: var(--accent-deep);
    transform: rotate(-4deg);
  }
  .lower-eyebrow {
    margin-bottom: -2px;
  }
  @media (hover: hover) {
    .lower:hover .fan-slide {
      transform: rotate(calc(-13deg + var(--i) * 7deg)) translateY(calc(var(--i) * -2px));
    }
  }
  .faces {
    display: flex;
    align-items: center;
    padding-left: 10px;
    height: 96px;
  }
  /* under the pointer the faces rise and settle one after the other, the way
     the three slides beside them fan out, once; then they rest for about four
     seconds before the next rise (the movement is the first quarter of a
     five-second loop, the stagger rides on the delay) */
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .lower:hover .face,
    .lower:focus-visible .face {
      animation: bob 5s var(--motion-ease) infinite;
      animation-delay: calc(var(--i) * 0.13s);
    }
  }
  @keyframes bob {
    0%,
    26%,
    100% {
      transform: translateY(0);
    }
    9% {
      transform: translateY(-9px);
    }
    17% {
      transform: translateY(3px);
    }
  }
  .face {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 54px;
    height: 54px;
    margin-left: -10px;
    border-radius: 999px;
    border: 2px solid var(--ground);
    background: var(--accent-soft);
    color: var(--accent-deep);
    font-family: var(--display);
    font-size: 17px;
    z-index: calc(10 - var(--i));
    backdrop-filter: blur(6px);
  }
  .face.seat {
    border: 1.5px dashed color-mix(in oklab, var(--accent) 45%, var(--hairline));
    background: var(--plate-strong);
    color: var(--muted);
    font-family: var(--ui);
  }
</style>
