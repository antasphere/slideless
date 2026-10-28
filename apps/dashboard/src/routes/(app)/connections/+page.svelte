<script lang="ts">
  /* The connections (a tab of Settings, PRDCT-3773): every source the
     instance declares, one card each. An inbound source posts signed
     deliveries to a receiving URL made here; a key source is a key the
     instance holds to read a service; a source may be both. The webhooks
     page's pattern: the dialogs, the URL shown once with a copy button,
     confirmations before what cannot be undone, the log as a paged table.
     The sources, their fields and the event types all come from the list
     the instance serves (`GET /connections`), never from this file: the page
     names no source, so it stays the same for any tool. Every member reads;
     only an owner or an admin acts. A sibling source (a tool of the same hub,
     PRDCT-3774) is connected as the person, nothing to copy: the URL and the
     secret by hand stay below it, demoted, for a stack without the hub's scope. */
  import { untrack } from 'svelte';
  import { settingsTabs } from '$lib/settings-tabs';
  import { Tag } from '$lib/components/ui/tag';
  import { stateTag, type TagSpec } from '$lib/tags';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent, renderSnippet } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { createPagedList, type PagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { toastApiError } from '$lib/billing-refusal';
  import { formatDateTime, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type {
    Connection,
    ConnectionDelivery,
    ConnectionDeliveryOutcome,
    ConnectionFields,
    ConnectionFieldValue,
    ConnectionKind
  } from '@antasphere/chassis-contract';

  let { data } = $props();

  // the writes are an owner's or an admin's (the server's rule): a member reads only
  const canAct = $derived(data.me.role === 'owner' || data.me.role === 'admin');

  // ── The list: one entry per declared source, in the declared order ─────
  let connections = $state<Connection[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    try {
      connections = (await api.connections()).connections;
      loadError = null;
    } catch (e) {
      loadError = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  /** After every action: the cards and the log show the live state. */
  async function reload() {
    await load();
    await deliveries?.refresh();
  }

  $effect(() => {
    void load();
  });

  const takesDeliveries = (kind: ConnectionKind) => kind === 'inbound' || kind === 'both';
  const inbound = $derived(connections.filter((c) => takesDeliveries(c.kind)));

  // one action in flight per card: `<source>:<action>`
  let busy = $state<string | null>(null);

  // ── The receiving URL: made or rotated, shown exactly once ────────────
  let receivingUrl = $state<{ name: string; value: string } | null>(null);
  let rotateTarget = $state<Connection | null>(null);
  let rotateLoading = $state(false);

  async function makeUrl(connection: Connection): Promise<boolean> {
    busy = `${connection.source}:url`;
    try {
      const made = await api.connectSource(connection.source);
      receivingUrl = { name: connection.name, value: made.receivingUrl };
      toast.success(t('connections.urlMadeToast'));
      return true;
    } catch (e) {
      toastApiError(e, t('connections.urlFailed'));
      return false;
    } finally {
      busy = null;
    }
  }

  async function submitRotate() {
    if (!rotateTarget) return;
    rotateLoading = true;
    try {
      if (await makeUrl(rotateTarget)) rotateTarget = null;
    } finally {
      rotateLoading = false;
    }
  }

  function closeUrl() {
    receivingUrl = null;
    void reload();
  }

  // ── The secret (or the key): one password input, never shown again ────
  let secretFor = $state<Connection | null>(null);
  let secretValue = $state('');
  let secretLoading = $state(false);
  let secretError = $state<string | null>(null);

  function openSecret(connection: Connection) {
    secretFor = connection;
    secretValue = '';
    secretError = null;
  }

  async function submitSecret() {
    if (!secretFor) return;
    const connection = secretFor;
    secretError = null;
    secretLoading = true;
    try {
      await api.setConnectionSecret(connection.source, { secret: secretValue.trim() });
      secretFor = null;
      secretValue = '';
      toast.success(t('connections.secretSavedToast'));
      await reload();
    } catch (e) {
      // an inbound source takes its secret once its URL is made: say what to do first
      if (e instanceof PlatformApiError && e.code === 'not_connected' && takesDeliveries(connection.kind))
        secretError = t('connections.errorMakeUrlFirst');
      // the source's own answer (a refused key, an unreachable source), on the form
      else if (
        e instanceof PlatformApiError &&
        [
          'secret_invalid',
          'secret_refused',
          'source_unavailable',
          'not_connected',
          'validation_error'
        ].includes(e.code)
      )
        secretError = e.message;
      else toastApiError(e, t('connections.secretFailed'));
    } finally {
      secretLoading = false;
    }
  }

  // ── The declared fields: one input each, a list as comma-separated ─────
  let fieldsFor = $state<Connection | null>(null);
  let fieldText = $state<Record<string, string>>({});
  let fieldsLoading = $state(false);
  let fieldsError = $state<string | null>(null);

  const fieldDisplay = (value: ConnectionFieldValue | undefined): string =>
    Array.isArray(value) ? value.join(', ') : (value ?? '');

  function openFields(connection: Connection) {
    fieldsFor = connection;
    fieldsError = null;
    fieldText = Object.fromEntries(
      connection.declared.fields.map((f) => [f.key, fieldDisplay(connection.fields[f.key])])
    );
  }

  /** Every declared field: an empty one is null (cleared), a list is split on commas and trimmed. */
  function parseFields(connection: Connection): ConnectionFields {
    const fields: ConnectionFields = {};
    for (const field of connection.declared.fields) {
      const text = (fieldText[field.key] ?? '').trim();
      if (field.multiple) {
        const values = [
          ...new Set(
            text
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          )
        ];
        fields[field.key] = values.length ? values : null;
      } else {
        fields[field.key] = text || null;
      }
    }
    return fields;
  }

  async function submitFields() {
    if (!fieldsFor) return;
    const connection = fieldsFor;
    fieldsError = null;
    fieldsLoading = true;
    try {
      await api.setConnectionFields(connection.source, { fields: parseFields(connection) });
      fieldsFor = null;
      toast.success(t('connections.fieldsSavedToast'));
      await reload();
    } catch (e) {
      if (
        e instanceof PlatformApiError &&
        ['unknown_field', 'field_required', 'not_connected', 'validation_error'].includes(e.code)
      )
        fieldsError = e.message;
      else toastApiError(e, t('common.updateFailed'));
    } finally {
      fieldsLoading = false;
    }
  }

  // ── Test ───────────────────────────────────────────────────────────────
  async function runTest(connection: Connection) {
    busy = `${connection.source}:test`;
    try {
      const { ok, detail } = await api.testConnection(connection.source);
      if (ok) toast.success(t('connections.testPassed', { detail }));
      else toast.error(t('connections.testFailed', { detail }));
      await reload();
    } catch (e) {
      toastApiError(e, t('connections.testRunFailed'));
    } finally {
      busy = null;
    }
  }

  // ── A sibling tool: connected as the person, nothing to copy ──────────
  const isSibling = (connection: Connection) => connection.declared.sibling !== null;
  const registered = (connection: Connection) => Boolean(connection.sibling?.endpointId);

  /** The tool registers its URL on the sibling as the person and stores the secret; a re-run replaces them. */
  async function connectSibling(connection: Connection) {
    busy = `${connection.source}:sibling`;
    try {
      await api.connectSibling(connection.source);
      toast.success(t('connections.siblingConnectedToast'));
      await reload();
    } catch (e) {
      // the server's sentence says what to do (sign in again, open the sibling once, …)
      toastApiError(e, t('connections.siblingConnectFailed'));
    } finally {
      busy = null;
    }
  }

  // ── Disconnect ─────────────────────────────────────────────────────────
  let disconnectTarget = $state<Connection | null>(null);
  let disconnectLoading = $state(false);
  // a source registered on its sibling: the endpoint there goes too, or "only here"
  const disconnectBoth = $derived(disconnectTarget !== null && registered(disconnectTarget));

  async function submitDisconnect(onSibling = false) {
    if (!disconnectTarget) return;
    disconnectLoading = true;
    try {
      if (onSibling) await api.disconnectSibling(disconnectTarget.source);
      else await api.disconnectSource(disconnectTarget.source);
      toast.success(
        onSibling ? t('connections.siblingDisconnectedToast') : t('connections.disconnectedToast')
      );
      disconnectTarget = null;
      await reload();
    } catch (e) {
      toastApiError(e, t('connections.disconnectFailed'));
    } finally {
      disconnectLoading = false;
    }
  }

  // ── The chips ──────────────────────────────────────────────────────────
  function kindTag(kind: ConnectionKind): TagSpec {
    switch (kind) {
      case 'inbound':
        return { label: t('connections.kindInbound'), tone: 'indigo' };
      case 'key':
        return { label: t('connections.kindKey'), tone: 'amber' };
      default:
        return { label: t('connections.kindBoth'), tone: 'violet' };
    }
  }

  function outcomeTag(outcome: ConnectionDeliveryOutcome): TagSpec {
    switch (outcome) {
      case 'processed':
        return stateTag(t('connections.outcomeProcessed'), 'ok');
      case 'failed':
        return stateTag(t('connections.outcomeFailed'), 'bad');
      default:
        return stateTag(t('connections.outcomeIgnored'), 'off');
    }
  }

  // ── The log: the deliveries of one inbound source, paged ───────────────
  let logSource = $state<string | null>(null);
  // raw: the list is its own reactive object (getters over runes), never to be proxied
  let deliveries = $state.raw<PagedList<ConnectionDelivery> | null>(null);

  // the first inbound source by default; a source no longer declared falls back to it
  $effect(() => {
    const sources = inbound.map((c) => c.source);
    untrack(() => {
      if (!logSource || !sources.includes(logSource)) logSource = sources[0] ?? null;
    });
  });

  // one list per source, remembered under its own name (the list's fetch is the source's)
  $effect(() => {
    const source = logSource;
    untrack(() => {
      if (!source) {
        deliveries = null;
        return;
      }
      const list = createPagedList<ConnectionDelivery>(
        async (p) => {
          const page = await api.connectionDeliveries(source, p);
          return { items: page.deliveries, nextCursor: page.nextCursor };
        },
        { remember: `connections.deliveries.${source}` }
      );
      deliveries = list;
      void list.load();
    });
  });

  const logName = $derived(inbound.find((c) => c.source === logSource)?.name ?? '');
  const deliveryCount = $derived(
    deliveries?.nextCursor
      ? undefined
      : rowCount('connections.deliveriesCountOne', 'connections.deliveriesCount')
  );

  const columns: ColumnDef<ConnectionDelivery, unknown>[] = $derived([
    {
      accessorKey: 'receivedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('connections.colReceivedAt') }),
      cell: ({ row }) => renderSnippet(receivedCell, row.original),
      meta: { title: t('connections.colReceivedAt'), width: '170px' }
    },
    {
      accessorKey: 'type',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('connections.colType') }),
      cell: ({ row }) => renderSnippet(typeCell, row.original),
      meta: { title: t('connections.colType'), width: '220px' }
    },
    {
      accessorKey: 'outcome',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('connections.colOutcome') }),
      cell: ({ row }) => renderComponent(Tag, outcomeTag(row.original.outcome)),
      meta: { title: t('connections.colOutcome'), width: '130px' }
    },
    {
      id: 'detail',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('connections.colDetail') }),
      cell: ({ row }) => renderSnippet(detailCell, row.original),
      meta: { title: t('connections.colDetail') }
    }
  ]);
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  pageTitle={t('connections.title')}
  tabs={settingsTabs(data)}
  lede={t('connections.description')}
  drawing="lattice"
/>

<!-- When, with the exact date on hover, and by whom when the person is known. -->
{#snippet when(at: string, by: Connection['connectedBy'])}
  <span title={formatDateTime(at)}>
    {by ? t('connections.atBy', { when: formatTimeAgo(at), name: by.name }) : formatTimeAgo(at)}
  </span>
{/snippet}

<!-- SECURITY: the field values, the delivery types and the check's detail come from outside: text interpolation only. -->
{#snippet facts(connection: Connection)}
  <dl class="grid grid-cols-[minmax(130px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]">
    {#if connection.connectedAt}
      <dt class="text-muted-foreground">{t('connections.factConnected')}</dt>
      <dd>{@render when(connection.connectedAt, connection.connectedBy)}</dd>
    {/if}
    {#if takesDeliveries(connection.kind)}
      <dt class="text-muted-foreground">{t('connections.factUrl')}</dt>
      <dd>
        {#if connection.receiving}
          {@render when(connection.receiving.madeAt, connection.receiving.madeBy)}
        {:else}
          <span class="text-muted-foreground">{t('connections.urlNotMade')}</span>
        {/if}
      </dd>
    {/if}
    <dt class="text-muted-foreground">
      {connection.kind === 'key' ? t('connections.factKey') : t('connections.factSecret')}
    </dt>
    <dd>
      {#if connection.secretState.set}
        {#if connection.secretState.setAt}
          {@render when(connection.secretState.setAt, connection.secretState.setBy)}
        {:else}
          {t('connections.secretSet')}
        {/if}
        {#if !connection.secretState.readable}
          <span class="block text-xs text-muted-foreground">{t('connections.secretUnreadableHint')}</span>
        {/if}
      {:else}
        <span class="text-muted-foreground">{t('connections.secretMissing')}</span>
      {/if}
    </dd>
    {#each connection.declared.fields as field (field.key)}
      {@const value = fieldDisplay(connection.fields[field.key])}
      <dt class="text-muted-foreground" title={field.description ?? undefined}>{field.label}</dt>
      <dd class="break-words">{value || '—'}</dd>
    {/each}
    {#if takesDeliveries(connection.kind)}
      <dt class="text-muted-foreground">{t('connections.factLastDelivery')}</dt>
      <dd>
        {#if connection.lastDelivery}
          <span class="flex flex-wrap items-center gap-2">
            <Tag {...outcomeTag(connection.lastDelivery.outcome)} />
            <code class="text-xs">{connection.lastDelivery.type}</code>
            <span class="text-xs text-muted-foreground" title={formatDateTime(connection.lastDelivery.at)}>
              {formatTimeAgo(connection.lastDelivery.at)}
            </span>
          </span>
        {:else}
          <span class="text-muted-foreground">{t('connections.noDelivery')}</span>
        {/if}
      </dd>
    {/if}
    <dt class="text-muted-foreground">{t('connections.factLastCheck')}</dt>
    <dd>
      {#if connection.check}
        <span class="flex flex-wrap items-center gap-2">
          <Tag
            {...stateTag(
              connection.check.ok ? t('connections.checkOk') : t('connections.checkFailed'),
              connection.check.ok ? 'ok' : 'bad'
            )}
          />
          <span class="text-xs text-muted-foreground" title={formatDateTime(connection.check.at)}>
            {formatTimeAgo(connection.check.at)}
          </span>
        </span>
        {#if connection.check.detail}
          <span class="block break-words pt-1 text-xs text-muted-foreground">{connection.check.detail}</span>
        {/if}
      {:else}
        <span class="text-muted-foreground">{t('connections.neverChecked')}</span>
      {/if}
    </dd>
    {#if isSibling(connection)}
      <dt class="text-muted-foreground">{t('connections.factSibling')}</dt>
      <dd>
        {#if connection.sibling?.endpointId}
          <span title={connection.sibling.endpointId}>
            {t('connections.siblingStateRegistered', { name: connection.name })}
          </span>
        {:else}
          <span class="text-muted-foreground">
            {t('connections.siblingStateNotRegistered', { name: connection.name })}
          </span>
        {/if}
      </dd>
    {/if}
  </dl>
{/snippet}

<!-- The URL and the secret by hand: the card's own actions, or demoted under a sibling's "Connect as me". -->
{#snippet byHand(connection: Connection, demoted: boolean)}
  {#if takesDeliveries(connection.kind)}
    {#if connection.receiving}
      <Button
        size="sm"
        variant={demoted ? 'ghost' : 'outline'}
        disabled={busy !== null}
        onclick={() => (rotateTarget = connection)}
      >
        {t('connections.actionRotateUrl')}
      </Button>
    {:else}
      <Button
        size="sm"
        variant={demoted ? 'ghost' : 'default'}
        disabled={busy !== null}
        onclick={() => void makeUrl(connection)}
      >
        {busy === `${connection.source}:url` ? t('common.working') : t('connections.actionMakeUrl')}
      </Button>
    {/if}
  {/if}
  <Button
    size="sm"
    variant={demoted ? 'ghost' : 'outline'}
    disabled={busy !== null}
    onclick={() => openSecret(connection)}
  >
    {connection.kind === 'key' ? t('connections.actionSetKey') : t('connections.actionSetSecret')}
  </Button>
{/snippet}

{#snippet actions(connection: Connection)}
  {@const row = connection.connectedAt !== null}
  {@const sibling = isSibling(connection)}
  <div class="flex flex-wrap gap-2">
    {#if sibling}
      <Button size="sm" disabled={busy !== null} onclick={() => void connectSibling(connection)}>
        {#if busy === `${connection.source}:sibling`}
          {t('common.working')}
        {:else}
          {registered(connection) ? t('connections.siblingReconnect') : t('connections.siblingConnect')}
        {/if}
      </Button>
    {:else}
      {@render byHand(connection, false)}
    {/if}
    {#if row && connection.declared.fields.length}
      <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => openFields(connection)}>
        {t('connections.actionEditFields')}
      </Button>
    {/if}
    {#if row}
      <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => void runTest(connection)}>
        {busy === `${connection.source}:test` ? t('common.working') : t('connections.actionTest')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="text-destructive"
        disabled={busy !== null}
        onclick={() => (disconnectTarget = connection)}
      >
        {t('connections.actionDisconnect')}
      </Button>
    {/if}
  </div>
  {#if sibling}
    <div class="space-y-1.5">
      <p class="text-xs text-muted-foreground">{t('connections.siblingByHand')}</p>
      <div class="flex flex-wrap gap-1">
        {@render byHand(connection, true)}
      </div>
    </div>
  {/if}
{/snippet}

<FormError
  message={loadError && connections.length ? t('common.refreshFailedCached', { error: loadError }) : null}
  class="pb-3"
/>
{#if loading}
  <div class="grid gap-6 lg:grid-cols-2">
    <Skeleton class="h-64 rounded-xl" />
    <Skeleton class="h-64 rounded-xl" />
  </div>
{:else if loadError && !connections.length}
  <p class="text-sm text-destructive" in:appear>{t('connections.loadFailed', { error: loadError })}</p>
{:else if !connections.length}
  <p class="notice" in:appear>{t('connections.empty')}</p>
{:else}
  <div class="grid gap-6 lg:grid-cols-2" in:appear>
    {#each connections as connection (connection.source)}
      <Card.Root>
        <Card.Header>
          <div class="flex flex-wrap items-center gap-2">
            <Card.Title class="text-base">{connection.name}</Card.Title>
            <Tag {...kindTag(connection.kind)} />
            {#if connection.connected}
              <Tag {...stateTag(t('connections.stateConnected'), 'ok')} />
            {:else}
              <Tag {...stateTag(t('connections.stateNotConnected'), 'off')} />
            {/if}
            {#if connection.secretState.set && !connection.secretState.readable}
              <Tag {...stateTag(t('connections.stateUnreadable'), 'wait')} />
            {/if}
          </div>
          {#if connection.declared.description}
            <Card.Description>{connection.declared.description}</Card.Description>
          {/if}
        </Card.Header>
        <Card.Content class="space-y-5">
          {@render facts(connection)}
          {#if canAct}
            {@render actions(connection)}
          {/if}
        </Card.Content>
      </Card.Root>
    {/each}
  </div>
{/if}

{#if inbound.length}
  <section class="space-y-3 pt-10" aria-labelledby="connections-deliveries">
    <h2 id="connections-deliveries" class="eyebrow">{t('connections.deliveriesTitle')}</h2>
    {#snippet sourceFilter()}
      <Select.Root
        type="single"
        value={logSource ?? undefined}
        onValueChange={(v) => {
          if (v) logSource = v;
        }}
      >
        <Select.Trigger class="h-8 w-48" aria-label={t('connections.deliveriesSource')}>
          {logName}
        </Select.Trigger>
        <Select.Content>
          {#each inbound as source (source.source)}
            <Select.Item value={source.source} label={source.name} />
          {/each}
        </Select.Content>
      </Select.Root>
    {/snippet}
    {#if deliveries}
      <FormError
        message={deliveries.error && deliveries.items.length
          ? t('common.refreshFailedCached', { error: deliveries.error })
          : null}
        class="pb-3"
      />
      {#if deliveries.loading}
        <TableSkeleton columns={4} />
      {:else if deliveries.error && !deliveries.items.length}
        <p class="text-sm text-destructive" in:appear>
          {t('connections.deliveriesLoadFailed', { error: deliveries.error })}
        </p>
      {:else}
        <DataTable
          data={deliveries.items}
          {columns}
          pageSize={50}
          searchColumns={['type']}
          searchPlaceholder={t('connections.deliveriesSearch')}
          emptyMessage={t('connections.deliveriesEmpty')}
          count={deliveryCount}
          toolbar={sourceFilter}
          getRowId={(d) => d.id}
        />
        {#if deliveries.nextCursor}
          <div class="flex justify-center py-4">
            <Button
              variant="outline"
              onclick={() => void deliveries?.loadMore()}
              disabled={deliveries.loadingMore}
            >
              {deliveries.loadingMore ? t('common.loading') : t('common.loadMore')}
            </Button>
          </div>
        {/if}
      {/if}
    {/if}
  </section>
{/if}

<!-- SECURITY: the delivery's type, detail and error come from the source: text interpolation only. -->
{#snippet receivedCell(delivery: ConnectionDelivery)}
  <span class="block min-w-0">
    <span class="block text-[13px]">{formatDateTime(delivery.receivedAt)}</span>
    <span class="block text-xs text-muted-foreground">{formatTimeAgo(delivery.receivedAt)}</span>
  </span>
{/snippet}

{#snippet typeCell(delivery: ConnectionDelivery)}
  <code class="block truncate text-[13px]" title={delivery.deliveryId}>{delivery.type}</code>
{/snippet}

{#snippet detailCell(delivery: ConnectionDelivery)}
  {#if delivery.error}
    <span class="block break-words text-[13px] text-destructive">{delivery.error}</span>
  {:else if delivery.detail}
    <span class="block break-words text-[13px]">{delivery.detail}</span>
  {:else}
    —
  {/if}
{/snippet}

{#snippet urlAside()}
  <Dialog.Illustration eyebrow={t('connections.asideEyebrow')} caption={t('connections.urlAsideCaption')}>
    <DialogDrawing kind="share" />
  </Dialog.Illustration>
{/snippet}

{#snippet secretAside()}
  <Dialog.Illustration eyebrow={t('connections.asideEyebrow')} caption={t('connections.secretAsideCaption')}>
    <DialogDrawing kind="key" />
  </Dialog.Illustration>
{/snippet}

<Dialog.Root
  open={receivingUrl !== null}
  onOpenChange={(isOpen) => {
    if (!isOpen) closeUrl();
  }}
>
  <Dialog.Content size="lg" aside={urlAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('connections.urlTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('connections.urlDescription', { name: receivingUrl?.name ?? '' })}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if receivingUrl}
        <CodeBlock
          field
          code={receivingUrl.value}
          ariaLabel={t('connections.urlAria')}
          copyLabel={t('connections.urlCopyAria')}
          copiedMessage={t('connections.urlCopiedToast')}
        />
        <p class="notice notice--danger">
          <TriangleAlert class="size-4" />
          <span>{t('connections.urlWarning')}</span>
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button onclick={closeUrl}>{t('connections.savedIt')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<FormDialog
  open={secretFor !== null}
  aside={secretAside}
  title={secretFor?.kind === 'key'
    ? t('connections.keyTitle', { name: secretFor?.name ?? '' })
    : t('connections.secretTitle', { name: secretFor?.name ?? '' })}
  description={t('connections.secretDescription')}
  onClose={() => {
    // the typed value leaves the component's state however the dialog closes
    secretFor = null;
    secretValue = '';
  }}
  onSubmit={() => void submitSecret()}
  loading={secretLoading}
>
  <div class="space-y-2">
    <Label for="connection-secret">
      {secretFor?.kind === 'key' ? t('connections.factKey') : t('connections.factSecret')}
    </Label>
    <Input
      id="connection-secret"
      type="password"
      bind:value={secretValue}
      placeholder={secretFor?.declared.secretHint ?? ''}
      spellcheck={false}
      autocomplete="off"
      required
    />
  </div>
  <FormError message={secretError} />
</FormDialog>

<FormDialog
  open={fieldsFor !== null}
  title={t('connections.fieldsTitle', { name: fieldsFor?.name ?? '' })}
  description={t('connections.fieldsDescription')}
  onClose={() => (fieldsFor = null)}
  onSubmit={() => void submitFields()}
  loading={fieldsLoading}
>
  {#each fieldsFor?.declared.fields ?? [] as field (field.key)}
    <div class="space-y-1.5">
      <Label for="connection-field-{field.key}" class="flex items-baseline gap-2">
        <span>{field.label}</span>
        {#if field.required}
          <span class="text-xs text-muted-foreground">{t('connections.fieldRequired')}</span>
        {/if}
      </Label>
      <Input
        id="connection-field-{field.key}"
        value={fieldText[field.key] ?? ''}
        oninput={(e) => (fieldText[field.key] = e.currentTarget.value)}
        placeholder={field.multiple ? t('connections.fieldMultiplePlaceholder') : ''}
        aria-required={field.required}
        spellcheck={false}
        autocomplete="off"
      />
      {#if field.description || field.multiple}
        <p class="text-xs text-muted-foreground">
          {[field.description, field.multiple ? t('connections.fieldMultipleHint') : null]
            .filter(Boolean)
            .join(' ')}
        </p>
      {/if}
    </div>
  {/each}
  <FormError message={fieldsError} />
</FormDialog>

<ConfirmDialog
  open={rotateTarget !== null}
  title={t('connections.rotateConfirmTitle')}
  description={t('connections.rotateConfirmDescription', { name: rotateTarget?.name ?? '' })}
  confirmLabel={t('connections.actionRotateUrl')}
  variant="default"
  onClose={() => (rotateTarget = null)}
  onConfirm={() => void submitRotate()}
  loading={rotateLoading}
/>

<ConfirmDialog
  open={disconnectTarget !== null && !disconnectBoth}
  title={t('connections.disconnectConfirmTitle', { name: disconnectTarget?.name ?? '' })}
  description={t('connections.disconnectConfirmDescription')}
  confirmLabel={t('connections.actionDisconnect')}
  onClose={() => (disconnectTarget = null)}
  onConfirm={() => void submitDisconnect()}
  loading={disconnectLoading}
/>

<!-- The sibling variant: the endpoint on the sibling is deleted first; "only here" for a sibling out of reach. -->
<Dialog.Root
  open={disconnectBoth}
  onOpenChange={(isOpen) => {
    if (!isOpen) disconnectTarget = null;
  }}
>
  <Dialog.Content size="sm" framed>
    <Dialog.Body class="dlg-words">
      <Dialog.Header>
        <Dialog.Title>
          {t('connections.disconnectConfirmTitle', { name: disconnectTarget?.name ?? '' })}
        </Dialog.Title>
        <Dialog.Description>
          {t('connections.siblingDisconnectDescription', { name: disconnectTarget?.name ?? '' })}
        </Dialog.Description>
      </Dialog.Header>
      <p class="pt-3 text-xs text-muted-foreground">
        {t('connections.siblingOnlyHereHint', { name: disconnectTarget?.name ?? '' })}
      </p>
    </Dialog.Body>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (disconnectTarget = null)} disabled={disconnectLoading}>
        {t('common.cancel')}
      </Button>
      <Button variant="outline" onclick={() => void submitDisconnect()} disabled={disconnectLoading}>
        {t('connections.siblingOnlyHere')}
      </Button>
      <Button variant="destructive" onclick={() => void submitDisconnect(true)} disabled={disconnectLoading}>
        {disconnectLoading ? t('common.working') : t('connections.siblingDisconnectBoth')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
