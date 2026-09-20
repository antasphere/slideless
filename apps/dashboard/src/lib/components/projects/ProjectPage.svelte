<script lang="ts">
  /* One project (PRDCT-2582): its name and what it is for, who is in it and
     with which role, then what it holds. The first two are the shell's; the
     last is the tool's, through the one door. Every control reads
     `projectCan` on the project the server last answered, so a change of role
     or an archive made here or elsewhere is on screen after the next read. */
  import ProjectHeader from './ProjectHeader.svelte';
  import ProjectMembers from './ProjectMembers.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import { errorMessage } from '$lib/api';
  import { crumbs } from '$lib/crumbs.svelte';
  import { projects } from '$lib/projects/client';
  import { isNotFound } from '$lib/projects/errors';
  import type { Project } from '$lib/projects/types';
  import { tool } from '$lib/tool';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  interface Props {
    projectId: string;
    myUserId: string;
    instanceName: string;
  }
  let { projectId, myUserId, instanceName }: Props = $props();

  let project = $state<Project | null>(null);
  let loading = $state(true);
  let notFound = $state(false);
  let loadError = $state<string | null>(null);

  // The first read, and the read after every change: the screen follows the
  // server's `myRole` and `archivedAt`, never a guess made here. A project
  // that stops answering (the reader was removed meanwhile) is the calm 404.
  async function read() {
    try {
      project = await projects.get(projectId);
      loadError = null;
    } catch (e) {
      if (isNotFound(e)) {
        notFound = true;
        project = null;
      } else if (!project) {
        loadError = errorMessage(e);
      } else {
        // the screen keeps the last answer; say that the fresh one did not come
        toast.error(t('projects.loadOneFailed', { error: errorMessage(e) }));
      }
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void read();
  });

  // The shell's path bar reads `Projects / <name>` once the band has scrolled
  // away. The name is user-authored: the bar renders it as text.
  $effect(() => {
    if (!project) return;
    crumbs.set([{ label: project.name }]);
    return () => crumbs.clear();
  });

  const Resources = $derived(tool.project?.Resources);
</script>

<svelte:head>
  <title>{project ? project.name : t('nav.projects')} · {instanceName}</title>
</svelte:head>

{#if loading}
  <TableSkeleton columns={4} showSearch={false} />
{:else if notFound}
  <!-- a non-member gets the same 404 as a wrong address, by design: a plain
       page, never an error -->
  <div in:appear>
    <Card.Root class="mx-auto mt-6 max-w-md">
      <Card.Header>
        <Card.Title class="text-base">{t('projects.notFoundTitle')}</Card.Title>
        <Card.Description>{t('projects.notFoundBody')}</Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" href="/projects">
          <ArrowLeft class="mr-2 h-4 w-4" />
          {t('projects.backToProjects')}
        </Button>
      </Card.Content>
    </Card.Root>
  </div>
{:else if loadError || !project}
  <p class="text-sm text-destructive" in:appear>{t('projects.loadOneFailed', { error: loadError ?? '' })}</p>
{:else}
  <ProjectHeader {project} onChanged={read} />
  <div class="space-y-10">
    <ProjectMembers {project} {myUserId} onChanged={read} />
    {#if Resources}
      <Resources {project} />
    {/if}
  </div>
{/if}
