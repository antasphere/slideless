<script lang="ts">
  /* The person's paper (PRDCT-4189): the five brand ground scales as a run
     of dots, set like the workspace's colour above it on the Identity card,
     but the person's own. It is not part of the workspace's look: it is
     applied at once, kept in this browser (theme.svelte.ts, ADR 007), and
     open to every member, whoever may change the look. Each dot shows the
     paper as it reads in the current mode, its day ground or its night. */
  import { PAPER_GROUNDS, PAPER_KEYS, theme, type PaperKey } from '$lib/theme.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    /** A dot's diameter, in px. */
    dot?: number;
  }

  let { dot = 24 }: Props = $props();

  $effect(() => theme.start());

  const names: Record<PaperKey, string> = {
    creme: t('settings.paperCreme'),
    graphite: t('settings.paperGraphite'),
    porcelain: t('settings.paperPorcelain'),
    stone: t('settings.paperStone'),
    fog: t('settings.paperFog')
  };
</script>

<div class="row" data-testid="paper-picker">
  <div class="head">
    <span class="eyebrow">{t('settings.paper')}</span>
    <span class="picked">{names[theme.paper]}</span>
  </div>
  <div class="dots" role="radiogroup" aria-label={t('settings.paper')} style="--dot: {dot}px">
    {#each PAPER_KEYS as key (key)}
      <button
        type="button"
        role="radio"
        aria-checked={theme.paper === key}
        class="pdot"
        class:on={theme.paper === key}
        style:background={theme.dark ? PAPER_GROUNDS[key].night : PAPER_GROUNDS[key].ground}
        title={names[key]}
        aria-label={names[key]}
        data-paper-key={key}
        onclick={() => theme.setPaper(key)}
      ></button>
    {/each}
  </div>
  <p class="hint">{t('settings.paperHint')}</p>
</div>

<style>
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
  .pdot {
    appearance: none;
    border: 0;
    padding: 0;
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    cursor: pointer;
    outline-offset: 3px;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent);
    transition:
      box-shadow var(--motion-duration) var(--motion-ease),
      transform var(--motion-duration) var(--motion-ease);
  }
  .pdot:hover {
    transform: scale(1.12);
    box-shadow:
      inset 0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent),
      0 0 0 2px color-mix(in oklab, var(--ink) 30%, transparent);
  }
  .pdot.on,
  .pdot.on:hover {
    box-shadow:
      inset 0 0 0 1px color-mix(in oklab, var(--ink) 22%, transparent),
      0 0 0 2.5px var(--ground),
      0 0 0 4.5px var(--ink);
  }
  .hint {
    font-size: 12.5px;
    color: var(--muted);
  }
</style>
