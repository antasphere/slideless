<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { t } from '$lib/i18n';

  onMount(() => {
    document.getElementById('splash')?.remove();
  });
</script>

<div class="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
  <h1 class="text-2xl font-semibold">{page.status}</h1>
  <p class="max-w-md text-sm text-muted-foreground">
    {page.error?.message ?? t('error.generic')}
  </p>
  <Button onclick={() => window.location.assign('/')}>{t('common.backToDashboard')}</Button>
</div>
