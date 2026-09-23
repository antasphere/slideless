<script lang="ts">
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Reveal, appear, reveal } from '$lib/components/ui/reveal/index.js';
  import CapabilityCell from './CapabilityCell.svelte';
  import ShareLinkNameCell from './ShareLinkNameCell.svelte';
  import ShareLinkPanel, { type LinkAction } from './ShareLinkPanel.svelte';
  import ShareLinkRowActions from './ShareLinkRowActions.svelte';
  import ShareLinkStatusCell from './ShareLinkStatusCell.svelte';
  import ShareLinkVersionCell from './ShareLinkVersionCell.svelte';
  import ShareLinkColumnsMenu from './ShareLinkColumnsMenu.svelte';
  import { LinkColumns, type LinkColumnId } from './linkColumns.svelte';
  import type { Snippet } from 'svelte';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { isPreviewToken, tokenStatus } from '$lib/tool/decks';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import Activity from '@lucide/svelte/icons/activity';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import FileDown from '@lucide/svelte/icons/file-down';
  import Ban from '@lucide/svelte/icons/ban';
  import type { PresentationVersion, ShareToken } from '@slideless/contract';

  /**
   * The deck's share links as a table (rebuilt with PRDCT-2308: the
   * recipient on one line, the version as a tag, one check column per
   * capability, copy and open on every row) with their per-row actions
   * (copy, open, activity, change version, file uploads on/off, PDF export
   * on/off, revoke) and
   * the dialogs those open. A row opens the link's panel (ShareLinkPanel):
   * the same facts and the same acts, with the link's activity. Which
   * columns show is the reader's choice, kept in this browser (LinkColumns).
   * Shared by the admin page's share panel and the master page's share sheet
   * (PRDCT-2279). Creating a link is the sibling ShareLinkCreateDialog. With
   * no link yet the table still stands, its heads over one quiet row. The
   * toolbar over it carries the count at the left (how many links still
   * open, out of how many) and the View button with the host's action at
   * the right.
   */
  interface Props {
    deckId: string;
    /** Page-owned list — shared with the preview's token housekeeping. */
    list: PagedList<ShareToken>;
    versions: PresentationVersion[];
    /**
     * Which columns show before the reader chooses: `full` is every column
     * (the master page's share sheet), `lean` hides the least telling ones
     * (the deck page). Each keeps its own remembered choice.
     */
    defaults?: 'full' | 'lean';
    /**
     * The host's own column choice: it renders the View button itself, in
     * `actions`. Without it the table keeps its own choice and its own View
     * button, in the toolbar over it.
     */
    view?: LinkColumns;
    /** The host's buttons at the right of the toolbar (View and New share link on the deck page). */
    actions?: Snippet;
  }

  let { deckId, list, versions, defaults = 'full', view, actions }: Props = $props();

  // The page's own transient preview tokens are plumbing, not shares.
  const tokens = $derived(list.items.filter((token) => !isPreviewToken(token)));

  // ── Change version dialog ──────────────────────────────────────────────
  let showVersionDialog = $state(false);
  let versionLoading = $state(false);
  let versionTarget = $state<ShareToken | null>(null);
  let editVersionMode = $state<'latest' | 'pinned'>('latest');
  let editPinnedVersion = $state('');

  function openVersionDialog(token: ShareToken) {
    versionTarget = token;
    editVersionMode = token.pinnedVersion === null ? 'latest' : 'pinned';
    editPinnedVersion = String(token.pinnedVersion ?? versions[0]?.version ?? '');
    showVersionDialog = true;
  }

  async function submitVersionChange() {
    if (!versionTarget) return;
    versionLoading = true;
    try {
      await api.updateShareToken(
        deckId,
        versionTarget.id,
        editVersionMode === 'latest'
          ? { versionMode: 'latest' }
          : { versionMode: 'pinned', pinnedVersion: Number(editPinnedVersion) }
      );
      toast.success(t('tokens.updatedToast', { name: versionTarget.name }));
      showVersionDialog = false;
      versionTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.updateFailed')));
    } finally {
      versionLoading = false;
    }
  }

  // ── File uploads on an existing link (PRDCT-2403) ──────────────────────
  // A link minted before file fields existed has uploads OFF (a link already
  // in circulation never gains a public write by itself): this is where its
  // owner turns them on, and off again. One PATCH, no dialog; the check in
  // the table is the read-back.
  let uploadsSaving = $state(false);

  async function setUploads(token: ShareToken, value: boolean) {
    if (uploadsSaving) return;
    uploadsSaving = true;
    try {
      await api.updateShareToken(deckId, token.id, { canUploadFiles: value });
      toast.success(t(value ? 'tokens.uploadsOnToast' : 'tokens.uploadsOffToast', { name: token.name }));
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.updateFailed')));
    } finally {
      uploadsSaving = false;
    }
  }

  // ── PDF export on an existing link (PRDCT-2668) ────────────────────────
  // A link minted before the switch existed has it OFF: this is where its
  // owner turns the Export PDF action on, and off again. One PATCH, no
  // dialog; the check in the table is the read-back.
  let pdfSaving = $state(false);

  async function setPdf(token: ShareToken, value: boolean) {
    if (pdfSaving) return;
    pdfSaving = true;
    try {
      await api.updateShareToken(deckId, token.id, { canExportPdf: value });
      toast.success(t(value ? 'tokens.pdfOnToast' : 'tokens.pdfOffToast', { name: token.name }));
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.updateFailed')));
    } finally {
      pdfSaving = false;
    }
  }

  // ── The link's panel ───────────────────────────────────────────────────
  // A row opens it, and so does the menu's "View activity": the link's
  // facts, its counted views (PRDCT-1313) and its acts. The panel follows
  // the list's live row by id, so a change made from it reads back in it.
  let panelTokenId = $state<string | null>(null);
  const panelToken = $derived(tokens.find((token) => token.id === panelTokenId) ?? null);

  function openPanel(token: ShareToken) {
    panelTokenId = token.id;
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  let showRevokeDialog = $state(false);
  let revokeLoading = $state(false);
  let revokeTarget = $state<ShareToken | null>(null);

  async function submitRevoke() {
    if (!revokeTarget) return;
    revokeLoading = true;
    try {
      await api.revokeShareToken(deckId, revokeTarget.id);
      toast.success(t('tokens.revokedToast', { name: revokeTarget.name }));
      showRevokeDialog = false;
      revokeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.revokeFailed')));
    } finally {
      revokeLoading = false;
    }
  }

  // ── A link's acts, built ONCE ──────────────────────────────────────────
  // The row menu and the link's panel both show this list, so the two can
  // never drift: same labels, same handlers.
  function actionsFor(token: ShareToken): LinkAction[] {
    if (tokenStatus(token) !== 'active') return [];
    return [
      {
        key: 'version',
        label: t('tokens.actionChangeVersion'),
        icon: GitBranch,
        onclick: () => openVersionDialog(token)
      },
      // Uploads need submissions: no switch on a link with forms off.
      ...(token.canSubmitForms
        ? [
            {
              key: 'uploads' as const,
              label: token.canUploadFiles ? t('tokens.actionUploadsOff') : t('tokens.actionUploadsOn'),
              icon: Paperclip,
              onclick: () => void setUploads(token, !token.canUploadFiles)
            }
          ]
        : []),
      {
        key: 'pdf',
        label: token.canExportPdf ? t('tokens.actionPdfOff') : t('tokens.actionPdfOn'),
        icon: FileDown,
        onclick: () => void setPdf(token, !token.canExportPdf)
      },
      {
        key: 'revoke',
        label: t('tokens.actionRevoke'),
        icon: Ban,
        onclick: () => {
          revokeTarget = token;
          showRevokeDialog = true;
        },
        variant: 'destructive'
      }
    ];
  }

  // ── Which columns show ─────────────────────────────────────────────────
  // The reader's choice (LinkColumns): the host's when it renders the View
  // button itself, this table's own otherwise.
  // svelte-ignore state_referenced_locally
  const own = view ? null : new LinkColumns(defaults);
  const columnsView = $derived(view ?? own!);
  const hidden = $derived(columnsView.hidden);

  const statusShown = $derived(!hidden.includes('revokedAt'));
  const activeCount = $derived(tokens.filter((token) => tokenStatus(token) === 'active').length);

  // One capability, one column: a check or nothing (PRDCT-2308).
  const capability = (
    key: 'downloads' | 'pdf' | 'bar' | 'notes' | 'forms' | 'uploads' | 'remembers',
    field:
      | 'canDownload'
      | 'canExportPdf'
      | 'showBar'
      | 'canAnnotate'
      | 'canSubmitForms'
      | 'canUploadFiles'
      | 'remembersResponses',
    label: string
  ): ColumnDef<ShareToken, unknown> => ({
    accessorKey: field,
    header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: label }),
    cell: ({ row }) => renderComponent(CapabilityCell, { key, on: row.original[field], label }),
    meta: { title: label, width: '80px', align: 'center' }
  });

  // The recipient first and never cut; the version as a tag; the
  // capabilities as checks; the counts; the status with its expiry behind
  // the hover; copy, open and the menu at the end. EVERY column carries a
  // width and the visible ones add up to the table's min width: in a fixed
  // table layout the one column without a width gets whatever is left,
  // which was nothing — the cut column Romain reported. A narrower host
  // scrolls the table sideways instead.
  const allColumns: ColumnDef<ShareToken, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('tokens.colName') }),
      // SECURITY: the recipient label is USER-SUPPLIED text — the cell
      // component renders it through escaped {} interpolation only. Never
      // wrap it in createRawSnippet / {@html}.
      cell: ({ row }) =>
        renderComponent(ShareLinkNameCell, {
          name: row.original.name,
          hasPassword: row.original.hasPassword,
          status: tokenStatus(row.original),
          showState: !statusShown,
          onopen: () => openPanel(row.original)
        }),
      meta: { title: t('tokens.colName'), width: statusShown ? '180px' : '260px' }
    },
    {
      accessorKey: 'pinnedVersion',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colVersion') }),
      cell: ({ row }) => renderComponent(ShareLinkVersionCell, { pinnedVersion: row.original.pinnedVersion }),
      meta: { title: t('tokens.colVersion'), width: '88px' }
    },
    capability('downloads', 'canDownload', t('tokens.colDownloads')),
    // PRDCT-2668: the Export PDF action in the recipient's bar.
    capability('pdf', 'canExportPdf', t('tokens.colPdf')),
    capability('bar', 'showBar', t('tokens.colBar')),
    capability('notes', 'canAnnotate', t('tokens.colNotes')),
    capability('forms', 'canSubmitForms', t('tokens.colForms')),
    // PRDCT-2403: file uploads, right after the forms they belong to. Shown
    // only with forms on — uploads need submissions, so a link that refuses
    // them never carries a misleading check.
    {
      ...capability('uploads', 'canUploadFiles', t('tokens.colUploads')),
      cell: ({ row }) =>
        renderComponent(CapabilityCell, {
          key: 'uploads',
          on: row.original.canSubmitForms && row.original.canUploadFiles,
          label: t('tokens.colUploads')
        })
    },
    // PRDCT-2328: the link remembers its answers — shown as a fifth check so
    // the state is never unverifiable from the table (PRDCT-1337's lesson).
    capability('remembers', 'remembersResponses', t('tokens.colRemembers')),
    {
      accessorKey: 'accessCount',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('tokens.colViews') }),
      cell: ({ row }) => String(row.original.accessCount),
      meta: { title: t('tokens.colViews'), width: '88px' }
    },
    {
      accessorKey: 'lastAccessedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colLastAccess') }),
      cell: ({ row }) => formatTimeAgo(row.original.lastAccessedAt),
      meta: { title: t('tokens.colLastAccess'), width: '112px' }
    },
    {
      accessorKey: 'revokedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colStatus') }),
      cell: ({ row }) => renderComponent(ShareLinkStatusCell, { token: row.original }),
      meta: { title: t('tokens.colStatus'), width: '92px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        renderComponent(ShareLinkRowActions, {
          tokenId: row.original.id,
          actions: [
            // View activity stays available on revoked/expired links too —
            // access history deliberately survives revocation.
            {
              key: 'activity',
              label: t('tokens.actionViews'),
              icon: Activity,
              onclick: () => openPanel(row.original)
            },
            ...actionsFor(row.original)
          ]
        }),
      meta: { width: '116px' }
    }
  ]);

  const columnId = (column: ColumnDef<ShareToken, unknown>) =>
    ('accessorKey' in column ? String(column.accessorKey) : (column.id ?? '')) as LinkColumnId;
  const columns = $derived(allColumns.filter((column) => !hidden.includes(columnId(column))));
  // Every column carries a width; the table is never narrower than their sum
  // (a narrower host scrolls it sideways), and never wider than it has to be.
  const minWidth = $derived(
    columns.reduce((sum, column) => sum + parseInt(column.meta?.width ?? '0', 10), 0)
  );
</script>

{#snippet toolbarActions()}
  {#if own}
    <ShareLinkColumnsMenu view={own} class="h-8" />
  {/if}
  {@render actions?.()}
{/snippet}

{#if list.loading}
  <TableSkeleton columns={10} rows={2} />
{:else if list.error && !tokens.length}
  <p class="text-sm text-destructive" in:appear>{t('tokens.loadFailed', { error: list.error })}</p>
{:else}
  <!-- the count says how many links still open, out of how many; with none
       yet the table still stands, its heads over one quiet row -->
  <div class="links" style="--links-min: {minWidth}px">
    <DataTable
      data={tokens}
      {columns}
      count={tokens.length
        ? () => t('tokens.countLine', { active: activeCount, total: tokens.length })
        : undefined}
      actions={toolbarActions}
      emptyMessage={t('tokens.empty')}
      showViewOptions={false}
      showPagination={false}
      pageSize={200}
      sticky={false}
      tableClass="links-table"
      onRowClick={openPanel}
    />
  </div>
  {#if list.nextCursor}
    <div class="flex justify-center py-2" transition:reveal>
      <Button variant="outline" size="sm" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<ShareLinkPanel
  {deckId}
  token={panelToken}
  actions={panelToken ? actionsFor(panelToken) : []}
  onClose={() => (panelTokenId = null)}
/>

<FormDialog
  bind:open={showVersionDialog}
  title={t('tokens.versionDialogTitle')}
  description={t('tokens.versionDialogDescription', { name: versionTarget?.name ?? '' })}
  onClose={() => {
    showVersionDialog = false;
    versionTarget = null;
  }}
  onSubmit={() => void submitVersionChange()}
  loading={versionLoading}
  submitLabel={t('common.save')}
>
  <div class="space-y-2">
    <Label for="edit-version-mode">{t('tokens.versionLabel')}</Label>
    <Select.Root
      type="single"
      value={editVersionMode}
      onValueChange={(v) => {
        if (v === 'latest' || v === 'pinned') editVersionMode = v;
      }}
    >
      <Select.Trigger id="edit-version-mode" class="w-full">
        {editVersionMode === 'latest' ? t('tokens.versionLatest') : t('tokens.versionPinned')}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="latest" label={t('tokens.versionLatest')} />
        <Select.Item value="pinned" label={t('tokens.versionPinned')} disabled={!versions.length} />
      </Select.Content>
    </Select.Root>
  </div>
  <Reveal open={editVersionMode === 'pinned'}>
    <div class="space-y-2">
      <Label for="edit-pinned-version">{t('tokens.colVersion')}</Label>
      <Select.Root
        type="single"
        value={editPinnedVersion}
        onValueChange={(v) => {
          if (v) editPinnedVersion = v;
        }}
      >
        <Select.Trigger id="edit-pinned-version" class="w-full">
          {editPinnedVersion ? `v${editPinnedVersion}` : '—'}
        </Select.Trigger>
        <Select.Content>
          {#each versions as version (version.version)}
            <Select.Item value={String(version.version)} label={`v${version.version}`} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  </Reveal>
</FormDialog>

<ConfirmDialog
  bind:open={showRevokeDialog}
  title={t('tokens.revokeConfirmTitle')}
  description={t('tokens.revokeConfirmDescription', { name: revokeTarget?.name ?? '' })}
  confirmLabel={t('tokens.actionRevoke')}
  onClose={() => {
    showRevokeDialog = false;
    revokeTarget = null;
  }}
  onConfirm={() => void submitRevoke()}
  loading={revokeLoading}
/>

<style>
  /* every column has a width: the table is at least their sum */
  .links :global(.links-table) {
    min-width: var(--links-min);
  }
  /* A link that no longer opens is read as such before any word: its row is
     faded. The name cell keeps its ink (it carries the state tag) and so do
     the row's buttons. */
  .links :global(tr:has([data-link-state='revoked'], [data-link-state='expired']) > td) {
    transition: opacity var(--motion-duration) var(--motion-ease);
  }
  .links
    :global(
      tr:has([data-link-state='revoked'], [data-link-state='expired'])
        > td:not([data-actions-cell]):not(:has([data-link-state]))
    ) {
    opacity: 0.42;
  }
  /* on a phone a link that no longer opens folds to its name and its state:
     the rest is one tap away, in its panel */
  .links :global(li:has([data-link-state='revoked'], [data-link-state='expired']) > dl) {
    display: none;
  }
  /* the row opens the link: the name answers the pointer anywhere on it */
  @media (hover: hover) {
    .links :global(tbody tr:hover [data-link-state='active'] [data-testid='link-open-panel']) {
      text-decoration-line: underline;
      text-decoration-color: color-mix(in oklab, var(--accent) 70%, transparent);
      text-underline-offset: 3px;
    }
  }
</style>
