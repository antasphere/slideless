<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { t } from '$lib/i18n';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    onSubmit: () => void;
    loading?: boolean;
    submitLabel?: string;
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
    children
  }: Props = $props();
</script>

<Dialog.Root
  bind:open
  onOpenChange={(isOpen) => {
    if (!isOpen) onClose();
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}
        <Dialog.Description>{description}</Dialog.Description>
      {/if}
    </Dialog.Header>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      class="space-y-4"
    >
      {@render children()}
      <div class="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onclick={onClose} disabled={loading}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={loading}>
          {loading ? t('common.saving') : submitLabel}
        </Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
