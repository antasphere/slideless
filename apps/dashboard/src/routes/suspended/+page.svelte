<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  // This page maps to hub_unavailable ONLY (user-scoped federation):
  // suspension never strands the shell anymore — /me is exempt, so a
  // suspended org shows as a badged, disabled switcher entry instead.
  // load() gates the visit; the copy is static.
</script>

<div class="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
  <h1 class="text-2xl font-semibold">{t('suspended.unavailableTitle')}</h1>
  <p class="max-w-md text-sm text-muted-foreground">{t('suspended.unavailableBody')}</p>
  <div class="flex gap-2">
    <Button onclick={() => window.location.assign('/')}>{t('common.tryAgain')}</Button>
    <Button variant="outline" onclick={() => signOutToLogin()}>{t('nav.signOut')}</Button>
  </div>
</div>
