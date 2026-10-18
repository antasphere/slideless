<!-- One app on the Apps page: a plate band with the tool's drawing
     (AppDrawing, the registry descriptor's name), its name in the display
     serif, one sentence on what it is (the descriptor's),
     a quiet line of facts when the hub knows them (connected since, last
     used), and the way in: Open, in a new tab, or "You are here" on this very
     tool. The account's card is the same card with the hub's drawing. On
     hover the card lifts and its border takes the accent. -->
<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Check from '@lucide/svelte/icons/check';
  import { Button } from '$lib/components/ui/button/index.js';
  import { t } from '$lib/i18n';
  import AppDrawing from './AppDrawing.svelte';

  interface Props {
    slug: string;
    name: string;
    /** The registry's drawing name (`TOOL_DRAWINGS`); absent, this tool's own concept or a monogram. */
    drawing?: string | null;
    /** The registry's accent (`#rrggbb`), the card's and the drawing's; absent, the page's. */
    accent?: string | null;
    sentence: string;
    /** The quiet line under the sentence (connected since, last used), or null. */
    fact?: string | null;
    href: string;
    /** This very tool: no button, the "You are here" mark. */
    current?: boolean;
    /** The button's words ("Open", "Open your account"). */
    action: string;
  }

  let {
    slug,
    name,
    drawing = null,
    accent = null,
    sentence,
    fact = null,
    href,
    current = false,
    action
  }: Props = $props();

  // the accent is the hub's validated #rrggbb, never anything else, so it may set the variable
  const style = $derived(accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? `--accent: ${accent}` : undefined);
</script>

<article class="card" class:current data-testid="app-card" data-app={slug} {style}>
  <div class="band">
    <AppDrawing {drawing} {name} {current} />
  </div>

  <div class="body">
    <h3 class="title">{name}</h3>
    <p class="sentence">{sentence}</p>
    {#if fact}<p class="fact">{fact}</p>{/if}
  </div>

  <footer class="foot">
    {#if current}
      <span class="here" data-testid="app-here"><Check class="size-3.5" />{t('apps.here')}</span>
    {:else}
      <Button
        size="sm"
        class="gap-1"
        {href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('apps.openLabel', { name })}
      >
        {action}
        <ArrowUpRight class="size-3.5" />
      </Button>
    {/if}
  </footer>
</article>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    background: var(--bar);
    box-shadow: var(--shadow-sm);
    transition:
      transform calc(var(--motion-duration) * 1.6) var(--motion-ease),
      box-shadow calc(var(--motion-duration) * 1.6) var(--motion-ease),
      border-color calc(var(--motion-duration) * 1.6) var(--motion-ease);
  }
  @media (hover: hover) {
    .card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
      border-color: color-mix(in oklab, var(--accent) 45%, var(--hairline));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .card:hover {
      transform: none;
      transition: none;
    }
  }
  /* the plate the drawing sits on: the page's paper, a hairline under it */
  .band {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 136px;
    padding: 12px 24px 8px;
    background: var(--plate);
    border-bottom: 1px solid var(--hairline);
  }
  .body {
    display: grid;
    flex: 1;
    align-content: start;
    gap: 6px;
    padding: 16px 18px 10px;
  }
  .title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 19px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .sentence {
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--muted);
  }
  .fact {
    margin-top: 2px;
    font-size: 12px;
    color: color-mix(in oklab, var(--muted) 80%, transparent);
  }
  .foot {
    display: flex;
    align-items: center;
    min-height: 52px;
    padding: 6px 18px 16px;
  }
  .here {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--muted);
    background: color-mix(in oklab, var(--ground-2) 60%, transparent);
  }
</style>
