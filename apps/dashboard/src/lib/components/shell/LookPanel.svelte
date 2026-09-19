<script lang="ts">
  /* The recipe box at the foot of the sidebar, as the brand console has it:
     one dot per theme, then the workspace's form (one glyph per pattern of
     the library), then how much of the field and how much grain. The look
     is the workspace's: the reset returns to its own defaults. */
  import ThemeDots from './ThemeDots.svelte';
  import FormGlyphs from './FormGlyphs.svelte';
  import { look } from '$lib/look.svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { t } from '$lib/i18n';

  const isDefault = $derived(
    look.value.theme === look.defaults.theme &&
      look.value.field === look.defaults.field &&
      look.value.grain === look.defaults.grain &&
      look.value.pattern === look.defaults.pattern
  );
</script>

<!-- At rest a single row: the dots. Under the pointer, or when a control
     inside has focus, the box unfolds to the forms, the name and the two
     sliders, slowly: it is a drawer a person opens by resting on it, never a
     thing that springs up as the pointer passes. -->
<div class="recipe">
  <ThemeDots value={look.value.theme} onpick={(key) => look.set({ theme: key })} spread />
  <div class="more">
    <!-- the workspace's form: one glyph per pattern, the current one ringed like the current dot -->
    <FormGlyphs value={look.value.pattern} onpick={(key) => look.set({ pattern: key })} spread />
    <div class="row">
      <span class="lbl"><b>{look.value.theme}</b></span>
      <button
        type="button"
        class="reset"
        disabled={isDefault}
        title={t('look.reset')}
        aria-label={t('look.reset')}
        onclick={() => look.set({ ...look.defaults })}
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
</div>

<style>
  .recipe {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 9px;
    min-height: 44px;
    padding: 10px 10px;
    margin: 0 4px 4px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    background: var(--plate-strong);
  }
  /* folded at rest; unfolds under the pointer or when a control inside has
     focus. Four and a half times the one motion on an ease that only slows
     down, no overshoot, and a short wait before it opens so a pointer passing
     over the dots does not pull the drawer out. Folding back takes the same
     time, with no wait. */
  .more {
    display: flex;
    flex-direction: column;
    gap: 9px;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transform: translateY(-4px);
    transition:
      max-height calc(var(--motion-duration) * 4.5) cubic-bezier(0.25, 1, 0.5, 1),
      opacity calc(var(--motion-duration) * 3) var(--motion-ease),
      transform calc(var(--motion-duration) * 4.5) cubic-bezier(0.25, 1, 0.5, 1);
  }
  .recipe:hover .more,
  .recipe:focus-within .more {
    max-height: 220px;
    opacity: 1;
    transform: translateY(0);
    transition-delay: 140ms;
  }
  @media (prefers-reduced-motion: reduce) {
    .more {
      transition: none;
    }
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
