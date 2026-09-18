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
  <!-- A question: its words may run long (a description names what is lost),
       so they scroll; the two answers never do. -->
  <Dialog.Content size="sm" framed>
    <Dialog.Body class="dlg-words">
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
      </Dialog.Header>
    </Dialog.Body>
    <Dialog.Footer>
      <Button variant="outline" onclick={onClose} disabled={loading}>{t('common.cancel')}</Button>
      <Button {variant} onclick={onConfirm} disabled={loading}>
        {loading ? t('common.working') : confirmLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
