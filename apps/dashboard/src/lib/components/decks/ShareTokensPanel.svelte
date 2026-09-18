<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import ShareLinksTable from './share/ShareLinksTable.svelte';
  import ShareLinkCreateDialog from './share/ShareLinkCreateDialog.svelte';
  import ShareLinkColumnsMenu from './share/ShareLinkColumnsMenu.svelte';
  import { LinkColumns } from './share/linkColumns.svelte';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { t } from '$lib/i18n';
  import type { PresentationVersion, ShareToken } from '@slideless/contract';

  /**
   * The admin page's share-links card: the table and the create flow live in
   * `share/` and are shared with the master page's share sheet (PRDCT-2279);
   * this is the card around them. The section's two buttons sit together in
   * the toolbar right over the table, at its right edge: View (which columns
   * the table shows, a choice this card owns and hands to the table) and,
   * after it, New share link.
   */
  interface Props {
    deckId: string;
    /** Page-owned list — shared with the preview's token housekeeping. */
    list: PagedList<ShareToken>;
    versions: PresentationVersion[];
  }

  let { deckId, list, versions }: Props = $props();

  let showCreateDialog = $state(false);
  const view = new LinkColumns('lean');
</script>

{#snippet actions()}
  <ShareLinkColumnsMenu {view} class="h-8" />
  <Button size="sm" class="h-8" onclick={() => (showCreateDialog = true)}>
    <Plus class="mr-2 h-4 w-4" />
    {t('tokens.create')}
  </Button>
{/snippet}

<Card.Root class="deck-section gap-3">
  <DeckSectionHeading drawing="links" title={t('tokens.title')} description={t('tokens.description')} />
  <Card.Content>
    <ShareLinksTable {deckId} {list} {versions} defaults="lean" {view} {actions} />
  </Card.Content>
</Card.Root>

<ShareLinkCreateDialog {deckId} {versions} bind:open={showCreateDialog} onCreated={() => list.refresh()} />
