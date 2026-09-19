<script lang="ts">
  /* The workspace's look, chosen: the brand's themes as a run of dots and
     its pattern library as a grid of glyphs, each set under its word and
     with the picked one named beside it. The workspace settings and the
     create dialog share it; a change is reported up, the caller decides
     whether it is tried live or saved. Sized for a hand, not a sidebar. */
  import { THEMES } from '$lib/brand/recipe.js';
  import { formMask, OFFERED_PATTERN_KEYS, patternName } from '$lib/brand/form';
  import { THEME_KEYS, type Look, type ThemeKey } from '$lib/look.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    value: Look;
    onchange: (patch: Partial<Look>) => void;
    /** A dot's diameter and a glyph's side, in px. */
    dot?: number;
    glyph?: number;
    /** The accent the glyphs are drawn in: the page's by default, a preview's in the create dialog. */
    accent?: string;
    /** Extra classes on the root. */
    class?: string;
  }

  let { value, onchange, dot = 24, glyph = 52, accent, class: className = '' }: Props = $props();

  /* Five forms are the offer. Someone who already wears a form from outside
     it (dealt before the offer shrank, or chosen when it was wider) must
     still see their own mark in the row and be able to return to it, so it
     is appended rather than hidden. */
  const formKeys = $derived(
    OFFERED_PATTERN_KEYS.includes(value.pattern)
      ? OFFERED_PATTERN_KEYS
      : [...OFFERED_PATTERN_KEYS, value.pattern]
  );

  const themeName = (key: ThemeKey) => key.charAt(0).toUpperCase() + key.slice(1);
</script>

<div class="picker {className}" style={accent ? `--pick-accent: ${accent}` : undefined}>
  <div class="row">
    <div class="head">
      <span class="eyebrow">{t('settings.colour')}</span>
      <span class="picked">{themeName(value.theme)}</span>
    </div>
    <div class="dots" role="radiogroup" aria-label={t('settings.colour')} style="--dot: {dot}px">
      {#each THEME_KEYS as key (key)}
        <button
          type="button"
          role="radio"
          aria-checked={value.theme === key}
          class="tdot"
          class:on={value.theme === key}
          style="background: {key === 'paper' ? '#D8D2C4' : THEMES[key].accent}"
          title={themeName(key)}
          aria-label={themeName(key)}
          onclick={() => onchange({ theme: key })}
        ></button>
      {/each}
    </div>
  </div>
  <div class="row">
    <div class="head">
      <span class="eyebrow">{t('settings.form')}</span>
      <span class="picked">{patternName(value.pattern)}</span>
    </div>
    <div class="forms" role="radiogroup" aria-label={t('settings.form')} style="--glyph: {glyph}px">
      {#each formKeys as key (key)}
        <button
          type="button"
          role="radio"
          aria-checked={value.pattern === key}
          class="fbtn"
          class:on={value.pattern === key}
          title={patternName(key)}
          aria-label={patternName(key)}
          data-pattern={key}
          onclick={() => onchange({ pattern: key })}
        >
          <span
            class="glyph"
            style="-webkit-mask-image: url({formMask(key, glyph)}); mask-image: url({formMask(key, glyph)})"
          ></span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .picker {
    --pick-accent: var(--accent);
    display: grid;
    gap: 18px;
  }
  .row {
    display: grid;
    gap: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .picked {
    font-family: var(--display);
    font-size: 15px;
    color: var(--ink-soft);
  }
  .dots {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .tdot {
    appearance: none;
    border: 0;
    padding: 0;
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    cursor: pointer;
    outline-offset: 3px;
    transition:
      box-shadow var(--motion-duration) var(--motion-ease),
      transform var(--motion-duration) var(--motion-ease);
  }
  .tdot:hover {
    transform: scale(1.12);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--ink) 30%, transparent);
  }
  .tdot.on,
  .tdot.on:hover {
    box-shadow:
      0 0 0 2.5px var(--ground),
      0 0 0 4.5px var(--ink);
  }
  /* Five marks, five columns: with a short offer the row is a set of
     choices, not a sheet to scan, so each one gets real size. A sixth (the
     form someone already wears) wraps onto the next line rather than
     squeezing the five. */
  .forms {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
  }
  .fbtn {
    appearance: none;
    border: 0;
    padding: 0;
    aspect-ratio: 1;
    width: 100%;
    max-width: calc(var(--glyph) * 1.6);
    border-radius: 26%;
    cursor: pointer;
    outline-offset: 2px;
    background: var(--plate-strong);
    box-shadow: inset 0 0 0 1px var(--hairline);
    transition:
      box-shadow var(--motion-duration) var(--motion-ease),
      background-color var(--motion-duration) var(--motion-ease),
      transform var(--motion-duration) var(--motion-ease);
  }
  .fbtn:hover {
    transform: translateY(-1px);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--pick-accent) 45%, var(--hairline));
  }
  .fbtn.on,
  .fbtn.on:hover {
    background: color-mix(in oklab, var(--pick-accent) 13%, transparent);
    box-shadow:
      0 0 0 2px var(--ground),
      0 0 0 3.5px var(--ink);
  }
  .glyph {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--pick-accent);
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
  }
</style>
