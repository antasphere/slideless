<script lang="ts">
  import FieldCanvas from '$lib/components/brand/FieldCanvas.svelte';
  import { DECK_PALETTES, PALETTES, RECIPE } from '$lib/brand/recipe.js';
  import { seedOf } from '$lib/brand/seed';
  import { paletteFor, theme } from '$lib/theme.svelte';
  import { crumbs } from '$lib/crumbs.svelte';
  import { onDestroy } from 'svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Tag, type TagTone } from '$lib/components/ui/tag/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Presentation from '@lucide/svelte/icons/presentation';
  import AppWindow from '@lucide/svelte/icons/app-window';
  import FileText from '@lucide/svelte/icons/file-text';
  import MousePointerClick from '@lucide/svelte/icons/mouse-pointer-click';
  import ShareTokensPanel from './ShareTokensPanel.svelte';
  import CollaboratorsPanel from './CollaboratorsPanel.svelte';
  import AnnotationsPanel from './AnnotationsPanel.svelte';
  import FormResponsesPanel from './FormResponsesPanel.svelte';
  import VersionsPanel from './VersionsPanel.svelte';
  import DeckMetaPanel from './DeckMetaPanel.svelte';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import DeckFact from './DeckFact.svelte';
  import DeckBannerDrawing from './drawings/DeckBannerDrawing.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { kindLabel, PREVIEW_SANDBOX } from '$lib/tool/decks';
  import { canPreviewDeck, createPreviewController } from '$lib/tool/decks/preview.svelte';
  import { formatDateTime, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { deckMasterPath } from '@slideless/contract';
  import type { Component } from 'svelte';
  import type {
    MeResponse,
    Presentation as Deck,
    PresentationKind,
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
  // The token lifecycle is the shared controller ($lib/tool/decks/preview): one
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

  // The preview's description names the version in the frame once one is.
  const previewDescription = $derived.by(() => {
    const base = t('deck.previewDescription');
    if (!deck || preview.version === null || deck.currentVersion < 1) return base;
    const which =
      preview.version === deck.currentVersion
        ? t('deck.previewLatest', { n: preview.version })
        : t('deck.previewPinned', { n: preview.version });
    return `${base} · ${which}`;
  });

  // ── The banner and the facts under it ──────────────────────────────────
  // The banner is still: the field the deck's card carries on the decks page
  // (same seed, same palette), with one drawing of the deck's kind on it.
  $effect(() => theme.start());
  const bannerPalette = $derived(
    deck ? paletteFor(DECK_PALETTES[seedOf(deck.id) % DECK_PALETTES.length], theme.dark, PALETTES) : 'dawn'
  );

  const KIND_TAGS: Record<PresentationKind, { tone: TagTone; icon: Component }> = {
    presentation: { tone: 'clay', icon: Presentation },
    app: { tone: 'indigo', icon: AppWindow },
    plan: { tone: 'green', icon: FileText }
  };

  // The shell's path bar reads `Decks / <title>` once the banner has scrolled
  // away. The title is user-authored: the bar renders it as text.
  $effect(() => {
    if (!deck) return;
    crumbs.set([{ label: deck.title }]);
    return () => crumbs.clear();
  });
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
  <p class="text-sm text-destructive" in:appear>{t('deck.loadFailed', { error: deckError ?? '' })}</p>
{:else}
  <div class="space-y-6">
    <div>
      <!-- The deck's banner (PRDCT-2439): the field its card carries on the
           decks page, so a deck keeps one face from the list to its page.
           Still: a ground, one drawing of the deck's kind, the title. -->
      <div class="banner plate-window" data-page-head>
        <div class="absolute inset-0">
          <FieldCanvas palette={bannerPalette} shape={RECIPE.shape} seed={seedOf(deck.id)} linework={false} />
        </div>
        <div class="banner-art"><DeckBannerDrawing kind={deck.kind} /></div>
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
          class="banner-title on-field relative mt-auto font-display text-[28px] font-light leading-[1.1] tracking-[-0.015em] md:text-[38px]"
        >
          {deck.title}
        </h2>
      </div>
      <!-- The deck's facts, five small cards in the overview's spirit
           (DeckFact): the value, its name, a drawing of the thing. All five
           on a desk; on a phone the kind alone, then two to a line. -->
      <div class="deck-facts" role="group" aria-label={t('deck.factsAria')}>
        <DeckFact label={t('decks.colKind')} drawing="decks">
          <Tag label={kindLabel(deck.kind)} {...KIND_TAGS[deck.kind] ?? KIND_TAGS.presentation} />
          {#if deck.interactive}
            <Tag label={t('decks.badgeInteractive')} tone="amber" icon={MousePointerClick} />
          {/if}
        </DeckFact>
        {#if deck.currentVersion > 0}
          <DeckFact label={t('decks.colVersion')} value={`v${deck.currentVersion}`} figure drawing="fresh" />
        {:else}
          <DeckFact label={t('decks.colVersion')} value={t('deck.versionNone')} muted drawing="fresh" />
        {/if}
        <!-- SECURITY: ownerLabel may be a member email (user text) — DeckFact
             renders it through escaped text interpolation only. -->
        <DeckFact label={t('deck.labelOwner')} value={ownerLabel} drawing="owner" />
        <DeckFact label={t('deck.labelTotalViews')} value={String(deck.totalViews)} figure drawing="opens" />
        <DeckFact
          label={t('deck.labelUpdated')}
          value={formatTimeAgo(deck.updatedAt)}
          title={formatDateTime(deck.updatedAt)}
          drawing="updated"
        />
      </div>
    </div>

    <Card.Root>
      <DeckSectionHeading drawing="preview" title={t('deck.previewTitle')} description={previewDescription} />
      <Card.Content>
        {#if deck.currentVersion < 1}
          <p class="text-sm text-muted-foreground">{t('deck.previewEmpty')}</p>
        {:else if !canPreview}
          <!-- Preview tokens are hidden + stat-excluded, so minting them is
               owner/admin only (never a dev collaborator) — see ADR 012. -->
          <p class="text-sm text-muted-foreground">{t('deck.previewOwnerOnly')}</p>
        {:else if preview.error}
          <p class="text-sm text-destructive" in:appear>
            {t('deck.previewFailed', { error: preview.error })}
          </p>
        {:else if !preview.url}
          <div
            class="flex h-[320px] w-full items-center justify-center rounded-[8px] border border-dashed border-[var(--hairline)] md:h-[480px]"
          >
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
              class="h-[320px] w-full rounded-[8px] border border-[var(--hairline)] bg-background md:h-[480px]"
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

    <!-- Room at the foot, so the last section can scroll up under the bars,
         closed by the deck's own drawing set very light. -->
    <div class="deck-foot" aria-hidden="true">
      <div class="deck-foot-art"><DeckBannerDrawing kind={deck.kind} /></div>
    </div>
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
  /* the drawing sits at the right of the field, under the chips' line; the
     title keeps clear of it on a desk and may cross its faded edge on a phone */
  .banner-art {
    position: absolute;
    right: 8px;
    bottom: 6px;
    width: 150px;
    aspect-ratio: 200 / 132;
    opacity: 0.8;
    pointer-events: none;
  }
  @media (min-width: 768px) {
    .banner-art {
      right: 40px;
      bottom: 12px;
      width: 210px;
      opacity: 1;
    }
    .banner-title {
      max-width: calc(100% - 260px);
    }
  }
  .deck-facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }
  /* the kind's card carries tags, which need the width: on a phone it has
     the first line to itself, and the four others pair up under it */
  @media (max-width: 767px) {
    .deck-facts > :global(:first-child) {
      grid-column: 1 / -1;
    }
  }
  @media (min-width: 768px) {
    .deck-facts {
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 1.4fr) minmax(0, 0.9fr) minmax(
          0,
          1fr
        );
      gap: 12px;
      margin-top: 14px;
    }
  }
  .deck-foot {
    display: flex;
    justify-content: center;
    padding: 28px 0 0;
    min-height: 96px;
  }
  @media (min-width: 768px) {
    .deck-foot {
      padding-top: 44px;
      min-height: 160px;
    }
  }
  .deck-foot-art {
    width: 120px;
    aspect-ratio: 200 / 132;
    opacity: 0.22;
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
