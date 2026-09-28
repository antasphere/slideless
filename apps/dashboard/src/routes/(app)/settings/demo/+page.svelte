<script lang="ts">
  /* The demo links (a tab of Settings, the demo pass spec, section 7): an
     owner mints a link that signs one member in without their password,
     sees the links made, and revokes one. The API keys page's pattern: a
     table, a create dialog, the link shown once with a copy button, a revoke
     with confirmation. */
  import { Tag } from '$lib/components/ui/tag';
  import { stateTag } from '$lib/tags';
  import Plus from '@lucide/svelte/icons/plus';
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
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { toastApiError } from '$lib/billing-refusal';
  import { formatDateTime, formatTimeAgo } from '$lib/format';
  import { settingsTabs } from '$lib/settings-tabs';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { DemoPass, DemoPassMinted, Member } from '@antasphere/chassis-contract';

  let { data } = $props();

  // The passes come in one answer (newest first, never a secret); the paged
  // list gives the page its loading, error and refresh states all the same.
  const list = createPagedList<DemoPass>(async () => {
    const { passes } = await api.demoPasses();
    return { items: passes, nextCursor: null };
  });

  $effect(() => {
    void list.load();
  });

  const passes = $derived(list.items);
  const passCount = $derived(rowCount('demoLinks.countOne', 'demoLinks.count'));

  // ── The members a link may be made for: the active ones ────────────────
  let members = $state<Member[]>([]);
  let membersError = $state<string | null>(null);

  async function loadMembers() {
    membersError = null;
    try {
      const all: Member[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.members({ cursor, limit: 100 });
        all.push(...page.members);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      members = all.filter((m) => m.isActive);
    } catch (e) {
      membersError = errorMessage(e);
    }
  }

  const memberLabel = (m: Pick<Member, 'name' | 'email'>) => (m.name ? `${m.name} · ${m.email}` : m.email);

  // ── Create dialog ──────────────────────────────────────────────────────
  const lifetimeOptions = [
    { value: '60', label: t('demoLinks.lifetimeHour') },
    { value: '1440', label: t('demoLinks.lifetimeDay') },
    { value: '4320', label: t('demoLinks.lifetimeDays', { n: 3 }) },
    { value: '10080', label: t('demoLinks.lifetimeDays', { n: 7 }) }
  ];
  let showCreateDialog = $state(false);
  let createLoading = $state(false);
  let email = $state('');
  let path = $state('/');
  let lifetime = $state('1440');

  // ── The link: shown exactly once, never retrievable again ─────────────
  let minted = $state<DemoPassMinted | null>(null);
  let showLinkDialog = $state(false);

  function openCreateDialog() {
    email = '';
    path = '/';
    lifetime = '1440';
    showCreateDialog = true;
    void loadMembers();
  }

  async function submitCreate() {
    if (!email) {
      toast.error(t('demoLinks.errorNoMember'));
      return;
    }
    createLoading = true;
    try {
      const result = await api.mintDemoPass({ email, path, expiresInMinutes: Number(lifetime) });
      showCreateDialog = false;
      minted = result;
      showLinkDialog = true;
      await list.refresh();
    } catch (e) {
      // the server's own sentence (no_such_member, owner_target, …)
      toastApiError(e, t('demoLinks.createFailed'));
    } finally {
      createLoading = false;
    }
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  let showRevokeDialog = $state(false);
  let revokeLoading = $state(false);
  let revokeTarget = $state<DemoPass | null>(null);

  async function submitRevoke() {
    if (!revokeTarget) return;
    revokeLoading = true;
    try {
      await api.revokeDemoPass(revokeTarget.id);
      toast.success(t('demoLinks.revokedToast', { email: revokeTarget.email }));
      showRevokeDialog = false;
      revokeTarget = null;
      await list.refresh();
    } catch (e) {
      toastApiError(e, t('common.revokeFailed'));
    } finally {
      revokeLoading = false;
    }
  }

  // State precedence: Revoked (the owner's act) > Expired > Live.
  const isExpired = (p: DemoPass) => new Date(p.expiresAt) <= new Date();
  const isLive = (p: DemoPass) => !p.revokedAt && !isExpired(p);

  const columns: ColumnDef<DemoPass, unknown>[] = $derived([
    {
      accessorKey: 'email',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('demoLinks.colPerson') }),
      cell: ({ row }) => renderSnippet(personCell, row.original),
      meta: { title: t('demoLinks.colPerson') }
    },
    {
      accessorKey: 'targetPath',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('demoLinks.colPage') }),
      cell: ({ row }) => renderComponent(Tag, { label: row.original.targetPath, mono: true }),
      meta: { title: t('demoLinks.colPage'), width: '160px' }
    },
    {
      accessorKey: 'expiresAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('demoLinks.colExpires') }),
      cell: ({ row }) => formatDateTime(row.getValue('expiresAt') as string),
      meta: { title: t('demoLinks.colExpires'), width: '150px' }
    },
    {
      accessorKey: 'lastUsedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('demoLinks.colLastUsed') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('lastUsedAt') as string | null),
      meta: { title: t('demoLinks.colLastUsed'), width: '118px' }
    },
    {
      accessorKey: 'useCount',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('demoLinks.colUses') }),
      cell: ({ row }) => String(row.getValue('useCount')),
      meta: { title: t('demoLinks.colUses'), width: '84px' }
    },
    {
      accessorKey: 'revokedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('demoLinks.colState') }),
      cell: ({ row }) =>
        renderComponent(
          Tag,
          row.original.revokedAt
            ? stateTag(t('demoLinks.stateRevoked'), 'bad')
            : isExpired(row.original)
              ? stateTag(t('demoLinks.stateExpired'), 'wait')
              : stateTag(t('demoLinks.stateLive'), 'ok')
        ),
      meta: { title: t('demoLinks.colState'), width: '112px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        isLive(row.original)
          ? renderComponent(DataTableActions, {
              actions: [
                {
                  label: t('demoLinks.actionRevoke'),
                  onclick: () => {
                    revokeTarget = row.original;
                    showRevokeDialog = true;
                  },
                  variant: 'destructive' as const
                }
              ]
            })
          : '',
      meta: { width: '60px' }
    }
  ]);
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  lede={t('demoLinks.lede')}
  pageTitle={t('settings.tabDemo')}
  tabs={settingsTabs(data)}
  drawing="meridians"
/>

<!-- SECURITY: the name and the address are user-authored: text interpolation only. -->
{#snippet personCell(pass: DemoPass)}
  <span class="block min-w-0">
    <span class="block truncate font-medium">{pass.name}</span>
    <span class="block truncate text-xs text-muted-foreground">{pass.email}</span>
  </span>
{/snippet}

{#snippet createAction()}
  <Button onclick={openCreateDialog} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {t('demoLinks.create')}
  </Button>
{/snippet}

<p class="notice mb-4">{t('demoLinks.intro')}</p>

<FormError
  message={list.error && passes.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={7} />
{:else if list.error && !passes.length}
  <p class="text-sm text-destructive" in:appear>{t('demoLinks.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={passes}
    {columns}
    searchColumns={['email', 'targetPath']}
    searchPlaceholder={t('demoLinks.searchPlaceholder')}
    emptyMessage={t('demoLinks.empty')}
    count={passCount}
    actions={createAction}
  />
{/if}

{#snippet linkAside()}
  <Dialog.Illustration eyebrow={t('demoLinks.asideEyebrow')} caption={t('demoLinks.asideCaption')}>
    <DialogDrawing kind="key" />
  </Dialog.Illustration>
{/snippet}

{#snippet secretAside()}
  <Dialog.Illustration eyebrow={t('demoLinks.asideEyebrow')} caption={t('demoLinks.secretAsideCaption')}>
    <DialogDrawing kind="key" />
  </Dialog.Illustration>
{/snippet}

<FormDialog
  bind:open={showCreateDialog}
  size="lg"
  aside={linkAside}
  title={t('demoLinks.createTitle')}
  description={t('demoLinks.createDescription')}
  onClose={() => (showCreateDialog = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('demoLinks.create')}
>
  <div class="space-y-2">
    <Label for="demo-member">{t('demoLinks.memberLabel')}</Label>
    <Select.Root
      type="single"
      value={email}
      onValueChange={(v) => {
        if (v) email = v;
      }}
    >
      <Select.Trigger id="demo-member" class="w-full">
        {#if email}
          {memberLabel(members.find((m) => m.email === email) ?? { name: '', email })}
        {:else}
          <span class="text-muted-foreground">{t('demoLinks.memberPlaceholder')}</span>
        {/if}
      </Select.Trigger>
      <Select.Content>
        {#each members as member (member.id)}
          <Select.Item value={member.email} label={memberLabel(member)} />
        {/each}
      </Select.Content>
    </Select.Root>
    <FormError message={membersError ? t('demoLinks.membersLoadFailed', { error: membersError }) : null} />
  </div>
  <div class="space-y-2">
    <Label for="demo-path">{t('demoLinks.pageLabel')}</Label>
    <Input id="demo-path" bind:value={path} spellcheck={false} autocomplete="off" required />
    <p class="text-xs text-muted-foreground">{t('demoLinks.pageHint')}</p>
  </div>
  <div class="space-y-2">
    <Label for="demo-lifetime">{t('demoLinks.lifetimeLabel')}</Label>
    <Select.Root
      type="single"
      value={lifetime}
      onValueChange={(v) => {
        if (v) lifetime = v;
      }}
    >
      <Select.Trigger id="demo-lifetime" class="w-full">
        {lifetimeOptions.find((o) => o.value === lifetime)?.label}
      </Select.Trigger>
      <Select.Content>
        {#each lifetimeOptions as option (option.value)}
          <Select.Item value={option.value} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showLinkDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) minted = null;
  }}
>
  <Dialog.Content size="lg" aside={secretAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('demoLinks.secretTitle')}</Dialog.Title>
      <Dialog.Description>
        {minted
          ? t('demoLinks.secretDescription', { email: minted.pass.email, path: minted.pass.targetPath })
          : ''}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if minted}
        <CodeBlock
          field
          code={minted.url}
          ariaLabel={t('demoLinks.secretAria')}
          copyLabel={t('demoLinks.copyAria')}
          copiedMessage={t('demoLinks.copiedToast')}
        />
        <p class="notice notice--danger">
          <TriangleAlert class="size-4" />
          <span>{t('demoLinks.secretWarning')}</span>
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showLinkDialog = false;
          minted = null;
        }}
      >
        {t('demoLinks.savedIt')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showRevokeDialog}
  title={t('demoLinks.revokeConfirmTitle')}
  description={t('demoLinks.revokeConfirmDescription', { email: revokeTarget?.email ?? '' })}
  confirmLabel={t('demoLinks.actionRevoke')}
  onClose={() => {
    showRevokeDialog = false;
    revokeTarget = null;
  }}
  onConfirm={() => void submitRevoke()}
  loading={revokeLoading}
/>
