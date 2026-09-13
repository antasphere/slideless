<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import ShareLinksTable from './share/ShareLinksTable.svelte';
  import ShareLinkCreateDialog from './share/ShareLinkCreateDialog.svelte';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { t } from '$lib/i18n';
  import type { PresentationVersion, ShareToken } from '@slideless/contract';

  /**
   * The admin page's share-links card: the table and the create flow live in
   * `share/` and are shared with the master page's share sheet (PRDCT-2279);
   * this is the card around them.
   */
  interface Props {
    deckId: string;
    /** Page-owned list — shared with the preview's token housekeeping. */
    list: PagedList<ShareToken>;
    versions: PresentationVersion[];
  }

  let { deckId, list, versions }: Props = $props();

  let showCreateDialog = $state(false);
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <Card.Title class="text-base">{t('tokens.title')}</Card.Title>
        <Card.Description>{t('tokens.description')}</Card.Description>
      </div>
      <Button size="sm" onclick={() => (showCreateDialog = true)}>
        <Plus class="mr-2 h-4 w-4" />
        {t('tokens.create')}
      </Button>
    </div>
  </Card.Header>
  <Card.Content>
    <ShareLinksTable {deckId} {list} {versions} />
  </Card.Content>
</Card.Root>

<ShareLinkCreateDialog {deckId} {versions} bind:open={showCreateDialog} onCreated={() => list.refresh()} />
