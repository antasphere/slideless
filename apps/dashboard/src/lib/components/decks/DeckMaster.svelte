<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { LinkPreview } from 'bits-ui';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CopyPlus from '@lucide/svelte/icons/copy-plus';
  import Download from '@lucide/svelte/icons/download';
  import Eye from '@lucide/svelte/icons/eye';
  import History from '@lucide/svelte/icons/history';
  import Layers from '@lucide/svelte/icons/layers';
  import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Share2 from '@lucide/svelte/icons/share-2';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import ShareLinksTable from './share/ShareLinksTable.svelte';
  import ShareLinkCreateDialog from './share/ShareLinkCreateDialog.svelte';
  import VersionHistorySheet from './VersionHistorySheet.svelte';
  import VersionList from './VersionList.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { PREVIEW_SANDBOX } from '$lib/decks';
  import {
    canPreviewDeck,
    createPreviewController,
    createThumbnailController
  } from '$lib/decks/preview.svelte';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { deckMasterPath } from '@slideless/contract';
  import type {
    Attachment,
    MeResponse,
    Presentation as Deck,
    PresentationVersionSummary,
    ShareToken
  } from '@slideless/contract';

  /**
   * The deck's master page (PRDCT-2279): the presentation full-page under a
   * slim bar, on the APP origin behind the session cookie. The bar is the
   * owner's: rename, duplicate, share (links are made here, on top of the
   * deck), the version history with each version's files, delete; on the
   * right the shown version's files, the views and the version badge. The
   * deck itself renders through the same sandboxed preview the admin page
   * uses (one preview path, ADR 012 Surface D) — never in this DOM.
   *
   * The version history (PRDCT-2308) is two popovers and a sheet: hovering
   * [[Version history]] in the title menu opens the versions beside it,
   * newest first, each with a live thumbnail, its files, its views and its
   * downloads; hovering the version badge on the right opens the same list;
   * picking a version shows it in the frame. The sheet, opened from the
   * sub-menu's last item, is the long form with each version's files, and
   * closes by itself on [[Show]].
   *
   * Who sees what: rename, share and delete are the deck administrator's
   * (owner, workspace admin/owner); a dev collaborator gets the read-only
   * bar. The page only HIDES — every act is enforced server-side (canWrite /
   * canAdministerDeck, 404 never 403 on a failed read).
   *
   * Mounted under {#key deckId} — a deck switch remounts this component.
   */
  interface Props {
    deckId: string;
    me: MeResponse;
  }

  let { deckId, me }: Props = $props();

  // ── Deck + child collections ───────────────────────────────────────────
  let deck = $state<Deck | null>(null);
  let deckError = $state<string | null>(null);
  let notFound = $state(false);
  let loading = $state(true);

  const versionsList = createPagedList<PresentationVersionSummary>(async (p) => {
    const { versions, nextCursor } = await api.presentationVersions(deckId, p);
    return { items: versions, nextCursor };
  });
  const tokensList = createPagedList<ShareToken>(async (p) => {
    const { shareTokens, nextCursor } = await api.shareTokens(deckId, p);
    return { items: shareTokens, nextCursor };
  });

  // Member emails resolve the owner id (best-effort; guest-forbidden roster).
  let memberLabels = $state<Record<string, string>>({});
  async function loadMembers() {
    try {
      const { members } = await api.members({ limit: 100 });
      memberLabels = Object.fromEntries(members.map((m) => [m.userId, m.email]));
    } catch {
      // Roster unavailable — ids fall back to a shortened form.
    }
  }

  $effect(() => {
    void initialize();
  });

  async function initialize() {
    try {
      deck = await api.presentation(deckId);
    } catch (e) {
      // ADR 013: unreadable decks answer 404 — existence is not probeable.
      if (e instanceof PlatformApiError && e.status === 404) {
        notFound = true;
      } else {
        deckError = errorMessage(e, t('common.genericError'));
      }
      loading = false;
      return;
    }
    loading = false;
    if (me.origin !== 'guest') void loadMembers();
    await Promise.all([versionsList.load(), canAdminister ? tokensList.load() : Promise.resolve()]);
    if (deck) await preview.init(deck);
  }

  // ── Capabilities (the page hides; the server rules) ───────────────────
  const canAdminister = $derived(
    me.role === 'owner' || me.role === 'admin' || (deck !== null && deck.ownerUserId === me.user.id)
  );
  // Deck creation is a workspace-level act: guests never get it (D2).
  const canDuplicate = $derived(me.origin !== 'guest');
  const hasVersion = $derived(deck !== null && deck.currentVersion > 0);
  // Read inside snippets, where the template's null narrowing does not reach.
  const title = $derived(deck?.title ?? '');
  const canPreview = $derived(canPreviewDeck(me, deck));

  // ── The frame (shared preview controller) ──────────────────────────────
  const preview = createPreviewController(deckId, {
    canPreview: () => canPreview,
    onSelectError: (message) => toast.error(message)
  });
  // The version popovers' and the sheet's thumbnails: one preview token per
  // version, minted when a row comes into view, all revoked with the page.
  const thumbs = createThumbnailController(deckId, { canPreview: () => canPreview });
  onDestroy(() => {
    preview.destroy();
    thumbs.destroy();
  });
  // The hover card on the version badge (bits-ui LinkPreview: hover intent
  // both ways, focus opens it too); a pick closes it.
  let badgeOpen = $state(false);

  /** The version the bar describes: the frame's, or the deck's current one before the first mint. */
  const shownVersion = $derived(
    preview.version ?? (deck && deck.currentVersion > 0 ? deck.currentVersion : null)
  );

  // The shown version's files, for the bar's Download menu (hidden when the
  // version carries none). One detail fetch per shown version; versions are
  // immutable so a fetched answer stays true.
  let attachmentsByVersion = $state<Record<number, Attachment[]>>({});
  const shownAttachments = $derived(shownVersion === null ? [] : (attachmentsByVersion[shownVersion] ?? []));
  $effect(() => {
    const v = shownVersion;
    if (v === null || v in attachmentsByVersion) return;
    const row = versionsList.items.find((r) => r.version === v);
    // Only the current version is known before the list arrives; its flag
    // rides the deck row. A version without files needs no fetch.
    const hasDownloads = row ? row.hasDownloads : v === deck?.currentVersion ? deck.hasDownloads : false;
    if (!hasDownloads) return;
    api
      .presentationVersion(deckId, v)
      .then((detail) => {
        attachmentsByVersion = { ...attachmentsByVersion, [v]: detail.attachments };
      })
      .catch(() => {
        // The menu stays hidden; the history sheet reports its own error.
      });
  });

  // ── Owner label ────────────────────────────────────────────────────────
  const ownerLabel = $derived.by(() => {
    if (!deck) return '';
    if (!deck.ownerUserId) return t('deck.ownerDeleted');
    if (deck.ownerUserId === me.user.id) return t('deck.ownerYou');
    return memberLabels[deck.ownerUserId] ?? `${deck.ownerUserId.slice(0, 8)}…`;
  });

  // ── Rename (inline, in the bar) ────────────────────────────────────────
  let renaming = $state(false);
  let renameValue = $state('');
  let renameLoading = $state(false);
  let renameInput = $state<HTMLInputElement | null>(null);

  function startRename() {
    if (!deck) return;
    renameValue = deck.title;
    renaming = true;
    queueMicrotask(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  }

  async function submitRename() {
    if (!deck) return;
    const title = renameValue.trim();
    if (!title || title === deck.title) {
      renaming = false;
      return;
    }
    renameLoading = true;
    try {
      deck = await api.updatePresentation(deckId, { title });
      renaming = false;
      toast.success(t('master.renamedToast'));
    } catch (e) {
      toast.error(errorMessage(e, t('master.renameFailed')));
    } finally {
      renameLoading = false;
    }
  }

  // ── Duplicate ──────────────────────────────────────────────────────────
  let duplicating = $state(false);

  async function duplicate() {
    if (duplicating) return;
    duplicating = true;
    try {
      // One click, one copy: the key makes a network-blip retry land on the
      // same deck instead of minting a second one.
      const { presentation: copy } = await api.duplicatePresentation(
        deckId,
        {},
        { idempotencyKey: crypto.randomUUID() }
      );
      toast.success(t('master.duplicatedToast', { title: copy.title }));
      await goto(deckMasterPath(copy.id));
    } catch (e) {
      toast.error(errorMessage(e, t('master.duplicateFailed')));
    } finally {
      duplicating = false;
    }
  }

  // ── Share sheet ────────────────────────────────────────────────────────
  let shareOpen = $state(false);
  let showCreateDialog = $state(false);

  // ── Version history sheet ──────────────────────────────────────────────
  let historyOpen = $state(false);

  // ── Delete ─────────────────────────────────────────────────────────────
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);

  async function submitDelete() {
    if (!deck) return;
    deleteLoading = true;
    try {
      await api.deletePresentation(deckId);
      toast.success(t('master.deletedToast', { title: deck.title }));
      showDeleteDialog = false;
      await goto('/decks');
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      deleteLoading = false;
    }
  }
</script>

{#if loading}
  <div class="flex flex-1 items-center justify-center">
    <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
  </div>
{:else if notFound}
  <div class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
    <p class="max-w-md text-sm text-muted-foreground">{t('deck.notFound')}</p>
    <Button variant="outline" href="/decks">{t('deck.backToDecks')}</Button>
  </div>
{:else if deckError || !deck}
  <div class="flex flex-1 items-center justify-center p-8">
    <p class="text-sm text-destructive" in:appear>{t('deck.loadFailed', { error: deckError ?? '' })}</p>
  </div>
{:else}
  <header class="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3" data-testid="master-bar">
    <!-- Left: the title, a menu trigger; or the rename field. -->
    <div class="flex min-w-0 flex-1 items-center gap-2">
      {#if renaming}
        <form
          in:appear
          class="flex min-w-0 flex-1 items-center gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            void submitRename();
          }}
        >
          <Input
            bind:ref={renameInput}
            bind:value={renameValue}
            class="h-8 max-w-md"
            aria-label={t('master.renameLabel')}
            maxlength={300}
            required
            disabled={renameLoading}
            onkeydown={(e) => {
              if (e.key === 'Escape') renaming = false;
            }}
          />
          <Button type="submit" size="sm" disabled={renameLoading}>{t('common.save')}</Button>
          <Button type="button" size="sm" variant="ghost" onclick={() => (renaming = false)}>
            {t('common.cancel')}
          </Button>
        </form>
      {:else}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <!-- SECURITY: the deck title is USER-AUTHORED — escaped {…}
                   interpolation only. NEVER switch this to {@html}. -->
              <button
                {...props}
                in:appear
                class="flex min-w-0 items-center gap-1.5 rounded-btn px-2 py-1 text-left font-display text-base hover:bg-accent"
                data-testid="master-title"
              >
                <span class="truncate">{title}</span>
                <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" class="w-64">
            <DropdownMenu.Label class="font-normal">
              <!-- ownerLabel may be a member email (user text) — escaped only. -->
              <p class="truncate text-sm">{t('master.artifactBy', { owner: ownerLabel })}</p>
              <p class="text-xs text-muted-foreground">
                {t('master.updated', { when: formatTimeAgo(deck.updatedAt) })}
              </p>
            </DropdownMenu.Label>
            <DropdownMenu.Separator />
            {#if canAdminister}
              <DropdownMenu.Item onSelect={startRename}>
                <Pencil />
                {t('master.rename')}
              </DropdownMenu.Item>
            {/if}
            {#if canDuplicate}
              <DropdownMenu.Item onSelect={() => void duplicate()} disabled={duplicating || !hasVersion}>
                <CopyPlus />
                {duplicating ? t('master.duplicating') : t('master.duplicate')}
              </DropdownMenu.Item>
            {/if}
            {#if canAdminister}
              <DropdownMenu.Item onSelect={() => (shareOpen = true)}>
                <Share2 />
                {t('master.share')}
              </DropdownMenu.Item>
            {/if}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger data-testid="master-history-trigger">
                <History />
                {t('master.versionHistory')}
                <span class="text-xs text-muted-foreground">{deck.currentVersion}</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent class="w-auto p-1" data-testid="master-history-popover">
                <VersionList
                  list={versionsList}
                  {thumbs}
                  currentVersion={deck.currentVersion}
                  {shownVersion}
                  menu
                  onPick={(version) => void preview.select(version)}
                />
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => (historyOpen = true)} data-testid="master-history-full">
                  <History />
                  {t('master.historyFull')}
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
            <DropdownMenu.Item onSelect={() => void goto('/decks')}>
              <Layers />
              {t('master.allDecks')}
            </DropdownMenu.Item>
            {#if canAdminister}
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="text-destructive" onSelect={() => (showDeleteDialog = true)}>
                <Trash2 />
                {t('master.delete')}
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    </div>

    <!-- Right: the shown version's files, the views, the version, the escape. -->
    <div class="flex shrink-0 items-center gap-1.5">
      {#if shownVersion !== null && shownAttachments.length > 0}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="sm" data-testid="master-downloads">
                <Download class="h-4 w-4" />
                {t('master.downloadFiles')}
                <span class="text-muted-foreground">{shownAttachments.length}</span>
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-72">
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <a {...props} href={api.versionAttachmentsZipUrl(deckId, shownVersion)}>
                  <Download />
                  {t('master.downloadAll')}
                </a>
              {/snippet}
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {#each shownAttachments as file (file.path)}
              <!-- SECURITY: file names are DECK-AUTHORED text — escaped {} only. -->
              <DropdownMenu.Item>
                {#snippet child({ props })}
                  <a {...props} href={api.versionAttachmentUrl(deckId, shownVersion, file.name)}>
                    <span class="truncate font-mono text-xs">{file.name}</span>
                  </a>
                {/snippet}
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
      <span
        class="inline-flex items-center gap-1 px-2 text-sm text-muted-foreground"
        title={t('deck.labelTotalViews')}
        data-testid="master-views"
      >
        <Eye class="h-4 w-4" />
        {deck.totalViews}
      </span>
      {#if shownVersion !== null}
        {@const shownIsCurrent = shownVersion === deck.currentVersion}
        <LinkPreview.Root bind:open={badgeOpen} openDelay={150} closeDelay={200}>
          <LinkPreview.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                in:appear
                class="inline-flex rounded-[7px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('master.versionBadgeAria', { n: shownVersion })}
                data-testid="master-version"
              >
                <!-- keyed, so another version settles in rather than swapping in place -->
                {#key shownVersion}
                  <span class="inline-flex" in:appear>
                    <Badge variant={shownIsCurrent ? 'latest' : 'version'}>v{shownVersion}</Badge>
                  </span>
                {/key}
              </button>
            {/snippet}
          </LinkPreview.Trigger>
          <LinkPreview.Portal>
            <LinkPreview.Content
              side="bottom"
              align="end"
              sideOffset={6}
              class="float motion z-50 p-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
              data-testid="master-version-popover"
            >
              <VersionList
                list={versionsList}
                {thumbs}
                currentVersion={deck.currentVersion}
                {shownVersion}
                onPick={(version) => {
                  badgeOpen = false;
                  void preview.select(version);
                }}
              />
            </LinkPreview.Content>
          </LinkPreview.Portal>
        </LinkPreview.Root>
      {/if}
      <Button variant="ghost" size="sm" href={`/decks/${encodeURIComponent(deckId)}`}>
        <LayoutDashboard class="h-4 w-4" />
        {t('master.openDashboard')}
      </Button>
    </div>
  </header>

  <!-- The deck, filling the rest of the viewport. -->
  <div class="min-h-0 flex-1 bg-[color-mix(in_oklab,var(--ground-2)_60%,transparent)]">
    {#if deck.currentVersion < 1}
      <div class="flex h-full items-center justify-center p-8">
        <p class="max-w-md text-center text-sm text-muted-foreground">{t('deck.previewEmpty')}</p>
      </div>
    {:else if !canPreview}
      <!-- Preview tokens are hidden + stat-excluded, so minting them is
           owner/admin only (never a dev collaborator) — see ADR 012. -->
      <div class="flex h-full items-center justify-center p-8">
        <p class="max-w-md text-center text-sm text-muted-foreground">{t('master.previewOwnerOnly')}</p>
      </div>
    {:else if preview.error}
      <div class="flex h-full items-center justify-center p-8">
        <p class="text-sm text-destructive" in:appear>{t('deck.previewFailed', { error: preview.error })}</p>
      </div>
    {:else if !preview.url}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    {:else}
      {#key preview.key}
        <!-- SECURITY (ADR 012 Surface D): user-authored deck HTML renders
             ONLY inside this sandboxed iframe. The sandbox attribute must
             NEVER gain `allow-same-origin` (that single token re-opens
             full session theft, ADR 012 Surface C) and never
             `allow-top-navigation*`. Deck HTML must never be rendered
             into the dashboard DOM directly ({@html}, srcdoc, etc.). -->
        <iframe
          src={preview.url}
          title={deck.title}
          sandbox={PREVIEW_SANDBOX}
          referrerpolicy="no-referrer"
          allow="fullscreen"
          class="h-full w-full border-0 bg-background"
          data-testid="deck-preview"
        ></iframe>
      {/key}
    {/if}
  </div>

  <!-- Share sheet: the links list and the create flow, the same components
       as the admin page's share panel. -->
  <Sheet.Root bind:open={shareOpen}>
    <Sheet.Content
      side="right"
      class="flex w-full flex-col overflow-y-auto sm:max-w-5xl"
      data-testid="share-sheet"
    >
      <Sheet.Header>
        <Sheet.Title>{t('master.shareTitle')}</Sheet.Title>
        <Sheet.Description>{t('master.shareDescription')}</Sheet.Description>
      </Sheet.Header>
      <div>
        <Button size="sm" onclick={() => (showCreateDialog = true)}>
          <Plus class="mr-2 h-4 w-4" />
          {t('tokens.create')}
        </Button>
      </div>
      <ShareLinksTable {deckId} list={tokensList} versions={versionsList.items} />
    </Sheet.Content>
  </Sheet.Root>
  <ShareLinkCreateDialog
    {deckId}
    versions={versionsList.items}
    bind:open={showCreateDialog}
    onCreated={() => tokensList.refresh()}
  />

  <VersionHistorySheet
    {deckId}
    bind:open={historyOpen}
    list={versionsList}
    {thumbs}
    currentVersion={deck.currentVersion}
    {shownVersion}
    onShow={(version) => void preview.select(version)}
  />

  <ConfirmDialog
    bind:open={showDeleteDialog}
    title={t('master.deleteConfirmTitle')}
    description={t('master.deleteConfirmDescription', { title: deck.title })}
    confirmLabel={t('master.delete')}
    onClose={() => (showDeleteDialog = false)}
    onConfirm={() => void submitDelete()}
    loading={deleteLoading}
  />
{/if}
