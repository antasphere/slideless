<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Card from '$lib/components/ui/card/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { api, PlatformApiError } from '$lib/api';
  import { authClient, isTwoFactorRedirect } from '$lib/auth-client';
  import { refreshSession } from '$lib/session';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const token = $derived(data.token);
  const lookup = $derived(data.lookup);
  // Already signed in as the invited account → one-click accept.
  const signedInMatch = $derived(data.me !== null && lookup !== null && data.me.user.email === lookup.email);

  let name = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  let deadReason = $state<string | null>(null);

  async function finish() {
    await refreshSession();
    await goto('/');
  }

  async function acceptAsSignedIn() {
    error = null;
    loading = true;
    try {
      await api.acceptInvitation({ token });
      await finish();
    } catch (e) {
      handleAcceptError(e);
    } finally {
      loading = false;
    }
  }

  async function signInAndAccept() {
    if (!lookup) return;
    error = null;
    loading = true;
    try {
      const { data, error: err } = await authClient.signIn.email({ email: lookup.email, password });
      if (err) {
        error =
          err.status === 401 ? t('invite.errorWrongPassword') : err.message || t('invite.errorSignInFailed');
        return;
      }
      // 2FA-enrolled account: complete the second factor on the login page,
      // which lands back here signed in for the one-click accept.
      if (isTwoFactorRedirect(data)) {
        await goto(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
        return;
      }
      await api.acceptInvitation({ token });
      await finish();
    } catch (e) {
      handleAcceptError(e);
    } finally {
      loading = false;
    }
  }

  async function createAndAccept() {
    if (!lookup) return;
    error = null;
    if (password.length < 12) {
      error = t('common.errorPasswordLength');
      return;
    }
    loading = true;
    try {
      await api.acceptInvitation({ token, name, password });
      const { error: err } = await authClient.signIn.email({ email: lookup.email, password });
      if (err) {
        // Account exists and membership is granted — a manual login still works.
        await goto('/login');
        return;
      }
      await finish();
    } catch (e) {
      handleAcceptError(e);
    } finally {
      loading = false;
    }
  }

  function handleAcceptError(e: unknown) {
    if (e instanceof PlatformApiError) {
      if (e.status === 410) {
        deadReason = t('invite.deadUsed');
        return;
      }
      if (e.status === 404) {
        deadReason = t('invite.deadGone');
        return;
      }
      error = e.message;
      return;
    }
    error = t('common.errorGenericRetry');
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<GateShell width="max-w-md">
  <Card.Root class="w-full border-0 bg-transparent shadow-none">
    {#if data.state === 'dead' || deadReason}
      <Card.Header>
        <Card.Title class="font-display text-xl font-normal">{t('invite.deadTitle')}</Card.Title>
        <Card.Description>
          {deadReason ?? t('invite.deadDescription')}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" class="w-full" onclick={() => goto('/login')}>
          {t('common.goToSignIn')}
        </Button>
      </Card.Content>
    {:else if data.state === 'error' || !lookup}
      <Card.Header>
        <Card.Title class="font-display text-xl font-normal">{t('invite.errorTitle')}</Card.Title>
        <Card.Description>{t('invite.errorDescription')}</Card.Description>
      </Card.Header>
    {:else}
      <Card.Header>
        <Card.Title class="font-display text-xl font-normal"
          >{t('invite.joinTitle', { workspace: lookup.workspaceName })}</Card.Title
        >
        <Card.Description>
          {t('invite.invitedAs', { email: lookup.email })}
          <Badge variant="secondary" class="align-middle">{lookup.role}</Badge>
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if signedInMatch}
          {#if error}
            <p class="text-sm text-destructive">{error}</p>
          {/if}
          <Button class="w-full" disabled={loading} onclick={() => void acceptAsSignedIn()}>
            {loading ? t('invite.accepting') : t('invite.accept')}
          </Button>
        {:else if lookup.accountExists}
          <p class="text-sm text-muted-foreground">
            {t('invite.accountExists')}
          </p>
          <form
            class="space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void signInAndAccept();
            }}
          >
            <div class="space-y-2">
              <Label for="invite-password">{t('invite.passwordFor', { email: lookup.email })}</Label>
              <Input
                id="invite-password"
                type="password"
                autocomplete="current-password"
                bind:value={password}
                required
              />
            </div>
            {#if error}
              <p class="text-sm text-destructive">{error}</p>
            {/if}
            <Button type="submit" class="w-full" disabled={loading}>
              {loading ? t('common.working') : t('invite.signInAndAccept')}
            </Button>
          </form>
        {:else}
          <form
            class="space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void createAndAccept();
            }}
          >
            <div class="space-y-2">
              <Label for="invite-name">{t('invite.yourName')}</Label>
              <Input id="invite-name" autocomplete="name" bind:value={name} required />
            </div>
            <div class="space-y-2">
              <Label for="invite-new-password">{t('invite.choosePassword')}</Label>
              <Input
                id="invite-new-password"
                type="password"
                autocomplete="new-password"
                bind:value={password}
                required
              />
              <p class="text-xs text-muted-foreground">{t('common.passwordMinHint')}</p>
            </div>
            {#if error}
              <p class="text-sm text-destructive">{error}</p>
            {/if}
            <Button type="submit" class="w-full" disabled={loading}>
              {loading ? t('invite.joining') : t('invite.createAndJoin')}
            </Button>
          </form>
        {/if}
      </Card.Content>
    {/if}
  </Card.Root>
</GateShell>
