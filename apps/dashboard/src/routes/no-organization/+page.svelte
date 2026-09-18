<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import CreateWorkspaceDialog from '$lib/components/sidebar/CreateWorkspaceDialog.svelte';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // On cloud, organizations are created at the hub — /me carries the CTA
  // target (hubManageUrl) even in the zero-membership state. On oss (no
  // hub) the honest copy is "ask for an invitation".
  const hubManageUrl = $derived(data.me.hubManageUrl);

  // When /me says this person may create a workspace (PRDCT-2443), the same
  // dialog as the sidebar's is the way out of the zero state: the server
  // serves the zero-membership session on that route, and switching into the
  // new workspace reloads this page, which then bounces home. The link-out
  // stays for everyone the flag is false for.
  const canCreate = $derived(data.me.canCreateWorkspace);
  let showCreateDialog = $state(false);
</script>

<GateShell palette="paper" strength="quiet" width="max-w-md">
  <div class="flex flex-col items-center gap-4 p-8 text-center">
    <h1 class="font-display text-2xl font-normal">
      {canCreate ? t('noOrg.titleCreate') : t('noOrg.title')}
    </h1>
    <p class="max-w-md text-sm text-muted-foreground">
      {canCreate ? t('noOrg.bodyCreate') : hubManageUrl ? t('noOrg.body') : t('noOrg.bodyLocal')}
    </p>
    <div class="flex flex-wrap justify-center gap-2">
      {#if canCreate}
        <Button onclick={() => (showCreateDialog = true)} data-testid="workspace-create">
          {t('workspace.createSubmit')}
        </Button>
      {:else if hubManageUrl}
        <Button href={hubManageUrl} target="_blank" rel="noopener noreferrer">{t('noOrg.cta')}</Button>
      {/if}
      <Button variant="outline" onclick={() => window.location.assign('/')}>{t('common.tryAgain')}</Button>
      <Button variant="outline" onclick={() => signOutToLogin()}>{t('nav.signOut')}</Button>
    </div>
  </div>
</GateShell>

{#if canCreate}
  <CreateWorkspaceDialog bind:open={showCreateDialog} />
{/if}
