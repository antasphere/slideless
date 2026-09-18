<script lang="ts">
  import { createRawSnippet } from 'svelte';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Tag } from '$lib/components/ui/tag/index.js';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import DialogDrawing from './drawings/DialogDrawing.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import Plus from '@lucide/svelte/icons/plus';
  import { page } from '$app/state';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatDate } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { roleTag } from '$lib/tags';
  import { t } from '$lib/i18n';
  import type { Collaborator, MeResponse, Presentation } from '@slideless/contract';

  interface Props {
    deckId: string;
    /** Invite/remove are owner-level (deck owner or workspace admin/owner). */
    canManage: boolean;
  }

  let { deckId, canManage }: Props = $props();

  const list = createPagedList<Collaborator>(async (p) => {
    const { collaborators, nextCursor } = await api.collaborators(deckId, p);
    return { items: collaborators, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  // ── The owner's row ────────────────────────────────────────────────────
  // The roster the API returns holds GRANTS only: the owner is the deck's
  // `ownerUserId`, never a collaborator row (inviting the owner's address is
  // refused `already_owner`), so a list built from the grants alone shows a
  // collaborator only themselves. The owner is put back here, first, from
  // what the viewer may already read: the deck, their own `/me`, and, for a
  // workspace member, the member roster. A guest is refused that roster
  // (`guest_forbidden`), so for them the row says what is known and no more.
  const OWNER_ROW_ID = '__owner__';
  const me = $derived((page.data as { me?: MeResponse | null }).me ?? null);
  let deck = $state<Presentation | null>(null);
  let ownerEmail = $state<string | null>(null);

  $effect(() => {
    const id = deckId;
    deck = null;
    ownerEmail = null;
    void api
      .presentation(id)
      .then((d) => {
        if (id === deckId) deck = d;
      })
      .catch(() => {
        // The panel still lists the grants; the owner row is simply absent.
      });
  });

  $effect(() => {
    const ownerId = deck?.ownerUserId;
    if (!ownerId || !me || ownerId === me.user.id || me.origin === 'guest') return;
    void api
      .members({ limit: 100 })
      .then(({ members }) => {
        if (deck?.ownerUserId === ownerId) {
          ownerEmail = members.find((m) => m.userId === ownerId)?.email ?? null;
        }
      })
      .catch(() => {
        // Not allowed or unreachable: the row keeps its honest fallback.
      });
  });

  const ownerLabel = $derived.by(() => {
    if (!deck) return null;
    if (!deck.ownerUserId) return t('deck.ownerDeleted');
    if (me && deck.ownerUserId === me.user.id) return t('collaborators.ownerYou', { email: me.user.email });
    return ownerEmail ?? t('collaborators.ownerUnknown');
  });

  const rows: Collaborator[] = $derived(
    deck && ownerLabel !== null
      ? [
          {
            id: OWNER_ROW_ID,
            presentationId: deckId,
            email: ownerLabel,
            userId: deck.ownerUserId,
            role: 'owner',
            status: 'active',
            invitedBy: null,
            claimedAt: null,
            revokedAt: null,
            createdAt: deck.createdAt
          },
          ...list.items
        ]
      : list.items
  );
  const isOwnerRow = (row: Collaborator) => row.id === OWNER_ROW_ID;

  // ── Invite dialog ──────────────────────────────────────────────────────
  let showInviteDialog = $state(false);
  let inviteLoading = $state(false);
  let inviteEmail = $state('');

  // ── Claim-link dialog (always returned — SMTP never required) ─────────
  let claimUrl = $state<string | null>(null);
  let claimEmail = $state('');
  let claimEmailSent = $state(false);
  let showClaimDialog = $state(false);

  function openInviteDialog() {
    inviteEmail = '';
    showInviteDialog = true;
  }

  async function submitInvite() {
    inviteLoading = true;
    try {
      const result = await api.inviteCollaborator(deckId, { email: inviteEmail });
      showInviteDialog = false;
      claimUrl = result.claimUrl;
      claimEmail = result.collaborator.email;
      claimEmailSent = result.emailSent;
      showClaimDialog = true;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('collaborators.inviteFailed')));
    } finally {
      inviteLoading = false;
    }
  }

  // ── Remove ─────────────────────────────────────────────────────────────
  let showRemoveDialog = $state(false);
  let removeLoading = $state(false);
  let removeTarget = $state<Collaborator | null>(null);

  async function submitRemove() {
    if (!removeTarget) return;
    removeLoading = true;
    try {
      await api.removeCollaborator(deckId, removeTarget.id);
      toast.success(t('collaborators.removedToast', { email: removeTarget.email }));
      showRemoveDialog = false;
      removeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      removeLoading = false;
    }
  }

  const statusKey = {
    pending: 'collaborators.statusPending',
    active: 'collaborators.statusActive',
    revoked: 'collaborators.statusRevoked'
  } as const;

  const columns: ColumnDef<Collaborator, unknown>[] = $derived([
    {
      accessorKey: 'email',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colEmail') }),
      // SECURITY: collaborator emails are USER-SUPPLIED text. Returning the
      // plain string renders through FlexRender's escaped `{result}` text
      // interpolation — never wrap it in createRawSnippet / {@html}.
      cell: ({ row }) => row.getValue('email'),
      meta: { title: t('collaborators.colEmail') }
    },
    {
      accessorKey: 'role',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colRole') }),
      // Static i18n labels only: the tag never carries user data here.
      cell: ({ row }) =>
        renderComponent(
          Tag,
          row.original.role === 'owner'
            ? roleTag('owner')
            : { label: t('collaborators.roleDev'), tone: 'slate' as const, icon: PenLine }
        ),
      meta: { title: t('collaborators.colRole'), width: '130px' }
    },
    {
      accessorKey: 'status',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colStatus') }),
      cell: ({ row }) =>
        isOwnerRow(row.original)
          ? ''
          : renderComponent(Badge, {
              variant: (row.original.status === 'revoked' ? 'destructive' : 'outline') as
                'destructive' | 'outline',
              // Static i18n text only — never user data inside createRawSnippet.
              children: createRawSnippet(() => ({
                render: () => `<span>${t(statusKey[row.original.status])}</span>`
              }))
            }),
      meta: { title: t('collaborators.colStatus'), width: '110px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colInvited') }),
      cell: ({ row }) => (isOwnerRow(row.original) ? '' : formatDate(row.original.createdAt)),
      meta: { title: t('collaborators.colInvited'), width: '110px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        !canManage || row.original.status === 'revoked' || isOwnerRow(row.original)
          ? ''
          : renderComponent(DataTableActions, {
              actions: [
                {
                  label: t('collaborators.actionRemove'),
                  onclick: () => {
                    removeTarget = row.original;
                    showRemoveDialog = true;
                  },
                  variant: 'destructive' as const
                }
              ]
            }),
      meta: { width: '60px' }
    }
  ]);
</script>

{#snippet inviteAside()}
  <Dialog.Illustration eyebrow={t('collaborators.asideEyebrow')} caption={t('collaborators.asideCaption')}>
    <DialogDrawing kind="invite" />
  </Dialog.Illustration>
{/snippet}

{#snippet claimAside()}
  <Dialog.Illustration
    eyebrow={t('collaborators.asideEyebrow')}
    caption={t('collaborators.claimAsideCaption')}
  >
    <DialogDrawing kind="invited" />
  </Dialog.Illustration>
{/snippet}

<Card.Root>
  <DeckSectionHeading
    drawing="collaborators"
    title={t('collaborators.title')}
    description={t('collaborators.description')}
  >
    {#snippet action()}
      {#if canManage}
        <Button size="sm" onclick={openInviteDialog}>
          <Plus class="mr-2 h-4 w-4" />
          {t('collaborators.invite')}
        </Button>
      {/if}
    {/snippet}
  </DeckSectionHeading>
  <Card.Content>
    {#if !canManage}
      <p class="pb-2 text-xs text-muted-foreground">{t('collaborators.ownersOnly')}</p>
    {/if}
    {#if list.loading}
      <TableSkeleton columns={4} rows={2} showSearch={false} />
    {:else}
      {#if rows.length}
        <DataTable data={rows} {columns} showViewOptions={false} showPagination={false} pageSize={200} />
      {/if}
      {#if list.error && !list.items.length}
        <p class="pt-3 text-sm text-destructive">{t('collaborators.loadFailed', { error: list.error })}</p>
      {:else if !list.items.length}
        <p class="pt-3 text-sm text-muted-foreground">{t('collaborators.empty')}</p>
      {/if}
      {#if list.nextCursor}
        <div class="flex justify-center py-2">
          <Button
            variant="outline"
            size="sm"
            onclick={() => void list.loadMore()}
            disabled={list.loadingMore}
          >
            {list.loadingMore ? t('common.loading') : t('common.loadMore')}
          </Button>
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>

<FormDialog
  bind:open={showInviteDialog}
  size="lg"
  aside={inviteAside}
  title={t('collaborators.inviteTitle')}
  description={t('collaborators.inviteDescription')}
  onClose={() => (showInviteDialog = false)}
  onSubmit={() => void submitInvite()}
  loading={inviteLoading}
  submitLabel={t('collaborators.inviteSubmit')}
>
  <div class="space-y-2">
    <Label for="collab-email">{t('collaborators.emailLabel')}</Label>
    <Input
      id="collab-email"
      type="email"
      autocomplete="off"
      bind:value={inviteEmail}
      placeholder={t('collaborators.emailPlaceholder')}
      required
    />
  </div>
  <ol class="steps">
    <li><span class="n">1</span><span>{t('collaborators.stepLink')}</span></li>
    <li><span class="n">2</span><span>{t('collaborators.stepClaim')}</span></li>
    <li><span class="n">3</span><span>{t('collaborators.stepWork')}</span></li>
  </ol>
</FormDialog>

<Dialog.Root
  bind:open={showClaimDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) claimUrl = null;
  }}
>
  <Dialog.Content size="lg" aside={claimAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('collaborators.linkTitle')}</Dialog.Title>
      <Dialog.Description>
        <!-- claimEmail is user-supplied; t() output renders as escaped text. -->
        {t('collaborators.linkShare', { email: claimEmail })}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if claimUrl}
        <CodeBlock
          field
          code={claimUrl}
          ariaLabel={t('collaborators.linkAria')}
          copyLabel={t('collaborators.copyLinkAria')}
          copiedMessage={t('collaborators.linkCopied')}
        />
        <p class="text-sm text-muted-foreground">
          {#if claimEmailSent}
            <Badge variant="outline">{t('invitations.badgeEmailSent')}</Badge>
            {t('collaborators.emailAlsoSent')}
          {:else}
            <Badge variant="outline">{t('invitations.badgeNoEmail')}</Badge>
            {t('collaborators.sendYourself')}
          {/if}
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showClaimDialog = false;
          claimUrl = null;
        }}
      >
        {t('common.done')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showRemoveDialog}
  title={t('collaborators.removeConfirmTitle')}
  description={t('collaborators.removeConfirmDescription', { email: removeTarget?.email ?? '' })}
  confirmLabel={t('collaborators.actionRemove')}
  onClose={() => {
    showRemoveDialog = false;
    removeTarget = null;
  }}
  onConfirm={() => void submitRemove()}
  loading={removeLoading}
/>

<style>
  /* what happens after Create, said before it: three plain steps */
  .steps {
    display: grid;
    gap: 2px;
    padding: 6px 12px;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    background: color-mix(in oklab, var(--ground-2) 38%, transparent);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-soft);
  }
  .steps li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 7px 0;
  }
  .steps li + li {
    border-top: 1px solid color-mix(in oklab, var(--hairline) 70%, transparent);
  }
  .n {
    flex: none;
    width: 18px;
    font-family: var(--display);
    font-size: 15px;
    font-weight: 300;
    color: var(--accent-deep);
    font-variant-numeric: lining-nums;
  }
</style>
