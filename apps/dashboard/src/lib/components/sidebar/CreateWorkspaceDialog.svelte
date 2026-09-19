<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FormField from '$lib/components/ui/FormField.svelte';
  import { api, switchWorkspace } from '$lib/api';
  import {
    newIdempotencyKey,
    signInAgain as decideSignInAgain,
    workspaceCreateFailure
  } from '$lib/workspace-create';
  import { authClient } from '$lib/auth-client';
  import ThemeDots from '$lib/components/shell/ThemeDots.svelte';
  import FormGlyphs from '$lib/components/shell/FormGlyphs.svelte';
  import BrandTile from './BrandTile.svelte';
  import { dealtPattern, DEFAULT_LOOK, look, saveLook, type Look, type ThemeKey } from '$lib/look.svelte';
  import { roleTag } from '$lib/tags';
  import { t } from '$lib/i18n';

  /**
   * "New workspace" (PRDCT-2443 cloud, PRDCT-2444 self-hosted): ONE dialog on
   * both editions, offered only while /me's `canCreateWorkspace` is true.
   * POST /workspaces, then `switchWorkspace` persists the choice and reloads,
   * so the person LANDS in the workspace they just named. The wording is a
   * Slideless workspace everywhere (`$lib/workspace-create` owns the refusal
   * sentences): where it is created behind the scenes is not the person's
   * business.
   */
  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  const NAME_MAX = 120;

  let name = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  let signInAgain = $state(false);
  let freshSignIn = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  // One key per OPENING: a double click, or a retry of an answer that never
  // arrived, replays the first creation instead of making a second one. A
  // refused attempt releases its claim server-side, so the same key serves
  // the corrected name too.
  let idempotencyKey = $state(newIdempotencyKey());

  // The look the new workspace is born with (the hub's way). Until the person
  // picks, the colour is the current one and the form is dealt from the name
  // as it is typed, so the tile takes shape with the words; the look is
  // stored under the new workspace's id the moment it exists, before the
  // switch, so it opens with the look they chose.
  let pickedTheme = $state<ThemeKey | null>(null);
  let pickedPattern = $state<string | null>(null);
  const trimmedName = $derived(name.trim());
  const preview = $derived<Look>({
    ...DEFAULT_LOOK,
    theme: pickedTheme ?? look.value.theme,
    pattern: pickedPattern ?? dealtPattern(trimmedName || 'workspace')
  });

  // Keyed on `open` itself, not on the primitive's onOpenChange: the menu
  // entry and the Cancel button move `open` from outside the primitive.
  $effect(() => {
    if (open) {
      idempotencyKey = newIdempotencyKey();
    } else {
      name = '';
      error = null;
      signInAgain = false;
      freshSignIn = false;
      pickedTheme = null;
      pickedPattern = null;
    }
  });

  /** The "Sign in again" control: `signInAgain` in $lib/workspace-create owns the decision. */
  function signInAgainNow() {
    return decideSignInAgain({
      freshSignIn,
      oauth2: (options) => authClient.signIn.oauth2(options),
      returnTo: window.location.pathname + window.location.search,
      reload: () => window.location.reload()
    });
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || loading) return;
    error = null;
    signInAgain = false;
    freshSignIn = false;
    loading = true;
    try {
      const { workspace } = await api.createWorkspace(trimmed, { idempotencyKey });
      saveLook(workspace.id, $state.snapshot(preview));
      // Persist + reload: every loader restarts inside the new workspace. The
      // button stays disabled until the page goes away.
      switchWorkspace(workspace.id);
    } catch (e) {
      const failure = workspaceCreateFailure(e);
      error = failure.message;
      signInAgain = failure.signInAgain;
      freshSignIn = failure.freshSignIn;
      loading = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="sm:max-w-md"
    data-testid="workspace-create-dialog"
    onOpenAutoFocus={(e) => {
      // Focus lands in the field, not on whatever the trap finds first.
      e.preventDefault();
      nameInput?.focus();
    }}
  >
    <Dialog.Header>
      <Dialog.Title>{t('workspace.createTitle')}</Dialog.Title>
      <Dialog.Description>{t('workspace.createDescription')}</Dialog.Description>
    </Dialog.Header>
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FormField id="workspace-name" label={t('workspace.nameLabel')}>
        <Input
          id="workspace-name"
          bind:ref={nameInput}
          bind:value={name}
          required
          maxlength={NAME_MAX}
          autocomplete="off"
          placeholder={t('workspace.namePlaceholder')}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'workspace-name-error' : undefined}
          data-testid="workspace-name-input"
        />
        {#if error}
          <p id="workspace-name-error" role="alert" class="text-sm text-destructive">
            {error}
            {#if signInAgain}
              <button type="button" class="font-medium underline underline-offset-4" onclick={signInAgainNow}>
                {t('workspace.signInAgain')}
              </button>
            {/if}
          </p>
        {/if}
      </FormField>
      <fieldset class="space-y-3">
        <legend class="eyebrow pb-1">{t('workspace.lookLegend')}</legend>
        <!-- how it will sit in the sidebar. SECURITY: the name is user-authored: text interpolation only. -->
        <div class="preview" data-testid="workspace-preview">
          <BrandTile {preview} label={trimmedName || t('workspace.create')} size={40} />
          <span class="grid min-w-0 flex-1 leading-tight">
            <span class="truncate font-display text-[17px] font-normal tracking-[-0.005em] text-[var(--ink)]">
              {trimmedName || t('workspace.create')}
            </span>
            <span class="role truncate">{roleTag('owner').label}</span>
          </span>
        </div>
        <ThemeDots value={preview.theme} onpick={(key) => (pickedTheme = key)} size={15} />
        <FormGlyphs value={preview.pattern} onpick={(key) => (pickedPattern = key)} size={24} />
        <p class="text-xs text-muted-foreground">{t('workspace.lookHint')}</p>
      </fieldset>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={loading}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={loading || !name.trim()} data-testid="workspace-create-submit">
          {loading ? t('workspace.creating') : t('workspace.createSubmit')}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<style>
  .preview {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    background: color-mix(in oklab, var(--ground-2) 46%, transparent);
  }
  .role {
    font-family: var(--second);
    font-weight: 300;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
</style>
