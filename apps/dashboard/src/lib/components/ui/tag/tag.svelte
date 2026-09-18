<script lang="ts" module>
  /* A tag says what KIND of thing a value is before the eye reads it: a tone
     per meaning (who acted, what a key may do, what a file is), a small glyph,
     and the value in the body face. A wash of the tone under its own ink, one
     faint edge, soft corners: a label on paper, not a log line. The tones are
     the brand's own themes, so a tag never brings a colour the brand lacks. */
  export const TAG_TONES = {
    clay: '#C05E45',
    amber: '#C7822F',
    green: '#2E8A74',
    indigo: '#5058B4',
    violet: '#7A66A8',
    slate: '#5C7285',
    danger: '#B4552F',
    neutral: ''
  } as const;
  export type TagTone = keyof typeof TAG_TONES;
</script>

<script lang="ts">
  import type { Component } from 'svelte';

  interface Props {
    /** Rendered as text, never as markup: a label may be user-authored. */
    label: string;
    tone?: TagTone;
    icon?: Component;
    /** A second, stronger segment: the verb of a scope, the unit of a figure. */
    detail?: string;
    /** An identifier: the mono face, copied as it is read. */
    mono?: boolean;
    /** A state rather than a kind: a dot in place of the glyph. */
    dot?: boolean;
    title?: string;
  }

  let { label, tone = 'neutral', icon: Icon, detail, mono = false, dot = false, title }: Props = $props();
</script>

<span
  class="tag"
  class:mono
  class:neutral={tone === 'neutral'}
  style="--tone: {TAG_TONES[tone] || 'var(--muted)'}"
  {title}
>
  {#if dot}<span class="dot"></span>{:else if Icon}<Icon class="glyph" strokeWidth={1.8} />{/if}
  <span class="label">{label}</span>
  {#if detail}<span class="detail">{detail}</span>{/if}
</span>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 24px;
    padding: 0 8px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--tone) 24%, transparent);
    background: color-mix(in oklab, var(--tone) 11%, var(--plate-strong));
    color: color-mix(in oklab, var(--tone) 62%, var(--ink));
    font-family: var(--ui);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0;
    white-space: nowrap;
    vertical-align: middle;
    user-select: none;
  }
  .neutral {
    border-color: var(--hairline);
    background: var(--ground-2);
    color: var(--ink-soft);
  }
  .mono {
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 400;
    user-select: all;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag :global(.glyph) {
    flex: none;
    width: 12px;
    height: 12px;
    opacity: 0.85;
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--tone) 18%, transparent);
    margin: 0 2px 0 1px;
  }
  /* the second segment sits in a deeper wash, flush with the tag's right edge */
  .detail {
    align-self: stretch;
    display: inline-flex;
    align-items: center;
    margin: -1px -9px -1px 3px;
    padding: 0 8px 0 7px;
    border-radius: 0 6px 6px 0;
    background: color-mix(in oklab, var(--tone) 20%, transparent);
    border-left: 1px solid color-mix(in oklab, var(--tone) 24%, transparent);
  }
</style>
