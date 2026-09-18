<script lang="ts">
  import Lock from '@lucide/svelte/icons/lock';
  import { Tag } from '$lib/components/ui/tag/index.js';
  import type { TokenStatus } from '$lib/decks';
  import { stateTag } from '$lib/tags';
  import { t } from '$lib/i18n';

  /**
   * The recipient's name on ONE line, cut with an ellipsis, the whole name
   * on hover (PRDCT-2308); a lock beside it when the link asks for a
   * password. The name is the row's opener: a real button, so the link's
   * panel is one Tab and one Enter away while the row stays a table row.
   * A link that no longer opens says so here, with a state tag beside a
   * struck name, whenever the table's status column is hidden: the state is
   * text, so a screen reader hears it too.
   * SECURITY: the label is USER-SUPPLIED text — escaped {} interpolation
   * only, in the text and in the title attribute alike.
   */
  interface Props {
    name: string;
    hasPassword: boolean;
    status?: TokenStatus;
    /** Say the state beside the name (the status column is hidden). */
    showState?: boolean;
    onopen?: () => void;
  }

  let { name, hasPassword, status = 'active', showState = false, onopen }: Props = $props();

  const stateSpec = $derived(
    status === 'revoked'
      ? stateTag(t('tokens.statusRevoked'), 'bad')
      : status === 'expired'
        ? stateTag(t('tokens.statusExpired'), 'wait')
        : null
  );
</script>

<span class="cell" data-link-state={status}>
  {#if hasPassword}
    <span class="inline-flex shrink-0" title={t('tokens.passwordProtected')} data-testid="link-password">
      <Lock class="h-3.5 w-3.5 text-muted-foreground" />
      <span class="sr-only">{t('tokens.passwordProtected')}</span>
    </span>
  {/if}
  {#if onopen}
    <button
      type="button"
      class="opener"
      class:gone={status !== 'active'}
      data-testid="link-open-panel"
      onclick={(e) => {
        e.stopPropagation();
        onopen();
      }}
    >
      <span class="block min-w-0 truncate" title={name} data-testid="link-name">{name}</span>
    </button>
  {:else}
    <span class="block min-w-0 truncate" class:gone={status !== 'active'} title={name} data-testid="link-name"
      >{name}</span
    >
  {/if}
  {#if showState && stateSpec}
    <span class="shrink-0" data-testid="link-state"><Tag {...stateSpec} /></span>
  {/if}
</span>

<style>
  .cell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  /* on a phone the row is a card: the whole name shows, the tag under it */
  @media (max-width: 767px) {
    .cell {
      flex-wrap: wrap;
      row-gap: 4px;
    }
    .cell :global([data-testid='link-name']) {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
  .opener {
    display: block;
    min-width: 0;
    max-width: 100%;
    margin: -4px -6px;
    padding: 4px 6px;
    border-radius: 7px;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  @media (hover: hover) {
    .opener:hover {
      text-decoration: underline;
      text-decoration-color: color-mix(in oklab, var(--accent) 70%, transparent);
      text-underline-offset: 3px;
    }
  }
  /* a link that no longer opens: the name struck and quiet */
  .gone {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklab, var(--muted) 60%, transparent);
  }
  @media (hover: hover) {
    .opener.gone:hover {
      text-decoration: line-through underline;
    }
  }
</style>
