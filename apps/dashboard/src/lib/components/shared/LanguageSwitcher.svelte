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
  class={cn('inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5', className)}
>
  {#each LANGS as lang (lang)}
    <button
      type="button"
      aria-pressed={lang === current}
      class="rounded px-2 py-1 text-xs font-medium transition-colors {lang === current
        ? 'bg-muted text-foreground'
        : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => switchTo(lang)}
    >
      {lang.toUpperCase()}
    </button>
  {/each}
</div>
