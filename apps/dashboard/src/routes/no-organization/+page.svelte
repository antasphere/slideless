<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // On cloud, organizations are created at the hub — /me carries the CTA
  // target (hubManageUrl) even in the zero-membership state. On oss (no
  // hub) the honest copy is "ask for an invitation".
  const hubManageUrl = $derived(data.me.hubManageUrl);
</script>

<div class="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
  <h1 class="text-2xl font-semibold">{t('noOrg.title')}</h1>
  <p class="max-w-md text-sm text-muted-foreground">
    {hubManageUrl ? t('noOrg.body') : t('noOrg.bodyLocal')}
  </p>
  <div class="flex gap-2">
    {#if hubManageUrl}
      <Button href={hubManageUrl} target="_blank" rel="noopener noreferrer">{t('noOrg.cta')}</Button>
    {/if}
    <Button variant="outline" onclick={() => window.location.assign('/')}>{t('common.tryAgain')}</Button>
    <Button variant="outline" onclick={() => signOutToLogin()}>{t('nav.signOut')}</Button>
  </div>
</div>
