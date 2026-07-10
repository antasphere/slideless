<script lang="ts">
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import Download from '@lucide/svelte/icons/download';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const isAdmin = $derived(data.me.role === 'owner' || data.me.role === 'admin');

  let signingOut = $state(false);

  async function handleSignOut() {
    signingOut = true;
    try {
      await signOutToLogin();
    } finally {
      signingOut = false;
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
        <!-- A plain link: the download rides the session cookie. -->
        <Button variant="outline" href="/api/v1/workspace/export" download>
          <Download class="mr-2 h-4 w-4" />
          {t('settings.exportButton')}
        </Button>
        <p class="pt-3 text-xs text-muted-foreground">
          {t('settings.exportHint')}
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
