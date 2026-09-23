<script lang="ts">
  /* The card at the foot of the rail, over the person: where the docs are,
     and the one prompt that sets an agent up on this instance. A sheet, as
     every card, with a drawing in the hand of the figures' drawings (the
     pages of the docs, the ringed dot on the one that carries the meaning)
     and two quiet actions: the docs open in a new tab, the prompt goes to
     the clipboard and the button says so. It folds away with the rail:
     collapsed to icons there is no room for a card, and the docs are one
     click away in the welcome and the help. */
  import { page } from '$app/state';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { DOCS_URL, agentPrompt } from '$lib/docs';
  import { t } from '$lib/i18n';

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The write happens here rather than through $lib/clipboard so the button
  // only says "copied" when the clipboard took it (the code block's rule).
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(agentPrompt(page.url.origin));
    } catch {
      toast.error(t('clipboard.copyFailed'));
      return;
    }
    toast.success(t('docsCard.copied'));
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1600);
  }
  $effect(() => () => clearTimeout(timer));
</script>

<div class="docs-card sheet group-data-[collapsible=icon]:hidden" data-docs-card>
  <div class="head">
    <div class="drawing-box" aria-hidden="true">
      <svg viewBox="0 0 96 96" class="drawing">
        <!-- the docs: two pages behind, one in front carrying the lines, and
           the ringed dot on the line a reader is on -->
        <rect class="bx page page-l" x="24" y="30" width="46" height="40" rx="4" />
        <rect class="bx page page-r" x="24" y="30" width="46" height="40" rx="4" />
        <g class="front">
          <rect class="bx bx--front" x="24" y="30" width="46" height="40" rx="4" />
          <line class="ln ln--thin" x1="32" y1="41" x2="56" y2="41" />
          <line class="ln ln--c" x1="32" y1="49" x2="48" y2="49" />
          <line class="ln ln--thin" x1="32" y1="57" x2="60" y2="57" />
          <circle class="ring ring--c" cx="61" cy="49" r="4" />
          <circle class="dot dot--c" cx="61" cy="49" r="1.6" />
        </g>
      </svg>
    </div>
    <p class="title">{t('docsCard.title')}</p>
  </div>
  <p class="body">{t('docsCard.body')}</p>
  <div class="acts">
    <Button variant="outline" size="xs" href={DOCS_URL} target="_blank" rel="noreferrer">
      <BookOpen />
      {t('docsCard.read')}
    </Button>
    <Button variant="ghost" size="xs" onclick={() => void copyPrompt()} data-copied={copied || undefined}>
      {#if copied}<Check class="text-[var(--ok)]" />{:else}<Copy />{/if}
      {copied ? t('docsCard.copiedShort') : t('docsCard.copyPrompt')}
    </Button>
  </div>
</div>

<style>
  .docs-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 4px 6px;
    padding: 12px;
    border-radius: 10px;
  }
  /* the drawing and the title on one line: the mark of the thing, then its
     name, the way every other card in the app opens */
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .drawing-box {
    flex: none;
    width: 30px;
    height: 30px;
    /* the drawing's one colour: the accent, as on the overview's tiles */
    --c: var(--accent);
  }
  .title {
    margin: 0;
    font-family: var(--display);
    font-size: 15px;
    font-weight: 400;
    letter-spacing: -0.005em;
    line-height: 1.2;
    color: var(--ink);
  }
  .body {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted);
    text-wrap: pretty;
  }
  .acts {
    display: grid;
    gap: 4px;
  }
  .acts :global(a),
  .acts :global(button) {
    width: 100%;
    height: 28px;
    padding-inline: 8px;
    font-size: 12.5px;
  }

  /* the drawing, in the figures' vocabulary (StatDrawing's classes) */
  .drawing {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .drawing :is(.ln, .bx, .ring) {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ln {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 45%, transparent);
    stroke-width: 1.2;
  }
  .ln--thin {
    stroke: color-mix(in oklab, var(--ink) 30%, transparent);
    stroke-width: 1;
  }
  .bx {
    fill: color-mix(in oklab, var(--ground) 40%, transparent);
    stroke: color-mix(in oklab, var(--ink) 40%, transparent);
    stroke-width: 1;
  }
  .bx--front {
    fill: color-mix(in oklab, var(--ground), white 55%);
  }
  :global(:root.dark) .bx--front {
    fill: var(--ground-3);
  }
  .dot {
    fill: color-mix(in oklab, var(--ink) 78%, transparent);
  }
  .ring {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 42%, transparent);
    stroke-width: 1;
  }
  .ln--c {
    stroke: var(--c);
    stroke-width: 1.6;
  }
  .dot--c {
    fill: var(--c);
  }
  .ring--c {
    stroke: var(--c);
  }
  /* the pages behind fan out a touch under the hand, once, CSS only */
  .page,
  .front {
    transition: transform 460ms var(--motion-ease);
    transform-origin: 47px 96px;
  }
  .page-l {
    transform: rotate(-7deg);
  }
  .page-r {
    transform: rotate(7deg);
  }
  @media (hover: hover) {
    .docs-card:hover .page-l {
      transform: rotate(-13deg);
    }
    .docs-card:hover .page-r {
      transform: rotate(13deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .page,
    .front {
      transition: none;
    }
  }
</style>
