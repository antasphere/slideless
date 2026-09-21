<script lang="ts">
  /* The "Projects" block of a deck's page (PRDCT-2584): the projects the deck
     sits in, each a link to its page. Only the projects the reader can read
     are named; the API never tells the others. Whoever administers the deck
     adds it to a project where they are editor or manager, since linking
     widens who reads the deck. They take it out too, and so does the
     project's manager. A reader who may do neither sees the list and no
     control. Every project fact comes through `$lib/tool/projects-client`.

     SECURITY: a project's name is USER-AUTHORED; it renders through text
     interpolation only, never {@html}. */
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Tag } from '$lib/components/ui/tag/index.js';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DeckSectionHeading from '$lib/tool/components/decks/DeckSectionHeading.svelte';
  import PickList from './PickList.svelte';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import Folder from '@lucide/svelte/icons/folder';
  import Palette from '@lucide/svelte/icons/palette';
  import { errorMessage } from '$lib/api';
  import { deckProjects, type DeckProjectRef } from '$lib/tool/projects-client';
  import { canUnlinkFrom, projectsToAddTo } from '$lib/tool/project-filter';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Project } from '$lib/projects/types';

  interface Props {
    deckId: string;
    deckTitle: string;
    /** The reader administers the deck: its owner, a workspace admin or owner. */
    canManage: boolean;
  }

  let { deckId, deckTitle, canManage }: Props = $props();

  let refs = $state<DeckProjectRef[]>([]);
  let readable = $state<Project[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    try {
      [refs, readable] = await Promise.all([
        deckProjects.projectsOf(deckId),
        deckProjects.readableProjects()
      ]);
      error = null;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loaded = true;
    }
  }
  $effect(() => {
    void load();
  });

  const addable = $derived(canManage ? projectsToAddTo(readable, refs) : []);
  // a deck in no project the reader reads, and nothing the reader can do: no block at all
  const shown = $derived(loaded && (refs.length > 0 || addable.length > 0 || error !== null));

  let showAddDialog = $state(false);
  let addChoice = $state<string | null>(null);
  let adding = $state(false);
  function openAddDialog() {
    addChoice = addable.length === 1 ? addable[0].id : null;
    showAddDialog = true;
  }
  async function add() {
    if (!addChoice || adding) return;
    adding = true;
    try {
      await deckProjects.link(deckId, addChoice);
      showAddDialog = false;
      toast.success(t('deckProjects.linked'));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      adding = false;
    }
  }

  let unlinkTarget = $state<DeckProjectRef | null>(null);
  let showUnlinkDialog = $state(false);
  let unlinking = $state(false);
  // read through a derived: a snippet loses the null-narrowing
  const unlinkName = $derived(unlinkTarget?.name ?? '');
  async function unlink() {
    if (!unlinkTarget) return;
    unlinking = true;
    try {
      await deckProjects.unlink(deckId, unlinkTarget.id);
      showUnlinkDialog = false;
      toast.success(t('deckProjects.unlinked'));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      unlinking = false;
    }
  }
</script>

{#snippet addButton()}
  {#if addable.length}
    <Button size="sm" class="h-8 gap-1.5" onclick={openAddDialog} data-testid="deck-add-to-project">
      <Plus class="h-4 w-4" />
      {t('deckProjects.addToProject')}
    </Button>
  {/if}
{/snippet}

{#if shown}
  <div in:appear>
    <Card.Root class="deck-section gap-3" data-testid="deck-projects-panel">
      <DeckSectionHeading
        drawing="projects"
        title={t('deckProjects.panelTitle')}
        description={t('deckProjects.panelDescription')}
        action={addButton}
      />
      <Card.Content>
        <FormError message={error ? t('deckProjects.panelLoadFailed', { error }) : null} />
        {#if !error && !refs.length}
          <p class="text-sm text-muted-foreground">{t('deckProjects.panelEmpty')}</p>
        {:else if refs.length}
          <ul class="rows">
            {#each refs as ref (ref.id)}
              <li class="row">
                <a href="/projects/{ref.id}" class="name">
                  <Folder class="size-4 flex-none text-muted-foreground" strokeWidth={1.6} />
                  <span class="truncate">{ref.name}</span>
                </a>
                {#if ref.isBrand}
                  <Tag label={t('deckProjects.tagBrandOf')} tone="violet" icon={Palette} />
                {/if}
                {#if canUnlinkFrom(ref.id, readable, canManage)}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="ml-auto h-8 flex-none"
                    aria-label={t('deckProjects.unlinkFromAria', { project: ref.name })}
                    onclick={() => {
                      unlinkTarget = ref;
                      showUnlinkDialog = true;
                    }}
                  >
                    {t('deckProjects.unlinkShort')}
                  </Button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
{/if}

<FormDialog
  bind:open={showAddDialog}
  title={t('deckProjects.addToProjectTitle')}
  description={t('deckProjects.addToProjectDescription')}
  onClose={() => (showAddDialog = false)}
  onSubmit={() => void add()}
  loading={adding}
  submitLabel={t('deckProjects.addSubmit')}
>
  <PickList
    bind:value={addChoice}
    label={t('deckProjects.addToProjectTitle')}
    items={addable.map((p) => ({ id: p.id, title: p.name, detail: p.description ?? undefined }))}
  />
</FormDialog>

<ConfirmDialog
  bind:open={showUnlinkDialog}
  title={t('deckProjects.unlinkTitle')}
  description={t('deckProjects.unlinkDescription', { deck: deckTitle, project: unlinkName })}
  confirmLabel={t('deckProjects.unlink')}
  onClose={() => (showUnlinkDialog = false)}
  onConfirm={() => void unlink()}
  loading={unlinking}
/>

<style>
  .rows {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    min-height: 44px;
    padding: 6px 0;
    border-top: 1px solid var(--hairline);
  }
  .row:first-child {
    border-top: 0;
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
    font-size: 14px;
  }
  .name:hover {
    text-decoration: underline;
    text-underline-offset: 4px;
  }
</style>
