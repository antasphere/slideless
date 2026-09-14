<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import { t } from '$lib/i18n';

  /**
   * One capability of a link as a check or nothing (PRDCT-2308): downloads,
   * the bar, notes, forms each get a column of their own, read at a glance.
   * The stable `data-capability` key is for the browser suite; the label is
   * the column's, for the screen reader.
   */
  interface Props {
    key: 'downloads' | 'bar' | 'notes' | 'forms';
    on: boolean;
    label: string;
  }

  let { key, on, label }: Props = $props();
</script>

<span
  class="inline-flex h-5 w-5 items-center justify-center"
  data-capability={key}
  data-on={on ? '' : undefined}
>
  {#if on}
    <Check class="h-4 w-4 text-[var(--ok)]" aria-hidden="true" />
    <span class="sr-only">{t('tokens.capOn', { name: label })}</span>
  {:else}
    <span class="sr-only">{t('tokens.capOff', { name: label })}</span>
  {/if}
</span>
