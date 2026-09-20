<!-- What a project holds in Slideless (PRDCT-2582): its brand and its decks.
     The shell's project page renders it under the members, through the
     contribution's `project.Resources` door. The shell owns the project and
     its roles; this piece reads them (`projectCan`) to show a control only to
     who may use it, and an archived project shows none: its lists stay
     readable. Every project fact comes through `$lib/tool/projects-client`.

     SECURITY: deck titles, descriptions and the project's name are
     USER-AUTHORED; they render through text interpolation only, never
     {@html}. -->
<script lang="ts">
  import { page } from '$app/state';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import DeckCard from '$lib/tool/components/decks/DeckCard.svelte';
  import PickList from './PickList.svelte';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import Unlink from '@lucide/svelte/icons/unlink';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { errorMessage } from '$lib/api';
  import { deckProjects, type DeckWithProjects } from '$lib/tool/projects-client';
  import { administersDeck } from '$lib/tool/project-filter';
  import { descriptionOf } from '$lib/tool/references';
  import { projectCan } from '$lib/projects/can';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Project } from '$lib/projects/types';
  import type { MeResponse, Presentation } from '@slideless/contract';

  let { project }: { project: Project } = $props();

  const me = $derived((page.data as { me?: MeResponse | null }).me ?? null);
  // A manager sets the brand and takes any deck out; an editor adds their own decks.
  const canEdit = $derived(projectCan.edit(project));
  const canWrite = $derived(projectCan.write(project));

  // ── The brand ──────────────────────────────────────────────────────────
  let brand = $state<Presentation | null>(null);
  let brandLoaded = $state(false);
  let brandError = $state<string | null>(null);
  const brandDescription = $derived(descriptionOf(brand?.reference ?? null));

  async function loadBrand() {
    try {
      brand = await deckProjects.brandOf(project.id);
      brandError = null;
    } catch (e) {
      brandError = errorMessage(e);
    } finally {
      brandLoaded = true;
    }
  }

  let showBrandDialog = $state(false);
  let brandChoices = $state<Presentation[] | null>(null);
  let brandChoicesError = $state<string | null>(null);
  let brandChoice = $state<string | null>(null);
  let brandSaving = $state(false);

  async function openBrandDialog() {
    brandChoice = brand?.id ?? null;
    brandChoices = null;
    brandChoicesError = null;
    showBrandDialog = true;
    try {
      // the brand is one of the project's own decks: a brand reference linked
      // to it first (the add dialog, or a push with --project)
      brandChoices = (await deckProjects.decksOf(project.id, { type: 'brand', limit: 100 })).presentations;
    } catch (e) {
      brandChoicesError = errorMessage(e);
    }
  }

  async function saveBrand() {
    if (!brandChoice || brandSaving) return;
    brandSaving = true;
    try {
      await deckProjects.setBrand(project.id, brandChoice);
      showBrandDialog = false;
      toast.success(t('deckProjects.brandSaved'));
      await loadBrand();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      brandSaving = false;
    }
  }

  let showClearDialog = $state(false);
  let clearing = $state(false);
  async function clearBrand() {
    clearing = true;
    try {
      await deckProjects.setBrand(project.id, null);
      showClearDialog = false;
      toast.success(t('deckProjects.brandCleared'));
      await loadBrand();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      clearing = false;
    }
  }

  // ── The decks ──────────────────────────────────────────────────────────
  // one list per project: a project page that changes project under this piece starts over
  const list = $derived.by(() => {
    const id = project.id;
    return createPagedList<DeckWithProjects>(async (p) => {
      const { presentations, nextCursor } = await deckProjects.decksOf(id, p);
      return { items: presentations, nextCursor };
    });
  });
  const decks = $derived(list.items);

  $effect(() => {
    void loadBrand();
    void list.load();
  });

  const pushCommand = $derived(`slideless push --project ${project.id}`);

  // Add a deck: the reader's own, since linking widens who reads the deck.
  let showAddDialog = $state(false);
  let addChoices = $state<DeckWithProjects[] | null>(null);
  let addChoicesError = $state<string | null>(null);
  let addChoice = $state<string | null>(null);
  let adding = $state(false);

  async function openAddDialog() {
    addChoice = null;
    addChoices = null;
    addChoicesError = null;
    showAddDialog = true;
    try {
      const { presentations } = await deckProjects.decksOf(null, { limit: 100 });
      addChoices = presentations.filter(
        (d) => me && administersDeck(me, d) && !deckProjects.named(d).some((p) => p.id === project.id)
      );
    } catch (e) {
      addChoicesError = errorMessage(e);
    }
  }

  async function addDeck() {
    if (!addChoice || adding) return;
    adding = true;
    try {
      await deckProjects.link(addChoice, project.id);
      showAddDialog = false;
      toast.success(t('deckProjects.linked'));
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      adding = false;
    }
  }

  let unlinkTarget = $state<DeckWithProjects | null>(null);
  let showUnlinkDialog = $state(false);
  let unlinking = $state(false);
  // read through a derived: a snippet loses the null-narrowing
  const unlinkTitle = $derived(unlinkTarget?.title ?? '');

  async function unlinkDeck() {
    if (!unlinkTarget) return;
    unlinking = true;
    try {
      await deckProjects.unlink(unlinkTarget.id, project.id);
      showUnlinkDialog = false;
      toast.success(t('deckProjects.unlinked'));
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      unlinking = false;
    }
  }
</script>

<div class="space-y-6" data-testid="project-decks" data-project={project.id}>
  <Card.Root data-testid="project-brand">
    <Card.Header>
      <Card.Title class="text-[19px]">{t('deckProjects.brandTitle')}</Card.Title>
      <Card.Description class="max-w-[62ch]">{t('deckProjects.brandDescription')}</Card.Description>
    </Card.Header>
    <Card.Content>
      <FormError message={brandError ? t('deckProjects.brandLoadFailed', { error: brandError }) : null} />
      {#if brandLoaded && !brandError}
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3" in:appear>
          {#if brand}
            <div class="min-w-0 flex-1 basis-[240px]">
              <a
                href="/decks/{brand.id}"
                class="group inline-flex max-w-full items-center gap-1.5 font-display text-[18px] leading-[1.2] tracking-[-0.01em] hover:underline hover:underline-offset-4"
              >
                <span class="truncate">{brand.title}</span>
                <ArrowRight class="size-4 flex-none text-muted-foreground" />
              </a>
              {#if brandDescription}
                <p class="mt-1 max-w-[62ch] text-sm text-muted-foreground">{brandDescription}</p>
              {/if}
            </div>
          {:else}
            <p class="text-sm text-muted-foreground">{t('deckProjects.brandNone')}</p>
          {/if}
          {#if canEdit}
            <div class="flex flex-none gap-2">
              <Button variant="outline" size="sm" class="h-8" onclick={() => void openBrandDialog()}>
                {brand ? t('deckProjects.brandChange') : t('deckProjects.brandSet')}
              </Button>
              {#if brand}
                <Button variant="ghost" size="sm" class="h-8" onclick={() => (showClearDialog = true)}>
                  {t('deckProjects.brandClear')}
                </Button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root data-testid="project-deck-list">
    <Card.Header>
      <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div class="min-w-0 flex-1 basis-[240px]">
          <Card.Title class="text-[19px]">{t('deckProjects.decksTitle')}</Card.Title>
          <Card.Description class="mt-1.5 max-w-[62ch]">{t('deckProjects.decksDescription')}</Card.Description
          >
        </div>
        {#if canWrite}
          <Button size="sm" class="h-8 flex-none gap-1.5" onclick={() => void openAddDialog()}>
            <Plus class="h-4 w-4" />
            {t('deckProjects.add')}
          </Button>
        {/if}
      </div>
    </Card.Header>
    <Card.Content>
      <FormError
        message={list.error && decks.length ? t('common.refreshFailedCached', { error: list.error }) : null}
        class="pb-3"
      />
      {#if list.loading}
        <TableSkeleton columns={3} />
      {:else if list.error && !decks.length}
        <p class="text-sm text-destructive" in:appear>{t('decks.loadFailed', { error: list.error })}</p>
      {:else if !decks.length}
        <div class="space-y-3" in:appear>
          <p class="text-sm text-muted-foreground">{t('deckProjects.emptyDecks')}</p>
          {#if canWrite}
            <p class="text-sm">{t('deckProjects.emptyHow')}</p>
            <CodeBlock code={pushCommand} language="shell" copyLabel={t('decks.copyCommandAria')} />
            <p class="text-sm text-muted-foreground">{t('deckProjects.emptyOr')}</p>
          {/if}
        </div>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" in:appear>
          {#each decks as deck (deck.id)}
            <!-- the card is a link, so the action sits beside it, not inside -->
            <div class="relative grid min-w-0">
              <DeckCard {deck} exceptProject={project.id} />
              {#if canEdit}
                <button
                  type="button"
                  class="unlink"
                  title={t('deckProjects.unlink')}
                  aria-label={t('deckProjects.unlinkAria', { deck: deck.title })}
                  onclick={() => {
                    unlinkTarget = deck;
                    showUnlinkDialog = true;
                  }}
                >
                  <Unlink class="size-3.5" />
                </button>
              {/if}
            </div>
          {/each}
        </div>
        {#if list.nextCursor}
          <div class="flex justify-center pt-4" transition:reveal>
            <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
              {list.loadingMore ? t('common.loading') : t('common.loadMore')}
            </Button>
          </div>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<FormDialog
  bind:open={showBrandDialog}
  title={t('deckProjects.brandPickTitle')}
  description={t('deckProjects.brandPickDescription')}
  onClose={() => (showBrandDialog = false)}
  onSubmit={() => void saveBrand()}
  loading={brandSaving}
  submitLabel={t('deckProjects.brandPickSubmit')}
>
  {#if brandChoicesError}
    <p class="text-sm text-destructive">{t('deckProjects.brandPickFailed', { error: brandChoicesError })}</p>
  {:else if brandChoices === null}
    <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
  {:else if !brandChoices.length}
    <p class="text-sm text-muted-foreground">{t('deckProjects.brandPickEmpty')}</p>
  {:else}
    <PickList
      bind:value={brandChoice}
      label={t('deckProjects.brandPickTitle')}
      items={brandChoices.map((d) => ({ id: d.id, title: d.title, detail: descriptionOf(d.reference) }))}
    />
  {/if}
</FormDialog>

<ConfirmDialog
  bind:open={showClearDialog}
  title={t('deckProjects.brandClearTitle')}
  description={t('deckProjects.brandClearDescription')}
  confirmLabel={t('deckProjects.brandClear')}
  onClose={() => (showClearDialog = false)}
  onConfirm={() => void clearBrand()}
  loading={clearing}
/>

<FormDialog
  bind:open={showAddDialog}
  title={t('deckProjects.addTitle')}
  description={t('deckProjects.addDescription')}
  onClose={() => (showAddDialog = false)}
  onSubmit={() => void addDeck()}
  loading={adding}
  submitLabel={t('deckProjects.addSubmit')}
>
  {#if addChoicesError}
    <p class="text-sm text-destructive">{t('decks.loadFailed', { error: addChoicesError })}</p>
  {:else if addChoices === null}
    <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
  {:else if !addChoices.length}
    <p class="text-sm text-muted-foreground">{t('deckProjects.addEmpty')}</p>
  {:else}
    <PickList
      bind:value={addChoice}
      label={t('deckProjects.addTitle')}
      items={addChoices.map((d) => ({ id: d.id, title: d.title }))}
    />
  {/if}
</FormDialog>

<ConfirmDialog
  bind:open={showUnlinkDialog}
  title={t('deckProjects.unlinkTitle')}
  description={t('deckProjects.unlinkDescription', { deck: unlinkTitle, project: project.name })}
  confirmLabel={t('deckProjects.unlink')}
  onClose={() => (showUnlinkDialog = false)}
  onConfirm={() => void unlinkDeck()}
  loading={unlinking}
/>

<style>
  /* the deck card's own chips, as a button: a plate on the picture's corner */
  .unlink {
    position: absolute;
    top: 18px;
    right: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    background: var(--plate-strong);
    border: 1px solid var(--plate-edge);
    color: var(--ink-soft);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    transition: background-color var(--motion-duration) var(--motion-ease);
  }
  .unlink:hover,
  .unlink:focus-visible {
    background: var(--ground);
    color: var(--ink);
  }
</style>
