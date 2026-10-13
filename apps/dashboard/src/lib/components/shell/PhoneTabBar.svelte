<script lang="ts">
  /* The phone's navigation (PRDCT-2436, PRDCT-3413): at most four thumbs under
     the thumb in place of the desk's sidebar (the overview, the tool's own),
     then a Menu thumb that opens the whole sidebar as a drawer: the rest of
     the rail, the docs card and the account, from the same navigation data.
     The Menu thumb is lit while the drawer is open, and while the open page is
     one the bar has no thumb for. */
  import { page, navigating } from '$app/state';
  import { isActive, type NavItem } from '$lib/nav';
  import { t } from '$lib/i18n';
  import NavBadge from './NavBadge.svelte';
  import Menu from '@lucide/svelte/icons/menu';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';

  interface Props {
    tabs: NavItem[];
  }

  let { tabs }: Props = $props();

  // The navigation target as soon as a tap starts a navigation, so the
  // highlight flips under the thumb instead of after the load.
  const path = $derived(navigating.to?.url.pathname ?? page.url.pathname);

  // the Menu tab opens the whole sidebar as a drawer; a navigation closes it
  const sidebar = useSidebar();
  $effect(() => {
    void page.url.pathname;
    sidebar.setOpenMobile(false);
  });
  // a page behind the drawer (Settings, Apps) lights the Menu thumb, so the bar always says where you are
  const behind = $derived(!tabs.some((tab) => isActive(tab, path)));
  const menuOn = $derived(sidebar.openMobile || behind);
</script>

<nav class="tabbar" aria-label={t('nav.primary')}>
  {#each tabs as tab (tab.id)}
    {@const on = isActive(tab, path)}
    <a href={tab.href} class="tab" class:on aria-current={on ? 'page' : undefined}>
      <span class="pill"
        ><tab.icon class="size-[22px]" strokeWidth={on ? 2 : 1.6} /><NavBadge
          badge={tab.badge}
          class="tab-badge"
        /></span
      >
      <span class="name">{tab.title}</span>
    </a>
  {/each}
  <button
    type="button"
    class="tab"
    class:on={menuOn}
    aria-expanded={sidebar.openMobile}
    aria-current={behind && !sidebar.openMobile ? 'page' : undefined}
    onclick={() => sidebar.setOpenMobile(true)}
  >
    <span class="pill"><Menu class="size-[22px]" strokeWidth={menuOn ? 2 : 1.6} /></span>
    <span class="name">{t('nav.menu')}</span>
  </button>
</nav>

<style>
  .tabbar {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 40;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    height: calc(var(--tabbar-h) + env(safe-area-inset-bottom));
    padding: 6px 8px env(safe-area-inset-bottom);
    background: var(--bar);
    backdrop-filter: blur(18px) saturate(1.2);
    -webkit-backdrop-filter: blur(18px) saturate(1.2);
    border-top: 1px solid var(--hairline);
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--muted);
    -webkit-tap-highlight-color: transparent;
  }
  .pill {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 30px;
    border-radius: 999px;
    transition:
      background-color var(--motion-duration) var(--motion-ease),
      transform var(--motion-duration) var(--motion-ease);
  }
  .pill {
    position: relative;
  }
  /* the badge on the icon's corner, as the phones draw it */
  .pill :global(.tab-badge) {
    position: absolute;
    top: 0;
    left: 34px;
  }
  .tab:active .pill {
    transform: scale(0.94);
  }
  .name {
    font-size: 11px;
    line-height: 1;
    letter-spacing: 0.01em;
  }
  .on {
    color: var(--ink);
  }
  .on .pill {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .on .name {
    font-weight: 500;
  }
  /* a desk has its sidebar (a scoped rule outranks a utility class, so the
     breakpoint lives here) */
  @media (min-width: 768px) {
    .tabbar {
      display: none;
    }
  }
</style>
