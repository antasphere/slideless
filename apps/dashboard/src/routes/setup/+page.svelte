<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Card from '$lib/components/ui/card/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { api, PlatformApiError } from '$lib/api';
  import { authClient } from '$lib/auth-client';
  import { refreshSession } from '$lib/session';
  import { t } from '$lib/i18n';

  let instanceName = $state('');
  let ownerName = $state('');
  let ownerEmail = $state('');
  let ownerPassword = $state('');
  // Shown from the start (PRDCT-2389): the claim ALWAYS requires the token on
  // an unclaimed instance (PRDCT-1347), and this page renders only while the
  // instance is unclaimed, so there is nothing to discover by being refused.
  // Presentation only: the server's check and its 403/410 are untouched.
  let setupToken = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function submit() {
    error = null;
    if (ownerPassword.length < 12) {
      error = t('common.errorPasswordLength');
      return;
    }
    loading = true;
    try {
      await api.setup({
        instanceName,
        owner: { name: ownerName, email: ownerEmail, password: ownerPassword },
        ...(setupToken ? { setupToken } : {})
      });

      const { error: signInErr } = await authClient.signIn.email({
        email: ownerEmail,
        password: ownerPassword
      });
      await refreshSession();
      if (signInErr) {
        // Setup succeeded but auto sign-in failed — land on login, not limbo.
        await goto('/login');
        return;
      }
      await goto('/');
    } catch (e) {
      if (e instanceof PlatformApiError && e.code === 'invalid_setup_token') {
        error = setupToken ? t('setup.errorTokenInvalid') : t('setup.errorTokenRequired');
      } else if (e instanceof PlatformApiError && e.status === 410) {
        error = t('setup.errorAlreadySetUp');
        await refreshSession();
        await goto('/login');
      } else if (e instanceof PlatformApiError && e.code === 'validation_error') {
        error = t('setup.errorValidation');
      } else if (e instanceof PlatformApiError) {
        error = e.message;
      } else {
        error = t('setup.errorUnreachable');
      }
    } finally {
      loading = false;
    }
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<GateShell width="max-w-md">
  <Card.Root class="w-full border-0 bg-transparent shadow-none">
    <Card.Header>
      <Card.Title class="font-display text-xl font-normal">{t('setup.title')}</Card.Title>
      <Card.Description>{t('setup.description')}</Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        class="space-y-4"
        onsubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="space-y-2">
          <Label for="instance-name">{t('setup.instanceName')}</Label>
          <Input id="instance-name" bind:value={instanceName} placeholder="Acme Platform" required />
        </div>

        <Separator />

        <div class="space-y-2">
          <Label for="owner-name">{t('setup.yourName')}</Label>
          <Input id="owner-name" autocomplete="name" bind:value={ownerName} required />
        </div>
        <div class="space-y-2">
          <Label for="owner-email">{t('setup.email')}</Label>
          <Input id="owner-email" type="email" autocomplete="email" bind:value={ownerEmail} required />
        </div>
        <div class="space-y-2">
          <Label for="owner-password">{t('setup.password')}</Label>
          <Input
            id="owner-password"
            type="password"
            autocomplete="new-password"
            bind:value={ownerPassword}
            required
          />
          <p class="text-xs text-muted-foreground">{t('common.passwordMinHint')}</p>
        </div>

        <Separator />

        <div class="space-y-2">
          <Label for="setup-token">{t('setup.setupToken')}</Label>
          <Input id="setup-token" autocomplete="off" spellcheck={false} bind:value={setupToken} required />
          <p class="text-xs text-muted-foreground">{t('setup.setupTokenHint')}</p>
        </div>

        {#if error}
          <p class="text-sm text-destructive">{error}</p>
        {/if}

        <Button type="submit" class="w-full" disabled={loading}>
          {loading ? t('setup.creating') : t('setup.submit')}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</GateShell>
