<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { t } from '$lib/i18n';

  interface Props {
    open: boolean;
    title?: string;
    description?: string;
    onClose: () => void;
    onConfirm: () => void;
    loading?: boolean;
    confirmLabel?: string;
    /** Visual weight of the confirm action; destructive by default. */
    variant?: 'destructive' | 'default';
  }

  let {
    open = $bindable(),
    title = t('confirm.title'),
    description = t('confirm.description'),
    onClose,
    onConfirm,
    loading = false,
    confirmLabel = t('common.confirm'),
    variant = 'destructive'
  }: Props = $props();
</script>

<Dialog.Root
  bind:open
  onOpenChange={(isOpen) => {
    if (!isOpen) onClose();
  }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>
    <div class="flex justify-end gap-2 pt-4">
      <Button variant="outline" onclick={onClose} disabled={loading}>{t('common.cancel')}</Button>
      <Button {variant} onclick={onConfirm} disabled={loading}>
        {loading ? t('common.working') : confirmLabel}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
