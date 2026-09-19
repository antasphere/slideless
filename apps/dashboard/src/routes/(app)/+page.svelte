<script lang="ts">
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import StatTile from '$lib/components/brand/StatTile.svelte';
  import OverviewTile from '$lib/components/shell/OverviewTile.svelte';
  import { THEMES } from '$lib/brand/recipe.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { t } from '$lib/i18n';
  import { tool } from '$lib/tool';
  import type { FileInfo, Member } from '@slideless/contract';

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

  // What the tool shows here (contribution.ts): its sentence in the hero, its
  // figures before the shell's, what it made of late, the first lower tile.
  const toolOverview = tool.overview.create({
    isGuest: () => isGuest,
    workspaceName: () => workspaceName
  });
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

  $effect(() => {
    toolOverview.load();
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

  // One drawing and one colour per figure, each colour one of the brand's own themes.
  const stats = $derived([
    ...toolOverview.stats,
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
    {toolOverview.lede ?? overviewDescription}
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

<tool.overview.Recent model={toolOverview} />

<div class="mt-10 grid gap-4 lg:grid-cols-2">
  <tool.overview.Tile model={toolOverview} />

  <!-- P7: a hub workspace's membership is managed at the hub; the members page links out -->
  <OverviewTile
    href={isAdmin && !hubManaged ? '/invitations' : '/members'}
    title={t('overview.teamTitle')}
    body={isAdmin ? t('overview.teamLede') : t('overview.askAdmin')}
    cta={isAdmin && !hubManaged ? t('overview.teamCta') : t('overview.manageMembers')}
  >
    {#snippet art()}
      <div class="faces" aria-hidden="true">
        {#each faces as member, i (member.id)}
          <span class="face" style="--i: {i}">{initialsOf(member.name || member.email)}</span>
        {/each}
        {#each [0, 1, 2].slice(0, Math.max(1, 4 - faces.length)) as n (n)}
          <span class="face seat" style="--i: {faces.length + n}">+</span>
        {/each}
      </div>
    {/snippet}
  </OverviewTile>
</div>

<!-- what runs this workspace, for whoever needs it: one quiet line -->
<p class="mt-8 text-center text-xs text-muted-foreground">
  {t('overview.aboutInstance')} · {data.instance.name} · v{data.instance.version} · {data.instance.edition} · API
  {data.instance.apiVersion}
</p>

<style>
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
    :global(.lower:hover) .face,
    :global(.lower:focus-visible) .face {
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
