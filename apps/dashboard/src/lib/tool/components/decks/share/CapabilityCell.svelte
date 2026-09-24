<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import { t } from '$lib/i18n';

  /**
   * One capability of a link as a check or a faint dash (PRDCT-2308): downloads,
   * the PDF export (PRDCT-2668), the bar, notes, forms, file uploads
   * (PRDCT-2403) and remembers (PRDCT-2328) each get a column of their own,
   * read at a glance.
   * The stable `data-capability` key is for the browser suite; the label is
   * the column's, for the screen reader.
   */
  interface Props {
    key: 'downloads' | 'pdf' | 'bar' | 'notes' | 'forms' | 'uploads' | 'remembers';
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
    <!-- off is a faint dash, so an empty cell never reads as a missing value -->
    <span class="h-px w-2 bg-[color-mix(in_oklab,var(--ink)_22%,transparent)]" aria-hidden="true"></span>
    <span class="sr-only">{t('tokens.capOff', { name: label })}</span>
  {/if}
</span>
