<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Card from '$lib/components/ui/card/index.js';
  import GateShell from '$lib/components/brand/GateShell.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { authClient, isTwoFactorRedirect } from '$lib/auth-client';
  import { refreshSession } from '$lib/session';
  import {
    clearHintCookieClientSide,
    evaluateAutoConnect,
    isLoginRequiredError,
    pendingNextStorage,
    readAttemptMarker,
    writeAttemptMarker,
    writePendingNext
  } from '$lib/sso';
  import { safeNext } from '$lib/utils';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const methods = $derived(data.instance.auth.methods);
  const hasGoogle = $derived(methods.includes('google'));
  const hasOtp = $derived(methods.includes('email-otp'));
  // On the cloud edition (D1, hub-only login) 'password' is absent and
  // 'antasphere' present — the page then renders ONLY the SSO button.
  const hasPassword = $derived(methods.includes('password'));
  const hasAntasphere = $derived(methods.includes('antasphere'));
  const hasPasswordReset = $derived(data.instance.auth.passwordReset);

  // ── SL-3: the silent auto-connect (cloud only, discovery-gated) ──────────
  // Decided SYNCHRONOUSLY at component init so the FIRST paint is the
  // branded connecting state — the login form never flashes on the silent
  // path. +page.ts already redirected any signed-in visitor (gate E).
  const sso = data.instance.auth.sso ?? null;
  const decision = evaluateAutoConnect({
    sso,
    methods: data.instance.auth.methods,
    cookies: typeof document === 'undefined' ? '' : document.cookie,
    params: page.url.searchParams,
    attemptMarker: readAttemptMarker(),
    now: Date.now(),
    signedIn: false
  });
  // The AS answered a silent attempt with the login_required family: the
  // hint promised a hub session that is not there — retire it so the next
  // visit renders a quiet login page instead of bouncing again.
  if (decision.clearStaleHint && sso) clearHintCookieClientSide(sso);

  let connecting = $state(decision.attempt);
  const signedOutNotice = decision.signedOut;

  onMount(() => {
    if (connecting) void startSilentConnect();
  });

  async function startSilentConnect() {
    const next = safeNext(page.url.searchParams.get('next'));
    // Gate D: the marker goes down BEFORE any navigation so even an
    // unforeseen bounce-back is bounded to one attempt per tab per TTL.
    writeAttemptMarker(Date.now());
    // Return-to-origin (decision 7): remember the destination across
    // journeys that outlive the OAuth state row (the signup detour).
    writePendingNext(pendingNextStorage(), next, Date.now());
    try {
      const { error: err } = await authClient.signIn.oauth2({
        providerId: 'antasphere',
        callbackURL: next,
        // AS failures land back on this page as /login?error=<code>.
        errorCallbackURL: '/login',
        // Only the literal prompt=none pair passes the server whitelist.
        additionalData: { prompt: 'none' }
      });
      // Success answers { url, redirect } and the client navigates to the
      // hub — the connecting state stays up until the browser leaves. A
      // refused sign-in degrades QUIETLY to the form: the user asked for
      // nothing, and the manual button is right there.
      if (err) connecting = false;
    } catch {
      connecting = false;
    }
  }

  let mode = $state<'password' | 'otp'>('password');

  let email = $state('');
  let password = $state('');
  let otp = $state('');
  let otpSent = $state(false);
  let loading = $state(false);
  // A failed SSO dance lands back here with ?error=<code> (both the
  // server's per-login checks and the OAuth plugin's own error redirects).
  let error = $state<string | null>(ssoErrorMessage(page.url.searchParams.get('error')));

  function ssoErrorMessage(code: string | null): string | null {
    if (!code) return null;
    // The login_required family is the hub saying "no session" to a silent
    // prompt=none attempt — an expected outcome, never an error banner.
    if (isLoginRequiredError(code)) return null;
    if (code === 'sso_email_conflict') return t('login.errorSsoEmailConflict');
    if (code === 'sso_identity_conflict') return t('login.errorSsoIdentityConflict');
    return t('login.errorSsoGeneric');
  }

  // Second factor: set when a sign-in answers { twoFactorRedirect } instead
  // of a session (the pending sign-in rides a short-lived signed cookie).
  let totpRequired = $state(false);
  let useBackupCode = $state(false);
  let totpCode = $state('');
  let backupCode = $state('');

  function authErrorMessage(status: number, fallback?: string | null): string {
    if (status === 401) return t('login.errorInvalidCredentials');
    if (status === 403) return t('login.errorForbidden');
    if (status === 429) return t('login.errorRateLimited');
    return fallback || t('login.errorGeneric');
  }

  async function afterSignIn() {
    await refreshSession();
    await goto(safeNext(page.url.searchParams.get('next')));
  }

  async function signInPassword() {
    error = null;
    loading = true;
    try {
      const { data, error: err } = await authClient.signIn.email({ email, password });
      if (err) {
        error = authErrorMessage(err.status ?? 0, err.message);
        return;
      }
      if (isTwoFactorRedirect(data)) {
        totpRequired = true;
        return;
      }
      await afterSignIn();
    } finally {
      loading = false;
    }
  }

  async function verifySecondFactor() {
    error = null;
    loading = true;
    try {
      const { error: err } = useBackupCode
        ? await authClient.twoFactor.verifyBackupCode({ code: backupCode.trim() })
        : await authClient.twoFactor.verifyTotp({ code: totpCode.trim() });
      if (err) {
        error =
          err.status === 401
            ? t(useBackupCode ? 'login.errorInvalidBackupCode' : 'login.errorInvalidTotp')
            : authErrorMessage(err.status ?? 0, err.message);
        return;
      }
      await afterSignIn();
    } finally {
      loading = false;
    }
  }

  function resetSecondFactor() {
    totpRequired = false;
    useBackupCode = false;
    totpCode = '';
    backupCode = '';
    password = '';
    error = null;
  }

  async function sendOtp() {
    error = null;
    loading = true;
    try {
      const { error: err } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (err) {
        error = authErrorMessage(err.status ?? 0, err.message);
        return;
      }
      otpSent = true;
    } finally {
      loading = false;
    }
  }

  async function signInOtp() {
    error = null;
    loading = true;
    try {
      const { data, error: err } = await authClient.signIn.emailOtp({ email, otp });
      if (err) {
        error =
          err.status === 401 ? t('login.errorInvalidOtp') : authErrorMessage(err.status ?? 0, err.message);
        return;
      }
      // A 2FA-enrolled user gets the second-factor step on this path too.
      if (isTwoFactorRedirect(data)) {
        totpRequired = true;
        return;
      }
      await afterSignIn();
    } finally {
      loading = false;
    }
  }

  async function signInGoogle() {
    error = null;
    await authClient.signIn.social({
      provider: 'google',
      callbackURL: safeNext(page.url.searchParams.get('next'))
    });
  }

  async function signInAntasphere() {
    error = null;
    loading = true;
    // Return-to-origin (decision 7): every tool→hub redirect — interactive
    // included — records the destination, so a signup detour that outlives
    // the OAuth state row still ends on the exact page the user wanted.
    writePendingNext(pendingNextStorage(), page.url.searchParams.get('next'), Date.now());
    try {
      const { error: err } = await authClient.signIn.oauth2({
        providerId: 'antasphere',
        callbackURL: safeNext(page.url.searchParams.get('next')),
        // Failed dances land back on this page with ?error=<code>.
        errorCallbackURL: '/login'
      });
      if (err) {
        error = authErrorMessage(err.status ?? 0, err.message);
      }
      // Success answers { url, redirect: true } and the client navigates
      // to the hub; keep `loading` on so the button stays disabled while
      // the browser leaves the page.
    } catch {
      loading = false;
      error = t('login.errorSsoGeneric');
    }
  }
</script>

{#if connecting}
  <!-- SL-3 connecting state (decision 5): a real, branded interstitial that
       OWNS the screen on every visible leg of the silent redirect chain —
       it stays painted until the browser leaves for the hub, and the
       app-shell splash (app.html) covers the callback-return leg, so no
       blank/white frame ever shows between redirects. -->
  <GateShell plate={false}>
    <div class="flex flex-col items-center gap-8 text-center" role="status" aria-live="polite">
      <div class="connect-mark" aria-hidden="true">
        <span class="connect-ring"></span>
        <span class="connect-arc"></span>
        <span class="connect-core"></span>
      </div>
      <div class="space-y-2">
        <h1 class="font-display text-2xl font-normal tracking-tight text-foreground">{data.instance.name}</h1>
        <p class="text-sm text-muted-foreground">{t('login.connectingToAntasphere')}</p>
        <p class="text-xs text-muted-foreground/70">{t('login.connectingHint')}</p>
      </div>
      <div class="connect-dots" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </div>
  </GateShell>
{:else}
  <LanguageSwitcher class="fixed right-4 top-4 z-20" />

  <GateShell>
    <Card.Root class="w-full border-0 bg-transparent shadow-none">
      <Card.Header>
        <Card.Title class="font-display text-xl font-normal">{data.instance.name}</Card.Title>
        <Card.Description>{t('login.subtitle')}</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if signedOutNotice && !totpRequired}
          <!-- Quiet post-logout notice (?signed_out=1) — informational, never
             an error, and the lattice never auto-reconnects from here. -->
          <p class="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {t('login.signedOutNotice')}
          </p>
        {/if}
        {#if totpRequired}
          <form
            class="space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void verifySecondFactor();
            }}
          >
            {#if useBackupCode}
              <div class="space-y-2">
                <Label for="backup-code">{t('login.backupCode')}</Label>
                <Input
                  id="backup-code"
                  autocomplete="off"
                  spellcheck={false}
                  bind:value={backupCode}
                  required
                />
                <p class="text-xs text-muted-foreground">{t('login.backupCodeHint')}</p>
              </div>
            {:else}
              <div class="space-y-2">
                <Label for="totp-code">{t('login.totpCode')}</Label>
                <Input
                  id="totp-code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  bind:value={totpCode}
                  required
                />
                <p class="text-xs text-muted-foreground">{t('login.totpHint')}</p>
              </div>
            {/if}
            {#if error}
              <p class="text-sm text-destructive">{error}</p>
            {/if}
            <Button type="submit" class="w-full" disabled={loading}>
              {loading ? t('common.working') : t('login.verifyCode')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              class="w-full"
              onclick={() => {
                useBackupCode = !useBackupCode;
                error = null;
              }}
            >
              {useBackupCode ? t('login.useAuthenticator') : t('login.useBackupCode')}
            </Button>
            <Button type="button" variant="ghost" class="w-full" onclick={resetSecondFactor}>
              {t('login.backToSignIn')}
            </Button>
          </form>
        {:else}
          {#if hasPassword && hasOtp}
            <div class="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                class="rounded-md px-3 py-1.5 text-sm transition-colors {mode === 'password'
                  ? 'bg-background shadow-sm'
                  : 'text-muted-foreground'}"
                onclick={() => {
                  mode = 'password';
                  error = null;
                }}
              >
                {t('login.tabPassword')}
              </button>
              <button
                type="button"
                class="rounded-md px-3 py-1.5 text-sm transition-colors {mode === 'otp'
                  ? 'bg-background shadow-sm'
                  : 'text-muted-foreground'}"
                onclick={() => {
                  mode = 'otp';
                  error = null;
                }}
              >
                {t('login.tabOtp')}
              </button>
            </div>
          {/if}

          {#if hasPassword}
            {#if mode === 'password'}
              <form
                class="space-y-4"
                onsubmit={(e) => {
                  e.preventDefault();
                  void signInPassword();
                }}
              >
                <div class="space-y-2">
                  <Label for="email">{t('login.email')}</Label>
                  <Input id="email" type="email" autocomplete="email" bind:value={email} required />
                </div>
                <div class="space-y-2">
                  <Label for="password">{t('login.password')}</Label>
                  <Input
                    id="password"
                    type="password"
                    autocomplete="current-password"
                    bind:value={password}
                    required
                  />
                  {#if hasPasswordReset}
                    <div class="text-right">
                      <a
                        href="/forgot-password"
                        class="text-xs text-muted-foreground underline-offset-4 hover:underline"
                      >
                        {t('login.forgotPassword')}
                      </a>
                    </div>
                  {/if}
                </div>
                {#if error}
                  <p class="text-sm text-destructive">{error}</p>
                {/if}
                <Button type="submit" class="w-full" disabled={loading}>
                  {loading ? t('login.signingIn') : t('login.signIn')}
                </Button>
              </form>
            {:else}
              <form
                class="space-y-4"
                onsubmit={(e) => {
                  e.preventDefault();
                  void (otpSent ? signInOtp() : sendOtp());
                }}
              >
                <div class="space-y-2">
                  <Label for="otp-email">{t('login.email')}</Label>
                  <Input
                    id="otp-email"
                    type="email"
                    autocomplete="email"
                    bind:value={email}
                    required
                    disabled={otpSent}
                  />
                </div>
                {#if otpSent}
                  <div class="space-y-2">
                    <Label for="otp-code">{t('login.otpCode')}</Label>
                    <Input
                      id="otp-code"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      bind:value={otp}
                      required
                    />
                    <p class="text-xs text-muted-foreground">{t('login.otpSentTo', { email })}</p>
                  </div>
                {/if}
                {#if error}
                  <p class="text-sm text-destructive">{error}</p>
                {/if}
                <Button type="submit" class="w-full" disabled={loading}>
                  {loading ? t('common.working') : otpSent ? t('login.verifyCode') : t('login.sendCode')}
                </Button>
                {#if otpSent}
                  <Button
                    type="button"
                    variant="ghost"
                    class="w-full"
                    onclick={() => {
                      otpSent = false;
                      otp = '';
                    }}
                  >
                    {t('login.useDifferentEmail')}
                  </Button>
                {/if}
              </form>
            {/if}
          {/if}

          {#if hasGoogle}
            <div class="relative">
              <div class="absolute inset-0 flex items-center"><span class="w-full border-t"></span></div>
              <div class="relative flex justify-center text-xs uppercase">
                <span class="bg-card px-2 text-muted-foreground">{t('login.or')}</span>
              </div>
            </div>
            <Button variant="outline" class="w-full" onclick={signInGoogle}>
              {t('login.signInWithGoogle')}
            </Button>
          {/if}

          {#if hasAntasphere}
            <!-- Cloud (D1): the hub is the only human entrance, so this button
               usually stands alone; the divider only renders in the unusual
               mixed posture. Errors surface here when no password form does. -->
            {#if hasPassword || hasGoogle}
              <div class="relative">
                <div class="absolute inset-0 flex items-center"><span class="w-full border-t"></span></div>
                <div class="relative flex justify-center text-xs uppercase">
                  <span class="bg-card px-2 text-muted-foreground">{t('login.or')}</span>
                </div>
              </div>
            {/if}
            {#if error && !hasPassword}
              <p class="text-sm text-destructive">{error}</p>
            {/if}
            <Button class="w-full" disabled={loading} onclick={() => void signInAntasphere()}>
              {loading ? t('login.signingIn') : t('login.signInWithAntasphere')}
            </Button>
          {/if}
        {/if}
      </Card.Content>
    </Card.Root>
  </GateShell>
{/if}

<style>
  /* The connecting mark: a quiet ring, one revolving arc in the primary
     tone, a solid core — deliberate and calm, not a throwaway spinner. */
  .connect-mark {
    position: relative;
    width: 3.5rem;
    height: 3.5rem;
  }
  .connect-ring,
  .connect-arc {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    border: 2px solid transparent;
  }
  .connect-ring {
    border-color: hsl(var(--primary) / 0.15);
  }
  .connect-arc {
    border-top-color: hsl(var(--primary) / 0.9);
    animation: connect-rotate 1.1s cubic-bezier(0.45, 0.15, 0.55, 0.85) infinite;
  }
  .connect-core {
    position: absolute;
    inset: 1.125rem;
    border-radius: 9999px;
    background: hsl(var(--primary) / 0.85);
    animation: connect-breathe 2.2s ease-in-out infinite;
  }
  .connect-dots {
    display: flex;
    gap: 0.375rem;
  }
  .connect-dots span {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 9999px;
    background: hsl(var(--muted-foreground) / 0.5);
    animation: connect-pulse 1.4s ease-in-out infinite;
  }
  .connect-dots span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .connect-dots span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes connect-rotate {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes connect-breathe {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.85;
    }
    50% {
      transform: scale(0.82);
      opacity: 0.6;
    }
  }
  @keyframes connect-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
