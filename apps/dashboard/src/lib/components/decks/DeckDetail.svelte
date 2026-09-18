<script lang="ts">
  import PatternCanvas from '$lib/components/brand/PatternCanvas.svelte';
  import { DECK_PALETTES, DECK_PATTERNS } from '$lib/brand/recipe.js';
  import { seedOf } from '$lib/brand/seed';
  import { onDestroy } from 'svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Presentation from '@lucide/svelte/icons/presentation';
  import ShareTokensPanel from './ShareTokensPanel.svelte';
  import CollaboratorsPanel from './CollaboratorsPanel.svelte';
  import AnnotationsPanel from './AnnotationsPanel.svelte';
  import FormResponsesPanel from './FormResponsesPanel.svelte';
  import VersionsPanel from './VersionsPanel.svelte';
  import DeckMetaPanel from './DeckMetaPanel.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { kindLabel, PREVIEW_SANDBOX } from '$lib/decks';
  import { canPreviewDeck, createPreviewController } from '$lib/decks/preview.svelte';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { deckMasterPath } from '@slideless/contract';
  import type {
    MeResponse,
    Presentation as Deck,
    PresentationVersion,
    ShareToken
  } from '@slideless/contract';

  /** Mounted under {#key deckId} — a deck switch remounts this component. */
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
  // The token lifecycle is the shared controller ($lib/decks/preview): one
  // preview path for this page and the master page (PRDCT-2279).
  const canPreview = $derived(canPreviewDeck(me, deck));
  const preview = createPreviewController(deckId, {
    canPreview: () => canPreview,
    onSelectError: (message) => toast.error(message)
  });

  async function initPreview() {
    if (!deck) return;
    await preview.init(deck);
  }

  onDestroy(() => preview.destroy());

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

  let bannerPlayed = $state(false);
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
      <!-- The deck's banner (PRDCT-2439): the same plate its card carries on
           the decks page, so a deck keeps one face from the list to its page. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="banner plate-window"
        onpointerenter={() => (bannerPlayed = true)}
        onpointerleave={() => (bannerPlayed = false)}
      >
        <div class="absolute inset-0">
          <PatternCanvas
            pattern={DECK_PATTERNS[deck.kind] ?? 'slides'}
            palette={DECK_PALETTES[seedOf(deck.id) % DECK_PALETTES.length]}
            seed={seedOf(deck.id)}
            active={bannerPlayed}
          />
        </div>
        <div class="relative flex items-center justify-between gap-4">
          <a href="/decks" class="chip">
            <ArrowLeft class="h-3.5 w-3.5" />
            {t('deck.backToDecks')}
          </a>
          <!-- The deck's own page (PRDCT-2279): the presentation full-page with
               the artifact bar, at the path the CLI opens after a push. -->
          <a href={deckMasterPath(deck.id)} class="chip">
            <Presentation class="h-4 w-4" />
            {t('deck.openMaster')}
          </a>
        </div>
        <!-- SECURITY: the deck title is USER-AUTHORED — Svelte {…} interpolation
             renders it as escaped text. NEVER switch this to {@html}. -->
        <h2
          class="on-field relative mt-auto font-display text-[28px] font-light leading-[1.1] tracking-[-0.015em] md:text-[38px]"
        >
          {deck.title}
        </h2>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
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
          {#if preview.version !== null && deck.currentVersion > 0}
            ·
            {preview.version === deck.currentVersion
              ? t('deck.previewLatest', { n: preview.version })
              : t('deck.previewPinned', { n: preview.version })}
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
        {:else if preview.error}
          <p class="text-sm text-destructive">{t('deck.previewFailed', { error: preview.error })}</p>
        {:else if !preview.url}
          <div class="flex h-[480px] w-full items-center justify-center rounded-md border">
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
      previewedVersion={preview.version}
      onPreview={(version) => void preview.select(version)}
    />
  </div>
{/if}

<style>
  .banner {
    display: flex;
    flex-direction: column;
    gap: 28px;
    min-height: 170px;
    padding: 14px 16px 18px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  @media (min-width: 768px) {
    .banner {
      min-height: 200px;
      padding: 16px 22px 24px;
    }
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h-sm);
    padding: 0 12px;
    border-radius: 999px;
    background: var(--plate-strong);
    border: 1px solid var(--plate-edge);
    font-size: 13px;
    color: var(--ink-soft);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    transition: background-color var(--motion-duration) var(--motion-ease);
  }
  .chip:hover {
    background: var(--ground);
    color: var(--ink);
  }
</style>
