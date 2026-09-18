<script lang="ts">
  /* A section that holds sibling pages (people and their invitations; the
     instance and the account) opens on one card: a compact hero band with the
     section's name and the open page's sentence, and the tab bar attached
     under it as the foot of the same card. When the page scrolls the band
     goes and the tab bar stays, held at the top of the scroll container as a
     bar. The band says the SECTION; the page's own name is the lit tab, and a
     heading for a reader who cannot see the tabs. */
  import type { Snippet } from 'svelte';
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import SectionTabs from './SectionTabs.svelte';

  interface Tab {
    href: string;
    label: string;
    count?: number;
  }
  interface Props {
    /** The small line over the title: where this section lives. */
    eyebrow: string;
    /** The section's name, the band's title. */
    title: string;
    /** One sentence on the page that is open. */
    lede?: string;
    /** The open page's own name: a heading for assistive technology (the lit tab says it to the eye). */
    pageTitle: string;
    tabs: Tab[];
    /** One of the engine's constructions (HeroBand). */
    drawing?: string;
    seed?: number;
    /** The page's one action, at the right end of the tab bar. */
    action?: Snippet;
  }

  let { eyebrow, title, lede, pageTitle, tabs, drawing = 'graph', seed, action }: Props = $props();
</script>

<div class="section-hero">
  <HeroBand {drawing} {seed} compact attached>
    <p class="hero-eyebrow">{eyebrow}</p>
    <h1 class="hero-title">{title}</h1>
    {#if lede}<p class="hero-lede">{lede}</p>{/if}
  </HeroBand>
</div>
<!-- a sibling of the band, not its child: a stuck element travels inside its
     parent, and the parent here is the whole page column -->
<SectionTabs label={title} {tabs} {action} />
<h2 class="sr-only">{pageTitle}</h2>
