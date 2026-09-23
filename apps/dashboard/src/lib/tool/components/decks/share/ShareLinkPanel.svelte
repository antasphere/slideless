<script lang="ts" module>
  import type { Component } from 'svelte';

  /** One act on a link. The table builds the list once; the row menu and this panel both call it. */
  export interface LinkAction {
    key: 'activity' | 'version' | 'uploads' | 'pdf' | 'revoke';
    label: string;
    onclick: () => void;
    variant?: 'default' | 'destructive';
    icon?: Component;
  }
</script>

<script lang="ts">
  /* One share link, opened from its row: who it is for and whether it still
     opens, its URL when this page knows it, what it lets a reader do, how
     much it was read, and every act the row's menu offers as a real button.
     A right-hand sheet at a desk, a bottom sheet on a phone.

     SECURITY: the link's name is USER-AUTHORED, and a view's referring host
     and placement label are VISITOR-INFLUENCED. All of them render through
     Svelte's escaped {…} interpolation only. NEVER switch any of it to
     {@html}. The URL comes from link-urls.svelte.ts (memory of this page
     load) and from nowhere else: a link made earlier has no URL to show, and
     the panel says so instead of building one. */
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { Tag } from '$lib/components/ui/tag/index.js';
  import ShareLinkVersionCell from './ShareLinkVersionCell.svelte';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';
  import Lock from '@lucide/svelte/icons/lock';
  import LockOpen from '@lucide/svelte/icons/lock-open';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import { api, errorMessage } from '$lib/api';
  import { tokenStatus } from '$lib/tool/decks';
  import { linkUrl } from '$lib/tool/decks/link-urls.svelte';
  import { formatDate, formatDateTime, formatTimeAgo } from '$lib/format';
  import { stateTag } from '$lib/tags';
  import { getLocale, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import type { ShareToken, ShareTokenView } from '@slideless/contract';

  interface Props {
    deckId: string;
    /** The link to show; null closes the panel. Always the list's live row, so a change reads back here. */
    token: ShareToken | null;
    actions: LinkAction[];
    onClose: () => void;
  }

  let { deckId, token: live, actions, onClose }: Props = $props();

  const phone = new IsMobile();

  // The sheet slides away AFTER its link is cleared: what it shows is the
  // last link it was given, so it never closes on an empty panel.
  let kept = $state<ShareToken | null>(null);
  $effect(() => {
    if (live) kept = live;
  });
  const token = $derived(live ?? kept);

  const status = $derived(token ? tokenStatus(token) : 'active');
  const stateSpec = $derived(
    status === 'active'
      ? stateTag(t('tokens.statusActive'), 'ok')
      : status === 'revoked'
        ? stateTag(t('tokens.statusRevoked'), 'bad')
        : stateTag(t('tokens.statusExpired'), 'wait')
  );
  const url = $derived(token ? linkUrl(token.id) : null);

  const capabilities = $derived(
    token
      ? [
          { key: 'notes', label: t('tokens.colNotes'), on: token.canAnnotate },
          { key: 'forms', label: t('tokens.colForms'), on: token.canSubmitForms },
          // Uploads need submissions: a link that refuses forms never shows them on.
          {
            key: 'uploads',
            label: t('tokens.colUploads'),
            on: token.canSubmitForms && token.canUploadFiles
          },
          { key: 'remembers', label: t('tokens.colRemembers'), on: token.remembersResponses },
          { key: 'downloads', label: t('tokens.colDownloads'), on: token.canDownload },
          { key: 'pdf', label: t('tokens.colPdf'), on: token.canExportPdf },
          { key: 'bar', label: t('tokens.colBar'), on: token.showBar }
        ]
      : []
  );

  // ── The link's counted views (PRDCT-1313) ──────────────────────────────
  // Loaded when a link opens in the panel, and again when its count moves.
  // Access history deliberately survives revocation, so a revoked link
  // still shows it.
  const VIEWS_PAGE = 100;
  let views = $state<ShareTokenView[]>([]);
  let viewsCursor = $state<string | null>(null);
  let viewsLoading = $state(false);
  let viewsLoadingMore = $state(false);
  let viewsError = $state<string | null>(null);
  let loadedFor = '';

  $effect(() => {
    const key = token ? `${token.id}:${token.accessCount}` : '';
    if (key === loadedFor) return;
    loadedFor = key;
    if (!token) return;
    void loadViews(token.id, key);
  });

  async function loadViews(tokenId: string, key: string) {
    views = [];
    viewsCursor = null;
    viewsError = null;
    viewsLoading = true;
    try {
      const page = await api.shareTokenViews(deckId, tokenId, { limit: VIEWS_PAGE });
      if (loadedFor !== key) return;
      views = page.views;
      viewsCursor = page.nextCursor;
    } catch (e) {
      if (loadedFor === key) viewsError = errorMessage(e);
    } finally {
      if (loadedFor === key) viewsLoading = false;
    }
  }

  async function loadMoreViews() {
    if (!token || !viewsCursor) return;
    const key = loadedFor;
    viewsLoadingMore = true;
    try {
      const page = await api.shareTokenViews(deckId, token.id, { limit: VIEWS_PAGE, cursor: viewsCursor });
      if (loadedFor !== key) return;
      views = [...views, ...page.views];
      viewsCursor = page.nextCursor;
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      viewsLoadingMore = false;
    }
  }

  // ── Opens by day, the last two weeks ───────────────────────────────────
  const DAYS = 14;
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const days = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const view of views) {
      const k = dayKey(new Date(view.occurredAt));
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const today = new Date();
    return Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1 - i));
      return { date: d, count: counts[dayKey(d)] ?? 0 };
    });
  });
  const peak = $derived(Math.max(1, ...days.map((d) => d.count)));
  const lastActive = $derived(days.reduce((last, d, i) => (d.count > 0 ? i : last), -1));
  const shortDay = (d: Date) => d.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
  const chartLabel = $derived(
    t('tokens.panelChartAria', {
      n: days.reduce((sum, d) => sum + d.count, 0),
      days: DAYS
    })
  );

  // the chart's geometry, in its own units
  const CW = 336;
  const CH = 64;
  const STEP = CW / DAYS;
  const BAR = 13;
  const barH = (count: number) => (count ? Math.max(5, (count / peak) * (CH - 16)) : 0);
</script>

<Sheet.Root open={live !== null} onOpenChange={(open) => !open && onClose()}>
  <Sheet.Content
    side={phone.current ? 'bottom' : 'right'}
    class="flex max-h-[90dvh] flex-col gap-0 p-0 max-md:rounded-t-2xl md:max-h-none md:w-[480px] md:max-w-[480px]"
    data-testid="share-link-panel"
  >
    {#if token}
      <Sheet.Header class="space-y-2 px-6 pb-4 pt-6 text-left">
        <p class="eyebrow">{t('tokens.panelEyebrow')}</p>
        <!-- SECURITY: the name is user-authored. Escaped text only. -->
        <Sheet.Title
          class="break-words pr-8 font-display text-[24px] font-normal leading-[1.15] tracking-[-0.01em] {status ===
          'active'
            ? ''
            : 'text-[var(--muted)]'}"
        >
          {token.name}
        </Sheet.Title>
        <Sheet.Description class="flex flex-wrap items-center gap-2">
          <Tag {...stateSpec} />
          <span>{t('tokens.panelCreated', { date: formatDate(token.createdAt) })}</span>
        </Sheet.Description>
      </Sheet.Header>

      <div class="body" data-panel-scroll>
        <!-- the URL, only when this page has it -->
        {#if url}
          <div class="url-row" data-testid="panel-url">
            <CodeBlock
              field
              code={url}
              ariaLabel={t('tokens.urlAria')}
              copyLabel={t('tokens.actionCopy')}
              copiedMessage={t('tokens.urlCopied')}
              class="flex-1"
            />
            <Button
              variant="ghost"
              size="icon"
              class="h-9 w-9 shrink-0"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('tokens.actionOpen')}
              aria-label={t('tokens.actionOpen')}
            >
              <ExternalLink class="h-4 w-4" />
            </Button>
          </div>
        {:else}
          <p class="url--none" data-testid="panel-url-unavailable">{t('tokens.urlUnavailable')}</p>
        {/if}

        <!-- the figures -->
        <dl class="figures">
          <div>
            <dd class="figure">{token.accessCount}</dd>
            <dt>{t('tokens.colViews')}</dt>
          </div>
          <!-- PRDCT-2670: an agent reading the link's index, never a view -->
          <div data-testid="panel-agent-reads">
            <dd class="figure">{token.agentReadCount}</dd>
            <dt>{t('tokens.agentReads')}</dt>
          </div>
          <div>
            <dd class="figure">{token.downloadCount}</dd>
            <dt>{t('tokens.colDownloads')}</dt>
          </div>
          <div>
            <dd class="figure figure--words">{formatTimeAgo(token.lastAccessedAt)}</dd>
            <dt>{t('tokens.colLastAccess')}</dt>
          </div>
        </dl>

        <!-- the facts -->
        <p class="eyebrow section">{t('tokens.panelSettings')}</p>
        <div class="facts rows">
          <div>
            <span>{t('tokens.colVersion')}</span>
            <span><ShareLinkVersionCell pinnedVersion={token.pinnedVersion} /></span>
          </div>
          <div>
            <span>{t('tokens.expiryLabel')}</span>
            <span>
              {#if !token.expiresAt}
                {t('tokens.expiryNever')}
              {:else if status === 'expired'}
                {t('tokens.panelExpiredOn', { date: formatDate(token.expiresAt) })}
              {:else}
                {t('tokens.expiresOn', { date: formatDate(token.expiresAt) })}
              {/if}
            </span>
          </div>
          {#if token.revokedAt}
            <div>
              <span>{t('tokens.statusRevoked')}</span>
              <span>{formatDateTime(token.revokedAt)}</span>
            </div>
          {/if}
          <div>
            <span>{t('tokens.panelPassword')}</span>
            <span>
              {#if token.hasPassword}
                <Tag label={t('tokens.passwordProtected')} tone="amber" icon={Lock} />
              {:else}
                <Tag label={t('tokens.panelNoPassword')} icon={LockOpen} />
              {/if}
            </span>
          </div>
          <div class="caps-row">
            <span>{t('tokens.panelAllows')}</span>
            <ul class="caps">
              {#each capabilities as cap (cap.key)}
                <li class:off={!cap.on} data-panel-capability={cap.key} data-on={cap.on ? '' : undefined}>
                  <span aria-hidden="true">
                    <Tag
                      label={cap.label}
                      tone={cap.on ? 'green' : 'neutral'}
                      icon={cap.on ? Check : Minus}
                    />
                  </span>
                  <span class="sr-only">
                    {t(cap.on ? 'tokens.capOn' : 'tokens.capOff', { name: cap.label })}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        </div>

        <!-- the activity -->
        <p class="eyebrow section">{t('tokens.viewsTitle')}</p>
        {#if viewsLoading}
          <p class="quiet">{t('common.loading')}</p>
        {:else if viewsError}
          <p class="text-sm text-destructive" in:appear>
            {t('tokens.viewsLoadFailed', { error: viewsError })}
          </p>
        {:else if !views.length}
          <p class="quiet">{t('tokens.viewsEmpty')}</p>
        {:else}
          <figure class="chart">
            <svg viewBox="0 0 {CW} {CH}" role="img" aria-label={chartLabel}>
              {#each days as day, i (i)}
                {@const h = barH(day.count)}
                {@const x = i * STEP + (STEP - BAR) / 2}
                {#if h}
                  <rect class="bar" {x} y={CH - 6 - h} width={BAR} height={h} rx="2.5">
                    <title>{shortDay(day.date)}: {day.count}</title>
                  </rect>
                  {#if i === lastActive}
                    <circle class="cap" cx={x + BAR / 2} cy={CH - 6 - h - 6} r="2.6" />
                  {/if}
                {:else}
                  <circle class="rest" cx={x + BAR / 2} cy={CH - 6} r="1" />
                {/if}
              {/each}
              <line class="axis" x1="0" y1={CH - 6} x2={CW} y2={CH - 6} />
            </svg>
            <figcaption>
              <span>{shortDay(days[0].date)}</span>
              <span>{t('tokens.panelChartCaption', { days: DAYS })}</span>
              <span>{t('tokens.panelToday')}</span>
            </figcaption>
          </figure>

          <ol class="timeline">
            {#each views as view, i (view.id)}
              <!-- referrerHost and placement are visitor-influenced: escaped {} only. -->
              <li class:latest={i === 0}>
                <span class="mark" aria-hidden="true"></span>
                <span class="when" title={formatDateTime(view.occurredAt)}>
                  {formatTimeAgo(view.occurredAt)}
                </span>
                <span class="what">
                  {view.referrerHost ?? t('tokens.viewsDirect')}
                  {#if view.placement}<span class="aside">· {view.placement}</span>{/if}
                  {#if view.uaFamily}<span class="aside">· {view.uaFamily}</span>{/if}
                  <span class="aside">· v{view.version}</span>
                </span>
              </li>
            {/each}
          </ol>
          {#if viewsCursor}
            <div class="flex justify-center pt-1">
              <Button
                variant="outline"
                size="sm"
                onclick={() => void loadMoreViews()}
                disabled={viewsLoadingMore}
              >
                {viewsLoadingMore ? t('common.loading') : t('common.loadMore')}
              </Button>
            </div>
          {/if}
        {/if}
        <p class="privacy">{t('tokens.panelPrivacy')}</p>
      </div>

      <!-- Every act of the row's menu, as buttons: the same handlers. Copy and
           open sit with the URL above, live only when this page has it. -->
      {#if actions.length}
        <div class="acts" data-testid="panel-actions">
          {#each actions as action (action.key)}
            <Button
              variant={action.variant === 'destructive' ? 'destructive' : 'outline'}
              size="sm"
              class={action.variant === 'destructive' ? 'md:ml-auto' : ''}
              onclick={action.onclick}
            >
              {#if action.icon}<action.icon />{/if}
              {action.label}
            </Button>
          {/each}
        </div>
      {/if}
    {/if}
  </Sheet.Content>
</Sheet.Root>

<style>
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 24px 20px;
  }
  .section {
    margin: 26px 0 12px;
  }
  .quiet {
    font-size: 13.5px;
    color: var(--muted);
  }

  /* the URL as the one-line code block, the way out beside it */
  .url-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .url--none {
    display: block;
    padding: 10px 12px;
    border: 1px dashed var(--hairline);
    border-radius: 10px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--muted);
  }

  /* three figures on one line, a hairline between them */
  .figures {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-top: 20px;
  }
  .figures > div {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 0 2px 16px;
    border-left: 1px solid var(--hairline);
  }
  .figures > div:first-child {
    padding-left: 0;
    border-left: 0;
  }
  .figures dd {
    font-size: 30px;
    color: var(--ink);
  }
  .figures dd.figure--words {
    font-size: 19px;
    line-height: 30px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .figures dt {
    font-size: 12.5px;
    color: var(--muted);
  }

  .rows {
    font-size: 13.5px;
  }
  .rows > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 9px 0;
  }
  .rows > div.caps-row {
    align-items: flex-start;
  }
  .rows > div.caps-row > span:first-child {
    padding-top: 3px;
  }
  .caps {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    max-width: 300px;
  }
  .caps li.off {
    opacity: 0.55;
  }

  /* opens by day: the presentations' outlined bars, the accent once, on the
     cap of the last day the link was opened */
  .chart svg {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
  }
  .bar {
    fill: color-mix(in oklab, var(--ground) 40%, transparent);
    stroke: color-mix(in oklab, var(--ink) 40%, transparent);
    stroke-width: 1;
  }
  .axis {
    stroke: color-mix(in oklab, var(--ink) 45%, transparent);
    stroke-width: 1.2;
    stroke-linecap: round;
  }
  .rest {
    fill: color-mix(in oklab, var(--ink) 30%, transparent);
  }
  .cap {
    fill: var(--accent);
  }
  .chart figcaption {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    font-family: var(--second);
    font-weight: 300;
    font-size: 10.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* each open on a thin line; the latest carries the ringed dot */
  .timeline {
    position: relative;
    margin-top: 18px;
    font-size: 13px;
  }
  .timeline::before {
    content: '';
    position: absolute;
    left: 5.5px;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: color-mix(in oklab, var(--ink) 18%, transparent);
  }
  .timeline li {
    position: relative;
    display: grid;
    grid-template-columns: 12px 76px minmax(0, 1fr);
    align-items: baseline;
    column-gap: 10px;
    padding: 5px 0;
  }
  .mark {
    align-self: center;
    justify-self: center;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: color-mix(in oklab, var(--ink) 70%, var(--ground));
    box-shadow: 0 0 0 3px var(--ground);
  }
  .latest .mark {
    background: var(--accent);
    box-shadow:
      0 0 0 3px var(--ground),
      0 0 0 4px var(--accent);
  }
  .when {
    color: var(--muted);
    white-space: nowrap;
  }
  .what {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .aside {
    color: var(--muted);
  }
  .privacy {
    margin-top: 16px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted);
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 14px 24px calc(14px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--hairline);
    background: var(--ground);
    border-radius: 0 0 12px 12px;
  }
</style>
