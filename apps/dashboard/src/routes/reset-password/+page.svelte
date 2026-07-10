<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { authClient } from '$lib/auth-client';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // Better Auth redirects here with either a token or an error (e.g. INVALID_TOKEN).
  const token = $derived(page.url.searchParams.get('token'));
  const linkError = $derived(page.url.searchParams.get('error'));
  const linkDead = $derived(!token || linkError !== null);

  const retryHref = $derived(data.instance.auth.passwordReset ? '/forgot-password' : '/login');
  const retryLabel = $derived(
    data.instance.auth.passwordReset ? t('reset.requestNew') : t('common.goToSignIn')
  );

  let newPassword = $state('');
  let confirmPassword = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function submit() {
    error = null;
    if (newPassword.length < 12) {
      error = t('common.errorPasswordLength');
      return;
    }
    if (newPassword !== confirmPassword) {
      error = t('common.errorPasswordMismatch');
      return;
    }
    if (!token) return;
    loading = true;
    try {
      const { error: err } = await authClient.resetPassword({ newPassword, token });
      if (err) {
        error =
          err.code === 'INVALID_TOKEN'
            ? t('reset.errorInvalidToken')
            : err.status === 429
              ? t('common.errorRateLimitedRetry')
              : err.message || t('reset.errorGeneric');
        return;
      }
      toast.success(t('reset.success'));
      await goto('/login');
    } finally {
      loading = false;
    }
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<div class="flex min-h-dvh items-center justify-center bg-surface-secondary p-6">
  <Card.Root class="w-full max-w-sm">
    {#if linkDead}
      <Card.Header>
        <Card.Title class="text-xl">{t('reset.deadTitle')}</Card.Title>
        <Card.Description>{t('reset.deadDescription')}</Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" class="w-full" onclick={() => goto(retryHref)}>{retryLabel}</Button>
      </Card.Content>
    {:else}
      <Card.Header>
        <Card.Title class="text-xl">{t('reset.title')}</Card.Title>
        <Card.Description>{t('reset.description')}</Card.Description>
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
            <Label for="new-password">{t('reset.newPassword')}</Label>
            <Input
              id="new-password"
              type="password"
              autocomplete="new-password"
              bind:value={newPassword}
              required
            />
            <p class="text-xs text-muted-foreground">{t('common.passwordMinHint')}</p>
          </div>
          <div class="space-y-2">
            <Label for="confirm-password">{t('reset.confirmPassword')}</Label>
            <Input
              id="confirm-password"
              type="password"
              autocomplete="new-password"
              bind:value={confirmPassword}
              required
            />
          </div>
          {#if error}
            <p class="text-sm text-destructive">{error}</p>
          {/if}
          <Button type="submit" class="w-full" disabled={loading}>
            {loading ? t('reset.updating') : t('reset.submit')}
          </Button>
        </form>
      </Card.Content>
    {/if}
  </Card.Root>
</div>
