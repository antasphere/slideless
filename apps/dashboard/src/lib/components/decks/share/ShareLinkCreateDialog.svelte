<script lang="ts">
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { api, errorMessage } from '$lib/api';
  import { copyText } from '$lib/clipboard';
  import { rememberLinkUrl } from '$lib/decks/link-urls.svelte';
  import { buildShareTokenCreate, defaultShareLinkForm } from '$lib/decks/share-form';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { PresentationVersion } from '@slideless/contract';
  import { badgePositionSchema, buildEmbedSnippets } from '@slideless/contract';

  /**
   * The share-link CREATE flow, in two dialogs: the form, then the one-shot
   * "created" dialog where the viewer URL and the embed snippets appear
   * exactly once. Shared by the admin page's share panel and the master
   * page's share sheet (PRDCT-2279) — one form, one set of defaults.
   *
   * `open` is bindable: the host opens the form; the component closes it on
   * success and calls `onCreated` once the link is live.
   */
  interface Props {
    deckId: string;
    versions: PresentationVersion[];
    open: boolean;
    onCreated: () => void | Promise<void>;
  }

  let { deckId, versions, open = $bindable(), onCreated }: Props = $props();

  // ── Create form ────────────────────────────────────────────────────────
  const expiryOptions = [
    { value: 'never', label: t('tokens.expiryNever') },
    { value: '7', label: t('tokens.expiryDays', { n: 7 }) },
    { value: '30', label: t('tokens.expiryDays', { n: 30 }) },
    { value: '90', label: t('tokens.expiryDays', { n: 90 }) }
  ];
  let createLoading = $state(false);
  // The form's state, one object; the body it sends is built by a pure
  // function with its own unit test ($lib/decks/share-form.ts), so a switch
  // dropped from the payload goes red without a browser (PRDCT-2299).
  let form = $state(defaultShareLinkForm(null));

  // The 8 badge slots (4 corners + 4 edge centers) + inherit-the-deck-default.
  const badgeSlotLabels: Record<(typeof badgePositionSchema.options)[number], string> = $derived({
    'top-left': t('tokens.badgePosTopLeft'),
    top: t('tokens.badgePosTop'),
    'top-right': t('tokens.badgePosTopRight'),
    right: t('tokens.badgePosRight'),
    'bottom-right': t('tokens.badgePosBottomRight'),
    bottom: t('tokens.badgePosBottom'),
    'bottom-left': t('tokens.badgePosBottomLeft'),
    left: t('tokens.badgePosLeft')
  });
  const badgePositionOptions = $derived([
    { value: 'default', label: t('tokens.badgePositionDefault') },
    ...badgePositionSchema.options.map((slot) => ({ value: slot, label: badgeSlotLabels[slot] }))
  ]);

  // Reset the form each time the host opens it.
  $effect(() => {
    if (!open) return;
    form = defaultShareLinkForm(versions[0]?.version ?? null);
  });

  // ── Created dialog: the viewer URL appears exactly once ───────────────
  let createdUrl = $state<string | null>(null);
  let showCreatedDialog = $state(false);

  // ── Embed snippets (PRDCT-1312) ────────────────────────────────────────
  // Producible only NOW: secrets are hash-only at rest, so the snippets die
  // with this dialog exactly like the URL above. The script src is the APP
  // origin: the dashboard runs on it and it is the origin serving
  // /embed.js, so window.location.origin is correct even when
  // VIEWER_BASE_URL points share links elsewhere. The embedded deck URL
  // stays createdUrl (which honors VIEWER_BASE_URL). Sandbox attrs come
  // from the contract constant, the single source of truth (ADR 012
  // Surface D).
  const embedSnippets = $derived(
    createdUrl === null
      ? null
      : buildEmbedSnippets({ viewerUrl: createdUrl, appOrigin: window.location.origin })
  );
  const embedScriptSnippet = $derived(embedSnippets?.script ?? null);
  const embedIframeSnippet = $derived(embedSnippets?.iframe ?? null);

  async function submitCreate() {
    createLoading = true;
    try {
      const result = await api.createShareToken(deckId, buildShareTokenCreate(form));
      // The URL exists once, here: the links table's copy and open actions
      // read it from this page-session memory (PRDCT-2308).
      rememberLinkUrl(result.shareToken.id, result.url);
      open = false;
      createdUrl = result.url;
      showCreatedDialog = true;
      await onCreated();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.createFailed')));
    } finally {
      createLoading = false;
    }
  }
</script>

<FormDialog
  bind:open
  title={t('tokens.createTitle')}
  description={t('tokens.createDescription')}
  onClose={() => (open = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('tokens.createSubmit')}
>
  <div class="space-y-2">
    <Label for="token-name">{t('tokens.nameLabel')}</Label>
    <Input id="token-name" bind:value={form.name} placeholder={t('tokens.namePlaceholder')} required />
  </div>
  <div class="space-y-2">
    <Label for="token-version-mode">{t('tokens.versionLabel')}</Label>
    <Select.Root
      type="single"
      value={form.versionMode}
      onValueChange={(v) => {
        if (v === 'latest' || v === 'pinned') form.versionMode = v;
      }}
    >
      <Select.Trigger id="token-version-mode" class="w-full">
        {form.versionMode === 'latest' ? t('tokens.versionLatest') : t('tokens.versionPinned')}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="latest" label={t('tokens.versionLatest')} />
        <Select.Item value="pinned" label={t('tokens.versionPinned')} disabled={!versions.length} />
      </Select.Content>
    </Select.Root>
  </div>
  {#if form.versionMode === 'pinned'}
    <div class="space-y-2">
      <Label for="token-pinned-version">{t('tokens.colVersion')}</Label>
      <Select.Root
        type="single"
        value={form.pinnedVersion}
        onValueChange={(v) => {
          if (v) form.pinnedVersion = v;
        }}
      >
        <Select.Trigger id="token-pinned-version" class="w-full">
          {form.pinnedVersion ? `v${form.pinnedVersion}` : '—'}
        </Select.Trigger>
        <Select.Content>
          {#each versions as version (version.version)}
            <Select.Item value={String(version.version)} label={`v${version.version}`} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}
  <div class="flex items-center gap-2">
    <Checkbox id="token-annotate" bind:checked={form.canAnnotate} />
    <Label for="token-annotate" class="font-normal">
      {t('tokens.annotateLabel')}
      <span class="text-muted-foreground">{t('tokens.annotateHint')}</span>
    </Label>
  </div>
  <div class="flex items-center gap-2">
    <Checkbox id="token-forms" bind:checked={form.canSubmitForms} />
    <Label for="token-forms" class="font-normal">
      {t('tokens.formsLabel')}
      <span class="text-muted-foreground">{t('tokens.formsHint')}</span>
    </Label>
  </div>
  <div class="flex items-center gap-2">
    <Checkbox id="token-downloads" bind:checked={form.canDownload} />
    <Label for="token-downloads" class="font-normal">
      {t('tokens.downloadsLabel')}
      <span class="text-muted-foreground">{t('tokens.downloadsHint')}</span>
    </Label>
  </div>
  <div class="flex items-center gap-2">
    <Checkbox id="token-bar" bind:checked={form.showBar} />
    <Label for="token-bar" class="font-normal">
      {t('tokens.barLabel')}
      <span class="text-muted-foreground">{t('tokens.barHint')}</span>
    </Label>
  </div>
  {#if form.canAnnotate}
    <div class="space-y-2">
      <Label for="token-badge-position">{t('tokens.badgePositionLabel')}</Label>
      <Select.Root
        type="single"
        value={form.badgePosition}
        onValueChange={(v) => {
          if (v) form.badgePosition = v;
        }}
      >
        <Select.Trigger id="token-badge-position" class="w-full">
          {badgePositionOptions.find((o) => o.value === form.badgePosition)?.label}
        </Select.Trigger>
        <Select.Content>
          {#each badgePositionOptions as option (option.value)}
            <Select.Item value={option.value} label={option.label} />
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="text-xs text-muted-foreground">{t('tokens.badgePositionHint')}</p>
    </div>
  {/if}
  <div class="space-y-2">
    <Label for="token-expiry">{t('tokens.expiryLabel')}</Label>
    <Select.Root
      type="single"
      value={form.expiresIn}
      onValueChange={(v) => {
        if (v) form.expiresIn = v;
      }}
    >
      <Select.Trigger id="token-expiry" class="w-full">
        {expiryOptions.find((o) => o.value === form.expiresIn)?.label}
      </Select.Trigger>
      <Select.Content>
        {#each expiryOptions as option (option.value)}
          <Select.Item value={option.value} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="space-y-2">
    <Label for="token-password">{t('tokens.passwordLabel')}</Label>
    <Input id="token-password" type="password" autocomplete="off" bind:value={form.password} minlength={4} />
    <p class="text-xs text-muted-foreground">{t('tokens.passwordHint')}</p>
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showCreatedDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) createdUrl = null;
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('tokens.createdTitle')}</Dialog.Title>
      <Dialog.Description>{t('tokens.createdDescription')}</Dialog.Description>
    </Dialog.Header>
    {#if createdUrl}
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <Input readonly value={createdUrl} class="font-mono text-xs" aria-label={t('tokens.urlAria')} />
          <Button
            size="icon"
            variant="outline"
            class="shrink-0"
            aria-label={t('tokens.copyUrlAria')}
            onclick={() => void copyText(createdUrl!, t('tokens.urlCopied'))}
          >
            <Copy class="h-4 w-4" />
          </Button>
        </div>
        <p
          class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t('tokens.secretWarning')}</span>
        </p>
        <details class="rounded-md border">
          <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
            {t('tokens.embedTitle')}
          </summary>
          <div class="space-y-4 border-t p-3">
            <div class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium">{t('tokens.embedScriptLabel')}</span>
                <Button
                  size="icon"
                  variant="outline"
                  class="h-7 w-7 shrink-0"
                  aria-label={t('tokens.embedCopyScriptAria')}
                  onclick={() => void copyText(embedScriptSnippet!, t('tokens.embedCopied'))}
                >
                  <Copy class="h-3.5 w-3.5" />
                </Button>
              </div>
              <!-- Snippets render through escaped {} interpolation — never {@html}. -->
              <pre class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"><code
                  >{embedScriptSnippet}</code
                ></pre>
              <p class="text-xs text-muted-foreground">{t('tokens.embedScriptHint')}</p>
            </div>
            <div class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium">{t('tokens.embedIframeLabel')}</span>
                <Button
                  size="icon"
                  variant="outline"
                  class="h-7 w-7 shrink-0"
                  aria-label={t('tokens.embedCopyIframeAria')}
                  onclick={() => void copyText(embedIframeSnippet!, t('tokens.embedCopied'))}
                >
                  <Copy class="h-3.5 w-3.5" />
                </Button>
              </div>
              <pre class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"><code
                  >{embedIframeSnippet}</code
                ></pre>
              <p class="text-xs text-muted-foreground">{t('tokens.embedIframeHint')}</p>
            </div>
          </div>
        </details>
      </div>
    {/if}
    <div class="flex justify-end pt-2">
      <Button
        onclick={() => {
          showCreatedDialog = false;
          createdUrl = null;
        }}
      >
        {t('common.done')}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
