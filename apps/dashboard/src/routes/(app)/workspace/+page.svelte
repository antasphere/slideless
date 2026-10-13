<script lang="ts">
  /* The workspace page (PRDCT-2436): what the phone's tab bar has no room
     for (the drawer behind its Menu thumb lists the same), as large tiles with a plain sentence each, under the hero every
     workspace page opens on (the category, the workspace's name, one
     sentence). On a desk the rail lists the same entries. */
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import PatternCanvas from '$lib/components/brand/PatternCanvas.svelte';
  import WorkspaceSwitcher from '$lib/components/sidebar/WorkspaceSwitcher.svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import NavBadge from '$lib/components/shell/NavBadge.svelte';
  import { behindWorkspace, buildNav } from '$lib/nav';
  import { seedOf } from '$lib/brand/seed';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const nav = $derived(buildNav({ role: data.me.role, origin: data.me.origin }));
  // the references first, then the administration: what the phone's entry opens
  const tiles = $derived(behindWorkspace(nav));
  const several = $derived(data.me.workspaces.length > 1 && data.me.activeWorkspaceId !== '');

  let played = $state<string | null>(null);
</script>

<svelte:head><title>{t('nav.workspace')} · {data.instance.name}</title></svelte:head>

<SectionHero
  eyebrow={t('nav.workspace')}
  title={data.me.workspace.name}
  lede={t('workspace.description')}
  drawing="latitudes"
  seed={20261011}
/>

{#if several}
  <div class="mb-6 max-w-sm md:hidden">
    <WorkspaceSwitcher
      workspaces={data.me.workspaces}
      activeWorkspaceId={data.me.activeWorkspaceId}
      hubManageUrl={data.me.hubManageUrl}
    />
  </div>
{/if}

<div class="grid gap-4 sm:grid-cols-2">
  {#each tiles as tile (tile.id)}
    <a
      href={tile.href}
      class="sheet tile flex items-center gap-4 p-3"
      onpointerenter={() => (played = tile.id)}
      onpointerleave={() => (played = null)}
      onfocus={() => (played = tile.id)}
      onblur={() => (played = null)}
    >
      <div class="plate-window relative h-[76px] w-[96px] shrink-0">
        <PatternCanvas pattern={tile.pattern} seed={seedOf(tile.id)} active={played === tile.id} />
        <span class="absolute inset-0 flex items-center justify-center">
          <span class="icon-well"><tile.icon class="size-5" strokeWidth={1.6} /></span>
        </span>
      </div>
      <div class="min-w-0 flex-1">
        <h2 class="font-display text-[18px] font-normal leading-tight tracking-[-0.01em]">
          {tile.title}
        </h2>
        <p class="mt-1 text-[13.5px] leading-snug text-muted-foreground">{tile.blurb}</p>
      </div>
      <NavBadge badge={tile.badge} />
      <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
    </a>
  {/each}
</div>

<style>
  .icon-well {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 999px;
    background: var(--plate-strong);
    border: 1px solid var(--plate-edge);
    color: var(--accent-deep);
    box-shadow: var(--shadow-sm);
  }
</style>
