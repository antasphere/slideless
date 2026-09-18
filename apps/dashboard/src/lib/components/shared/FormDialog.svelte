<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import type { DialogSize } from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { t } from '$lib/i18n';

  /* A form in a dialog: the title and the two actions stay in place, the
     fields scroll between them, so Save is in reach however long the form is
     and however short the window (ui/dialog/dialog-content.svelte). */
  interface Props {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    onSubmit: () => void;
    loading?: boolean;
    submitLabel?: string;
    /** md by default; lg for a form that deserves room. */
    size?: DialogSize;
    /** A drawing panel on the left from 768px up (Dialog.Illustration). */
    aside?: Snippet;
    children: Snippet;
  }

  let {
    open = $bindable(),
    title,
    description,
    onClose,
    onSubmit,
    loading = false,
    submitLabel = t('common.save'),
    size = 'md',
    aside,
    children
  }: Props = $props();
</script>

<Dialog.Root
  bind:open
  onOpenChange={(isOpen) => {
    if (!isOpen) onClose();
  }}
>
  <Dialog.Content {size} {aside} framed>
    <form
      class="dlg-form"
      onsubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        {#if description}
          <Dialog.Description>{description}</Dialog.Description>
        {/if}
      </Dialog.Header>
      <Dialog.Body class="space-y-4">
        {@render children()}
      </Dialog.Body>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={onClose} disabled={loading}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={loading}>
          {loading ? t('common.saving') : submitLabel}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
