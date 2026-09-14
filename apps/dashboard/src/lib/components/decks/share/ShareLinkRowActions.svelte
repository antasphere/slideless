<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { copyText } from '$lib/clipboard';
  import { linkUrl } from '$lib/decks/link-urls.svelte';
  import { t } from '$lib/i18n';

  /**
   * A links row's actions (PRDCT-2308): copy the link, open it in a new
   * tab, then the row menu (activity, change version, revoke). The URL of a
   * link exists once, at creation, and is never stored — so copy and open
   * are live for the links made in this page session (link-urls.svelte.ts)
   * and disabled, with the reason on hover, for every older row.
   */
  interface ActionItem {
    label: string;
    onclick: () => void;
    variant?: 'default' | 'destructive';
  }

  interface Props {
    tokenId: string;
    actions: ActionItem[];
  }

  let { tokenId, actions }: Props = $props();

  const url = $derived(linkUrl(tokenId));
</script>

<div class="flex items-center justify-end gap-0.5">
  {#if url}
    <Button
      variant="ghost"
      size="icon"
      class="h-8 w-8"
      title={t('tokens.actionCopy')}
      aria-label={t('tokens.actionCopy')}
      data-testid="link-copy"
      onclick={() => void copyText(url, t('tokens.urlCopied'))}
    >
      <Copy class="h-4 w-4" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="h-8 w-8"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={t('tokens.actionOpen')}
      aria-label={t('tokens.actionOpen')}
      data-testid="link-open"
    >
      <ExternalLink class="h-4 w-4" />
    </Button>
  {:else}
    <!-- A disabled control shows no tooltip; the span around it carries the reason. -->
    <span class="inline-flex" title={t('tokens.urlUnavailable')} data-testid="link-url-unavailable">
      <Button
        variant="ghost"
        size="icon"
        class="h-8 w-8"
        disabled
        aria-label={t('tokens.actionCopy')}
        data-testid="link-copy"
      >
        <Copy class="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="h-8 w-8"
        disabled
        aria-label={t('tokens.actionOpen')}
        data-testid="link-open"
      >
        <ExternalLink class="h-4 w-4" />
      </Button>
    </span>
  {/if}
  <DataTableActions {actions} />
</div>
