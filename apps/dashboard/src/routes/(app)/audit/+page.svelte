<script lang="ts">
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { formatDateTime } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { AuditEntry } from '@slideless/contract';

  const list = createPagedList<AuditEntry>(
    async (p) => {
      const { entries, nextCursor } = await api.audit(p);
      return { items: entries, nextCursor };
    },
    { limit: 50 }
  );

  $effect(() => {
    void list.load();
  });

  const entries = $derived(list.items);

  const viaVariant: Record<AuditEntry['actorVia'], 'default' | 'secondary' | 'outline'> = {
    session: 'secondary',
    api_key: 'default',
    oauth: 'default',
    system: 'outline'
  };
</script>

<PageHeader title={t('audit.title')} description={t('audit.description')} />

{#if list.loading}
  <TableSkeleton columns={6} showSearch={false} />
{:else if list.error && entries.length === 0}
  <p class="text-sm text-destructive">{list.error}</p>
{:else}
  <div class="rounded-md border">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-[170px]">{t('audit.colTime')}</Table.Head>
          <Table.Head>{t('audit.colActor')}</Table.Head>
          <Table.Head class="w-[90px]">{t('audit.colVia')}</Table.Head>
          <Table.Head>{t('audit.colAction')}</Table.Head>
          <Table.Head>{t('audit.colResource')}</Table.Head>
          <Table.Head class="w-[130px]">{t('audit.colRequest')}</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each entries as entry (entry.id)}
          <Table.Row>
            <Table.Cell class="whitespace-nowrap text-muted-foreground">
              {formatDateTime(entry.createdAt)}
            </Table.Cell>
            <Table.Cell>{entry.actorEmail ?? t('audit.system')}</Table.Cell>
            <Table.Cell>
              <Badge variant={viaVariant[entry.actorVia]}>{entry.actorVia}</Badge>
            </Table.Cell>
            <Table.Cell><code class="text-xs">{entry.action}</code></Table.Cell>
            <Table.Cell class="max-w-[220px] truncate text-muted-foreground">
              {entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId}` : ''}
            </Table.Cell>
            <Table.Cell>
              {#if entry.requestId}
                <code class="text-xs text-muted-foreground" title={entry.requestId}>
                  {entry.requestId.slice(0, 8)}…
                </code>
              {:else}
                <span class="text-muted-foreground">—</span>
              {/if}
            </Table.Cell>
          </Table.Row>
        {:else}
          <Table.Row>
            <Table.Cell colspan={6} class="h-24 text-center text-muted-foreground">
              {t('audit.empty')}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>

  {#if list.error}
    <p class="mt-3 text-sm text-destructive">{list.error}</p>
  {/if}

  {#if list.nextCursor}
    <div class="flex justify-center py-4">
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}
