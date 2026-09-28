<script lang="ts">
  import { onMount } from 'svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { api, PlatformApiError } from '$lib/api';
  import { consumeDemoFragment, demoTarget } from '$lib/demo-link';
  import { t } from '$lib/i18n';

  /*
   * A demo link (`/demo#pass=<secret>&to=<path>`), in this order:
   *   1. read `pass` and `to` from the fragment;
   *   2. take the fragment out of the address bar and of this history entry,
   *      before any request, so the secret stays in neither;
   *   3. redeem the pass through the SDK (the sign-in library sets the
   *      session cookie on its answer, replacing any session this browser
   *      had);
   *   4. read the target, then LOAD it as a fresh document, replacing this
   *      history entry. Not a client-side navigation: the browser may have
   *      been signed in as someone else a second ago, and nothing that person's
   *      pages kept in memory may follow the new one. Every target goes
   *      through `safeNext` (`demoTarget`).
   * A refusal is one sentence: never the server's code, never the secret.
   */
  let phase = $state<'working' | 'refused' | 'limited'>('working');

  onMount(() => {
    const { pass, to } = consumeDemoFragment(location, history);
    if (!pass) {
      phase = 'refused';
      return;
    }
    void redeem(pass, to);
  });

  async function redeem(pass: string, to: string | null) {
    let path: string;
    try {
      ({ path } = await api.redeemDemoPass(pass));
    } catch (e) {
      phase = e instanceof PlatformApiError && e.status === 429 ? 'limited' : 'refused';
      return;
    }
    window.location.replace(demoTarget(to, path));
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4 z-20" />

<GateShell eyebrow={t('demo.eyebrow')}>
  <Card.Root>
    {#if phase === 'working'}
      <Card.Header role="status" aria-live="polite">
        <Card.Title>{t('demo.title')}</Card.Title>
        <Card.Description>{t('demo.signingIn')}</Card.Description>
      </Card.Header>
    {:else}
      <Card.Header>
        <Card.Title>{t('demo.title')}</Card.Title>
        <Card.Description role="alert">
          {phase === 'limited' ? t('demo.rateLimited') : t('demo.refused')}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" class="w-full" href="/login">{t('common.goToSignIn')}</Button>
      </Card.Content>
    {/if}
  </Card.Root>
</GateShell>
