<!-- One of the overview's two lower tiles: a drawing on the left, a title, a
     sentence and where it leads on the right. The shell's own tile (the team)
     and the tool's (contribution.ts) are both this one, so they stay one family;
     the drawing is the caller's, and it hangs its hover on `.lower`. -->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import type { Snippet } from 'svelte';

  interface Props {
    href: string;
    testid?: string;
    /** A small line over the title, when the title is a name and needs saying what it is. */
    eyebrow?: string;
    title: string;
    body: string;
    cta: string;
    art: Snippet;
  }

  let { href, testid, eyebrow, title, body, cta, art }: Props = $props();
</script>

<a {href} class="sheet tile lower" data-testid={testid}>
  {@render art()}
  <div class="lower-copy">
    {#if eyebrow}
      <p class="hero-eyebrow lower-eyebrow">{eyebrow}</p>
    {/if}
    <h2 class="lower-title">{title}</h2>
    <p class="lower-body">{body}</p>
    <span class="lower-cta">{cta}<ArrowRight class="size-3.5" /></span>
  </div>
</a>

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
  .lower-eyebrow {
    margin-bottom: -2px;
  }
</style>
