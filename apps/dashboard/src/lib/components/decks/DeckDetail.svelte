<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ShareTokensPanel from './ShareTokensPanel.svelte';
  import CollaboratorsPanel from './CollaboratorsPanel.svelte';
  import AnnotationsPanel from './AnnotationsPanel.svelte';
  import FormResponsesPanel from './FormResponsesPanel.svelte';
  import VersionsPanel from './VersionsPanel.svelte';
  import DeckMetaPanel from './DeckMetaPanel.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { kindLabel, PREVIEW_SANDBOX } from '$lib/decks';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { MeResponse, Presentation, PresentationVersion, ShareToken } from '@slideless/contract';

  /** Mounted under {#key deckId} — a deck switch remounts this component. */
  interface Props {
    deckId: string;
    me: MeResponse;
  }

  let { deckId, me }: Props = $props();

  // ── Deck + child collections ───────────────────────────────────────────
  let deck = $state<Presentation | null>(null);
  let deckError = $state<string | null>(null);
  let notFound = $state(false);
  let loading = $state(true);

  const versionsList = createPagedList<PresentationVersion>(async (p) => {
    const { versions, nextCursor } = await api.presentationVersions(deckId, p);
    return { items: versions, nextCursor };
  });
  const tokensList = createPagedList<ShareToken>(async (p) => {
    const { shareTokens, nextCursor } = await api.shareTokens(deckId, p);
    return { items: shareTokens, nextCursor };
  });

  // Member emails resolve owner + annotation-author ids (best-effort).
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
    // The roster is guest-forbidden (D2, 403 guest_forbidden) — a guest's
    // ids fall back to their shortened form instead of a doomed fetch.
    if (me.origin !== 'guest') void loadMembers();
    await Promise.all([versionsList.load(), tokensList.load()]);
    void initPreview();
  }

  // ── Sandboxed preview (ADR 012 Surface D) ──────────────────────────────
  // The viewer only speaks share tokens, so the page mints a TRANSIENT
  // preview token through the dedicated endpoint (server-fixed: purpose
  // 'preview', 1 h expiry, no annotations) and revokes it on the way out.
  // Its secret lives only in this component's memory. Preview minting is
  // OWNER-LEVEL (deck owner / workspace admin) — a dev collaborator gets a
  // quiet placeholder instead, never a hidden stat-excluded token. Preview
  // tokens are immutable server-side: switching versions mints a fresh one.
  let previewUrl = $state<string | null>(null);
  let previewError = $state<string | null>(null);
  let previewedVersion = $state<number | null>(null);
  let previewKey = $state(0);
  let previewTokenId: string | null = null;

  const canPreview = $derived(me.role === 'owner' || me.role === 'admin' || deck?.ownerUserId === me.user.id);

  async function mintPreview(version?: number) {
    // Each mint produces its own short-lived token (secrets are
    // unrecoverable — hash-only storage — so reuse is impossible). Other
    // sessions' live previews are never revoked from here; the 1 h expiry
    // is the cleanup. Preview tokens are hidden from the panel and
    // excluded from view stats (purpose column, server-set).
    const created = await api.createPreviewToken(deckId, version !== undefined ? { version } : {});
    const staleId = previewTokenId;
    previewTokenId = created.shareToken.id;
    previewUrl = created.url;
    if (staleId) api.revokeShareToken(deckId, staleId).catch(() => {});
  }

  async function initPreview() {
    if (!deck || deck.currentVersion < 1 || !canPreview) return;
    try {
      await mintPreview();
      previewedVersion = deck.currentVersion;
    } catch (e) {
      previewError = errorMessage(e, t('common.genericError'));
    }
  }

  async function selectPreviewVersion(version: number) {
    if (!previewTokenId || version === previewedVersion) return;
    try {
      await mintPreview(version);
      previewedVersion = version;
      previewKey += 1; // Remount the iframe — the viewer entry is no-store.
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.updateFailed')));
    }
  }

  onDestroy(() => {
    // Best-effort: the token also self-expires after its server-set 1 h TTL.
    if (previewTokenId) {
      api.revokeShareToken(deckId, previewTokenId).catch(() => {});
      previewTokenId = null;
    }
  });

  // ── Derived display state ──────────────────────────────────────────────
  const canManageCollaborators = $derived(
    me.role === 'owner' || me.role === 'admin' || deck?.ownerUserId === me.user.id
  );

  const ownerLabel = $derived.by(() => {
    if (!deck) return '';
    if (!deck.ownerUserId) return t('deck.ownerDeleted');
    if (deck.ownerUserId === me.user.id) return t('deck.ownerYou');
    return memberLabels[deck.ownerUserId] ?? `${deck.ownerUserId.slice(0, 8)}…`;
  });

  function resolveUser(userId: string): string {
    if (userId === me.user.id) return me.user.email;
    return memberLabels[userId] ?? `${userId.slice(0, 8)}…`;
  }
</script>

{#if loading}
  <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
{:else if notFound}
  <Card.Root class="mx-auto max-w-md">
    <Card.Header>
      <Card.Title class="text-base">{t('deck.notFound')}</Card.Title>
    </Card.Header>
    <Card.Content>
      <Button variant="outline" href="/decks">
        <ArrowLeft class="mr-2 h-4 w-4" />
        {t('deck.backToDecks')}
      </Button>
    </Card.Content>
  </Card.Root>
{:else if deckError || !deck}
  <p class="text-sm text-destructive">{t('deck.loadFailed', { error: deckError ?? '' })}</p>
{:else}
  <div class="space-y-6">
    <div>
      <a
        href="/decks"
        class="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft class="h-3.5 w-3.5" />
        {t('deck.backToDecks')}
      </a>
      <!-- SECURITY: the deck title is USER-AUTHORED — Svelte {…} interpolation
           renders it as escaped text. NEVER switch this to {@html}. -->
      <h2 class="text-2xl font-semibold tracking-tight">{deck.title}</h2>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="secondary">{kindLabel(deck.kind)}</Badge>
        {#if deck.interactive}
          <Badge variant="outline">{t('decks.badgeInteractive')}</Badge>
        {/if}
        <Badge variant="outline">
          {deck.currentVersion > 0 ? `v${deck.currentVersion}` : t('deck.versionNone')}
        </Badge>
        <span>·</span>
        <!-- SECURITY: ownerLabel may be a member email (user text) — escaped
             text interpolation only. -->
        <span>{t('deck.labelOwner')}: {ownerLabel}</span>
        <span>·</span>
        <span>{t('deck.labelTotalViews')}: {deck.totalViews}</span>
        <span>·</span>
        <span>{t('deck.labelUpdated')}: {formatTimeAgo(deck.updatedAt)}</span>
      </div>
      <Separator class="mt-4" />
    </div>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">{t('deck.previewTitle')}</Card.Title>
        <Card.Description>
          {t('deck.previewDescription')}
          {#if previewedVersion !== null && deck.currentVersion > 0}
            ·
            {previewedVersion === deck.currentVersion
              ? t('deck.previewLatest', { n: previewedVersion })
              : t('deck.previewPinned', { n: previewedVersion })}
          {/if}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if deck.currentVersion < 1}
          <p class="text-sm text-muted-foreground">{t('deck.previewEmpty')}</p>
        {:else if !canPreview}
          <!-- Preview tokens are hidden + stat-excluded, so minting them is
               owner/admin only (never a dev collaborator) — see ADR 012. -->
          <p class="text-sm text-muted-foreground">{t('deck.previewOwnerOnly')}</p>
        {:else if previewError}
          <p class="text-sm text-destructive">{t('deck.previewFailed', { error: previewError })}</p>
        {:else if !previewUrl}
          <div class="flex h-[480px] w-full items-center justify-center rounded-md border">
            <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
          </div>
        {:else}
          {#key previewKey}
            <!-- SECURITY (ADR 012 Surface D): user-authored deck HTML renders
                 ONLY inside this sandboxed iframe. The sandbox attribute must
                 NEVER gain `allow-same-origin` (that single token re-opens
                 full session theft, ADR 012 Surface C) and never
                 `allow-top-navigation*`. Deck HTML must never be rendered
                 into the dashboard DOM directly ({@html}, srcdoc, etc.). -->
            <iframe
              src={previewUrl}
              title={t('deck.previewTitle')}
              sandbox={PREVIEW_SANDBOX}
              referrerpolicy="no-referrer"
              allow="fullscreen"
              class="h-[480px] w-full rounded-md border bg-background"
              data-testid="deck-preview"
            ></iframe>
          {/key}
        {/if}
      </Card.Content>
    </Card.Root>

    <DeckMetaPanel {deck} />

    <ShareTokensPanel {deckId} list={tokensList} versions={versionsList.items} />

    <CollaboratorsPanel {deckId} canManage={canManageCollaborators} />

    <AnnotationsPanel {deckId} versions={versionsList.items} {resolveUser} />

    <FormResponsesPanel {deckId} />

    <VersionsPanel
      list={versionsList}
      currentVersion={deck.currentVersion}
      {previewedVersion}
      onPreview={(version) => void selectPreviewVersion(version)}
    />
  </div>
{/if}
