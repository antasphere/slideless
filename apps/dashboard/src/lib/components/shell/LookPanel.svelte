<script lang="ts">
  /* The recipe box at the foot of the sidebar, as the brand console has it:
     one dot per theme, then how much of the field and how much grain. */
  import { THEMES } from '$lib/brand/recipe.js';
  import { DEFAULT_LOOK, look, THEME_KEYS } from '$lib/look.svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { t } from '$lib/i18n';

  const isDefault = $derived(
    look.value.theme === DEFAULT_LOOK.theme &&
      look.value.field === DEFAULT_LOOK.field &&
      look.value.grain === DEFAULT_LOOK.grain
  );
</script>

<div class="recipe">
  <div class="dots" role="radiogroup" aria-label={t('look.theme')}>
    {#each THEME_KEYS as key (key)}
      <button
        type="button"
        role="radio"
        aria-checked={look.value.theme === key}
        class="tdot"
        class:on={look.value.theme === key}
        style="background: {key === 'paper' ? '#D8D2C4' : THEMES[key].accent}"
        title={key}
        aria-label={key}
        onclick={() => look.set({ theme: key })}
      ></button>
    {/each}
  </div>
  <div class="row">
    <span class="lbl"><b>{look.value.theme}</b></span>
    <button
      type="button"
      class="reset"
      disabled={isDefault}
      title={t('look.reset')}
      aria-label={t('look.reset')}
      onclick={() => look.set({ ...DEFAULT_LOOK })}
    >
      <RotateCcw class="size-3" />
    </button>
  </div>
  <label class="slider">
    <span class="lbl">{t('look.field')}</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={look.value.field}
      oninput={(e) => look.set({ field: Number(e.currentTarget.value) })}
    />
  </label>
  <label class="slider">
    <span class="lbl">{t('look.grain')}</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={look.value.grain}
      oninput={(e) => look.set({ grain: Number(e.currentTarget.value) })}
    />
  </label>
</div>

<style>
  .recipe {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 11px 10px 10px;
    margin: 0 4px 4px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    background: var(--plate-strong);
  }
  .dots {
    display: flex;
    justify-content: space-between;
  }
  .tdot {
    appearance: none;
    border: 0;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    cursor: pointer;
    outline-offset: 2px;
    transition:
      transform 0.12s ease,
      box-shadow 0.12s ease;
  }
  .tdot:hover {
    transform: scale(1.15);
  }
  .tdot.on {
    box-shadow:
      0 0 0 2px var(--ground),
      0 0 0 3.5px var(--ink);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .reset {
    display: flex;
    padding: 3px;
    border-radius: 5px;
    color: var(--muted);
  }
  .reset:hover:not(:disabled) {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .reset:disabled {
    opacity: 0.3;
  }
  .slider {
    display: grid;
    grid-template-columns: 58px 1fr;
    align-items: center;
    gap: 8px;
  }
  input[type='range'] {
    appearance: none;
    width: 100%;
    height: 14px;
    background: transparent;
    cursor: pointer;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 3px;
    background: var(--hairline);
  }
  input[type='range']::-moz-range-track {
    height: 3px;
    border-radius: 3px;
    background: var(--hairline);
  }
  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4.5px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--ground);
    box-shadow: 0 0 0 1px var(--accent);
  }
  input[type='range']::-moz-range-thumb {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--ground);
    box-shadow: 0 0 0 1px var(--accent);
  }
</style>
