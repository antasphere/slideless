<script lang="ts">
  /* The Projects section (PRDCT-2582), the shell's: every tool gets it. A
     project is a group of the workspace with its own members; what it holds
     is the tool's to show, on the project's page. */
  import { goto } from '$app/navigation';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ProjectsTable from '$lib/components/projects/ProjectsTable.svelte';
  import ProjectFields from '$lib/components/projects/ProjectFields.svelte';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { readArchivedFilter, writeArchivedFilter } from '$lib/projects/filter';
  import type { ProjectArchivedFilter } from '$lib/projects/types';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // A guest is invited to one resource, never to the workspace's groups (D2):
  // the menu hides this section from them, and a typed address lands here.
  const isGuest = $derived(data.me.origin === 'guest');

  let filter = $state<ProjectArchivedFilter>(readArchivedFilter());
  function choose(next: ProjectArchivedFilter) {
    filter = next;
    writeArchivedFilter(next);
  }

  // ── New project ────────────────────────────────────────────────────────
  let showCreateDialog = $state(false);
  let createLoading = $state(false);
  let name = $state('');
  let description = $state('');

  function openCreateDialog() {
    name = '';
    description = '';
    showCreateDialog = true;
  }

  async function submitCreate() {
    createLoading = true;
    try {
      const created = await projects.create({
        name: name.trim(),
        description: description.trim() || undefined
      });
      showCreateDialog = false;
      toast.success(t('projects.createdToast', { name: created.name }));
      await goto(`/projects/${created.id}`);
    } catch (e) {
      toast.error(errorMessage(e, t('projects.createFailed')));
    } finally {
      createLoading = false;
    }
  }
</script>

<svelte:head>
  <title>{t('nav.projects')} · {data.instance.name}</title>
</svelte:head>

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('nav.projects')}
  lede={t('projects.description')}
  drawing="latitudes"
  seed={20260921}
/>

{#if isGuest}
  <p class="py-10 text-center text-sm text-muted-foreground" in:appear>{t('projects.guestUnavailable')}</p>
{:else}
  <ProjectsTable {filter} onFilter={choose} onCreate={openCreateDialog} />

  <FormDialog
    bind:open={showCreateDialog}
    title={t('projects.createTitle')}
    description={t('projects.createDescription')}
    onClose={() => (showCreateDialog = false)}
    onSubmit={() => void submitCreate()}
    loading={createLoading}
    submitLabel={t('projects.createSubmit')}
  >
    <ProjectFields bind:name bind:description idPrefix="project-create" />
  </FormDialog>
{/if}
