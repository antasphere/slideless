<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { t } from '$lib/i18n';

  onMount(() => {
    document.getElementById('splash')?.remove();
  });
</script>

<GateShell palette="paper" strength="quiet" width="max-w-md">
  <div class="flex flex-col items-center gap-4 p-8 text-center">
    <h1 class="font-display text-3xl font-normal">{page.status}</h1>
    <p class="max-w-md text-sm text-muted-foreground">
      {page.error?.message ?? t('error.generic')}
    </p>
    <Button onclick={() => window.location.assign('/')}>{t('common.backToDashboard')}</Button>
  </div>
</GateShell>
