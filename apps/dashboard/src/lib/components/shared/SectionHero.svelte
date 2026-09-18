<script lang="ts">
  /* How a page of the workspace opens: a compact hero band with where the
     page lives, its name and its sentence, and under it a bar that is part of
     the page. A section that holds sibling pages (people and their
     invitations; the instance and the account) names the SECTION on the band
     and carries the pages as tabs in the bar: the page's own name is the lit
     tab, and a heading for a reader who cannot see the tabs. A page with no
     sibling names itself on the band, and its bar carries a line of status
     and the page's one action; with neither there is no bar. When the page
     scrolls the band goes and the bar stays, held at the top of the scroll
     container. */
  import type { Snippet } from 'svelte';
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import SectionTabs from './SectionTabs.svelte';

  interface Tab {
    href: string;
    label: string;
    count?: number;
  }
  interface Props {
    /** The small line over the title: where this page lives. */
    eyebrow: string;
    /** The band's title: the section's name, or the page's own when it has no sibling. */
    title: string;
    /** One sentence on the page that is open. */
    lede?: string;
    /** In a tabbed section, the open page's own name: a heading for assistive technology (the lit tab says it to the eye). */
    pageTitle?: string;
    tabs?: Tab[];
    /** One quiet line at the left end of a bar that has no tabs (a row count). */
    status?: string;
    /** One of the engine's constructions (HeroBand). */
    drawing?: string;
    seed?: number;
    /** The page's one action, at the right end of the bar. */
    action?: Snippet;
  }

  let {
    eyebrow,
    title,
    lede,
    pageTitle,
    tabs = [],
    status,
    drawing = 'graph',
    seed,
    action
  }: Props = $props();

  const hasBar = $derived(tabs.length > 0 || !!action);
</script>

<div class="section-hero" class:alone={!hasBar}>
  <HeroBand {drawing} {seed} compact>
    <p class="hero-eyebrow">{eyebrow}</p>
    <h1 class="hero-title">{title}</h1>
    {#if lede}<p class="hero-lede">{lede}</p>{/if}
  </HeroBand>
</div>
{#if hasBar}
  <!-- a sibling of the band, not its child: a stuck element travels inside its
       parent, and the parent here is the whole page column -->
  <SectionTabs label={title} {tabs} {status} {action} />
{/if}
{#if pageTitle}<h2 class="sr-only">{pageTitle}</h2>{/if}

<style>
  .section-hero {
    margin-bottom: 4px;
  }
  .alone {
    margin-bottom: 22px;
  }
  @media (min-width: 768px) {
    .alone {
      margin-bottom: 26px;
    }
  }
</style>
