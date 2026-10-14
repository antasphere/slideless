<script lang="ts">
  /* The webhooks (a tab of Settings, PRDCT-3484): the workspace's endpoints,
     each a URL told by a signed POST when something happens. The API keys
     page's pattern: a table, a create dialog, the secret shown once with a
     copy button, confirmations before what cannot be undone. The event types
     and the filterable subjects come from the catalog the instance serves
     (`GET /webhooks/events`), never from this file: the page names no event,
     so it stays the same for any tool. */
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { settingsTabs, type SettingsFacts } from '$lib/settings-tabs';
  import { Tag, TagList } from '$lib/components/ui/tag';
  import { stateTag, type TagSpec } from '$lib/tags';
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent, renderSnippet } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import { createPagedList, type PagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { toastApiError } from '$lib/billing-refusal';
  import { formatDateTime, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type {
    WebhookCatalog,
    WebhookCatalogEvent,
    WebhookDelivery,
    WebhookDeliveryStatus,
    WebhookEndpoint,
    WebhookFilters
  } from '@antasphere/chassis-contract';

  // ── The list ───────────────────────────────────────────────────────────
  const list = createPagedList<WebhookEndpoint>(
    async (p) => {
      const { webhooks, nextCursor } = await api.webhooks(p);
      return { items: webhooks, nextCursor };
    },
    { remember: 'webhooks' }
  );

  $effect(() => {
    void list.load();
  });

  const endpoints = $derived(list.items);
  const endpointCount = $derived(
    list.nextCursor ? undefined : rowCount('webhooks.countOne', 'webhooks.count')
  );

  // ── The catalog: the event types and the subjects a filter can name ──
  let catalog = $state<WebhookCatalog | null>(null);
  let catalogError = $state<string | null>(null);

  async function loadCatalog() {
    catalogError = null;
    try {
      catalog = await api.webhookEvents();
    } catch (e) {
      catalogError = errorMessage(e);
    }
  }

  $effect(() => {
    void loadCatalog();
  });

  const familyOf = (type: string) => type.split('.')[0] ?? type;

  /** The catalog's events by family (`deck`, `project`…), in the order the catalog lists them. */
  const families = $derived.by(() => {
    const groups: { name: string; events: WebhookCatalogEvent[] }[] = [];
    for (const event of catalog?.events ?? []) {
      const name = familyOf(event.type);
      const group = groups.find((g) => g.name === name);
      if (group) group.events.push(event);
      else groups.push({ name, events: [event] });
    }
    return groups;
  });

  const eventDescription = (type: string) => catalog?.events.find((e) => e.type === type)?.description;

  // ── The row the auto-disable mail points at (`/webhooks?endpoint=<id>`) ──
  const focusId = $derived(page.url.searchParams.get('endpoint'));
  // a selected row is drawn lit (data-state="selected"); nothing else selects here
  const focusSelection = $derived(focusId ? { [focusId]: true } : {});
  let scrolledTo = '';
  $effect(() => {
    const id = focusId;
    if (!id || scrolledTo === id || !endpoints.some((w) => w.id === id)) return;
    scrolledTo = id;
    void tick().then(() =>
      document
        .querySelector('[data-state="selected"]')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    );
  });

  // ── Create and edit: one form ──────────────────────────────────────────
  let showForm = $state(false);
  let editing = $state<WebhookEndpoint | null>(null);
  let formLoading = $state(false);
  let formError = $state<string | null>(null);
  let url = $state('');
  let description = $state('');
  // what the endpoint subscribes to: `*`, `family.*` or exact types
  let selected = $state<string[]>([]);
  // one text field per subject: the ids, comma-separated
  let filterText = $state<Record<string, string>>({});
  let enabled = $state(true);

  const allOn = $derived(selected.includes('*'));
  const familyOn = (family: string) => selected.includes(`${family}.*`);
  const eventLocked = (type: string) => allOn || familyOn(familyOf(type));
  const eventOn = (type: string) => eventLocked(type) || selected.includes(type);

  function setAll(on: boolean) {
    selected = on ? ['*'] : [];
  }
  function setFamily(family: string, on: boolean) {
    const rest = selected.filter((p) => p !== `${family}.*` && familyOf(p) !== family);
    selected = on ? [...rest, `${family}.*`] : rest;
  }
  function setEvent(type: string, on: boolean) {
    const rest = selected.filter((p) => p !== type);
    selected = on ? [...rest, type] : rest;
  }

  /** The subjects a filter can name: the catalog's, plus any an endpoint already carries. */
  const filterSubjects = $derived.by(() => {
    const subjects = (catalog?.subjects ?? []).map((s) => ({ key: s.key, label: s.description }));
    for (const key of Object.keys(filterText)) {
      if (!subjects.some((s) => s.key === key)) subjects.push({ key, label: key });
    }
    return subjects;
  });

  function parseFilters(): WebhookFilters {
    const filters: WebhookFilters = {};
    for (const [key, text] of Object.entries(filterText)) {
      const ids = [
        ...new Set(
          text
            .split(/[\s,]+/)
            .map((id) => id.trim())
            .filter(Boolean)
        )
      ];
      if (ids.length) filters[key] = ids;
    }
    return filters;
  }

  function openForm(endpoint: WebhookEndpoint | null) {
    editing = endpoint;
    formError = null;
    url = endpoint?.url ?? '';
    description = endpoint?.description ?? '';
    selected = endpoint ? [...endpoint.events] : [];
    filterText = Object.fromEntries(
      Object.entries(endpoint?.filters ?? {}).map(([key, ids]) => [key, ids.join(', ')])
    );
    enabled = endpoint?.enabled ?? true;
    showForm = true;
    if (!catalog) void loadCatalog();
  }

  async function submitForm() {
    formError = null;
    if (selected.length === 0) {
      formError = t('webhooks.errorNoEvent');
      return;
    }
    const body = {
      url: url.trim(),
      description: description.trim(),
      events: selected,
      filters: parseFilters(),
      enabled
    };
    formLoading = true;
    try {
      if (editing) {
        await api.updateWebhook(editing.id, body);
        toast.success(t('webhooks.savedToast'));
        showForm = false;
      } else {
        const created = await api.createWebhook(body);
        showForm = false;
        secret = { value: created.secret, previousUntil: null };
      }
      await list.refresh();
    } catch (e) {
      // an address the server will not deliver to: its own sentence, on the form
      if (e instanceof PlatformApiError && e.code === 'url_refused') formError = e.message;
      else toastApiError(e, editing ? t('common.updateFailed') : t('webhooks.createFailed'));
    } finally {
      formLoading = false;
    }
  }

  // ── The secret: shown exactly once, at creation and at each rotation ──
  let secret = $state<{ value: string; previousUntil: string | null } | null>(null);
  const SIGNATURE_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'];

  // ── Enable, disable, test ──────────────────────────────────────────────
  async function setEnabled(endpoint: WebhookEndpoint, on: boolean) {
    try {
      await api.updateWebhook(endpoint.id, { enabled: on });
      toast.success(on ? t('webhooks.enabledToast') : t('webhooks.disabledToast'));
      await list.refresh();
    } catch (e) {
      toastApiError(e, t('common.updateFailed'));
    }
  }

  async function sendTest(endpoint: WebhookEndpoint) {
    try {
      const { delivery } = await api.testWebhook(endpoint.id);
      const code = delivery.lastStatusCode;
      if (delivery.status === 'delivered') toast.success(t('webhooks.testDelivered', { code: code ?? '' }));
      else if (delivery.status === 'failed')
        toast.error(
          code !== null
            ? t('webhooks.testFailedCode', { code })
            : t('webhooks.testFailed', { error: delivery.lastError ?? t('webhooks.deliveryNoAnswer') })
        );
      else toast.info(t('webhooks.testQueued'));
      await list.refresh();
    } catch (e) {
      toastApiError(e, t('webhooks.testSendFailed'));
    }
  }

  // ── Rotate ─────────────────────────────────────────────────────────────
  let rotateTarget = $state<WebhookEndpoint | null>(null);
  let rotateLoading = $state(false);

  async function submitRotate() {
    if (!rotateTarget) return;
    rotateLoading = true;
    try {
      const rotated = await api.rotateWebhookSecret(rotateTarget.id);
      rotateTarget = null;
      secret = { value: rotated.secret, previousUntil: rotated.previousSecretExpiresAt };
      await list.refresh();
    } catch (e) {
      toastApiError(e, t('webhooks.rotateFailed'));
    } finally {
      rotateLoading = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  let deleteTarget = $state<WebhookEndpoint | null>(null);
  let deleteLoading = $state(false);

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteWebhook(deleteTarget.id);
      toast.success(t('webhooks.deletedToast'));
      deleteTarget = null;
      await list.refresh();
    } catch (e) {
      toastApiError(e, t('common.deleteFailed'));
    } finally {
      deleteLoading = false;
    }
  }

  // ── Deliveries: a panel over the page ──────────────────────────────────
  const phone = new IsMobile();
  let deliveriesFor = $state<WebhookEndpoint | null>(null);
  // raw: the list is its own reactive object (getters over runes), never to be proxied
  let deliveries = $state.raw<PagedList<WebhookDelivery> | null>(null);
  let expanded = $state<string | null>(null);
  let redelivering = $state<string | null>(null);

  function openDeliveries(endpoint: WebhookEndpoint) {
    deliveriesFor = endpoint;
    expanded = null;
    deliveries = createPagedList<WebhookDelivery>(async (p) => {
      const page = await api.webhookDeliveries(endpoint.id, p);
      return { items: page.deliveries, nextCursor: page.nextCursor };
    });
    void deliveries.load();
  }

  async function redeliver(delivery: WebhookDelivery) {
    redelivering = delivery.id;
    try {
      await api.redeliverWebhook(delivery.endpointId, delivery.id);
      toast.success(t('webhooks.redeliveredToast'));
      await deliveries?.refresh();
    } catch (e) {
      toastApiError(e, t('webhooks.redeliverFailed'));
    } finally {
      redelivering = null;
    }
  }

  function deliveryTag(status: WebhookDeliveryStatus): TagSpec {
    switch (status) {
      case 'delivered':
        return stateTag(t('webhooks.deliveryDelivered'), 'ok');
      case 'failed':
        return stateTag(t('webhooks.deliveryFailed'), 'bad');
      case 'held':
        return stateTag(t('webhooks.deliveryHeld'), 'wait');
      default:
        return stateTag(t('webhooks.deliveryPending'), 'off');
    }
  }

  // ── The table ──────────────────────────────────────────────────────────
  const patternTag = (pattern: string): TagSpec =>
    pattern === '*'
      ? { label: t('webhooks.allEvents'), tone: 'indigo' }
      : { label: pattern, mono: true, title: eventDescription(pattern) ?? pattern };

  const filterTags = (filters: Record<string, string[]>): TagSpec[] =>
    Object.entries(filters).map(([key, ids]) => ({
      label: key,
      detail: String(ids.length),
      title: ids.join(', ')
    }));

  function rowActions(endpoint: WebhookEndpoint) {
    return [
      { label: t('webhooks.actionEdit'), onclick: () => openForm(endpoint) },
      endpoint.enabled
        ? { label: t('webhooks.actionDisable'), onclick: () => void setEnabled(endpoint, false) }
        : { label: t('webhooks.actionEnable'), onclick: () => void setEnabled(endpoint, true) },
      { label: t('webhooks.actionTest'), onclick: () => void sendTest(endpoint) },
      { label: t('webhooks.actionDeliveries'), onclick: () => openDeliveries(endpoint) },
      { label: t('webhooks.actionRotate'), onclick: () => (rotateTarget = endpoint) },
      {
        label: t('webhooks.actionDelete'),
        onclick: () => (deleteTarget = endpoint),
        variant: 'destructive' as const
      }
    ];
  }

  const columns: ColumnDef<WebhookEndpoint, unknown>[] = $derived([
    {
      accessorKey: 'url',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('webhooks.colEndpoint') }),
      cell: ({ row }) => renderSnippet(endpointCell, row.original),
      meta: { title: t('webhooks.colEndpoint') }
    },
    {
      accessorKey: 'events',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('webhooks.colEvents') }),
      cell: ({ row }) => renderComponent(TagList, { tags: row.original.events.map(patternTag) }),
      meta: { title: t('webhooks.colEvents'), width: '220px' }
    },
    {
      id: 'filters',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('webhooks.colFilters') }),
      cell: ({ row }) => {
        const tags = filterTags(row.original.filters);
        return tags.length ? renderComponent(TagList, { tags }) : '—';
      },
      meta: { title: t('webhooks.colFilters'), width: '140px' }
    },
    {
      accessorKey: 'enabled',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('webhooks.colState') }),
      cell: ({ row }) => renderSnippet(stateCell, row.original),
      meta: { title: t('webhooks.colState'), width: '180px' }
    },
    {
      accessorKey: 'lastDeliveryAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('webhooks.colLastDelivery') }),
      cell: ({ row }) => renderSnippet(lastDeliveryCell, row.original),
      meta: { title: t('webhooks.colLastDelivery'), width: '150px' }
    },
    {
      accessorKey: 'consecutiveFailures',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('webhooks.colFailures') }),
      cell: ({ row }) => renderSnippet(failuresCell, row.original),
      meta: { title: t('webhooks.colFailures'), width: '92px' }
    },
    {
      id: 'actions',
      cell: ({ row }) => renderComponent(DataTableActions, { actions: rowActions(row.original) }),
      meta: { width: '60px' }
    }
  ]);
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  pageTitle={t('webhooks.title')}
  tabs={settingsTabs(page.data as unknown as SettingsFacts, page.url.pathname)}
  lede={t('webhooks.description')}
  drawing="contour"
/>

<!-- SECURITY: the URL and the description are user-authored: text interpolation only. -->
{#snippet endpointCell(endpoint: WebhookEndpoint)}
  <span class="block min-w-0">
    <span class="block truncate font-mono text-[13px]" title={endpoint.url}>{endpoint.url}</span>
    {#if endpoint.description}
      <span class="block truncate text-xs text-muted-foreground">{endpoint.description}</span>
    {/if}
  </span>
{/snippet}

{#snippet stateCell(endpoint: WebhookEndpoint)}
  <span class="block min-w-0 space-y-1">
    {#if endpoint.enabled}
      <Tag {...stateTag(t('webhooks.stateEnabled'), 'ok')} />
    {:else if endpoint.disabledAt}
      <Tag {...stateTag(t('webhooks.stateSwitchedOff'), 'bad')} />
      <span class="block text-xs text-muted-foreground">
        {endpoint.disabledReason === 'delivery_failures'
          ? t('webhooks.switchedOffFailures', { date: formatDateTime(endpoint.disabledAt) })
          : t('webhooks.switchedOffOther', {
              date: formatDateTime(endpoint.disabledAt),
              reason: endpoint.disabledReason ?? ''
            })}
      </span>
    {:else}
      <Tag {...stateTag(t('webhooks.stateDisabled'), 'off')} />
    {/if}
  </span>
{/snippet}

{#snippet lastDeliveryCell(endpoint: WebhookEndpoint)}
  {#if endpoint.lastDeliveryAt && endpoint.lastDeliveryStatus}
    <span class="block min-w-0 space-y-1">
      <Tag {...deliveryTag(endpoint.lastDeliveryStatus)} />
      <span class="block text-xs text-muted-foreground" title={formatDateTime(endpoint.lastDeliveryAt)}>
        {formatTimeAgo(endpoint.lastDeliveryAt)}
      </span>
    </span>
  {:else}
    —
  {/if}
{/snippet}

{#snippet failuresCell(endpoint: WebhookEndpoint)}
  <span
    class={endpoint.consecutiveFailures > 0 ? 'font-medium text-destructive' : 'text-muted-foreground'}
    title={t('webhooks.failuresTitle', { n: endpoint.consecutiveFailures })}
  >
    {endpoint.consecutiveFailures}
  </span>
{/snippet}

{#snippet createAction()}
  <Button onclick={() => openForm(null)} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {t('webhooks.create')}
  </Button>
{/snippet}

<FormError
  message={list.error && endpoints.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={7} />
{:else if list.error && !endpoints.length}
  <p class="text-sm text-destructive" in:appear>{t('webhooks.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={endpoints}
    {columns}
    pageSize={50}
    searchColumns={['url']}
    searchPlaceholder={t('webhooks.searchPlaceholder')}
    emptyMessage={t('webhooks.empty')}
    count={endpointCount}
    actions={createAction}
    getRowId={(w) => w.id}
    rowSelection={focusSelection}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

{#snippet formAside()}
  <Dialog.Illustration eyebrow={t('webhooks.asideEyebrow')} caption={t('webhooks.asideCaption')}>
    <DialogDrawing kind="share" />
  </Dialog.Illustration>
{/snippet}

{#snippet secretAside()}
  <Dialog.Illustration eyebrow={t('webhooks.asideEyebrow')} caption={t('webhooks.secretAsideCaption')}>
    <DialogDrawing kind="key" />
  </Dialog.Illustration>
{/snippet}

<!-- One choice: its switch, its name (a mono pattern or a word), and under it what it means.
     The whole row is the label (app.css `.choice`); the switch is named by the name alone. -->
{#snippet choice(
  id: string,
  name: string,
  mono: boolean,
  hint: string | undefined,
  checked: boolean,
  disabled: boolean,
  set: (v: boolean) => void
)}
  <label for={id} class="choice">
    <Checkbox
      {id}
      {checked}
      {disabled}
      onCheckedChange={(v) => set(v === true)}
      aria-labelledby="{id}-name"
      aria-describedby={hint ? `${id}-hint` : undefined}
      class="mt-0.5"
    />
    <span class="min-w-0 space-y-1">
      <span id="{id}-name" class="choice-name {mono ? 'font-mono text-[13px]' : ''}">{name}</span>
      {#if hint}
        <span id="{id}-hint" class="choice-hint block">{hint}</span>
      {/if}
    </span>
  </label>
{/snippet}

<FormDialog
  bind:open={showForm}
  size="lg"
  aside={formAside}
  title={editing ? t('webhooks.editTitle') : t('webhooks.createTitle')}
  description={editing ? t('webhooks.editDescription') : t('webhooks.createDescription')}
  onClose={() => (showForm = false)}
  onSubmit={() => void submitForm()}
  loading={formLoading}
  submitLabel={editing ? t('common.save') : t('webhooks.createSubmit')}
>
  <div class="space-y-2">
    <Label for="webhook-url">{t('webhooks.urlLabel')}</Label>
    <Input
      id="webhook-url"
      type="url"
      bind:value={url}
      placeholder="https://example.com/hooks"
      spellcheck={false}
      autocomplete="off"
      required
    />
    <p class="text-xs text-muted-foreground">{t('webhooks.urlHint')}</p>
  </div>
  <div class="space-y-2">
    <Label for="webhook-description">{t('webhooks.descriptionLabel')}</Label>
    <Input
      id="webhook-description"
      bind:value={description}
      placeholder={t('webhooks.descriptionPlaceholder')}
      maxlength={200}
    />
  </div>
  <fieldset class="space-y-2">
    <legend class="eyebrow pb-2">{t('webhooks.eventsLegend')}</legend>
    <FormError message={catalogError ? t('webhooks.catalogLoadFailed', { error: catalogError }) : null} />
    <div class="choices">
      {@render choice(
        'webhook-events-all',
        t('webhooks.allEvents'),
        false,
        t('webhooks.allEventsHint'),
        allOn,
        false,
        setAll
      )}
    </div>
    {#if !allOn}
      {#each families as family (family.name)}
        <div class="choices" transition:reveal>
          {@render choice(
            `webhook-family-${family.name}`,
            `${family.name}.*`,
            true,
            t('webhooks.familyHint', { family: family.name }),
            familyOn(family.name),
            false,
            (v) => setFamily(family.name, v)
          )}
          {#each family.events as event (event.type)}
            {@render choice(
              `webhook-event-${event.type}`,
              event.type,
              true,
              event.description,
              eventOn(event.type),
              eventLocked(event.type),
              (v) => setEvent(event.type, v)
            )}
          {/each}
        </div>
      {/each}
    {/if}
  </fieldset>
  {#if filterSubjects.length}
    <fieldset class="space-y-3">
      <legend class="eyebrow pb-1">{t('webhooks.filtersLegend')}</legend>
      <p class="text-xs text-muted-foreground">{t('webhooks.filtersHint')}</p>
      {#each filterSubjects as subject (subject.key)}
        <div class="space-y-1.5">
          <Label for="webhook-filter-{subject.key}" class="flex items-baseline gap-2">
            <span>{subject.label}</span>
            <code class="text-xs text-muted-foreground">{subject.key}</code>
          </Label>
          <Input
            id="webhook-filter-{subject.key}"
            value={filterText[subject.key] ?? ''}
            oninput={(e) => (filterText[subject.key] = e.currentTarget.value)}
            placeholder={t('webhooks.filterPlaceholder')}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
      {/each}
    </fieldset>
  {/if}
  <div class="choices">
    {@render choice(
      'webhook-enabled',
      t('webhooks.enabledLabel'),
      false,
      t('webhooks.enabledHint'),
      enabled,
      false,
      (v) => (enabled = v)
    )}
  </div>
  <FormError message={formError} />
</FormDialog>

<Dialog.Root
  open={secret !== null}
  onOpenChange={(isOpen) => {
    if (!isOpen) secret = null;
  }}
>
  <Dialog.Content size="lg" aside={secretAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('webhooks.secretTitle')}</Dialog.Title>
      <Dialog.Description>{t('webhooks.secretDescription')}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if secret}
        <CodeBlock
          field
          code={secret.value}
          ariaLabel={t('webhooks.secretAria')}
          copyLabel={t('webhooks.copyAria')}
          copiedMessage={t('webhooks.copiedToast')}
        />
        <div class="space-y-1.5 text-sm">
          <p class="text-muted-foreground">{t('webhooks.secretHeaders')}</p>
          <ul class="flex flex-wrap gap-1.5">
            {#each SIGNATURE_HEADERS as header (header)}
              <li><Tag label={header} mono /></li>
            {/each}
          </ul>
        </div>
        {#if secret.previousUntil}
          <p class="notice">{t('webhooks.secretPrevious', { date: formatDateTime(secret.previousUntil) })}</p>
        {/if}
        <p class="notice notice--danger">
          <TriangleAlert class="size-4" />
          <span>{t('webhooks.secretWarning')}</span>
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button onclick={() => (secret = null)}>{t('webhooks.savedIt')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  open={rotateTarget !== null}
  title={t('webhooks.rotateConfirmTitle')}
  description={t('webhooks.rotateConfirmDescription')}
  confirmLabel={t('webhooks.actionRotate')}
  variant="default"
  onClose={() => (rotateTarget = null)}
  onConfirm={() => void submitRotate()}
  loading={rotateLoading}
/>

<ConfirmDialog
  open={deleteTarget !== null}
  title={t('webhooks.deleteConfirmTitle')}
  description={t('webhooks.deleteConfirmDescription', { url: deleteTarget?.url ?? '' })}
  confirmLabel={t('webhooks.actionDelete')}
  onClose={() => (deleteTarget = null)}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>

<Sheet.Root
  open={deliveriesFor !== null}
  onOpenChange={(open) => {
    if (!open) {
      deliveriesFor = null;
      deliveries = null;
    }
  }}
>
  <Sheet.Content
    side={phone.current ? 'bottom' : 'right'}
    class="max-h-[88dvh] overflow-y-auto max-md:rounded-t-2xl md:max-h-none md:max-w-xl"
  >
    {#if deliveriesFor}
      <Sheet.Header>
        <Sheet.Title class="font-display text-xl font-normal">{t('webhooks.actionDeliveries')}</Sheet.Title>
        <Sheet.Description class="break-all">
          {t('webhooks.deliveriesDescription', { url: deliveriesFor.url })}
        </Sheet.Description>
      </Sheet.Header>
      {#if deliveries}
        {#if deliveries.loading}
          <p class="py-6 text-sm text-muted-foreground">{t('common.loading')}</p>
        {:else if deliveries.error && !deliveries.items.length}
          <p class="py-6 text-sm text-destructive" in:appear>
            {t('webhooks.deliveriesLoadFailed', { error: deliveries.error })}
          </p>
        {:else if !deliveries.items.length}
          <p class="py-6 text-sm text-muted-foreground">{t('webhooks.deliveriesEmpty')}</p>
        {:else}
          <ul class="divide-y divide-[var(--hairline)]">
            {#each deliveries.items as delivery (delivery.id)}
              {@const open = expanded === delivery.id}
              <li class="py-2.5">
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 text-left"
                    aria-expanded={open}
                    onclick={() => (expanded = open ? null : delivery.id)}
                  >
                    <ChevronRight
                      class="size-4 shrink-0 text-muted-foreground transition-transform {open
                        ? 'rotate-90'
                        : ''}"
                    />
                    <Tag {...deliveryTag(delivery.status)} />
                    <span class="min-w-0 flex-1">
                      <code class="block truncate text-[13px]">{delivery.eventType}</code>
                      <span class="block text-xs text-muted-foreground">
                        {t('webhooks.deliveryAttempt', { n: delivery.attempt })} ·
                        {delivery.lastStatusCode !== null
                          ? `HTTP ${delivery.lastStatusCode}`
                          : t('webhooks.deliveryNoAnswer')} ·
                        <span title={formatDateTime(delivery.createdAt)}
                          >{formatTimeAgo(delivery.createdAt)}</span
                        >
                      </span>
                    </span>
                  </button>
                  <Button
                    size="sm"
                    variant="outline"
                    class="h-8 shrink-0"
                    disabled={redelivering === delivery.id}
                    onclick={() => void redeliver(delivery)}
                  >
                    {t('webhooks.actionRedeliver')}
                  </Button>
                </div>
                {#if open}
                  <div class="space-y-3 pb-1 pt-3" transition:reveal>
                    <dl class="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                      <dt class="text-muted-foreground">{t('webhooks.deliveryEventId')}</dt>
                      <dd class="break-all"><code class="text-xs">{delivery.eventId}</code></dd>
                      {#if delivery.lastError}
                        <dt class="text-muted-foreground">{t('webhooks.deliveryLastError')}</dt>
                        <dd class="break-words">{delivery.lastError}</dd>
                      {/if}
                      {#if delivery.nextAttemptAt}
                        <dt class="text-muted-foreground">{t('webhooks.deliveryNextAttempt')}</dt>
                        <dd>{formatDateTime(delivery.nextAttemptAt)}</dd>
                      {/if}
                    </dl>
                    <!-- SECURITY: the payload carries user-authored strings; CodeBlock renders text, never {@html}. -->
                    <CodeBlock
                      code={JSON.stringify(delivery.payload, null, 2)}
                      label={t('webhooks.deliveryPayload')}
                      ariaLabel={t('webhooks.deliveryPayload')}
                      wrap={false}
                      class="[--code-max-h:40dvh]"
                    />
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
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
    {/if}
  </Sheet.Content>
</Sheet.Root>
