<script lang="ts">
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Reveal } from '$lib/components/ui/reveal/index.js';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { api, errorMessage } from '$lib/api';
  import { rememberLinkUrl } from '$lib/tool/decks/link-urls.svelte';
  import {
    buildShareTokenCreate,
    defaultShareLinkForm,
    isNamedLink,
    willRememberResponses
  } from '$lib/tool/decks/share-form';
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
  // function with its own unit test ($lib/tool/decks/share-form.ts), so a switch
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
  let createdRemembers = $state(false);
  let showCreatedDialog = $state(false);
  let showEmbed = $state(false);

  // A link nobody named is a link for nobody in particular: it does not
  // remember answers (the CLI's rule, $lib/tool/decks/share-form.ts). The form
  // says so where the switch is, instead of sending something else quietly.
  const named = $derived(isNamedLink(form));

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
      const result = await api.createShareToken(
        deckId,
        buildShareTokenCreate(form, Date.now(), t('tokens.unnamedLabel'))
      );
      // The URL exists once, here: the links table's copy and open actions
      // read it from this page-session memory (PRDCT-2308).
      rememberLinkUrl(result.shareToken.id, result.url);
      open = false;
      createdUrl = result.url;
      createdRemembers = willRememberResponses(form);
      showEmbed = false;
      showCreatedDialog = true;
      await onCreated();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.createFailed')));
    } finally {
      createLoading = false;
    }
  }
</script>

{#snippet shareAside()}
  <Dialog.Illustration eyebrow={t('tokens.asideEyebrow')} caption={t('tokens.asideCaption')}>
    <DialogDrawing kind="share" />
  </Dialog.Illustration>
{/snippet}

{#snippet createdAside()}
  <Dialog.Illustration eyebrow={t('tokens.asideEyebrow')} caption={t('tokens.createdAsideCaption')}>
    <DialogDrawing kind="shared" />
  </Dialog.Illustration>
{/snippet}

<!-- One capability of the link: its switch, its name, and under it what it
     means. The whole row is the label (app.css `.choice`), so the hand lands
     anywhere on it; the switch is named by the title alone, and the hint is
     its description, never part of its name. -->
{#snippet option(
  id: string,
  label: string,
  hint: string,
  checked: boolean,
  set: (v: boolean) => void,
  disabled?: boolean
)}
  <label for={id} class="choice" data-disabled={disabled ? '' : undefined}>
    <Checkbox
      {id}
      {checked}
      {disabled}
      onCheckedChange={(v) => set(v === true)}
      aria-labelledby="{id}-name"
      aria-describedby="{id}-hint"
      class="mt-0.5"
    />
    <span class="min-w-0">
      <span id="{id}-name" class="choice-name">{label}</span>
      <span id="{id}-hint" class="choice-hint block">{hint}</span>
    </span>
  </label>
{/snippet}

<FormDialog
  bind:open
  size="lg"
  aside={shareAside}
  title={t('tokens.createTitle')}
  description={t('tokens.createDescription')}
  onClose={() => (open = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('tokens.createSubmit')}
>
  <div class="space-y-2">
    <Label for="token-name">{t('tokens.nameLabel')}</Label>
    <Input
      id="token-name"
      bind:value={form.name}
      placeholder={t('tokens.namePlaceholder')}
      maxlength={200}
      aria-describedby="token-name-hint"
    />
    <p id="token-name-hint" class="hint">{t('tokens.nameHint')}</p>
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
  <Reveal open={form.versionMode === 'pinned'} class="space-y-2">
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
  </Reveal>

  <fieldset class="space-y-2">
    <legend class="eyebrow pb-2">{t('tokens.groupCan')}</legend>
    <div class="choices">
      {@render option(
        'token-annotate',
        t('tokens.annotateLabel'),
        t('tokens.annotateHint'),
        form.canAnnotate,
        (v) => (form.canAnnotate = v)
      )}
      <Reveal open={form.canAnnotate} class="nested space-y-2">
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
        <p class="hint">{t('tokens.badgePositionHint')}</p>
      </Reveal>

      {@render option(
        'token-forms',
        t('tokens.formsLabel'),
        t('tokens.formsHint'),
        form.canSubmitForms,
        (v) => (form.canSubmitForms = v)
      )}
      <Reveal open={form.canSubmitForms} class="nested">
        {@render option(
          'token-uploads',
          t('tokens.uploadsLabel'),
          t('tokens.uploadsHint'),
          form.canUploadFiles,
          (v) => (form.canUploadFiles = v)
        )}
        <!-- An unnamed link never remembers: the switch shows it, off and
             locked, with the reason, rather than staying ticked and lying. -->
        {@render option(
          'token-remember',
          t('tokens.rememberLabel'),
          named ? t('tokens.rememberHint') : t('tokens.rememberNeedsName'),
          named && form.remembersResponses,
          (v) => (form.remembersResponses = v),
          !named
        )}
        <Reveal open={named && form.remembersResponses}>
          <p class="note note--warn" data-testid="token-remember-warning">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
            <span>{t('tokens.rememberWarning')}</span>
          </p>
        </Reveal>
      </Reveal>

      {@render option(
        'token-downloads',
        t('tokens.downloadsLabel'),
        t('tokens.downloadsHint'),
        form.canDownload,
        (v) => (form.canDownload = v)
      )}
      {@render option(
        'token-bar',
        t('tokens.barLabel'),
        t('tokens.barHint'),
        form.showBar,
        (v) => (form.showBar = v)
      )}
    </div>
  </fieldset>

  <div class="grid gap-4 sm:grid-cols-2">
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
      <Input
        id="token-password"
        type="password"
        autocomplete="off"
        bind:value={form.password}
        minlength={4}
      />
    </div>
  </div>
  <Reveal open={form.password.length > 0}>
    <p class="hint">{t('tokens.passwordHint')}</p>
  </Reveal>
</FormDialog>

<Dialog.Root
  bind:open={showCreatedDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) createdUrl = null;
  }}
>
  <Dialog.Content size="lg" aside={createdAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('tokens.createdTitle')}</Dialog.Title>
      <Dialog.Description>{t('tokens.createdDescription')}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-4">
      {#if createdUrl}
        <CodeBlock
          field
          code={createdUrl}
          ariaLabel={t('tokens.urlAria')}
          copyLabel={t('tokens.copyUrlAria')}
          copiedMessage={t('tokens.urlCopied')}
        />
        <p class="note note--danger">
          <TriangleAlert class="mt-0.5 size-4 shrink-0" />
          <span>{t('tokens.secretWarning')}</span>
        </p>

        <div class="embed">
          <button
            type="button"
            class="embed-toggle"
            aria-expanded={showEmbed}
            aria-controls="token-embed"
            onclick={() => (showEmbed = !showEmbed)}
          >
            <span>{t('tokens.embedTitle')}</span>
            <ChevronDown class="chevron size-4" />
          </button>
          <Reveal open={showEmbed} id="token-embed" class="embed-body space-y-4">
            {#if createdRemembers}
              <p class="note note--warn">
                <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
                <span>{t('tokens.embedRememberWarning')}</span>
              </p>
            {/if}
            <!-- SECURITY: CodeBlock renders the snippets as text, piece by
                 piece, through escaped interpolation. Never {@html}. -->
            <div class="space-y-1.5">
              <CodeBlock
                code={embedScriptSnippet ?? ''}
                language="html"
                label={t('tokens.embedScriptLabel')}
                copyLabel={t('tokens.embedCopyScriptAria')}
                copiedMessage={t('tokens.embedCopied')}
              />
              <p class="hint">{t('tokens.embedScriptHint')}</p>
            </div>
            <div class="space-y-1.5">
              <CodeBlock
                code={embedIframeSnippet ?? ''}
                language="html"
                label={t('tokens.embedIframeLabel')}
                copyLabel={t('tokens.embedCopyIframeAria')}
                copiedMessage={t('tokens.embedCopied')}
              />
              <p class="hint">{t('tokens.embedIframeHint')}</p>
            </div>
          </Reveal>
        </div>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showCreatedDialog = false;
          createdUrl = null;
        }}
      >
        {t('common.done')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .hint {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted);
    text-wrap: pretty;
  }
  /* what a switch opens sits under it, set in from the rule (the rows
     themselves are app.css `.choices` and `.choice`) */
  .choices :global(.nested) {
    padding: 0 12px 12px 38px;
    border-top: 0;
  }
  .choices :global(.nested .choice) {
    padding: 9px 0;
  }
  .choices :global(.nested > .choice + .choice) {
    border-top: 1px solid color-mix(in oklab, var(--hairline) 60%, transparent);
  }

  .note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    text-wrap: pretty;
  }
  .note--warn {
    border: 1px solid color-mix(in oklab, var(--warn) 30%, transparent);
    background: var(--warn-soft);
    color: color-mix(in oklab, var(--warn) 55%, var(--ink));
    font-size: 12.5px;
  }
  .note--danger {
    border: 1px solid color-mix(in oklab, var(--danger) 30%, transparent);
    background: var(--danger-soft);
    color: color-mix(in oklab, var(--danger) 45%, var(--ink));
  }
  .note :global(svg) {
    color: currentColor;
  }

  .embed {
    border: 1px solid var(--hairline);
    border-radius: 10px;
    background: color-mix(in oklab, var(--ground-2) 38%, transparent);
  }
  .embed-toggle {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 500;
    text-align: left;
    transition: background-color var(--motion-duration) var(--motion-ease);
  }
  .embed-toggle:hover {
    background: color-mix(in oklab, var(--accent) 6%, transparent);
  }
  .embed-toggle :global(.chevron) {
    flex: none;
    color: var(--muted);
    transition: transform calc(var(--motion-duration) * 1.25) var(--motion-ease);
  }
  .embed-toggle[aria-expanded='true'] :global(.chevron) {
    transform: rotate(180deg);
  }
  .embed :global(.embed-body) {
    padding: 4px 12px 12px;
  }
</style>
