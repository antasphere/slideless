<script lang="ts">
  /* The brand's themes as one dot each, the picked one ringed. The recipe box
     at the foot of the sidebar and the create-workspace dialog share it. */
  import { THEMES } from '$lib/brand/recipe.js';
  import { THEME_KEYS, type ThemeKey } from '$lib/look.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    value: ThemeKey;
    onpick: (key: ThemeKey) => void;
    /** A dot's diameter in px. */
    size?: number;
    /** Spread the dots across the row (the sidebar's box) or set them in a run. */
    spread?: boolean;
  }

  let { value, onpick, size = 13, spread = false }: Props = $props();
</script>

<div class="dots" class:spread role="radiogroup" aria-label={t('look.theme')} style="--dot: {size}px">
  {#each THEME_KEYS as key (key)}
    <button
      type="button"
      role="radio"
      aria-checked={value === key}
      class="tdot"
      class:on={value === key}
      style="background: {key === 'paper' ? '#D8D2C4' : THEMES[key].accent}"
      title={key}
      aria-label={key}
      onclick={() => onpick(key)}
    ></button>
  {/each}
</div>

<style>
  .dots {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .dots.spread {
    justify-content: space-between;
    gap: 0;
  }
  .tdot {
    appearance: none;
    border: 0;
    padding: 0;
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    cursor: pointer;
    outline-offset: 2px;
    transition: box-shadow 0.12s ease;
  }
  .tdot:hover {
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--ink) 30%, transparent);
  }
  .tdot.on,
  .tdot.on:hover {
    box-shadow:
      0 0 0 2px var(--ground),
      0 0 0 3.5px var(--ink);
  }
</style>
