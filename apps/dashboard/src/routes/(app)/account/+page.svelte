<script lang="ts">
  import { onMount } from 'svelte';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { authClient } from '$lib/auth-client';
  import { copyText } from '$lib/clipboard';
  import { refreshSession } from '$lib/session';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // ── Profile ────────────────────────────────────────────────────────────
  let name = $state(data.me.user.name);
  let profileLoading = $state(false);
  let profileError = $state<string | null>(null);

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

  const deleteArmed = $derived(deleteConfirm === 'DELETE' && deletePassword.length > 0);

  async function submitDelete() {
    if (!deleteArmed) return;
    deleteError = null;
    deleteLoading = true;
    try {
      const { error: err } = await authClient.deleteUser({ password: deletePassword });
      if (err) {
        deleteError =
          err.code === 'INVALID_PASSWORD'
            ? t('account.errorWrongPassword')
            : // e.g. the last-owner guard — surface the server's message verbatim.
              err.message || t('account.deleteFailed');
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
          err.status === 400 || err.status === 401
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

  // Settings is one section with two tabs (PRDCT-2441): the instance, and the
  // person's own account, so nobody has to find it under their name.
  const settingsTabs = [
    { href: '/settings', label: t('settings.tabInstance') },
    { href: '/account', label: t('settings.tabAccount') }
  ];
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  lede={t('account.description')}
  pageTitle={t('account.title')}
  tabs={settingsTabs}
  drawing="meridians"
/>

<div class="grid gap-6 lg:grid-cols-2">
  <!-- The language is the person's, not the instance's: it is kept in this
       browser (ADR 007), and this is where a person looks for it (PRDCT-2441). -->
  <Card.Root class="lg:col-span-2">
    <Card.Content class="flex flex-wrap items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="font-display text-base">{t('account.languageTitle')}</p>
        <p class="text-sm text-muted-foreground">{t('account.languageDescription')}</p>
      </div>
      <LanguageSwitcher />
    </Card.Content>
  </Card.Root>

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
        <Button type="submit" disabled={profileLoading}>
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

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">{t('account.passwordTitle')}</Card.Title>
      <Card.Description>{t('account.passwordDescription')}</Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        class="space-y-4"
        onsubmit={(e) => {
          e.preventDefault();
          void submitPassword();
        }}
      >
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
        <Button type="submit" disabled={passwordLoading}>
          {passwordLoading ? t('account.changingPassword') : t('account.changePassword')}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>

  {#if twoFactorAvailable}
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">{t('account.twoFactorTitle')}</Card.Title>
        <Card.Description>{t('account.twoFactorDescription')}</Card.Description>
      </Card.Header>
      <Card.Content>
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
            <p class="text-sm">{t('account.twoFactorOn')}</p>
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
            <Button type="submit" disabled={twoFaLoading}>
              {twoFaLoading ? t('common.working') : t('account.twoFactorStart')}
            </Button>
          </form>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root class="border-destructive/40">
    <Card.Header>
      <Card.Title class="text-base">{t('account.dangerTitle')}</Card.Title>
      <Card.Description>
        {t('account.dangerDescription')}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        class="space-y-4"
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
        <div class="space-y-2">
          <Label for="delete-password">{t('account.currentPassword')}</Label>
          <Input
            id="delete-password"
            type="password"
            autocomplete="current-password"
            bind:value={deletePassword}
          />
        </div>
        <FormError message={deleteError} />
        <Button type="submit" variant="destructive" disabled={!deleteArmed || deleteLoading}>
          {deleteLoading ? t('account.deleting') : t('account.deleteSubmit')}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</div>
