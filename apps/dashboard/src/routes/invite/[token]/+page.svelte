<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import * as Card from '$lib/components/ui/card/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { api, PlatformApiError, WORKSPACE_STORAGE_KEY } from '$lib/api';
  import { authClient, isTwoFactorRedirect } from '$lib/auth-client';
  import { refreshSession } from '$lib/session';
  import NameFields from '$lib/components/shared/NameFields.svelte';
  import { joinPersonName } from '$lib/person-name';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const token = $derived(data.token);
  const lookup = $derived(data.lookup);
  // Cloud (D1): 'antasphere' advertised means the hub is the human entrance.
  const hasAntasphere = $derived(data.instance.auth.methods.includes('antasphere'));
  // Already signed in as the invited account → one-click accept.
  const signedInMatch = $derived(data.me !== null && lookup !== null && data.me.user.email === lookup.email);

  // A view-only split: the API still takes one `name` ($lib/person-name.ts).
  let firstName = $state('');
  let lastName = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  // The lookup deliberately carries no account-existence signal (PRDCT-1437):
  // the invitee picks the path themselves.
  let mode = $state<'create' | 'signin'>('create');
  let deadReason = $state<string | null>(null);

  /** The return from the hub carries this mark: the person already chose to accept. */
  const ACCEPT_ON_RETURN = 'accept';

  onMount(() => {
    if (!signedInMatch) return;
    if (new URLSearchParams(window.location.search).get(ACCEPT_ON_RETURN) !== '1') return;
    void acceptAsSignedIn();
  });

  /**
   * Land IN THE WORKSPACE THE INVITATION NAMES: a person who already belongs
   * to another workspace (on cloud, always: their own organization is
   * projected at sign-in) would otherwise open their default one. Full
   * navigation, so the api client reboots with the persisted selection (the
   * collaborator claim's pattern).
   */
  async function finish(workspaceId: string) {
    try {
      globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
    } catch {
      // Not persistable: the dashboard opens the default workspace; the
      // membership stands either way.
    }
    await refreshSession();
    window.location.assign('/');
  }

  async function acceptAsSignedIn() {
    error = null;
    loading = true;
    try {
      const accepted = await api.acceptInvitation({ token });
      await finish(accepted.workspaceId);
    } catch (e) {
      handleAcceptError(e);
    } finally {
      loading = false;
    }
  }

  /** Cloud: through the hub, back to this exact page, then accept. */
  async function signInWithAntasphere() {
    error = null;
    loading = true;
    try {
      const { error: err } = await authClient.signIn.oauth2({
        providerId: 'antasphere',
        callbackURL: `/invite/${token}?${ACCEPT_ON_RETURN}=1`,
        errorCallbackURL: `/invite/${token}`
      });
      if (err) {
        loading = false;
        error = err.message || t('invite.errorSignInFailed');
      }
      // Success answers { url, redirect: true } and the client navigates to
      // the hub; keep `loading` on while the browser leaves the page.
    } catch {
      loading = false;
      error = t('invite.errorSignInFailed');
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
      const accepted = await api.acceptInvitation({ token });
      await finish(accepted.workspaceId);
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
      const accepted = await api.acceptInvitation({
        token,
        name: joinPersonName(firstName, lastName),
        password
      });
      const { error: err } = await authClient.signIn.email({ email: lookup.email, password });
      if (err) {
        // Account exists and membership is granted — a manual login still works.
        await goto('/login');
        return;
      }
      await finish(accepted.workspaceId);
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
      if (e.code === 'sso_required') {
        error = t('invite.ssoIntro');
        return;
      }
      error = e.message;
      return;
    }
    error = t('common.errorGenericRetry');
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<GateShell width="max-w-md" eyebrow={t('gate.eyebrowInvite')}>
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
          <FormError message={error} />
          <Button class="w-full" disabled={loading} onclick={() => void acceptAsSignedIn()}>
            {loading ? t('invite.accepting') : t('invite.accept')}
          </Button>
        {:else if hasAntasphere}
          <!-- Cloud (D1): the hub is the only human entrance, for an existing
               account and a new invitee alike (the SSO callback creates the
               account and returns here, where the invitation is accepted). -->
          {#if data.me !== null}
            <p class="text-sm text-muted-foreground">
              {t('invite.ssoWrongAccount', { current: data.me.user.email, email: lookup.email })}
            </p>
          {:else}
            <p class="text-sm text-muted-foreground">{t('invite.ssoIntro')}</p>
          {/if}
          <FormError message={error} />
          <Button class="w-full" disabled={loading} onclick={() => void signInWithAntasphere()}>
            {loading ? t('invite.accepting') : t('login.signInWithAntasphere')}
          </Button>
        {:else if mode === 'signin'}
          <form
            in:appear
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
            <FormError message={error} />
            <Button type="submit" class="w-full" disabled={loading}>
              {loading ? t('common.working') : t('invite.signInAndAccept')}
            </Button>
          </form>
          <button
            type="button"
            class="text-sm text-muted-foreground underline underline-offset-4"
            onclick={() => (mode = 'create')}
          >
            {t('invite.switchToCreate')}
          </button>
        {:else}
          <form
            in:appear
            class="space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void createAndAccept();
            }}
          >
            <NameFields idPrefix="invite" bind:first={firstName} bind:last={lastName} />
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
            <FormError message={error} />
            <Button type="submit" class="w-full" disabled={loading}>
              {loading ? t('invite.joining') : t('invite.createAndJoin')}
            </Button>
          </form>
          <button
            type="button"
            class="text-sm text-muted-foreground underline underline-offset-4"
            onclick={() => (mode = 'signin')}
          >
            {t('invite.switchToSignIn')}
          </button>
        {/if}
      </Card.Content>
    {/if}
  </Card.Root>
</GateShell>
