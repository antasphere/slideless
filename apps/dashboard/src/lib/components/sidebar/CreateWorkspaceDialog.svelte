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
