<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { api, PlatformApiError } from '$lib/api';
  import { authClient, isTwoFactorRedirect } from '$lib/auth-client';
  import { refreshSession } from '$lib/session';
  import { t } from '$lib/i18n';

  /**
   * Collaborator claim page (the /invite/[token] pattern): resolves the
   * claim token, then claims as the signed-in matching account, signs in an
   * existing account first, or creates the account inline. Claiming lands
   * on the deck the grant is for.
   */

  let { data } = $props();

  const token = $derived(data.token);
  const lookup = $derived(data.lookup);
  // Already signed in as the invited account → one-click claim.
  const signedInMatch = $derived(data.me !== null && lookup !== null && data.me.user.email === lookup.email);

  let name = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  let deadReason = $state<string | null>(null);

  async function finish(presentationId: string) {
    await refreshSession();
    await goto(`/decks/${presentationId}`);
  }

  async function claimAsSignedIn() {
    error = null;
    loading = true;
    try {
      const claimed = await api.claimCollaboratorInvite({ token });
      await finish(claimed.collaborator.presentationId);
    } catch (e) {
      handleClaimError(e);
    } finally {
      loading = false;
    }
  }

  async function signInAndClaim() {
    if (!lookup) return;
    error = null;
    loading = true;
    try {
      const { data: signInData, error: err } = await authClient.signIn.email({
        email: lookup.email,
        password
      });
      if (err) {
        error =
          err.status === 401 ? t('collab.errorWrongPassword') : err.message || t('collab.errorSignInFailed');
        return;
      }
      // 2FA-enrolled account: complete the second factor on the login page,
      // which lands back here signed in for the one-click claim.
      if (isTwoFactorRedirect(signInData)) {
        await goto(`/login?next=${encodeURIComponent(`/collab/${token}`)}`);
        return;
      }
      const claimed = await api.claimCollaboratorInvite({ token });
      await finish(claimed.collaborator.presentationId);
    } catch (e) {
      handleClaimError(e);
    } finally {
      loading = false;
    }
  }

  async function createAndClaim() {
    if (!lookup) return;
    error = null;
    if (password.length < 12) {
      error = t('common.errorPasswordLength');
      return;
    }
    loading = true;
    try {
      const claimed = await api.claimCollaboratorInvite({ token, name, password });
      const { error: err } = await authClient.signIn.email({ email: lookup.email, password });
      if (err) {
        // Account exists and the grant is claimed — a manual login still works.
        await goto('/login');
        return;
      }
      await finish(claimed.collaborator.presentationId);
    } catch (e) {
      handleClaimError(e);
    } finally {
      loading = false;
    }
  }

  function handleClaimError(e: unknown) {
    if (e instanceof PlatformApiError) {
      if (e.status === 410) {
        deadReason = t('collab.deadUsed');
        return;
      }
      if (e.status === 404) {
        deadReason = t('collab.deadGone');
        return;
      }
      error = e.message;
      return;
    }
    error = t('common.errorGenericRetry');
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<div class="flex min-h-dvh items-center justify-center bg-surface-secondary p-6">
  <Card.Root class="w-full max-w-md">
    {#if data.state === 'dead' || deadReason}
      <Card.Header>
        <Card.Title class="text-xl">{t('collab.deadTitle')}</Card.Title>
        <Card.Description>
          {deadReason ?? t('collab.deadDescription')}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" class="w-full" onclick={() => goto('/login')}>
          {t('common.goToSignIn')}
        </Button>
      </Card.Content>
    {:else if data.state === 'error' || !lookup}
      <Card.Header>
        <Card.Title class="text-xl">{t('collab.errorTitle')}</Card.Title>
        <Card.Description>{t('collab.errorDescription')}</Card.Description>
      </Card.Header>
    {:else}
      <Card.Header>
        <!-- SECURITY: the deck title is USER-AUTHORED text interpolated by
             t() and rendered with Svelte {…} — escaped. Never {@html}. -->
        <Card.Title class="text-xl">{t('collab.joinTitle', { deck: lookup.presentationTitle })}</Card.Title>
        <Card.Description>
          {t('collab.invitedAs', { email: lookup.email })}
          <Badge variant="secondary" class="align-middle">{lookup.role}</Badge>
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if signedInMatch}
          {#if error}
            <p class="text-sm text-destructive">{error}</p>
          {/if}
          <Button class="w-full" disabled={loading} onclick={() => void claimAsSignedIn()}>
            {loading ? t('collab.claiming') : t('collab.claim')}
          </Button>
        {:else if lookup.accountExists}
          <p class="text-sm text-muted-foreground">
            {t('collab.accountExists')}
          </p>
          <form
            class="space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void signInAndClaim();
            }}
          >
            <div class="space-y-2">
              <Label for="collab-password">{t('collab.passwordFor', { email: lookup.email })}</Label>
              <Input
                id="collab-password"
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
              {loading ? t('common.working') : t('collab.signInAndClaim')}
            </Button>
          </form>
        {:else}
          <form
            class="space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void createAndClaim();
            }}
          >
            <div class="space-y-2">
              <Label for="collab-name">{t('collab.yourName')}</Label>
              <Input id="collab-name" autocomplete="name" bind:value={name} required />
            </div>
            <div class="space-y-2">
              <Label for="collab-new-password">{t('collab.choosePassword')}</Label>
              <Input
                id="collab-new-password"
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
              {loading ? t('collab.claiming') : t('collab.createAndClaim')}
            </Button>
          </form>
        {/if}
      </Card.Content>
    {/if}
  </Card.Root>
</div>
