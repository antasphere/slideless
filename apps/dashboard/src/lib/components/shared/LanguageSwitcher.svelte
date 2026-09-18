<script lang="ts">
  import { cn } from '$lib/utils.js';
  import { getLocale, setLocale, t, LANGS, type Lang } from '$lib/i18n';

  interface Props {
    class?: string;
  }

  let { class: className }: Props = $props();

  // Fixed per page load: setLocale persists + reloads (see $lib/i18n).
  const current = getLocale();

  function switchTo(lang: Lang) {
    if (lang !== current) setLocale(lang);
  }
</script>

<div
  role="group"
  aria-label={t('common.language')}
  class={cn(
    'inline-flex items-center gap-0.5 rounded-[10px] border border-[var(--hairline)] bg-[var(--plate-strong)] p-0.5',
    className
  )}
>
  {#each LANGS as lang (lang)}
    <button
      type="button"
      aria-pressed={lang === current}
      class="rounded-[7px] px-2.5 py-1 text-xs font-medium transition-colors max-md:px-3.5 max-md:py-2.5 max-md:text-sm {lang ===
      current
        ? 'bg-[var(--accent-soft)] text-[var(--accent-deep)]'
        : 'text-muted-foreground hover:bg-[var(--wash)] hover:text-foreground'}"
      onclick={() => switchTo(lang)}
    >
      {lang.toUpperCase()}
    </button>
  {/each}
</div>
