<script lang="ts">
  /* The phone's navigation (PRDCT-2436): four large entries under the thumb in
     place of the desk's sidebar. The two everyday sections first, the whole
     administration behind one entry, the settings last. */
  import { page, navigating } from '$app/state';
  import { isActive, type NavItem } from '$lib/nav';
  import { t } from '$lib/i18n';

  interface Props {
    tabs: NavItem[];
  }

  let { tabs }: Props = $props();

  // The navigation target as soon as a tap starts a navigation, so the
  // highlight flips under the thumb instead of after the load.
  const path = $derived(navigating.to?.url.pathname ?? page.url.pathname);
</script>

<nav class="tabbar" aria-label={t('nav.primary')}>
  {#each tabs as tab (tab.id)}
    {@const on = isActive(tab, path)}
    <a href={tab.href} class="tab" class:on aria-current={on ? 'page' : undefined}>
      <span class="pill"><tab.icon class="size-[22px]" strokeWidth={on ? 2 : 1.6} /></span>
      <span class="name">{tab.title}</span>
    </a>
  {/each}
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
