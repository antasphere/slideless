<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { authClient } from '$lib/auth-client';
  import { t } from '$lib/i18n';

  let email = $state('');
  let sent = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);

  function authErrorMessage(status: number): string | null {
    if (status === 429) return t('common.errorRateLimitedRetry');
    return null;
  }

  async function submit() {
    error = null;
    loading = true;
    try {
      const { error: err } = await authClient.requestPasswordReset({
        email,
        redirectTo: window.location.origin + '/reset-password'
      });
      if (err) {
        const rateLimited = authErrorMessage(err.status ?? 0);
        if (rateLimited) {
          error = rateLimited;
          return;
        }
      }
      // Success and failure look identical on purpose: no account enumeration.
      sent = true;
    } finally {
      loading = false;
    }
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<GateShell width="max-w-sm" eyebrow={t('gate.eyebrowPassword')}>
  <Card.Root class="w-full border-0 bg-transparent shadow-none">
    <Card.Header>
      <Card.Title class="font-display text-xl font-normal">{t('forgot.title')}</Card.Title>
      <Card.Description>{t('forgot.description')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#if sent}
        <p class="text-sm text-muted-foreground" in:appear>{t('forgot.sent')}</p>
      {:else}
        <form
          class="space-y-4"
          onsubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div class="space-y-2">
            <Label for="reset-email">{t('forgot.email')}</Label>
            <Input id="reset-email" type="email" autocomplete="email" bind:value={email} required />
          </div>
          <FormError message={error} />
          <Button type="submit" class="w-full" disabled={loading}>
            {loading ? t('common.sending') : t('forgot.submit')}
          </Button>
        </form>
      {/if}
      <div class="text-center">
        <a href="/login" class="text-sm text-muted-foreground underline-offset-4 hover:underline">
          {t('forgot.backToSignIn')}
        </a>
      </div>
    </Card.Content>
  </Card.Root>
</GateShell>
