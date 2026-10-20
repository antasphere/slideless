<script lang="ts">
  /*
   * The Data tab of a TEMPLATE (PRDCT-3641, data-bound templates): its data
   * contract (the JSON Schema, the sample data.json, the field paths its
   * pages bind), an editor for the schema and the sample, and its entry page
   * previewed with the sample.
   *
   * Out of scope here, on purpose: the list of the documents made from this
   * template (a later task), and editing a DOCUMENT's data from the dashboard
   * (the CLI and the API do it).
   *
   * SECURITY: the schema, the sample and the binding paths are deck-author
   * text on the APP ORIGIN: CodeBlock and Tag render them through text
   * interpolation only, never {@html}. The preview is the template's own
   * HTML filled with the sample: it renders ONLY inside the sandboxed iframe
   * below, through `srcdoc`, with the deck preview's sandbox set
   * (PREVIEW_SANDBOX: never `allow-same-origin`, never
   * `allow-top-navigation*`), so it runs in an opaque origin exactly like the
   * `/v/` preview. A srcdoc frame also inherits the dashboard's CSP, which
   * keeps the deck's inline scripts from running: the preview shows the
   * filled page, not its behaviour.
   */
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Tag } from '$lib/components/ui/tag/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import Pencil from '@lucide/svelte/icons/pencil';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import EmptyTable from './EmptyTable.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { refusalCard, toastApiError } from '$lib/billing-refusal';
  import { PREVIEW_SANDBOX } from '$lib/tool/decks';
  import {
    jsonText,
    parseEditorJson,
    previewWithSample,
    refusalLines,
    type EditorJson
  } from '$lib/tool/decks/data';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { TemplateDataContract } from '@slideless/contract';

  interface Props {
    deckId: string;
    /** The page's preview token URL (`/v/{secret}/`), null while minting or when unavailable. */
    previewUrl: string | null;
    /** Bumps when the page's preview targets another version. */
    previewKey: number;
    /** Whether this reader may mint a preview (owner or workspace admin). */
    canPreview: boolean;
    /** The page's preview error, if its token could not be minted. */
    previewError: string | null;
    /** The tab bar's count: the bindings, `undefined` while unknown. */
    oncount?: (n: number | undefined) => void;
    /** A save made a new template version: the page reloads the deck. */
    onchange?: () => void;
  }

  let { deckId, previewUrl, previewKey, canPreview, previewError, oncount, onchange }: Props = $props();

  // ── The contract ────────────────────────────────────────────────────────
  let contract = $state<TemplateDataContract | null>(null);
  let loading = $state(true);
  let noSchema = $state(false);
  let loadError = $state<string | null>(null);

  async function load() {
    try {
      contract = await api.templateSchema(deckId);
      noSchema = false;
      loadError = null;
    } catch (e) {
      if (e instanceof PlatformApiError && e.code === 'no_schema') {
        contract = null;
        noSchema = true;
        loadError = null;
      } else {
        loadError = errorMessage(e, t('common.genericError'));
      }
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  $effect(() => {
    oncount?.(contract ? contract.bindings.length : undefined);
  });

  const bindings = $derived(contract ? [...contract.bindings].sort() : []);

  // ── The editor ──────────────────────────────────────────────────────────
  let editing = $state(false);
  let schemaText = $state('');
  let sampleText = $state('');
  let schemaError = $state<string | null>(null);
  let sampleError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let saveLines = $state<string[]>([]);

  function startEdit() {
    schemaText = contract ? jsonText(contract.schema) : '';
    sampleText = contract?.sample ? jsonText(contract.sample) : '';
    schemaError = sampleError = saveError = null;
    saveLines = [];
    editing = true;
  }

  function cancelEdit() {
    editing = false;
    schemaError = sampleError = saveError = null;
    saveLines = [];
  }

  function editorMessage(result: Extract<EditorJson, { ok: false }>): string {
    if (result.error === 'empty') return t('docData.schemaEmpty');
    if (result.error === 'not_object') return t('docData.notObject');
    return t('docData.parseError', { error: result.error });
  }

  async function save() {
    const schema = parseEditorJson(schemaText);
    const sample = parseEditorJson(sampleText, { allowEmpty: true });
    schemaError = schema.ok ? null : editorMessage(schema);
    sampleError = sample.ok ? null : editorMessage(sample);
    saveError = null;
    saveLines = [];
    // a parse error stays under its textarea, and nothing is sent
    if (!schema.ok || !sample.ok || schema.value === null) return;
    saving = true;
    try {
      const saved = await api.setTemplateSchema(deckId, { schema: schema.value, sample: sample.value });
      editing = false;
      toast.success(t('docData.savedToast', { version: saved.version }));
      await load();
      onchange?.();
    } catch (e) {
      if (refusalCard(e)) {
        toastApiError(e, t('common.genericError'));
      } else {
        saveError = t('docData.saveFailed', { error: errorMessage(e, t('common.genericError')) });
        saveLines = e instanceof PlatformApiError ? refusalLines(e.code, e.details) : [];
      }
    } finally {
      saving = false;
    }
  }

  // ── The preview with the sample ─────────────────────────────────────────
  let previewHtml = $state<string | null>(null);
  let previewRendered = $state(false);
  let previewLoadError = $state<string | null>(null);

  $effect(() => {
    const url = previewUrl;
    void previewKey;
    const sample = contract?.sample ?? null;
    if (!url || !canPreview || loading) return;
    let live = true;
    void (async () => {
      try {
        // the entry page's authored bytes, through the page's own preview token
        const res = await fetch(`${url}?raw`, { cache: 'no-store', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (!live) return;
        const out = previewWithSample(html, sample, url);
        previewHtml = out.html;
        previewRendered = out.rendered;
        previewLoadError = null;
      } catch (e) {
        if (!live) return;
        previewHtml = null;
        previewLoadError = errorMessage(e, t('common.genericError'));
      }
    })();
    return () => {
      live = false;
    };
  });
</script>

{#if loading}
  <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
{:else if loadError}
  <p class="text-sm text-destructive" in:appear>{t('docData.contractLoadFailed', { error: loadError })}</p>
{:else}
  <div class="space-y-6" data-testid="template-data-panel">
    {#if noSchema || !contract}
      <Card.Root class="deck-section gap-3">
        <DeckSectionHeading drawing="details" title={t('docData.contractTitle')} />
        <Card.Content>
          <EmptyTable message={t('docData.noSchema')} />
        </Card.Content>
      </Card.Root>
    {:else}
      {#snippet editAction()}
        {#if !editing}
          <Button variant="outline" size="sm" onclick={startEdit} data-testid="template-data-edit">
            <Pencil class="mr-2 h-3.5 w-3.5" />
            {t('docData.edit')}
          </Button>
        {/if}
      {/snippet}

      <Card.Root class="deck-section gap-3">
        <DeckSectionHeading
          drawing="details"
          title={t('docData.schemaTitle')}
          description={t('docData.schemaDescription', {
            schemaVersion: contract.schemaVersion,
            version: contract.version
          })}
          action={editAction}
        />
        <Card.Content class="space-y-4">
          {#if editing}
            <div class="space-y-2">
              <Label for="template-schema-text">{t('docData.schemaField')}</Label>
              <Textarea
                id="template-schema-text"
                bind:value={schemaText}
                spellcheck="false"
                rows={16}
                class="font-mono text-xs"
                data-testid="template-schema-text"
              />
              <FormError message={schemaError} />
            </div>
            <div class="space-y-2">
              <Label for="template-sample-text">{t('docData.sampleField')}</Label>
              <Textarea
                id="template-sample-text"
                bind:value={sampleText}
                spellcheck="false"
                rows={12}
                class="font-mono text-xs"
                data-testid="template-sample-text"
              />
              <p class="text-xs text-muted-foreground">{t('docData.sampleEmptyHint')}</p>
              <FormError message={sampleError} />
            </div>
            {#if saveError}
              <div
                class="space-y-1 text-sm text-destructive"
                role="alert"
                in:appear
                data-testid="template-save-error"
              >
                <p>{saveError}</p>
                {#if saveLines.length}
                  <ul class="list-disc space-y-0.5 pl-5 font-mono text-xs">
                    {#each saveLines as line, i (i)}
                      <li>{line}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
            <div class="flex justify-end gap-2">
              <Button variant="outline" size="sm" onclick={cancelEdit} disabled={saving}>
                {t('docData.cancel')}
              </Button>
              <Button
                size="sm"
                onclick={() => void save()}
                disabled={saving}
                data-testid="template-data-save"
              >
                {saving ? t('docData.saving') : t('docData.save')}
              </Button>
            </div>
          {:else}
            <CodeBlock code={jsonText(contract.schema)} label="schema.json" language="json" wrap={false} />
          {/if}
        </Card.Content>
      </Card.Root>

      {#if !editing}
        <Card.Root class="deck-section gap-3">
          <DeckSectionHeading
            drawing="details"
            title={t('docData.sampleTitle')}
            description={t('docData.sampleDescription')}
          />
          <Card.Content>
            {#if contract.sample}
              <CodeBlock code={jsonText(contract.sample)} label="data.json" language="json" wrap={false} />
            {:else}
              <EmptyTable message={t('docData.noSample')} />
            {/if}
          </Card.Content>
        </Card.Root>
      {/if}

      <Card.Root class="deck-section gap-3">
        <DeckSectionHeading
          drawing="links"
          title={t('docData.bindingsTitle')}
          description={bindings.length === 1
            ? t('docData.bindingsCountOne')
            : t('docData.bindingsCount', { n: bindings.length })}
        />
        <Card.Content>
          {#if bindings.length}
            <ul class="flex flex-wrap gap-1.5" data-testid="template-bindings">
              {#each bindings as path (path)}
                <li><Tag label={path} mono /></li>
              {/each}
            </ul>
          {:else}
            <EmptyTable message={t('docData.noBindings')} />
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root class="deck-section gap-3">
      <DeckSectionHeading
        drawing="preview"
        title={t('docData.previewTitle')}
        description={contract?.sample && previewRendered
          ? t('docData.previewDescription')
          : t('docData.previewRaw')}
      />
      <Card.Content>
        {#if !canPreview}
          <p class="text-sm text-muted-foreground">{t('docData.previewOwnerOnly')}</p>
        {:else if previewError || previewLoadError}
          <p class="text-sm text-destructive" in:appear>
            {t('docData.previewFailed', { error: previewError ?? previewLoadError ?? '' })}
          </p>
        {:else if previewHtml === null}
          <div
            class="flex h-[320px] w-full items-center justify-center rounded-[8px] border border-dashed border-[var(--hairline)] md:h-[480px]"
          >
            <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
          </div>
        {:else}
          <!-- SECURITY (ADR 012 Surface D): the template's HTML, filled with
               the sample, renders ONLY inside this sandboxed frame. The
               sandbox must NEVER gain `allow-same-origin` (a srcdoc frame
               with it would run deck script AS the dashboard) nor
               `allow-top-navigation*`. -->
          <iframe
            srcdoc={previewHtml}
            title={t('docData.previewTitle')}
            sandbox={PREVIEW_SANDBOX}
            referrerpolicy="no-referrer"
            class="h-[320px] w-full rounded-[8px] border border-[var(--hairline)] bg-background md:h-[480px]"
            data-testid="template-data-preview"
          ></iframe>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
{/if}
