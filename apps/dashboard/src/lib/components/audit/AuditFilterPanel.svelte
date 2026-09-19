<script lang="ts">
  /* The audit log's filter panel: five groups under their eyebrows, each
     one a question about an entry. When (a quick range, or two days), Who
     (a member, or the system), How (the ways an actor authenticates, as
     choice rows carrying the same tag the table shows), What (the action
     families, each unfolding into its actions), Resource (a type and an
     exact id). The host puts it in a popover on a desk and a bottom sheet on
     a phone; every change goes straight out through `onchange`, except the
     typed id which waits a beat. */
  import type { Member } from '@slideless/contract';
  import type { AuditVia } from '@slideless/contract';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Tag } from '$lib/components/ui/tag';
  import { roleTag, viaTag } from '$lib/tags';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { SvelteSet } from 'svelte/reactivity';
  import { t, type MessageKey } from '$lib/i18n';
  import { tool } from '$lib/tool';
  import {
    ACTOR_SYSTEM,
    QUICK_RANGES,
    RANGE_KEYS,
    VIAS,
    actionFamilies,
    familyOf,
    familySelected,
    toggleAction,
    toggleFamily,
    toggleVia,
    type AuditFilters,
    type QuickRange
  } from './audit-filters';

  interface Props {
    filters: AuditFilters;
    /** The workspace roster, for Who; empty while it loads or when it failed. */
    members: Member[];
    membersError?: string | null;
    /** The actions and resource types the loaded rows carry, on top of the fixed vocabulary. */
    seenActions?: string[];
    seenResourceTypes?: string[];
    onchange: (next: AuditFilters) => void;
    /** Prefix of every element id, so two panels on a page never collide. */
    idPrefix?: string;
    /** `stack`, the groups one under the other (a phone's sheet); `columns`, When, Who, How and Resource on the left, What on the right (a desk's popover). */
    layout?: 'stack' | 'columns';
  }

  let {
    filters,
    members,
    membersError = null,
    seenActions = [],
    seenResourceTypes = [],
    onchange,
    idPrefix = 'af',
    layout = 'stack'
  }: Props = $props();

  const id = (name: string) => `${idPrefix}-${name}`;

  const VIA_HINTS: Record<AuditVia, MessageKey> = {
    session: 'audit.viaSessionHint',
    api_key: 'audit.viaApiKeyHint',
    oauth: 'audit.viaOauthHint',
    system: 'audit.viaSystemHint'
  };

  // the shell's own, then the tool's; the list below is sorted either way
  const RESOURCE_TYPES = [
    'api_key',
    'file',
    'instance',
    'invitation',
    'member',
    'user',
    'workspace',
    ...tool.audit.resourceTypes
  ];

  const families = $derived(actionFamilies([...tool.audit.actions, ...seenActions]));
  const resourceTypes = $derived([...new Set([...RESOURCE_TYPES, ...seenResourceTypes])].sort());

  // a family stays folded until its row is unfolded, or one of its actions is chosen
  const unfolded = new SvelteSet<string>();
  const isUnfolded = (family: string) =>
    unfolded.has(family) || filters.actions.some((a) => !a.endsWith('.') && familyOf(a) === family);
  function unfold(family: string) {
    if (unfolded.has(family)) unfolded.delete(family);
    else unfolded.add(family);
  }
  const familyState = (family: string, actions: string[]): 'all' | 'some' | 'none' =>
    familySelected(filters, family)
      ? 'all'
      : actions.some((a) => filters.actions.includes(a))
        ? 'some'
        : 'none';

  function setRange(range: QuickRange | null) {
    onchange({ ...filters, range, from: null, to: null });
  }
  function setDay(which: 'from' | 'to', value: string) {
    onchange({ ...filters, range: null, [which]: value || null });
  }

  // the typed id waits a beat, the way the search field does; a value that
  // arrives from elsewhere (a tag removed, the back button) resets the field
  let resourceIdText = $state('');
  let pushedId = '';
  let idTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const fromUrl = filters.resourceId ?? '';
    if (fromUrl !== pushedId) {
      pushedId = fromUrl;
      resourceIdText = fromUrl;
    }
  });
  function typeResourceId(value: string) {
    resourceIdText = value;
    clearTimeout(idTimer);
    idTimer = setTimeout(() => {
      pushedId = value.trim();
      onchange({ ...filters, resourceId: pushedId || null });
    }, 250);
  }

  const memberLabel = (m: Member) => (m.name ? `${m.name} · ${m.email}` : m.email);
  const actorLabel = $derived.by(() => {
    if (!filters.actor) return t('audit.actorAnyone');
    if (filters.actor === ACTOR_SYSTEM) return t('audit.actorSystem');
    const member = members.find((m) => m.userId === filters.actor);
    return member ? memberLabel(member) : filters.actor;
  });
</script>

<div class="panel" class:columns={layout === 'columns'}>
  <section>
    <h3 class="eyebrow">{t('audit.groupWhen')}</h3>
    <div class="ranges" role="group" aria-label={t('audit.groupWhen')}>
      <button
        type="button"
        class="range"
        aria-pressed={!filters.range && !filters.from && !filters.to}
        onclick={() => setRange(null)}
      >
        {t('audit.rangeAll')}
      </button>
      {#each QUICK_RANGES as range (range)}
        <button
          type="button"
          class="range"
          aria-pressed={filters.range === range}
          onclick={() => setRange(range)}
        >
          {t(RANGE_KEYS[range])}
        </button>
      {/each}
    </div>
    <div class="dates">
      <div>
        <Label for={id('from')} class="field-label">{t('audit.fromLabel')}</Label>
        <Input
          id={id('from')}
          type="date"
          value={filters.from ?? ''}
          max={filters.to ?? undefined}
          onchange={(e) => setDay('from', e.currentTarget.value)}
          class="h-9 text-[13.5px]"
        />
      </div>
      <div>
        <Label for={id('to')} class="field-label">{t('audit.toLabel')}</Label>
        <Input
          id={id('to')}
          type="date"
          value={filters.to ?? ''}
          min={filters.from ?? undefined}
          onchange={(e) => setDay('to', e.currentTarget.value)}
          class="h-9 text-[13.5px]"
        />
      </div>
    </div>
  </section>

  <section>
    <h3 class="eyebrow">{t('audit.groupWho')}</h3>
    <Label for={id('actor')} class="sr-only">{t('audit.actorLabel')}</Label>
    <Select.Root
      type="single"
      value={filters.actor ?? ''}
      onValueChange={(v) => onchange({ ...filters, actor: v || null })}
    >
      <Select.Trigger id={id('actor')} class="w-full">
        <span class="truncate">{actorLabel}</span>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="" label={t('audit.actorAnyone')} />
        <Select.Item value={ACTOR_SYSTEM} label={t('audit.actorSystem')} />
        {#each members as member (member.id)}
          <Select.Item value={member.userId} label={memberLabel(member)}>
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate">{memberLabel(member)}</span>
              <Tag {...roleTag(member.role)} />
            </span>
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if membersError}
      <p class="mt-1.5 text-xs text-destructive">{membersError}</p>
    {/if}
  </section>

  <section>
    <h3 class="eyebrow">{t('audit.groupHow')}</h3>
    <div class="choices">
      {#each VIAS as via (via)}
        {@const checked = filters.via.includes(via)}
        <label for={id(`via-${via}`)} class="choice">
          <Checkbox
            id={id(`via-${via}`)}
            {checked}
            onCheckedChange={(v) => onchange(toggleVia(filters, via, v === true))}
            aria-labelledby="{id(`via-${via}`)}-name"
            aria-describedby="{id(`via-${via}`)}-hint"
            class="mt-0.5"
          />
          <span class="min-w-0 space-y-1">
            <span id="{id(`via-${via}`)}-name" class="block leading-none"><Tag {...viaTag(via)} /></span>
            <span id="{id(`via-${via}`)}-hint" class="choice-hint block">{t(VIA_HINTS[via])}</span>
          </span>
        </label>
      {/each}
    </div>
  </section>

  <section>
    <h3 class="eyebrow">{t('audit.groupWhat')}</h3>
    <div class="choices">
      {#each families as { family, actions } (family ?? actions[0])}
        {#if family === null}
          <!-- an action without a family (the fallback of an unlabelled route): its own row -->
          {@const action = actions[0]!}
          {@const on = filters.actions.includes(action)}
          <label for={id(`action-${action}`)} class="choice family-row">
            <Checkbox
              id={id(`action-${action}`)}
              checked={on}
              onCheckedChange={(v) => onchange(toggleAction(filters, action, v === true, actions))}
              aria-label={action}
              class="mt-0.5"
            />
            <code class="min-w-0 break-all text-[13px] leading-5 text-[var(--ink)]">{action}</code>
          </label>
        {:else}
          {@const state = familyState(family, actions)}
          {@const open = isUnfolded(family)}
          <div class="family" class:open>
            <div class="choice family-row">
              <Checkbox
                id={id(`family-${family}`)}
                checked={state === 'all'}
                indeterminate={state === 'some'}
                onCheckedChange={(v) => onchange(toggleFamily(filters, family, v === true))}
                aria-label={t('audit.familyAll', { family })}
                class="mt-0.5"
              />
              <label for={id(`family-${family}`)} class="min-w-0 flex-1 cursor-pointer">
                <span class="choice-name font-mono text-[13px]">{family}.</span>
                <span class="choice-hint block">{t('audit.familyAll', { family })}</span>
              </label>
              <button
                type="button"
                class="unfold"
                aria-expanded={open}
                aria-controls={id(`actions-${family}`)}
                aria-label={family}
                onclick={() => unfold(family)}
              >
                <ChevronRight class="size-4" />
              </button>
            </div>
            {#if open}
              <div id={id(`actions-${family}`)} class="actions">
                {#each actions as action (action)}
                  {@const on = state === 'all' || filters.actions.includes(action)}
                  <label for={id(`action-${action}`)} class="choice action">
                    <Checkbox
                      id={id(`action-${action}`)}
                      checked={on}
                      onCheckedChange={(v) => onchange(toggleAction(filters, action, v === true, actions))}
                      aria-label={action}
                    />
                    <code class="min-w-0 break-all text-[12.5px] leading-4">{action}</code>
                  </label>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </section>

  <section>
    <h3 class="eyebrow">{t('audit.groupResource')}</h3>
    <div class="space-y-2.5">
      <div>
        <Label for={id('type')} class="field-label">{t('audit.resourceTypeLabel')}</Label>
        <Select.Root
          type="single"
          value={filters.resourceType ?? ''}
          onValueChange={(v) => onchange({ ...filters, resourceType: v || null })}
        >
          <Select.Trigger id={id('type')} class="w-full">
            <span class="truncate">{filters.resourceType ?? t('audit.resourceTypeAny')}</span>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="" label={t('audit.resourceTypeAny')} />
            {#each resourceTypes as type (type)}
              <Select.Item value={type} label={type} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div>
        <Label for={id('id')} class="field-label">{t('audit.resourceIdLabel')}</Label>
        <Input
          id={id('id')}
          type="text"
          autocomplete="off"
          spellcheck={false}
          placeholder={t('audit.resourceIdPlaceholder')}
          value={resourceIdText}
          oninput={(e) => typeResourceId(e.currentTarget.value)}
          class="h-9 font-mono text-[12.5px]"
        />
      </div>
    </div>
  </section>
</div>

<style>
  .panel {
    display: grid;
    gap: 18px;
  }
  /* two columns on a desk: the four short groups stacked on the left, the
     long What group alone on the right, so the panel is wide rather than
     tall; the sections keep their order in the markup and for a reader */
  .panel.columns {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas:
      'when what'
      'who what'
      'how what'
      'resource what'
      '. what';
    column-gap: 28px;
    align-content: start;
  }
  .panel.columns > section:nth-child(1) {
    grid-area: when;
  }
  .panel.columns > section:nth-child(2) {
    grid-area: who;
  }
  .panel.columns > section:nth-child(3) {
    grid-area: how;
  }
  .panel.columns > section:nth-child(4) {
    grid-area: what;
  }
  .panel.columns > section:nth-child(5) {
    grid-area: resource;
  }
  .panel :global(.eyebrow) {
    margin-bottom: 8px;
  }
  .panel :global(.field-label) {
    display: block;
    margin-bottom: 5px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ink-soft);
  }
  /* the quick ranges, one row of small outline choices; the pressed one is ink on the accent wash */
  .ranges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .range {
    height: 30px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid var(--hairline);
    background: var(--plate-strong);
    color: var(--ink-soft);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    transition:
      background-color var(--motion-duration) var(--motion-ease),
      border-color var(--motion-duration) var(--motion-ease),
      color var(--motion-duration) var(--motion-ease);
  }
  @media (hover: hover) {
    .range:hover {
      border-color: color-mix(in oklab, var(--accent) 45%, var(--hairline));
      background: color-mix(in oklab, var(--accent) 6%, var(--plate-strong));
    }
  }
  .range[aria-pressed='true'] {
    border-color: color-mix(in oklab, var(--accent) 55%, var(--hairline));
    background: var(--accent-soft);
    color: var(--accent-deep);
  }
  .range:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .dates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 10px;
  }
  /* the What group: a family row folds its actions under it, indented past the switch */
  .family-row {
    align-items: center;
  }
  .unfold {
    display: inline-flex;
    flex: none;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: var(--muted);
    transition:
      transform var(--motion-duration) var(--motion-ease),
      background-color var(--motion-duration) var(--motion-ease);
  }
  .unfold:hover {
    background: color-mix(in oklab, var(--accent) 9%, transparent);
    color: var(--ink);
  }
  .unfold:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .family.open .unfold {
    transform: rotate(90deg);
  }
  .actions {
    padding: 2px 0 6px 36px;
    background: color-mix(in oklab, var(--ground-2) 55%, transparent);
  }
  .action {
    align-items: center;
    padding: 6px 12px 6px 0;
  }
  .action code {
    color: var(--ink);
  }
</style>
