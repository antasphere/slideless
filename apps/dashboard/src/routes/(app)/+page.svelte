<script lang="ts">
  import FieldCanvas from '$lib/components/brand/FieldCanvas.svelte';
  import StatGlyph from '$lib/components/brand/StatGlyph.svelte';
  import BrandSlide from '$lib/components/brands/BrandSlide.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { BRAND_FONTS_HREF, DEMO_BRANDS } from '$lib/brands-demo';
  import { heroPalette as heroFor, look } from '$lib/look.svelte';
  import DeckCard from '$lib/components/decks/DeckCard.svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { RECIPE, THEMES } from '$lib/brand/recipe.js';
  import { theme } from '$lib/theme.svelte';
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
  const heroPalette = $derived(heroFor(look.value.theme, theme.dark));

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

  // One form and one colour per figure, each colour one of the brand's own themes.
  const stats = $derived([
    {
      id: 'decks',
      label: t('overview.decksCard'),
      value: deckCount,
      href: '/decks',
      hint: t('overview.browseDecks'),
      form: 'square' as const,
      color: THEMES.dawn.accent
    },
    {
      id: 'opens',
      label: t('overview.opensCard'),
      value: openCount,
      href: '/decks',
      hint: t('overview.opensHint'),
      form: 'circle' as const,
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
            form: 'arc' as const,
            color: THEMES.reef.accent
          },
          {
            id: 'files',
            label: t('overview.filesCard'),
            value: fileCount,
            href: '/files',
            hint: t('overview.browseFiles'),
            form: 'diamond' as const,
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
  let played = $state<string | null>(null);
</script>

<svelte:head>
  <title>{t('overview.title')} · {data.instance.name}</title>
  <link rel="stylesheet" href={BRAND_FONTS_HREF} />
</svelte:head>

<!-- The opening: the workspace on its own field, the sphere of the brand's
     presentations turning slowly behind the greeting. Decoration only; the
     field never moves for a reader who asked for no motion. -->
<section class="hero plate-window">
  <div class="hero-ground">
    <FieldCanvas palette={heroPalette} shape="latitudes" seed={RECIPE.seed} linework={false} />
  </div>
  <!-- the sphere is its own square canvas on the same field, its edge faded
       into the ground by a mask, so it can sit beside the words on a desk and
       above them on a phone without a seam -->
  <div class="hero-sphere">
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
      <span class="stat-wash" style="--c: {stat.color}"></span>
      <div class="stat-plate">
        <StatGlyph form={stat.form} color={stat.color} active={played === stat.id} />
      </div>
      <p class="overline">{stat.label}</p>
      <p class="figure stat-figure">{stat.value ?? '—'}</p>
      <p class="stat-hint">{stat.hint}</p>
    </a>
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
  <!-- Brands: a preview of an idea, with made-up brands ($lib/brands-demo.ts) -->
  <a href="/brands" class="sheet tile lower">
    <div class="fan" aria-hidden="true">
      {#each DEMO_BRANDS as brand, i (brand.id)}
        <div class="fan-slide" style="--i: {i}"><BrandSlide {brand} small /></div>
      {/each}
    </div>
    <div class="lower-copy">
      <h2 class="lower-title">{t('overview.brandsTitle')}</h2>
      <p class="lower-body">{t('overview.brandsBody')}</p>
      <span class="lower-cta">{t('overview.brandsCta')}<ArrowRight class="size-3.5" /></span>
    </div>
  </a>

  <section class="sheet lower">
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
      <p class="lower-body">{t('overview.teamLede')}</p>
      {#if isAdmin}
        <!-- P7: a hub workspace's membership is managed at the hub; the members page links out -->
        <Button href={hubManaged ? '/members' : '/invitations'} size="sm" class="mt-1 w-fit">
          {hubManaged ? t('overview.manageMembers') : t('overview.teamCta')}
        </Button>
      {:else}
        <p class="text-sm text-muted-foreground">{t('overview.askAdmin')}</p>
      {/if}
    </div>
  </section>
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
  .hero-ground {
    position: absolute;
    inset: 0;
  }
  .hero-sphere {
    position: absolute;
    top: -40px;
    right: -34px;
    width: 176px;
    aspect-ratio: 1;
    -webkit-mask-image: radial-gradient(closest-side, #000 78%, transparent 100%);
    mask-image: radial-gradient(closest-side, #000 78%, transparent 100%);
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
    .stat-plate {
      width: 52px;
      height: 52px;
    }
    .hero {
      min-height: 250px;
    }
    .hero-sphere {
      top: 50%;
      right: 5%;
      width: 330px;
      transform: translateY(-50%);
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
  .stat :global(.overline) {
    display: block;
    width: fit-content;
    max-width: calc(100% - 50px);
  }
  .stat-plate {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 46px;
    height: 46px;
  }
  /* a breath of the figure's own colour in its corner, under the grain */
  .stat-wash {
    position: absolute;
    inset: 0;
    background:
      var(--grain),
      radial-gradient(70% 90% at 100% 0%, color-mix(in oklab, var(--c) 22%, transparent), transparent 70%);
    background-blend-mode: overlay, normal;
    pointer-events: none;
  }
  .stat > :global(p) {
    position: relative;
  }

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
  .lower-cta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 13.5px;
    color: var(--accent-deep);
  }
  /* three slides, fanned like the Slideless mark */
  .fan {
    position: relative;
    height: 128px;
  }
  .fan-slide {
    position: absolute;
    left: calc(8px + var(--i) * 24px);
    top: calc(26px - var(--i) * 10px);
    width: 150px;
    transform: rotate(calc(-7deg + var(--i) * 6deg));
    box-shadow: var(--shadow-md);
    border-radius: 6px;
    transition: transform 320ms var(--motion-ease);
  }
  @media (hover: hover) {
    .lower:hover .fan-slide {
      transform: rotate(calc(-11deg + var(--i) * 10deg)) translateY(calc(var(--i) * -2px));
    }
  }
  .faces {
    display: flex;
    align-items: center;
    padding-left: 10px;
    height: 84px;
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
