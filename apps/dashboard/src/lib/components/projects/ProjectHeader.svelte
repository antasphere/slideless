<script lang="ts">
  /* How a project's page opens: the band with its name and what it is for,
     the notice when it is archived, then the reader's role and the controls
     that role gives. A control is rendered only for who may use it
     (`projectCan`). There is no delete: a project is archived, never removed. */
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import ProjectFields from './ProjectFields.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Tag } from '$lib/components/ui/tag';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Archive from '@lucide/svelte/icons/archive';
  import { errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { projectCan } from '$lib/projects/can';
  import type { Project } from '$lib/projects/types';
  import { projectRoleTag, stateTag } from '$lib/tags';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  interface Props {
    project: Project;
    /** After any change: the page reads the project again. */
    onChanged: () => Promise<void> | void;
  }
  let { project, onChanged }: Props = $props();

  const archived = $derived(project.archivedAt !== null);

  // ── Edit ───────────────────────────────────────────────────────────────
  let showEditDialog = $state(false);
  let editLoading = $state(false);
  let name = $state('');
  let description = $state('');

  function openEditDialog() {
    name = project.name;
    description = project.description ?? '';
    showEditDialog = true;
  }

  async function submitEdit() {
    editLoading = true;
    try {
      await projects.update(project.id, { name: name.trim(), description: description.trim() || null });
      showEditDialog = false;
      toast.success(t('projects.savedToast'));
    } catch (e) {
      toast.error(errorMessage(e, t('common.updateFailed')));
    } finally {
      editLoading = false;
      // on a refusal too: a 409 means it was archived elsewhere meanwhile
      await onChanged();
    }
  }

  // ── Archive / unarchive ────────────────────────────────────────────────
  let showArchiveDialog = $state(false);
  let archiveLoading = $state(false);

  async function submitArchive() {
    archiveLoading = true;
    try {
      await projects.archive(project.id);
      showArchiveDialog = false;
      toast.success(t('projects.archivedToast', { name: project.name }));
    } catch (e) {
      toast.error(errorMessage(e, t('projects.archiveFailed')));
    } finally {
      archiveLoading = false;
      await onChanged();
    }
  }

  let unarchiveLoading = $state(false);
  async function unarchive() {
    unarchiveLoading = true;
    try {
      await projects.unarchive(project.id);
      toast.success(t('projects.unarchivedToast', { name: project.name }));
    } catch (e) {
      toast.error(errorMessage(e, t('projects.unarchiveFailed')));
    } finally {
      unarchiveLoading = false;
      await onChanged();
    }
  }
</script>

<!-- the name and the description are USER-AUTHORED: the band renders both as text -->
<SectionHero
  eyebrow={t('nav.projects')}
  title={project.name}
  lede={project.description ?? undefined}
  drawing="latitudes"
  seed={20260921}
/>

{#if archived}
  <div class="notice mb-4 flex-wrap items-center justify-between gap-3 px-4 py-3" in:appear>
    <p class="min-w-0 text-sm">{t('projects.archivedNotice')}</p>
    {#if projectCan.unarchive(project)}
      <Button variant="outline" size="sm" onclick={() => void unarchive()} disabled={unarchiveLoading}>
        {unarchiveLoading ? t('common.working') : t('projects.unarchive')}
      </Button>
    {/if}
  </div>
{/if}

<div class="mb-8 flex flex-wrap items-center justify-between gap-3">
  <div class="flex min-w-0 flex-wrap items-center gap-2">
    <span class="text-sm text-muted-foreground">{t('projects.yourRole')}</span>
    <Tag {...projectRoleTag(project.myRole)} />
    {#if archived}
      <Tag {...stateTag(t('projects.stateArchived'), 'off')} />
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-2">
    {#if projectCan.edit(project)}
      <Button variant="outline" size="sm" class="h-8 gap-1.5" onclick={openEditDialog}>
        <Pencil class="h-4 w-4" />
        {t('projects.edit')}
      </Button>
    {/if}
    {#if projectCan.archive(project)}
      <Button variant="outline" size="sm" class="h-8 gap-1.5" onclick={() => (showArchiveDialog = true)}>
        <Archive class="h-4 w-4" />
        {t('projects.archive')}
      </Button>
    {/if}
  </div>
</div>

<FormDialog
  bind:open={showEditDialog}
  title={t('projects.editTitle')}
  onClose={() => (showEditDialog = false)}
  onSubmit={() => void submitEdit()}
  loading={editLoading}
>
  <ProjectFields bind:name bind:description idPrefix="project-edit" />
</FormDialog>

<ConfirmDialog
  bind:open={showArchiveDialog}
  title={t('projects.archiveConfirmTitle', { name: project.name })}
  description={t('projects.archiveConfirmDescription')}
  confirmLabel={t('projects.archive')}
  variant="default"
  onClose={() => (showArchiveDialog = false)}
  onConfirm={() => void submitArchive()}
  loading={archiveLoading}
/>
