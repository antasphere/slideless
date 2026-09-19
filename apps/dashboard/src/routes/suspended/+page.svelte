<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  // This page maps to hub_unavailable ONLY (user-scoped federation):
  // suspension never strands the shell anymore — /me is exempt, so a
  // suspended org shows as a badged, disabled switcher entry instead.
  // load() gates the visit; the copy is static.
</script>

<GateShell palette="paper" strength="quiet" width="max-w-md" eyebrow={t('gate.eyebrowEdge')}>
  <div class="flex flex-col items-center gap-4 p-8 text-center">
    <h1 class="font-display text-2xl font-normal">{t('suspended.unavailableTitle')}</h1>
    <p class="max-w-md text-sm text-muted-foreground">{t('suspended.unavailableBody')}</p>
    <div class="flex gap-2">
      <Button onclick={() => window.location.assign('/')}>{t('common.tryAgain')}</Button>
      <Button variant="outline" onclick={() => signOutToLogin()}>{t('nav.signOut')}</Button>
    </div>
  </div>
</GateShell>
