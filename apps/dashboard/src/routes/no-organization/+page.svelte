<script module lang="ts">
  /**
   * The re-admission poll's cadence. The server's zero-state read runs the
   * reconciler's cached pass (10 s TTL, 15 s retry throttle), so a faster
   * poll would buy nothing.
   */
  export const READMISSION_POLL_MS = 10_000;
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import CreateWorkspaceDialog from '$lib/components/sidebar/CreateWorkspaceDialog.svelte';
  import { signOutToLogin } from '$lib/session';
  import { getLocale, t } from '$lib/i18n';
  import { hubLinkHere } from '$lib/hub-links';
  import { api } from '$lib/api';

  let { data } = $props();

  // On cloud, organizations are created at the hub — /me carries the CTA
  // target (hubManageUrl) even in the zero-membership state. On oss (no
  // hub) the honest copy is "ask for an invitation".
  const hubManageUrl = $derived(data.me.hubManageUrl);

  // The hub says an organization of this person's does not open the tool to
  // them (it lets only some of its teams use it): name it, and send them to
  // the hub's page of whom to ask. Absent (oss, an older server) reads as none.
  const denied = $derived(data.me.hubDenied ?? []);
  const toolName = $derived(data.instance.name);
  const deniedOrg = $derived(denied.length === 1 ? (denied[0]?.name ?? '') : t('noOrg.deniedOrgsMany'));
  const deniedList = $derived(
    new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(denied.map((o) => o.name))
  );
  const noAccessUrl = $derived(data.me.hubNoAccessUrl ?? null);

  // When /me says this person may create a workspace (PRDCT-2443), the same
  // dialog as the sidebar's is the way out of the zero state: the server
  // serves the zero-membership session on that route, and switching into the
  // new workspace reloads this page, which then bounces home. The link-out
  // stays for everyone the flag is false for.
  const canCreate = $derived(data.me.canCreateWorkspace);
  let showCreateDialog = $state(false);

  // Re-admission: while the hub names an organization that does not open
  // the tool to this person, re-read /me every ten seconds (the server's
  // zero-state read runs the hub pass itself) and open the workspace as
  // soon as the answer carries one. A hidden tab stops; showing it resumes.
  let visibility = $state<'visible' | 'hidden'>(
    typeof document === 'undefined' ? 'hidden' : document.visibilityState
  );
  $effect(() => {
    const onVisibility = () => (visibility = document.visibilityState);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });
  $effect(() => {
    if (!(denied.length > 0 && visibility === 'visible')) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const me = await api.me().catch(() => null);
      if (!stopped && me?.workspace) {
        stopped = true;
        clearInterval(timer);
        window.location.assign('/');
      }
    }, READMISSION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });
</script>

<GateShell palette="paper" strength="quiet" width="max-w-md" eyebrow={t('gate.eyebrowEdge')}>
  <div class="flex flex-col items-center gap-4 p-8 text-center">
    {#if denied.length > 0}
      <h1 class="font-display text-2xl font-normal">
        {t('noOrg.titleDenied', { tool: toolName, org: deniedOrg })}
      </h1>
      <p class="max-w-md text-sm text-muted-foreground">
        {denied.length === 1
          ? t('noOrg.bodyDenied', { org: deniedOrg, tool: toolName })
          : t('noOrg.bodyDeniedMany', { orgs: deniedList, tool: toolName })}
      </p>
    {:else}
      <h1 class="font-display text-2xl font-normal">
        {canCreate ? t('noOrg.titleCreate') : t('noOrg.title')}
      </h1>
      <p class="max-w-md text-sm text-muted-foreground">
        {canCreate ? t('noOrg.bodyCreate') : hubManageUrl ? t('noOrg.body') : t('noOrg.bodyLocal')}
      </p>
    {/if}
    <div class="flex flex-wrap justify-center gap-2">
      {#if denied.length > 0 && noAccessUrl}
        <Button href={hubLinkHere(noAccessUrl)} target="_blank" rel="noopener noreferrer">
          {t('noOrg.ctaDenied')}
        </Button>
      {:else if canCreate}
        <Button onclick={() => (showCreateDialog = true)} data-testid="workspace-create">
          {t('workspace.createSubmit')}
        </Button>
      {:else if hubManageUrl}
        <Button href={hubLinkHere(hubManageUrl)} target="_blank" rel="noopener noreferrer"
          >{t('noOrg.cta')}</Button
        >
      {/if}
      <Button variant="outline" onclick={() => window.location.assign('/')}>{t('common.tryAgain')}</Button>
      <Button variant="outline" onclick={() => signOutToLogin()}>{t('nav.signOut')}</Button>
    </div>
  </div>
</GateShell>

{#if canCreate}
  <CreateWorkspaceDialog bind:open={showCreateDialog} />
{/if}
