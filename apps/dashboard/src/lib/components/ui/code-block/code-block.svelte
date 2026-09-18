<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { tint, type CodeLanguage } from './tint.js';

  /* Code and commands, contained. The block never widens what holds it: a
     long line wraps softly inside (or scrolls sideways inside, with
     `wrap={false}`), a tall snippet scrolls inside too. The copy button sits
     in its corner and says when it has copied. `field` is the one-line form,
     a read-only input, for a link: it keeps the textbox role and its label,
     and selects itself on focus.

     SECURITY: the code is rendered as text, piece by piece, through text
     interpolation. Never {@html}: a snippet carries a link's secret and may
     one day carry user-authored text. */
  interface Props {
    code: string;
    /** A small heading over the block: what this snippet is. */
    label?: string;
    language?: CodeLanguage;
    /** Soft-wrap long lines (default). Off: one line per line, scrolling inside. */
    wrap?: boolean;
    /** One line, as a read-only input. */
    field?: boolean;
    /** The accessible name of the code itself (the input's, in `field`). */
    ariaLabel?: string;
    /** The copy button's accessible name. */
    copyLabel?: string;
    /** The toast after a copy; the generic one when absent. */
    copiedMessage?: string;
    class?: string;
  }

  let {
    code,
    label,
    language = 'text',
    wrap = true,
    field = false,
    ariaLabel,
    copyLabel = t('codeBlock.copy'),
    copiedMessage,
    class: className = ''
  }: Props = $props();

  const pieces = $derived(tint(code, language));

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The write happens here rather than through $lib/clipboard so the button
  // only says "copied" when the clipboard took it; the toasts are the same.
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      toast.error(t('clipboard.copyFailed'));
      return;
    }
    toast.success(copiedMessage ?? t('clipboard.copied'));
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1600);
  }
  $effect(() => () => clearTimeout(timer));
</script>

{#snippet copyButton()}
  <button
    type="button"
    class="copy"
    data-copied={copied ? '' : undefined}
    aria-label={copyLabel}
    onclick={copy}
  >
    <span class="glyph" aria-hidden="true">
      {#if copied}<Check />{:else}<Copy />{/if}
    </span>
  </button>
{/snippet}

<div
  class="code-block {className}"
  data-field={field ? '' : undefined}
  data-labelled={label ? '' : undefined}
>
  {#if field}
    <input
      class="line"
      readonly
      value={code}
      aria-label={ariaLabel ?? label}
      spellcheck="false"
      onfocus={(e) => e.currentTarget.select()}
    />
    {@render copyButton()}
  {:else}
    {#if label}
      <div class="head">
        <span class="name">{label}</span>
        {#if language !== 'text'}<span class="lang">{language}</span>{/if}
      </div>
    {/if}
    {@render copyButton()}
    <pre class="code" data-wrap={wrap ? '' : undefined} aria-label={ariaLabel}><code
        >{#each pieces as piece, i (i)}<span data-kind={piece.kind}>{piece.text}</span>{/each}</code
      ></pre>
  {/if}
</div>

<style>
  .code-block {
    position: relative;
    display: block;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    background: color-mix(in oklab, var(--ground-2) 78%, var(--plate-strong));
    box-shadow: inset 0 1px 0 var(--plate-edge);
    color: var(--ink);
    transition: border-color var(--motion-duration) var(--motion-ease);
  }
  .code-block:hover,
  .code-block:focus-within {
    border-color: color-mix(in oklab, var(--accent) 40%, var(--hairline));
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 44px 0 12px;
    border-bottom: 1px solid color-mix(in oklab, var(--hairline) 70%, transparent);
  }
  .name {
    overflow: hidden;
    font-family: var(--second);
    font-size: 10.5px;
    font-weight: 300;
    letter-spacing: 0.14em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--muted);
  }
  .lang {
    flex: none;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--accent-soft);
    font-family: var(--mono);
    font-size: 10px;
    color: var(--accent-deep);
  }
  .code {
    margin: 0;
    /* a caller with a short list that must stay whole lifts the cap */
    max-height: var(--code-max-h, 190px);
    overflow: auto;
    padding: 11px 12px 12px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.65;
    letter-spacing: 0;
    tab-size: 2;
    white-space: pre;
  }
  .code[data-wrap] {
    overflow-x: hidden;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  /* with no heading the button shares the first line's row */
  .code-block:not([data-labelled]) > .code {
    padding-right: 46px;
  }
  .code [data-kind='tag'] {
    color: var(--accent-deep);
  }
  .code [data-kind='attr'],
  .code [data-kind='flag'] {
    color: color-mix(in oklab, var(--accent) 72%, var(--ink));
  }
  .code [data-kind='value'] {
    color: color-mix(in oklab, var(--ok) 74%, var(--ink));
  }
  .code [data-kind='punct'] {
    color: var(--muted);
  }

  .copy {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 1;
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 7px;
    color: var(--muted);
    transition:
      background-color var(--motion-duration) var(--motion-ease),
      border-color var(--motion-duration) var(--motion-ease),
      color var(--motion-duration) var(--motion-ease),
      transform var(--motion-duration) var(--motion-ease);
  }
  .copy:hover {
    border-color: var(--hairline);
    background: var(--plate-strong);
    color: var(--ink);
  }
  .copy:active {
    transform: scale(0.94);
  }
  .copy:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .copy[data-copied] {
    border-color: color-mix(in oklab, var(--ok) 35%, transparent);
    background: var(--ok-soft);
    color: var(--ok);
  }
  .glyph {
    display: inline-flex;
  }
  .glyph :global(svg) {
    width: 14px;
    height: 14px;
  }
  .copy[data-copied] .glyph {
    animation: code-copied calc(var(--motion-duration) * 1.5) var(--motion-ease);
  }
  @keyframes code-copied {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
  }

  /* the one-line form */
  .code-block[data-field] {
    display: flex;
    align-items: center;
    height: var(--control-h-lg);
  }
  .line {
    min-width: 0;
    flex: 1 1 auto;
    height: 100%;
    padding: 0 4px 0 12px;
    border: 0;
    background: transparent;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0;
    color: var(--ink);
    text-overflow: ellipsis;
    outline: none;
  }
  .code-block[data-field] .copy {
    position: static;
    flex: none;
    width: 30px;
    height: 30px;
    margin-right: 4px;
  }
  .code-block[data-field]:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
</style>
