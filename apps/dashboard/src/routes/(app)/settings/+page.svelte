<script lang="ts">
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import Download from '@lucide/svelte/icons/download';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { toast } from 'svelte-sonner';
  import { api, errorMessage } from '$lib/api';
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
   * Export via the SDK, not a plain <a href>: an anchor cannot carry the
   * X-Workspace-Id header, so on a multi-workspace account it would export
   * the DEFAULT workspace instead of the active one (ADR 012). Trade-off:
   * the zip is buffered as a Blob before the save dialog — fine for
   * deck-scale exports; multi-GB exports should move to a server-tokenized
   * download URL.
   */
  async function handleExport() {
    exporting = true;
    try {
      const res = await api.downloadExport();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workspace-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      exporting = false;
    }
  }
</script>

<PageHeader title={t('settings.title')} description={t('settings.description')} />

<div class="grid gap-6 lg:grid-cols-2">
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('settings.instanceTitle')}</Card.Title>
      <Card.Description>{t('settings.instanceDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3 text-sm">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.name')}</span>
        <span class="font-medium">{data.instance.name}</span>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.version')}</span>
        <span>{data.instance.version}</span>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.edition')}</span>
        <span>{data.instance.edition}</span>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.instanceId')}</span>
        <code class="text-xs">{data.instance.instanceId ?? '—'}</code>
      </div>
      <Separator />
      <div class="flex items-center justify-between gap-4">
        <span class="text-muted-foreground">{t('settings.signInMethods')}</span>
        <span class="flex flex-wrap justify-end gap-1">
          {#each data.instance.auth.methods as method (method)}
            <Badge variant="outline">{method}</Badge>
          {/each}
        </span>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('settings.accountTitle')}</Card.Title>
      <Card.Description>{t('settings.signedInVia', { via: data.me.via })}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3 text-sm">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.name')}</span>
        <span class="font-medium">{data.me.user.name}</span>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.email')}</span>
        <span>{data.me.user.email}</span>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.role')}</span>
        <Badge variant={data.me.role === 'member' ? 'secondary' : 'default'}>{data.me.role}</Badge>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.workspace')}</span>
        <span>{data.me.workspace.name}</span>
      </div>
      <div class="pt-4">
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
