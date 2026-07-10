import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';

/**
 * Copy `text` and toast about it. `message` is the FULL success toast
 * (already translated by the caller, e.g. t('apiKeys.copiedToast'));
 * defaults to the generic "Copied to clipboard".
 */
export async function copyText(text: string, message?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message ?? t('clipboard.copied'));
  } catch {
    toast.error(t('clipboard.copyFailed'));
  }
}
