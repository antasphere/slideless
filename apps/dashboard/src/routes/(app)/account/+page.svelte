<script lang="ts">
  import { onMount } from 'svelte';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import { Tag } from '$lib/components/ui/tag';
  import { roleTag } from '$lib/tags';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import { theme, type ThemeMode } from '$lib/theme.svelte';
  import { settingsTabs } from '$lib/settings-tabs';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { authClient } from '$lib/auth-client';
  import { page } from '$app/state';
  import { copyText } from '$lib/clipboard';
  import { refreshSession } from '$lib/session';
  import { clearHintCookieClientSide, ssoDiscovery } from '$lib/sso';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // ── Profile ────────────────────────────────────────────────────────────
  let name = $state(data.me.user.name);
  let profileLoading = $state(false);
  let profileError = $state<string | null>(null);

  // ── How this person signs in ───────────────────────────────────────────
  // The instance says what it offers (`/instance` auth.methods): a cloud
  // tool drops `password` because every user is a hub identity with no
  // local credential, so the password card would be a form that can only
  // fail, and a delete armed on a password could never be submitted.
  // Read the descriptor, not `me.ssoOnly` (cloud-and-session-only).
  const hasPassword = $derived(data.instance.auth.methods.includes('password'));
  const hubSignIn = $derived(data.instance.auth.methods.includes('antasphere'));

  // ── Email change (self-serve; needs a delivering email driver) ─────────
  const emailChangeEnabled = $derived(data.instance.auth.emailChange);
  let newEmail = $state(data.me.user.email);
  let emailLoading = $state(false);
  let emailError = $state<string | null>(null);

  async function submitEmailChange() {
    emailError = null;
    if (newEmail.trim().toLowerCase() === data.me.user.email.toLowerCase()) {
      emailError = t('account.emailSameError');
      return;
    }
    emailLoading = true;
    try {
      const { error: err } = await authClient.changeEmail({
        newEmail: newEmail.trim(),
        callbackURL: '/account'
      });
      if (err) {
        emailError = err.message || t('account.emailChangeFailed');
        return;
      }
      // Neutral copy: whether a confirmation goes to the CURRENT address
      // first depends on whether this account's email is verified.
      toast.success(t('account.emailChangeToast'));
    } finally {
      emailLoading = false;
    }
  }

  async function submitProfile() {
    profileError = null;
    profileLoading = true;
    try {
      const { error: err } = await authClient.updateUser({ name });
      if (err) {
        profileError = err.message || t('account.profileUpdateFailed');
        return;
      }
      // The sidebar reads the session — refresh it so the new name shows up.
      await refreshSession();
      toast.success(t('account.profileUpdated'));
    } finally {
      profileLoading = false;
    }
  }

  // ── Two-factor authentication (opt-in TOTP + backup codes; ADR 009) ────
  const twoFactorAvailable = $derived(data.instance.auth.twoFactor);
  // null = still loading the session flag.
  let twoFactorEnabled = $state<boolean | null>(null);
  // Set while an enrollment's secret + backup codes are on screen. The codes
  // exist in the clear ONLY here — once dismissed they are gone for good.
  let enrollment = $state<{ totpURI: string; secret: string; backupCodes: string[] } | null>(null);
  let enrollmentActivated = $state(false);
  let enablePassword = $state('');
  let activateCode = $state('');
  let disablePassword = $state('');
  let twoFaLoading = $state(false);
  let twoFaError = $state<string | null>(null);

  onMount(async () => {
    const { data: session } = await authClient.getSession();
    twoFactorEnabled = Boolean(
      (session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled
    );
  });

  function secretOf(totpURI: string): string {
    try {
      return new URL(totpURI).searchParams.get('secret') ?? '';
    } catch {
      return '';
    }
  }

  async function startTwoFactorEnrollment() {
    twoFaError = null;
    twoFaLoading = true;
    try {
      const { data: res, error: err } = await authClient.twoFactor.enable({
        password: enablePassword
      });
      if (err || !res) {
        twoFaError =
          err?.status === 400
            ? t('account.errorWrongPassword')
            : err?.message || t('account.twoFactorFailed');
        return;
      }
      enrollment = {
        totpURI: res.totpURI,
        secret: secretOf(res.totpURI),
        backupCodes: res.backupCodes
      };
      enrollmentActivated = false;
      enablePassword = '';
    } finally {
      twoFaLoading = false;
    }
  }

  async function activateTwoFactor() {
    twoFaError = null;
    twoFaLoading = true;
    try {
      const { error: err } = await authClient.twoFactor.verifyTotp({ code: activateCode.trim() });
      if (err) {
        twoFaError =
          err.status === 401 || err.status === 400
            ? t('account.twoFactorInvalidCode')
            : err.message || t('account.twoFactorFailed');
        return;
      }
      enrollmentActivated = true;
      twoFactorEnabled = true;
      activateCode = '';
      toast.success(t('account.twoFactorEnabledToast'));
    } finally {
      twoFaLoading = false;
    }
  }

  function finishTwoFactorEnrollment() {
    // The one-time window closes: backup codes are never shown again.
    enrollment = null;
    enrollmentActivated = false;
  }

  async function disableTwoFactor() {
    twoFaError = null;
    twoFaLoading = true;
    try {
      const { error: err } = await authClient.twoFactor.disable({ password: disablePassword });
      if (err) {
        twoFaError =
          err.status === 400 ? t('account.errorWrongPassword') : err.message || t('account.twoFactorFailed');
        return;
      }
      twoFactorEnabled = false;
      disablePassword = '';
      toast.success(t('account.twoFactorDisabledToast'));
    } finally {
      twoFaLoading = false;
    }
  }

  // ── Password ───────────────────────────────────────────────────────────
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let passwordLoading = $state(false);
  let passwordError = $state<string | null>(null);

  // ── Danger zone: delete account ────────────────────────────────────────
  let deleteConfirm = $state('');
  let deletePassword = $state('');
  let deleteLoading = $state(false);
  let deleteError = $state<string | null>(null);

  // Without a local password the proof is a fresh hub sign-in: the button
  // first sends the person through "Sign in with Antasphere" and lands
  // back here with ?reauth=delete, where the same form deletes for real.
  // Better Auth accepts a password-less delete for a session younger than
  // its freshAge (24h), and a hub round trip mints a new session.
  const deleteReauthed = $derived(
    !hasPassword && hubSignIn && page.url.searchParams.get('reauth') === 'delete'
  );
  const deleteNeedsHubTrip = $derived(!hasPassword && hubSignIn && !deleteReauthed);
  const deleteArmed = $derived(
    deleteConfirm === 'DELETE' && (hasPassword ? deletePassword.length > 0 : true)
  );

  async function reauthThroughHub() {
    const { error: err } = await authClient.signIn.oauth2({
      providerId: 'antasphere',
      callbackURL: '/account?reauth=delete',
      errorCallbackURL: '/account'
    });
    if (err) deleteError = err.message || t('account.deleteFailed');
  }

  async function submitDelete() {
    if (!deleteArmed) return;
    deleteError = null;
    deleteLoading = true;
    try {
      if (deleteNeedsHubTrip) {
        await reauthThroughHub();
        return;
      }
      const { error: err } = await authClient.deleteUser(hasPassword ? { password: deletePassword } : {});
      if (err) {
        if (err.code === 'INVALID_PASSWORD') {
          deleteError = t('account.errorWrongPassword');
        } else if (err.code?.startsWith('SESSION_EXPIRED') && hubSignIn) {
          // The session is older than the fresh window: one more hub trip.
          // better-call derives the code from the whole message ("Session
          // expired. Re-authenticate to perform this action."), so a prefix.
          await reauthThroughHub();
        } else {
          // e.g. the last-owner guard — surface the server's message verbatim.
          deleteError = err.message || t('account.deleteFailed');
        }
        return;
      }
      // The account is gone; the hub session is not. On cloud the login page
      // would silently re-connect off the hub hint and mint a new, empty
      // account within seconds, so land the way a sign-out lands: the hint
      // cleared and the signed-out marker set, which is what keeps the
      // silent auto-connect from running (lib/sso.ts, gates B and C).
      const sso = ssoDiscovery();
      if (sso) {
        clearHintCookieClientSide(sso);
        window.location.assign('/login?signed_out=1');
        return;
      }
      window.location.href = '/login';
    } finally {
      deleteLoading = false;
    }
  }

  async function submitPassword() {
    passwordError = null;
    if (newPassword.length < 12) {
      passwordError = t('account.errorNewPasswordLength');
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError = t('common.errorPasswordMismatch');
      return;
    }
    passwordLoading = true;
    try {
      const { error: err } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true
      });
      if (err) {
        passwordError =
          err.code === 'CREDENTIAL_ACCOUNT_NOT_FOUND'
            ? // An OTP or Google sign-in on an instance that offers passwords:
              // the person has none yet, and the reset link is how one is set.
              t('account.errorNoPasswordYet')
            : err.status === 400 || err.status === 401
              ? t('account.errorCurrentPassword')
              : err.message || t('account.passwordChangeFailed');
        return;
      }
      toast.success(t('account.passwordChanged'));
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
    } finally {
      passwordLoading = false;
    }
  }

  // ── Who: the strip at the top ──────────────────────────────────────────
  const displayName = $derived(data.me.user.name || data.me.user.email.split('@')[0] || t('common.user'));
  const initials = $derived(
    displayName
      .split(' ')
      .map((word: string) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  );

  // ── Reading: the person's, this browser's ──────────────────────────────
  $effect(() => theme.start());
  const modes: { key: ThemeMode; label: string; icon: typeof Sun }[] = [
    { key: 'system', label: t('account.modeSystem'), icon: Monitor },
    { key: 'light', label: t('account.modeLight'), icon: Sun },
    { key: 'dark', label: t('account.modeDark'), icon: Moon }
  ];
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  lede={t('account.lede')}
  pageTitle={t('account.title')}
  tabs={settingsTabs()}
  drawing="meridians"
/>

<!-- who is signed in, and as what: the card the sidebar's person opens, laid
     flat. SECURITY: the name, the email and the workspace name are
     user-authored: text interpolation only. -->
<div class="who sheet mb-6">
  <span class="disc">{initials}</span>
  <div class="min-w-0 flex-1">
    <p
      class="truncate font-display text-[22px] font-normal leading-tight tracking-[-0.01em] text-[var(--ink)]"
    >
      {displayName}
    </p>
    <p class="truncate text-[13.5px] text-muted-foreground">{data.me.user.email}</p>
  </div>
  <div class="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
    <Tag {...roleTag(data.me.role)} />
    <span class="truncate">{data.me.workspace.name}</span>
    <span class="hidden sm:inline">·</span>
    <span class="hidden sm:inline">{t('account.signedInVia', { via: data.me.via })}</span>
  </div>
</div>

<div class="grid gap-6 lg:grid-cols-2">
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('account.profileTitle')}</Card.Title>
      <Card.Description>{t('account.profileDescription')}</Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        class="space-y-4"
        onsubmit={(e) => {
          e.preventDefault();
          void submitProfile();
        }}
      >
        <div class="space-y-2">
          <Label for="account-name">{t('account.name')}</Label>
          <Input id="account-name" autocomplete="name" bind:value={name} required />
        </div>
        {#if !emailChangeEnabled}
          <div class="space-y-2" in:appear>
            <Label for="account-email">{t('account.email')}</Label>
            <Input id="account-email" type="email" value={data.me.user.email} readonly />
            <p class="text-xs text-muted-foreground">{t('account.emailReadonlyHint')}</p>
          </div>
        {/if}
        <FormError message={profileError} />
        <Button type="submit" disabled={profileLoading || name.trim() === data.me.user.name}>
          {profileLoading ? t('common.saving') : t('account.saveChanges')}
        </Button>
      </form>
      {#if emailChangeEnabled}
        <form
          in:appear
          class="mt-6 space-y-4 border-t pt-6"
          onsubmit={(e) => {
            e.preventDefault();
            void submitEmailChange();
          }}
        >
          <div class="space-y-2">
            <Label for="account-email">{t('account.email')}</Label>
            <Input id="account-email" type="email" autocomplete="email" bind:value={newEmail} required />
            <p class="text-xs text-muted-foreground">
              {t('account.emailChangeHint')}
            </p>
          </div>
          <FormError message={emailError} />
          <Button type="submit" variant="outline" disabled={emailLoading}>
            {emailLoading ? t('common.sending') : t('account.changeEmail')}
          </Button>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- The preferences are the person's, not the instance's or the
       workspace's: kept in this browser (ADR 007). -->
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('account.preferencesTitle')}</Card.Title>
      <Card.Description>{t('account.preferencesDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-5">
      <div class="pref">
        <span class="pref-label">{t('account.languageTitle')}</span>
        <LanguageSwitcher />
      </div>
      <div class="pref">
        <span class="pref-label">{t('account.mode')}</span>
        <div class="seg" role="group" aria-label={t('account.mode')}>
          {#each modes as m (m.key)}
            <button
              type="button"
              class="seg-btn"
              class:on={theme.mode === m.key}
              aria-pressed={theme.mode === m.key}
              onclick={() => theme.setMode(m.key)}
            >
              <m.icon class="size-3.5" strokeWidth={1.8} />
              <span>{m.label}</span>
            </button>
          {/each}
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root class="lg:col-span-2">
    <Card.Header>
      <Card.Title class="text-base">{t('account.securityTitle')}</Card.Title>
      <Card.Description>
        {hasPassword ? t('account.securityDescription') : t('account.securityDescriptionSso')}
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-8 md:grid-cols-2">
      {#if !hasPassword}
        <!-- The sign-in panel: no local password exists here, so say how
             the person actually gets in and where that identity is managed. -->
        <div class="space-y-3">
          <p class="eyebrow">{t('account.signInTitle')}</p>
          <p class="-mt-2 text-sm text-muted-foreground">
            {hubSignIn ? t('account.signInWithHub') : t('account.signInNoPassword')}
          </p>
          {#if hubSignIn && data.me.hubManageUrl}
            <Button
              variant="outline"
              onclick={() => window.open(data.me.hubManageUrl ?? '', '_blank', 'noopener,noreferrer')}
            >
              {t('account.manageHubAccount')}
            </Button>
          {/if}
        </div>
      {:else}
        <form
          class="space-y-4"
          onsubmit={(e) => {
            e.preventDefault();
            void submitPassword();
          }}
        >
          <p class="eyebrow">{t('account.passwordTitle')}</p>
          <p class="-mt-2 text-sm text-muted-foreground">{t('account.passwordDescription')}</p>
          <div class="space-y-2">
            <Label for="current-password">{t('account.currentPassword')}</Label>
            <Input
              id="current-password"
              type="password"
              autocomplete="current-password"
              bind:value={currentPassword}
              required
            />
          </div>
          <div class="space-y-2">
            <Label for="new-password">{t('account.newPassword')}</Label>
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
            <Label for="confirm-password">{t('account.confirmNewPassword')}</Label>
            <Input
              id="confirm-password"
              type="password"
              autocomplete="new-password"
              bind:value={confirmPassword}
              required
            />
          </div>
          <FormError message={passwordError} />
          <Button type="submit" variant="outline" disabled={passwordLoading}>
            {passwordLoading ? t('account.changingPassword') : t('account.changePassword')}
          </Button>
        </form>
      {/if}

      {#if twoFactorAvailable}
        <div class="space-y-4 border-t pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0">
          <p class="eyebrow">{t('account.twoFactorTitle')}</p>
          <p class="-mt-2 text-sm text-muted-foreground">{t('account.twoFactorDescription')}</p>
          {#if twoFactorEnabled === null}
            <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
          {:else if enrollment}
            <div class="space-y-4" in:appear>
              <div class="space-y-2">
                <p class="text-sm font-medium leading-none">{t('account.twoFactorSecret')}</p>
                <CodeBlock
                  field
                  code={enrollment.secret}
                  ariaLabel={t('account.twoFactorSecret')}
                  copyLabel={t('account.twoFactorCopySecret')}
                />
                <p class="text-xs text-muted-foreground">{t('account.twoFactorSecretHint')}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onclick={() => void copyText(enrollment!.totpURI)}
                >
                  {t('account.twoFactorCopyUri')}
                </Button>
              </div>
              <div class="space-y-2">
                <CodeBlock
                  code={enrollment.backupCodes.join('\n')}
                  label={t('account.twoFactorBackupTitle')}
                  ariaLabel={t('account.twoFactorBackupTitle')}
                  copyLabel={t('account.twoFactorCopyCodes')}
                  class="[--code-max-h:none]"
                />
                <p class="text-xs text-muted-foreground">{t('account.twoFactorBackupHint')}</p>
              </div>
              {#if enrollmentActivated}
                <div class="space-y-4" in:appear>
                  <p class="text-sm">{t('account.twoFactorActivated')}</p>
                  <Button type="button" onclick={finishTwoFactorEnrollment}>{t('common.done')}</Button>
                </div>
              {:else}
                <form
                  class="space-y-4"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void activateTwoFactor();
                  }}
                >
                  <div class="space-y-2">
                    <Label for="totp-activate">{t('account.twoFactorVerifyLabel')}</Label>
                    <Input
                      id="totp-activate"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      bind:value={activateCode}
                      required
                    />
                  </div>
                  <FormError message={twoFaError} />
                  <Button type="submit" disabled={twoFaLoading}>
                    {twoFaLoading ? t('common.working') : t('account.twoFactorActivate')}
                  </Button>
                </form>
              {/if}
            </div>
          {:else if twoFactorEnabled}
            <form
              in:appear
              class="space-y-4"
              onsubmit={(e) => {
                e.preventDefault();
                void disableTwoFactor();
              }}
            >
              <p class="notice">{t('account.twoFactorOn')}</p>
              <div class="space-y-2">
                <Label for="twofa-disable-password">{t('account.currentPassword')}</Label>
                <Input
                  id="twofa-disable-password"
                  type="password"
                  autocomplete="current-password"
                  bind:value={disablePassword}
                  required
                />
                <p class="text-xs text-muted-foreground">{t('account.twoFactorDisableHint')}</p>
              </div>
              <FormError message={twoFaError} />
              <Button type="submit" variant="outline" disabled={twoFaLoading}>
                {twoFaLoading ? t('common.working') : t('account.twoFactorDisable')}
              </Button>
            </form>
          {:else}
            <form
              in:appear
              class="space-y-4"
              onsubmit={(e) => {
                e.preventDefault();
                void startTwoFactorEnrollment();
              }}
            >
              <p class="text-sm text-muted-foreground">{t('account.twoFactorOff')}</p>
              <div class="space-y-2">
                <Label for="twofa-enable-password">{t('account.currentPassword')}</Label>
                <Input
                  id="twofa-enable-password"
                  type="password"
                  autocomplete="current-password"
                  bind:value={enablePassword}
                  required
                />
                <p class="text-xs text-muted-foreground">{t('account.twoFactorEnableHint')}</p>
              </div>
              <FormError message={twoFaError} />
              <Button type="submit" variant="outline" disabled={twoFaLoading}>
                {twoFaLoading ? t('common.working') : t('account.twoFactorStart')}
              </Button>
            </form>
          {/if}
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root class="border-destructive/40 lg:col-span-2">
    <Card.Header>
      <Card.Title class="text-base">{t('account.dangerTitle')}</Card.Title>
      <Card.Description>
        <!-- The true scope, stated: a user row is instance-global, so the
             erasure leaves every workspace here. On hub sign-in the hub
             identity survives — deletion here is never a cross-tool act. -->
        {t('account.dangerDescription')}
        {t('account.dangerScope')}
        <!-- Slideless's own word: decks are workspace data (owner_user_id set
             null on erasure), so they outlive the account. -->
        {t('account.dangerDecksNote')}
        {#if hubSignIn}
          {t('account.dangerHubNote')}
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if deleteReauthed}
        <p class="mb-4 text-sm font-medium">{t('account.deleteReauthed')}</p>
      {:else if deleteNeedsHubTrip}
        <p class="mb-4 text-sm text-muted-foreground">{t('account.deleteVerifyHint')}</p>
      {/if}
      <form
        class="grid gap-4 md:items-end {hasPassword
          ? 'md:grid-cols-[1fr_1fr_auto]'
          : 'md:grid-cols-[1fr_auto]'}"
        onsubmit={(e) => {
          e.preventDefault();
          void submitDelete();
        }}
      >
        <div class="space-y-2">
          <Label for="delete-confirm">
            {t('account.deleteConfirmPrefix')} <span class="font-mono">DELETE</span>
            {t('account.deleteConfirmSuffix')}
          </Label>
          <Input id="delete-confirm" autocomplete="off" bind:value={deleteConfirm} placeholder="DELETE" />
        </div>
        {#if hasPassword}
          <div class="space-y-2">
            <Label for="delete-password">{t('account.currentPassword')}</Label>
            <Input
              id="delete-password"
              type="password"
              autocomplete="current-password"
              bind:value={deletePassword}
            />
          </div>
        {/if}
        <Button type="submit" variant="destructive" disabled={!deleteArmed || deleteLoading}>
          {deleteLoading
            ? t('account.deleting')
            : deleteNeedsHubTrip
              ? t('account.deleteContinueHub')
              : t('account.deleteSubmit')}
        </Button>
        <FormError message={deleteError} class={hasPassword ? 'md:col-span-3' : 'md:col-span-2'} />
      </form>
    </Card.Content>
  </Card.Root>
</div>

<style>
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    padding: 18px 20px;
  }
  /* the person, lit: the accent's wash under the initials */
  .disc {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 56px;
    height: 56px;
    border-radius: 999px;
    border: 1px solid color-mix(in oklab, var(--accent) 30%, var(--hairline));
    background: var(--accent-soft);
    font-family: var(--display);
    font-size: 20px;
    font-weight: 400;
    color: var(--accent-deep);
  }
  .pref {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .pref-label {
    font-size: 13.5px;
    color: var(--ink-soft);
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    background: var(--plate-strong);
  }
  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 7px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
    transition:
      background-color var(--motion-duration) var(--motion-ease),
      color var(--motion-duration) var(--motion-ease);
  }
  .seg-btn:hover {
    color: var(--ink);
  }
  .seg-btn.on {
    background: var(--accent-soft);
    color: var(--accent-deep);
  }
</style>
