<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const suspended = $derived(data.meError === 'account_suspended');
</script>

<div class="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
  <h1 class="text-2xl font-semibold">
    {suspended ? t('suspended.title') : t('suspended.unavailableTitle')}
  </h1>
  <p class="max-w-md text-sm text-muted-foreground">
    {suspended ? t('suspended.body') : t('suspended.unavailableBody')}
  </p>
  <div class="flex gap-2">
    <Button onclick={() => window.location.assign('/')}>{t('common.tryAgain')}</Button>
    <Button variant="outline" onclick={() => signOutToLogin()}>{t('nav.signOut')}</Button>
  </div>
</div>
