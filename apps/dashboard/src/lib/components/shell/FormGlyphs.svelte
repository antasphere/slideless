<script lang="ts">
  /* The brand's pattern library as one small glyph each (the form drawn
     still, in the current accent), the picked one ringed like a theme dot.
     The recipe box and the create-workspace dialog share it. */
  import { formMask, PATTERN_KEYS, patternName } from '$lib/brand/form';
  import { t } from '$lib/i18n';

  interface Props {
    value: string;
    onpick: (key: string) => void;
    /** A glyph's side in px. */
    size?: number;
    /** Spread the glyphs across the row (the sidebar's box) or set them in a run. */
    spread?: boolean;
  }

  let { value, onpick, size = 18, spread = false }: Props = $props();
</script>

<div class="forms" class:spread role="radiogroup" aria-label={t('look.form')} style="--glyph: {size}px">
  {#each PATTERN_KEYS as key (key)}
    <button
      type="button"
      role="radio"
      aria-checked={value === key}
      class="fbtn"
      class:on={value === key}
      title={patternName(key)}
      aria-label={patternName(key)}
      data-pattern={key}
      onclick={() => onpick(key)}
    >
      <span
        class="glyph"
        style="-webkit-mask-image: url({formMask(key, size)}); mask-image: url({formMask(key, size)})"
      ></span>
    </button>
  {/each}
</div>

<style>
  .forms {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .forms.spread {
    justify-content: space-between;
    gap: 5px 4px;
  }
  .fbtn {
    appearance: none;
    border: 0;
    padding: 0;
    width: var(--glyph);
    height: var(--glyph);
    border-radius: calc(var(--glyph) * 0.28);
    cursor: pointer;
    outline-offset: 2px;
    background: var(--plate-strong);
    box-shadow: inset 0 0 0 1px var(--hairline);
    transition: box-shadow 0.12s ease;
  }
  .fbtn:hover {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, var(--hairline));
  }
  .fbtn.on,
  .fbtn.on:hover {
    background: var(--accent-soft);
    box-shadow:
      0 0 0 2px var(--ground),
      0 0 0 3.5px var(--ink);
  }
  .glyph {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--accent);
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
  }
</style>
