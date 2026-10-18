<!-- What the rail unfolds under the Apps entry: the organization's tools as
     sub-entries, each opening its tool in a new tab, the account first, this
     tool marked as where the reader is. One read shared with the Apps page
     (`loadApps`); while it loads, three faint rows hold the room; with nothing
     to list, one quiet line sends to the page, and says the organization is
     suspended when the hub said so. The names come from the hub or
     the operator's file and render as text, here without the company's name in
     front (the Apps page keeps it), by name; the icon is the registry's
     descriptor (PRDCT-3493). The rows stand at the rail's own height,
     words and icons at its size, and reach its right edge. -->
<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Check from '@lucide/svelte/icons/check';
  import CircleUser from '@lucide/svelte/icons/circle-user';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { stagger } from '$lib/stagger';
  import ToolIcon from '$lib/tool/components/apps/ToolIcon.svelte';
  import { loadApps, shortName, sortApps } from '$lib/tool/apps';
  import { t } from '$lib/i18n';
  import type { NavItem } from '$lib/nav';
  import type { AppsList } from '@antasphere/chassis-contract';

  // the entry the fold hangs under: the sidebar hands it, and the list names it
  let { item }: { item: NavItem } = $props();

  let list = $state<AppsList | null>(null);
  let failed = $state(false);
  $effect(() => {
    loadApps()
      .then((answer) => (list = answer))
      .catch(() => (failed = true));
  });

  // the hub suspended the organization: the tools' rows give way to one line, the account's row stays
  const suspended = $derived(list?.organization?.status === 'suspended');

  // "Antasphere Finance" reads "Finance" in the fold: every row is the company's; the rows
  // by name, the icon the registry's descriptor names (PRDCT-3493), the grid for none
  const rows = $derived.by(() => {
    if (!list) return [];
    const apps = sortApps(list.apps).map((app) => ({
      key: app.slug,
      name: shortName(app.name),
      href: app.launchUrl,
      icon: app.descriptor?.icon ?? null,
      current: app.current
    }));
    return list.hub
      ? [
          {
            key: 'hub',
            name: shortName(list.hub.name),
            href: list.hub.url,
            icon: 'account',
            current: false
          },
          ...apps
        ]
      : apps;
  });
</script>

<!-- the sub-list keeps its left line and indent, not the margin on its right -->
<Sidebar.MenuSub class="fold-list mr-0 pr-0" data-testid="apps-fold" data-fold={item.id}>
  {#if !list && !failed}
    {#each [1, 2, 3] as n (n)}
      <li class="ghost" aria-hidden="true"></li>
    {/each}
  {:else if rows.length === 0}
    <Sidebar.MenuSubItem>
      <Sidebar.MenuSubButton href="/apps" class="h-9 text-muted-foreground" data-testid="apps-fold-empty">
        <LayoutGrid />
        <span>{t('apps.foldEmpty')}</span>
      </Sidebar.MenuSubButton>
    </Sidebar.MenuSubItem>
  {:else}
    <div use:stagger class="contents">
      {#each suspended ? rows.filter((r) => r.key === 'hub') : rows as row (row.key)}
        <Sidebar.MenuSubItem>
          {#if row.current}
            <span class="here" title={t('apps.here')}>
              {#if row.icon === 'account'}<CircleUser />{:else}<ToolIcon name={row.icon} />{/if}
              <span class="min-w-0 truncate">{row.name}</span>
              <Check class="mark" />
            </span>
          {:else}
            <Sidebar.MenuSubButton href={row.href} target="_blank" rel="noopener" class="row h-9">
              {#if row.icon === 'account'}<CircleUser />{:else}<ToolIcon name={row.icon} />{/if}
              <span class="min-w-0 truncate">{row.name}</span>
              <ArrowUpRight class="out" />
            </Sidebar.MenuSubButton>
          {/if}
        </Sidebar.MenuSubItem>
      {/each}
      {#if suspended}
        <Sidebar.MenuSubItem>
          <Sidebar.MenuSubButton
            href="/apps"
            class="h-9 text-muted-foreground"
            data-testid="apps-fold-suspended"
          >
            <LayoutGrid />
            <span>{t('apps.foldSuspended')}</span>
          </Sidebar.MenuSubButton>
        </Sidebar.MenuSubItem>
      {/if}
    </div>
  {/if}
</Sidebar.MenuSub>

<style>
  .ghost {
    height: 28px;
    margin: 4px 8px;
    border-radius: 6px;
    background: color-mix(in oklab, var(--ink) 5%, transparent);
  }
  /* this tool: named like the others, never a link */
  .here {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 8px;
    font-size: 14px;
    translate: -1px 0; /* the buttons' own nudge, so the rows line up */
    color: var(--muted);
  }
  .here :global(svg) {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .here :global(.mark) {
    width: 12px;
    height: 12px;
    margin-left: auto;
    color: var(--ok);
  }
  /* the out-arrow sits at the far edge and shows under the hand */
  :global(.row .out) {
    width: 12px !important;
    height: 12px !important;
    margin-left: auto;
    color: var(--muted);
    opacity: 0;
    transition: opacity var(--motion-duration) var(--motion-ease);
  }
  :global(.row:hover .out),
  :global(.row:focus-visible .out) {
    opacity: 1;
  }
</style>
