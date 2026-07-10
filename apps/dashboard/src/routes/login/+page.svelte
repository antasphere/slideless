<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { authClient, isTwoFactorRedirect } from '$lib/auth-client';
  import { refreshSession } from '$lib/session';
  import { safeNext } from '$lib/utils';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const methods = $derived(data.instance.auth.methods);
  const hasGoogle = $derived(methods.includes('google'));
  const hasOtp = $derived(methods.includes('email-otp'));
  const hasPasswordReset = $derived(data.instance.auth.passwordReset);

  let mode = $state<'password' | 'otp'>('password');

  let email = $state('');
  let password = $state('');
  let otp = $state('');
  let otpSent = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);

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
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<div class="flex min-h-dvh items-center justify-center bg-surface-secondary p-6">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <Card.Title class="text-xl">{data.instance.name}</Card.Title>
      <Card.Description>{t('login.subtitle')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
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
        {#if hasOtp}
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
      {/if}
    </Card.Content>
  </Card.Root>
</div>
