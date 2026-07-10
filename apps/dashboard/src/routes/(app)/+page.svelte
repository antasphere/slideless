<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { t } from '$lib/i18n';
  import type { FileInfo, Member, Presentation } from '@slideless/contract';

  let { data } = $props();

  const decksList = createPagedList<Presentation>(
    async (p) => {
      const { presentations, nextCursor } = await api.presentations(p);
      return { items: presentations, nextCursor };
    },
    { limit: 100 }
  );
  const membersList = createPagedList<Member>(
    async (p) => {
      const { members, nextCursor } = await api.members(p);
      return { items: members, nextCursor };
    },
    { limit: 100 }
  );
  const filesList = createPagedList<FileInfo>(
    async (p) => {
      const { files, nextCursor } = await api.files(p);
      return { items: files, nextCursor };
    },
    { limit: 100 }
  );

  $effect(() => {
    void decksList.load();
    void membersList.load();
    void filesList.load();
  });

  // Counts come from one page (limit 100); a trailing "+" keeps them honest
  // when the list is truncated.
  const memberCount = $derived(
    membersList.loading || (membersList.error && !membersList.items.length)
      ? null
      : `${membersList.items.filter((m) => m.isActive).length}${membersList.nextCursor ? '+' : ''}`
  );
  const fileCount = $derived(
    filesList.loading || (filesList.error && !filesList.items.length)
      ? null
      : `${filesList.items.length}${filesList.nextCursor ? '+' : ''}`
  );
  const deckCount = $derived(
    decksList.loading || (decksList.error && !decksList.items.length)
      ? null
      : `${decksList.items.length}${decksList.nextCursor ? '+' : ''}`
  );
</script>

<PageHeader title={t('overview.title')} description={t('overview.description')} />

<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
  <Card.Root>
    <Card.Header>
      <Card.Description>{t('overview.instanceCard')}</Card.Description>
      <Card.Title class="text-2xl">{data.instance.name}</Card.Title>
    </Card.Header>
    <Card.Content class="flex flex-wrap gap-2">
      <Badge variant="secondary">v{data.instance.version}</Badge>
      <Badge variant="outline">{data.instance.edition}</Badge>
      <Badge variant="outline">API {data.instance.apiVersion}</Badge>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Description>{t('overview.decksCard')}</Card.Description>
      <Card.Title class="text-2xl">{deckCount ?? '—'}</Card.Title>
    </Card.Header>
    <Card.Content>
      <a class="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/decks">
        {t('overview.browseDecks')}
      </a>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Description>{t('overview.activeMembers')}</Card.Description>
      <Card.Title class="text-2xl">{memberCount ?? '—'}</Card.Title>
    </Card.Header>
    <Card.Content>
      <a class="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/members">
        {t('overview.manageMembers')}
      </a>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Description>{t('overview.filesCard')}</Card.Description>
      <Card.Title class="text-2xl">{fileCount ?? '—'}</Card.Title>
    </Card.Header>
    <Card.Content>
      <a class="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/files">
        {t('overview.browseFiles')}
      </a>
    </Card.Content>
  </Card.Root>
</div>

<div class="mt-8 grid gap-4 md:grid-cols-2">
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('overview.apiAccessTitle')}</Card.Title>
      <Card.Description>
        {t('overview.apiAccessBody')}
        <code class="rounded bg-muted px-1 py-0.5 text-xs">/api/v1</code>.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <a class="text-sm underline-offset-4 hover:underline" href="/api-keys">{t('overview.manageKeys')}</a>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('overview.teamTitle')}</Card.Title>
      <Card.Description>
        {t('overview.teamDescription')}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if data.me.role === 'owner' || data.me.role === 'admin'}
        <a class="text-sm underline-offset-4 hover:underline" href="/invitations">
          {t('overview.inviteMembers')}
        </a>
      {:else}
        <p class="text-sm text-muted-foreground">{t('overview.askAdmin')}</p>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
