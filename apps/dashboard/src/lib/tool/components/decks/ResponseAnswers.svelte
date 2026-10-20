<script lang="ts">
  import { Badge } from '$lib/components/ui/badge/index.js';
  import Download from '@lucide/svelte/icons/download';
  import { answerFields, needsClamp } from '$lib/tool/decks/form-responses';
  import { formatBytes } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { FormResponseFileSnapshot } from '@slideless/contract';

  /**
   * One response's answers, field by field (PRDCT-3644): the field's name as a
   * small label above its value, a long text clamped with Show more, a
   * multi-choice as one chip per item, a file field as its files and sizes.
   *
   * SECURITY: payload KEYS and VALUES, and a file's `field` and `name`, are
   * RAW anonymous-respondent input (ADR 022) on the APP ORIGIN. Every one of
   * them renders through Svelte's `{value}` text interpolation, which escapes:
   * "<img src=x onerror=…>" must appear as literal text. NEVER {@html},
   * innerHTML or createRawSnippet here, and never move them into an attribute
   * but a `title` none of them reaches. A download is asked by the file's ID
   * only (`ondownload`), never by a name.
   */

  interface Props {
    payload: Record<string, string | string[]>;
    /** The files the answer holds; null on a revision from before file fields. */
    files: FormResponseFileSnapshot[] | null;
    /** Set on the current answer only: a revision keeps names, never a handle on bytes. */
    ondownload?: (fileId: string) => void;
    /** The file id whose download is running, to disable its control. */
    downloading?: string | null;
  }

  let { payload, files, ondownload, downloading = null }: Props = $props();

  const fields = $derived(answerFields(payload, files));

  // the fields a reader opened past the clamp, by field name
  let expanded = $state<Record<string, boolean>>({});
</script>

{#if !fields.length}
  <p class="text-sm text-muted-foreground">{t('formResponses.answerEmpty')}</p>
{/if}
<dl class="space-y-4" data-testid="response-answers">
  {#each fields as answer (`${answer.kind}:${answer.field}`)}
    <div class="min-w-0">
      <dt class="mb-1 break-words text-xs font-medium text-muted-foreground">{answer.field}</dt>
      <dd class="min-w-0">
        {#if answer.kind === 'text'}
          {#if !answer.value.trim()}
            <span class="text-sm text-muted-foreground">{t('formResponses.answerEmpty')}</span>
          {:else}
            {@const clampable = needsClamp(answer.value)}
            {@const open = expanded[answer.field] === true}
            <!-- the plate pads, the inner block clamps: a clamped box's own
                 padding would show the top of the seventh line -->
            <div class="answer-value">
              <div
                class="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground {clampable &&
                !open
                  ? 'line-clamp-6'
                  : ''}"
              >
                {answer.value}
              </div>
            </div>
            {#if clampable}
              <button
                type="button"
                class="mt-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                aria-expanded={open}
                onclick={() => (expanded = { ...expanded, [answer.field]: !open })}
              >
                {open ? t('formResponses.showLess') : t('formResponses.showMore')}
              </button>
            {/if}
          {/if}
        {:else if answer.kind === 'list'}
          {#if !answer.items.length}
            <span class="text-sm text-muted-foreground">{t('formResponses.answerEmpty')}</span>
          {:else}
            <ul class="flex flex-wrap gap-1.5">
              {#each answer.items as item, i (i)}
                <li class="min-w-0 max-w-full">
                  <!-- the badge's own 24px line, let wrap for a long item -->
                  <Badge
                    variant="secondary"
                    class="!h-auto min-h-6 max-w-full !whitespace-normal break-words py-1 !leading-snug"
                  >
                    {item}
                  </Badge>
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          <ul class="answer-files space-y-1 text-sm">
            {#each answer.files as file (file.id)}
              <li class="flex items-baseline justify-between gap-3">
                {#if ondownload}
                  <button
                    type="button"
                    onclick={() => ondownload(file.id)}
                    disabled={downloading === file.id}
                    class="inline-flex min-w-0 items-baseline gap-1.5 text-left underline-offset-4 hover:underline disabled:opacity-60"
                    title={t('formResponses.downloadFile')}
                    data-testid="response-file"
                  >
                    <Download class="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
                    <span class="min-w-0 break-all font-mono text-[13px]">{file.name}</span>
                  </button>
                {:else}
                  <span class="min-w-0 break-all font-mono text-[13px]">{file.name}</span>
                {/if}
                <span class="shrink-0 text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </dd>
    </div>
  {/each}
</dl>

<style>
  /* the value sits on its own quiet plate, so a long answer reads as one block */
  .answer-value,
  .answer-files {
    border: 1px solid var(--hairline);
    border-radius: 8px;
    background: color-mix(in oklab, var(--ground-2) 38%, transparent);
    padding: 8px 12px;
  }
</style>
