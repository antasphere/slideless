<script lang="ts">
  import { Tag, TagList } from '$lib/components/ui/tag';
  import { methodTag, roleTag } from '$lib/tags';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Download from '@lucide/svelte/icons/download';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { api } from '$lib/api';
  import { download } from '$lib/download';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const isAdmin = $derived(data.me.role === 'owner' || data.me.role === 'admin');

  let signingOut = $state(false);
  let exporting = $state(false);

  async function handleSignOut() {
    signingOut = true;
    try {
      await signOutToLogin();
    } finally {
      signingOut = false;
    }
  }

  /**
   * Export through $lib/download, the dashboard's one download path, not a
   * plain <a href>: an anchor cannot carry the X-Workspace-Id header, so on
   * a multi-workspace account it would export the DEFAULT workspace instead
   * of the active one (ADR 014). The file keeps the name the server gives it;
   * the dated name below is only the fallback. The helper's trade-off (the
   * zip is one Blob before the save dialog) is stated there.
   */
  async function handleExport() {
    exporting = true;
    try {
      await download(() => api.downloadExport(), {
        fallbackName: `workspace-export-${new Date().toISOString().slice(0, 10)}.zip`
      });
    } finally {
      exporting = false;
    }
  }

  // Settings is one section with two tabs (PRDCT-2441): the instance, and the
  // person's own account, so nobody has to find it under their name.
  const settingsTabs = [
    { href: '/settings', label: t('settings.tabInstance') },
    { href: '/account', label: t('settings.tabAccount') }
  ];
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  lede={t('settings.description')}
  pageTitle={t('settings.tabInstance')}
  tabs={settingsTabs}
  drawing="meridians"
/>

<div class="grid gap-6 lg:grid-cols-2">
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('settings.instanceTitle')}</Card.Title>
      <Card.Description>{t('settings.instanceDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="facts text-sm">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.name')}</span>
        <span class="font-medium">{data.instance.name}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.version')}</span>
        <span>{data.instance.version}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.edition')}</span>
        <span>{data.instance.edition}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.instanceId')}</span>
        {#if data.instance.instanceId}
          <Tag label={data.instance.instanceId} mono />
        {:else}
          <span class="text-muted-foreground">—</span>
        {/if}
      </div>
      <div class="flex items-center justify-between gap-4">
        <span class="text-muted-foreground">{t('settings.signInMethods')}</span>
        <span class="flex justify-end"><TagList tags={data.instance.auth.methods.map(methodTag)} /></span>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('settings.accountTitle')}</Card.Title>
      <Card.Description>{t('settings.signedInVia', { via: data.me.via })}</Card.Description>
    </Card.Header>
    <Card.Content class="facts text-sm">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.name')}</span>
        <span class="font-medium">{data.me.user.name}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.email')}</span>
        <span>{data.me.user.email}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.role')}</span>
        <Tag {...roleTag(data.me.role)} />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.workspace')}</span>
        <span>{data.me.workspace.name}</span>
      </div>
      <div class="flex flex-wrap gap-2 pt-4">
        <Button href="/account">{t('settings.openAccount')}</Button>
        <Button variant="outline" onclick={() => void handleSignOut()} disabled={signingOut}>
          <LogOut class="mr-2 h-4 w-4" />
          {signingOut ? t('settings.signingOut') : t('settings.signOut')}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  {#if isAdmin}
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">{t('settings.exportTitle')}</Card.Title>
        <Card.Description>
          {t('settings.exportDescription')}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" onclick={() => void handleExport()} disabled={exporting}>
          <Download class="mr-2 h-4 w-4" />
          {exporting ? t('common.working') : t('settings.exportButton')}
        </Button>
        <p class="pt-3 text-xs text-muted-foreground">
          {t('settings.exportHint')}
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
