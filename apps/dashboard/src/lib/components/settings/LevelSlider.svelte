<script lang="ts">
  /* A level between nothing and all of it, set by hand: the organization's
     gradient and its grain. The rail fills with the accent up to the thumb,
     a notch marks the brand's constant (the value a reset returns to, and
     the thumb settles on it when let go within a step of it), and the value
     is read beside the word, in the hand of the picker's "picked" names.
     A native range underneath: the keyboard, the screen reader and the
     phone's drag are the browser's own. */
  import { getLocale } from '$lib/i18n';

  interface Props {
    label: string;
    value: number;
    /** The brand's constant, marked on the rail. */
    mark?: number;
    step?: number;
    disabled?: boolean;
    oninput: (value: number) => void;
    testid?: string;
  }
  let { label, value, mark, step = 0.05, disabled = false, oninput, testid }: Props = $props();

  const percent = $derived(
    new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(value)
  );
</script>

<label class="level" class:disabled>
  <span class="head">
    <span class="eyebrow">{label}</span>
    <span class="picked">{percent}</span>
  </span>
  <span class="rail" style="--v: {value}; --mark: {mark ?? 0}">
    <span class="fill" aria-hidden="true"></span>
    {#if mark !== undefined}
      <span class="notch" class:under={value >= mark} aria-hidden="true"></span>
    {/if}
    <input
      type="range"
      min="0"
      max="1"
      {step}
      {value}
      {disabled}
      data-testid={testid}
      oninput={(e) => oninput(Number(e.currentTarget.value))}
    />
  </span>
</label>

<style>
  .level {
    --thumb: 20px;
    display: grid;
    gap: 8px;
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
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
  }
  /* the rail is inset by half a thumb, so the fill's end and the notch sit
     exactly under the thumb's centre at every value */
  .rail {
    position: relative;
    display: block;
    height: var(--thumb);
  }
  .rail::before,
  .fill {
    content: '';
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2);
    height: 6px;
    margin-top: -3px;
    border-radius: 999px;
  }
  .rail::before {
    right: calc(var(--thumb) / 2);
    background: var(--plate-strong);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .fill {
    width: calc((100% - var(--thumb)) * var(--v));
    background: linear-gradient(90deg, color-mix(in oklab, var(--accent) 45%, transparent), var(--accent));
  }
  .notch {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--mark));
    width: 2px;
    height: 12px;
    margin: -6px 0 0 -1px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--ink) 30%, transparent);
  }
  .notch.under {
    background: color-mix(in oklab, var(--accent-ink) 70%, transparent);
    height: 6px;
    margin-top: -3px;
  }
  input {
    appearance: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    cursor: pointer;
    outline: none;
  }
  input::-webkit-slider-runnable-track {
    height: var(--thumb);
    background: transparent;
  }
  input::-moz-range-track {
    height: var(--thumb);
    background: transparent;
  }
  input::-webkit-slider-thumb {
    appearance: none;
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: var(--ground);
    border: 0;
    box-shadow:
      inset 0 0 0 5.5px var(--ground),
      inset 0 0 0 20px var(--accent),
      0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent),
      var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.12));
    transition: box-shadow var(--motion-duration) var(--motion-ease);
  }
  input::-moz-range-thumb {
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: var(--ground);
    border: 0;
    box-shadow:
      inset 0 0 0 5.5px var(--ground),
      inset 0 0 0 20px var(--accent),
      0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent);
    transition: box-shadow var(--motion-duration) var(--motion-ease);
  }
  input:hover::-webkit-slider-thumb,
  input:active::-webkit-slider-thumb {
    box-shadow:
      inset 0 0 0 4.5px var(--ground),
      inset 0 0 0 20px var(--accent),
      0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent),
      0 0 0 6px var(--accent-soft);
  }
  input:hover::-moz-range-thumb,
  input:active::-moz-range-thumb {
    box-shadow:
      inset 0 0 0 4.5px var(--ground),
      inset 0 0 0 20px var(--accent),
      0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent),
      0 0 0 6px var(--accent-soft);
  }
  input:focus-visible::-webkit-slider-thumb {
    box-shadow:
      inset 0 0 0 4.5px var(--ground),
      inset 0 0 0 20px var(--accent),
      0 0 0 2px var(--ground),
      0 0 0 4px var(--ink);
  }
  input:focus-visible::-moz-range-thumb {
    box-shadow:
      inset 0 0 0 4.5px var(--ground),
      inset 0 0 0 20px var(--accent),
      0 0 0 2px var(--ground),
      0 0 0 4px var(--ink);
  }
  .disabled {
    opacity: 0.55;
  }
  .disabled input {
    cursor: default;
  }
</style>
