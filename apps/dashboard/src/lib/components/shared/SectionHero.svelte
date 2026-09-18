<script lang="ts">
  /* How a page of the workspace opens: a compact hero band with where the
     page lives, its name and its sentence. A section that holds sibling
     pages (people and their invitations; the instance and the account) names
     the SECTION on the band and carries the pages as tabs in a bar under it:
     the page's own name is the lit tab, and a heading for a reader who
     cannot see the tabs. A page with no sibling names itself on the band and
     has no bar: its count and its action sit in the toolbar over its table
     (TableToolbar). When the page scrolls the band goes and the bar stays,
     held at the top of the scroll container. */
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
    /** One of the engine's constructions (HeroBand). */
    drawing?: string;
    seed?: number;
  }

  let { eyebrow, title, lede, pageTitle, tabs = [], drawing = 'graph', seed }: Props = $props();

  const hasBar = $derived(tabs.length > 0);
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
  <SectionTabs label={title} {tabs} />
{/if}
{#if pageTitle}<h2 class="sr-only">{pageTitle}</h2>{/if}

<style>
  .section-hero {
    margin-bottom: 4px;
  }
  .alone {
    margin-bottom: 14px;
  }
  @media (min-width: 768px) {
    .alone {
      margin-bottom: 18px;
    }
  }
</style>
