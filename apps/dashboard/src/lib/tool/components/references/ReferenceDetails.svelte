<script lang="ts">
  /* The body of the reference sheet (PRDCT-2421), for ONE reference: the
     description, the frontmatter rendered by its type (a brand: colours as
     swatches with their hex, the fonts with a specimen when Google Fonts
     serves the family, background, shape, motion, the voice; a template:
     purpose, pages, what to fill; any key the type does not define as rows,
     nothing dropped), the files of the shown version (each downloadable
     through $lib/download, never a plain anchor, PRDCT-2426; the assets/
     folder first), the versions, the audience switch, the default, and the
     way to start a deck from it.

     The page hides, the server rules: the switch shows for whoever
     administers the deck, the default button for a workspace admin or owner,
     and a refusal the server answers is a sentence under the control.

     SECURITY: every frontmatter value, file name and title is USER-AUTHORED
     and renders through text interpolation only, never {@html}. A colour
     reaches an inline style only as a checked hex (hexOf); a font family
     reaches a font-family style only when it is on the Google Fonts list. */
  import { untrack } from 'svelte';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Tag } from '$lib/components/ui/tag';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import VersionList from '$lib/tool/components/decks/VersionList.svelte';
  import DeckStill from '$lib/tool/components/decks/DeckStill.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { download } from '$lib/download';
  import { fileTag } from '$lib/tags';
  import { formatBytes } from '$lib/format';
  import {
    audienceSentence,
    basenameOf,
    canSetAudience,
    canSetDefault,
    descriptionOf,
    entriesOf,
    extraFieldsOf,
    fileGroupsOf,
    fontsOf,
    googleFontOf,
    googleFontsHref,
    linesOf,
    plainValue,
    referenceRefusal,
    swatchesOf,
    tagsOf,
    voiceOf
  } from '$lib/tool/references';
  import { t } from '$lib/i18n';
  import type { MessageKey } from '$lib/i18n';
  import Crown from '@lucide/svelte/icons/crown';
  import Download from '@lucide/svelte/icons/download';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Lock from '@lucide/svelte/icons/lock';
  import Users from '@lucide/svelte/icons/users';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
  import { toast } from 'svelte-sonner';
  import type {
    Audience,
    MeResponse,
    Presentation,
    PresentationVersionDetail,
    PresentationVersionSummary,
    ReferenceType
  } from '@slideless/contract';

  interface Props {
    deck: Presentation;
    type: ReferenceType;
    me: MeResponse;
    onChanged: (deck: Presentation) => void;
  }

  let { deck, type, me, onChanged }: Props = $props();

  // the body is keyed on the deck by the sheet: the id and the first shown
  // version are read once, on purpose
  const deckId = untrack(() => deck.id);
  const typeName = $derived(t(type === 'brand' ? 'refs.typeBrandLower' : 'refs.typeTemplateLower'));

  // ── The versions and the one shown ──────────────────────────────────────
  const versions = createPagedList<PresentationVersionSummary>(async (p) => {
    const { versions, nextCursor } = await api.presentationVersions(deckId, p);
    return { items: versions, nextCursor };
  });
  $effect(() => {
    void versions.load();
  });

  let shownVersion = $state(untrack(() => deck.currentVersion));
  // One detail fetch per shown version; versions are immutable, so the
  // answer never goes stale.
  let details = $state<Record<number, PresentationVersionDetail>>({});
  let detailErrors = $state<Record<number, string>>({});
  $effect(() => {
    const v = shownVersion;
    if (v < 1 || v in details || v in detailErrors) return;
    api
      .presentationVersion(deckId, v)
      .then((d) => (details = { ...details, [v]: d }))
      .catch((e) => (detailErrors = { ...detailErrors, [v]: errorMessage(e, t('common.genericError')) }));
  });
  const detail = $derived(details[shownVersion] ?? null);
  // The frontmatter of the shown version: the detail's once it is here, the
  // deck's own for the current version meanwhile.
  const reference = $derived(
    detail ? detail.reference : shownVersion === deck.currentVersion ? deck.reference : null
  );

  // ── The frontmatter, by type ────────────────────────────────────────────
  const description = $derived(descriptionOf(reference));
  const tags = $derived(tagsOf(reference));
  const swatches = $derived(swatchesOf(reference));
  const fonts = $derived(fontsOf(reference));
  const fontsHref = $derived(googleFontsHref(fonts));
  const voice = $derived(voiceOf(reference));
  // a typed field the section could not read (a string where a list was
  // expected, an object as the description) is kept as a plain row below
  const unread = $derived([
    ...(description || !reference?.description ? [] : ['description']),
    ...(tags.length || !reference?.tags ? [] : ['tags']),
    ...(type !== 'brand' || swatches.length || !reference?.colors ? [] : ['colors']),
    ...(type !== 'brand' || fonts.length || !reference?.fonts ? [] : ['fonts']),
    ...(type !== 'brand' || voice || !reference?.voice ? [] : ['voice'])
  ]);
  const extras = $derived(extraFieldsOf(reference, type, unread));
  const field = (key: string) => reference?.[key];
  // the brand's three plain sections, each a label over its rows
  const BRAND_ROWS: [string, MessageKey][] = [
    ['background', 'refs.background'],
    ['shape', 'refs.shape'],
    ['motion', 'refs.motion']
  ];
  const fileGroups = $derived(detail ? fileGroupsOf(detail.manifest) : []);

  // ── The audience and the default ────────────────────────────────────────
  const mayAudience = $derived(canSetAudience(me, deck));
  const mayDefault = $derived(canSetDefault(me));
  let saving = $state(false);
  let refusal = $state<string | null>(null);

  async function patch(body: { audience?: Audience; defaultReference?: boolean }, done: string) {
    saving = true;
    refusal = null;
    try {
      const updated = await api.updatePresentation(deckId, body);
      onChanged(updated);
      toast.success(done);
    } catch (e) {
      const code = e instanceof PlatformApiError ? e.code : undefined;
      refusal = referenceRefusal(code, type) ?? errorMessage(e);
    } finally {
      saving = false;
    }
  }
  const setAudience = (audience: Audience) =>
    patch({ audience }, audience === 'workspace' ? t('refs.published') : t('refs.madePrivate'));
  const setDefault = (defaultReference: boolean) =>
    patch(
      { defaultReference },
      defaultReference
        ? t('refs.defaultSet', { type: typeName })
        : t('refs.defaultCleared', { type: typeName })
    );

  // ── Start a deck from it ────────────────────────────────────────────────
  let showStart = $state(false);
  const startCommand = $derived(`slideless ${type} start "${deck.title.replace(/"/g, '\\"')}" ./my-deck`);
</script>

<svelte:head>
  {#if fontsHref}
    <link rel="stylesheet" href={fontsHref} />
  {/if}
</svelte:head>

<Sheet.Header class="space-y-2 pr-8">
  <div class="flex flex-wrap items-center gap-2">
    <Tag label={t(type === 'brand' ? 'refs.typeBrand' : 'refs.typeTemplate')} tone="violet" />
    {#if deck.audience === 'workspace'}
      <Tag label={t('refs.audienceWorkspace')} tone="green" icon={Users} />
    {:else}
      <Tag label={t('refs.audiencePrivate')} tone="slate" icon={Lock} />
    {/if}
    {#if deck.defaultReference}
      <Tag label={t('refs.default')} tone="amber" icon={Crown} />
    {/if}
  </div>
  <Sheet.Title class="text-xl">{deck.title}</Sheet.Title>
  {#if description}
    <Sheet.Description>{description}</Sheet.Description>
  {/if}
  {#if tags.length}
    <p class="flex flex-wrap gap-1.5" aria-label={t('refs.tags')}>
      {#each tags as tag (tag)}
        <span class="chip">{tag}</span>
      {/each}
    </p>
  {/if}
</Sheet.Header>

<!-- the shown version's still image, captured on the server at its push and
     served to every reader of the deck (PRDCT-2725); a picture, no deck HTML -->
{#if deck.currentVersion > 0}
  <section class="space-y-2">
    <p class="eyebrow">{t('refs.sheetPreview', { n: shownVersion })}</p>
    <div class="plate-window preview" data-testid="reference-preview">
      <DeckStill {deckId} version={shownVersion} alt={t('master.thumbTitle', { n: shownVersion })} />
    </div>
  </section>
{/if}

{#if !reference}
  {#if shownVersion in detailErrors}
    <p class="text-sm text-destructive" role="alert">{detailErrors[shownVersion]}</p>
  {:else if !detail && shownVersion > 0}
    <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
  {:else}
    <p class="text-sm text-muted-foreground">{t('refs.noFrontmatter')}</p>
  {/if}
{:else if type === 'brand'}
  {#if swatches.length}
    <section class="space-y-2" data-testid="reference-colours">
      <p class="eyebrow">{t('refs.colours')}</p>
      <ul class="swatches">
        {#each swatches as swatch (swatch.name + swatch.hex)}
          <li class="swatch">
            <span class="sw" style={swatch.hex ? `background: ${swatch.hex}` : ''} class:none={!swatch.hex}
            ></span>
            <span class="min-w-0">
              <span class="block truncate text-sm">{swatch.name}</span>
              <span class="block truncate text-xs text-muted-foreground">
                {#if swatch.hex}<span class="font-mono">{swatch.hex}</span>{/if}
                {#if swatch.hex && swatch.role}
                  ·
                {/if}
                {swatch.role}
              </span>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if fonts.length}
    <section class="space-y-2" data-testid="reference-fonts">
      <p class="eyebrow">{t('refs.fonts')}</p>
      <ul class="fonts">
        {#each fonts as face (face.slot + face.family)}
          {@const served = googleFontOf(face.family)}
          <li class="font">
            {#if served}
              <span
                class="specimen"
                style="font-family: '{served}', sans-serif"
                title={t('refs.fontSpecimenTitle', { family: served })}>Aa</span
              >
            {:else}
              <span class="specimen plain" aria-hidden="true">Aa</span>
            {/if}
            <span class="min-w-0">
              <span class="block truncate text-sm"
                >{face.family} <span class="text-muted-foreground">· {face.slot}</span></span
              >
              {#if face.weights.length || face.source}
                <span class="block truncate text-xs text-muted-foreground">
                  {#if face.weights.length}{t('refs.fontWeights', { weights: face.weights.join(', ') })}{/if}
                  {#if face.weights.length && face.source}
                    ·
                  {/if}
                  {#if face.source}{t('refs.fontFile', { file: face.source })}{/if}
                </span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#each BRAND_ROWS as [key, label] (key)}
    {@const rows = entriesOf(field(key))}
    {#if rows.length}
      <section class="space-y-2">
        <p class="eyebrow">{t(label)}</p>
        <dl class="rows">
          {#each rows as row (row.key)}
            <div class="row">
              {#if row.key}<dt>{row.key}</dt>{/if}
              <dd>{row.value}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/if}
  {/each}
  {#if voice}
    <section class="space-y-2" data-testid="reference-voice">
      <p class="eyebrow">{t('refs.voice')}</p>
      <dl class="rows">
        {#if voice.tone.length}
          <div class="row">
            <dt>{t('refs.voiceTone')}</dt>
            <dd class="flex flex-wrap gap-1.5">
              {#each voice.tone as word (word)}<span class="chip">{word}</span>{/each}
            </dd>
          </div>
        {/if}
        {#if voice.avoid.length}
          <div class="row">
            <dt>{t('refs.voiceAvoid')}</dt>
            <dd class="flex flex-wrap gap-1.5">
              {#each voice.avoid as word (word)}<span class="chip struck">{word}</span>{/each}
            </dd>
          </div>
        {/if}
        {#each voice.rest as row (row.key)}
          <div class="row">
            <dt>{row.key}</dt>
            <dd class:sample={row.key === 'example'}>{row.value}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}
{:else}
  {@const purpose = plainValue(field('purpose'))}
  {@const pages = linesOf(field('pages'))}
  {@const fill = entriesOf(field('fill'))}
  {#if purpose}
    <section class="space-y-2" data-testid="reference-purpose">
      <p class="eyebrow">{t('refs.purpose')}</p>
      <p class="text-sm leading-relaxed">{purpose}</p>
    </section>
  {/if}
  {#if pages.length}
    <section class="space-y-2" data-testid="reference-pages">
      <p class="eyebrow">{t('refs.pages')}</p>
      <ol class="pages">
        {#each pages as line, i (i)}
          <li>{line}</li>
        {/each}
      </ol>
    </section>
  {/if}
  {#if fill.length}
    <section class="space-y-2" data-testid="reference-fill">
      <p class="eyebrow">{t('refs.fill')}</p>
      <dl class="rows">
        {#each fill as row (row.key)}
          <div class="row">
            {#if row.key}<dt>{row.key}</dt>{/if}
            <dd>{row.value}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}
{/if}

{#if extras.length}
  <section class="space-y-2" data-testid="reference-extras">
    <p class="eyebrow">{t('refs.more')}</p>
    <dl class="rows">
      {#each extras as row (row.key)}
        <div class="row">
          <dt>{row.key}</dt>
          <dd>{row.value}</dd>
        </div>
      {/each}
    </dl>
  </section>
{/if}

{#if shownVersion > 0}
  <section class="space-y-2" data-testid="reference-files">
    <p class="eyebrow">{t('refs.filesTitle', { n: shownVersion })}</p>
    {#if shownVersion in detailErrors}
      <p class="text-sm text-destructive" role="alert" transition:reveal>
        {t('refs.filesLoadFailed', { error: detailErrors[shownVersion] })}
      </p>
    {:else if !detail}
      <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
    {:else}
      <div class="space-y-3" in:appear>
        {#each fileGroups as group (group.id)}
          <div class="files">
            <p class="files-head">{group.id === 'assets' ? t('refs.filesAssets') : t('refs.filesRoot')}</p>
            <ul class="divide-y">
              {#each group.files as file (file.path)}
                {@const name = group.id === 'assets' ? file.path.slice('assets/'.length) : file.path}
                <!-- SECURITY: file names are DECK-AUTHORED text; escaped {}
                     interpolation only. Through $lib/download, never a plain
                     anchor (PRDCT-2426): an anchor cannot carry the active
                     workspace. -->
                <li class="file">
                  <Tag {...fileTag(file.contentType)} />
                  <button
                    type="button"
                    class="file-name"
                    title={t('refs.download', { name: basenameOf(file.path) })}
                    data-testid="reference-file"
                    data-path={file.path}
                    onclick={() =>
                      void download(() => api.downloadPresentationAsset(deckId, file.sha256), {
                        fallbackName: basenameOf(file.path)
                      })}
                  >
                    <span class="truncate font-mono text-[13px]">{name}</span>
                    <Download class="size-3.5 shrink-0" />
                  </button>
                  <span class="shrink-0 text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<section class="space-y-2" data-testid="reference-versions">
  <p class="eyebrow">{t('refs.versions')}</p>
  <div class="versions">
    <VersionList
      list={versions}
      {deckId}
      currentVersion={deck.currentVersion}
      {shownVersion}
      onPick={(v) => (shownVersion = v)}
    />
  </div>
</section>

<section class="space-y-2" data-testid="reference-audience">
  <p class="eyebrow">{t('refs.audienceTitle')}</p>
  {#if mayAudience}
    <div class="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={deck.audience === 'workspace'}
        aria-labelledby="reference-audience-label"
        class="switch"
        disabled={saving}
        data-testid="audience-switch"
        onclick={() => void setAudience(deck.audience === 'workspace' ? 'private' : 'workspace')}
      >
        <span class="knob"></span>
      </button>
      <span id="reference-audience-label" class="text-sm">{t('refs.switchWorkspace')}</span>
    </div>
  {/if}
  <p class="text-sm text-muted-foreground" data-testid="audience-sentence">
    {audienceSentence(deck.audience)}
  </p>
  {#if refusal}
    <p class="text-sm text-destructive" role="alert" data-testid="reference-refusal" transition:reveal>
      {refusal}
    </p>
  {/if}
  {#if mayDefault}
    <div class="pt-1">
      {#if deck.defaultReference}
        <Button variant="outline" size="sm" disabled={saving} onclick={() => void setDefault(false)}>
          <Crown class="mr-1.5 size-3.5" />
          {t('refs.clearDefault')}
        </Button>
      {:else}
        <Button variant="outline" size="sm" disabled={saving} onclick={() => void setDefault(true)}>
          <Crown class="mr-1.5 size-3.5" />
          {t(type === 'brand' ? 'refs.setDefaultBrand' : 'refs.setDefaultTemplate')}
        </Button>
      {/if}
    </div>
  {:else if deck.defaultReference}
    <p class="text-sm">{t(type === 'brand' ? 'refs.isDefaultBrand' : 'refs.isDefaultTemplate')}</p>
  {/if}
</section>

<Sheet.Footer class="mt-auto flex-col items-stretch gap-2 pt-2 sm:flex-col sm:space-x-0">
  <Button variant="secondary" onclick={() => (showStart = true)}>
    <WandSparkles class="mr-1.5 size-4" />
    {t(type === 'brand' ? 'refs.startBrand' : 'refs.startTemplate')}
  </Button>
  <Button variant="outline" href="/decks/{deckId}" data-testid="reference-open-deck">
    <ExternalLink class="mr-1.5 size-4" />
    {t('refs.openDeck')}
  </Button>
</Sheet.Footer>

<Dialog.Root bind:open={showStart}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{t('refs.startTitle', { title: deck.title })}</Dialog.Title>
      <Dialog.Description>{t('refs.startDescription')}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-2">
      <p class="text-sm">{t('refs.startStep')}</p>
      <CodeBlock
        code={startCommand}
        language="shell"
        copyLabel={t('decks.copyCommandAria')}
        copiedMessage={t('decks.commandCopied')}
      />
    </Dialog.Body>
    <Dialog.Footer>
      <Button onclick={() => (showStart = false)}>{t('common.done')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .preview {
    aspect-ratio: 16 / 9;
    width: 100%;
  }
  .eyebrow {
    font-size: 11.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .chip {
    padding: 2px 9px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .chip.struck {
    text-decoration: line-through;
    color: var(--muted);
  }
  .swatches,
  .fonts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
  }
  .swatch,
  .font {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .sw {
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    border: 1px solid var(--hairline);
  }
  .sw.none {
    background:
      linear-gradient(135deg, transparent 47%, var(--hairline) 47%, var(--hairline) 53%, transparent 53%),
      var(--ground-2);
  }
  .specimen {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    border: 1px solid var(--hairline);
    background: var(--ground-2);
    font-size: 17px;
    line-height: 1;
    color: var(--ink);
  }
  .specimen.plain {
    font-family: var(--ui);
    color: var(--muted);
  }
  .rows {
    display: grid;
    gap: 8px;
    font-size: 14px;
    line-height: 1.45;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(72px, 112px) 1fr;
    gap: 12px;
    align-items: baseline;
  }
  .row dt {
    font-size: 12.5px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .row dd {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .row dd.sample {
    font-family: var(--display);
    font-size: 16px;
  }
  .pages {
    display: grid;
    gap: 6px;
    padding-left: 22px;
    list-style: decimal;
    font-size: 14px;
    line-height: 1.45;
  }
  .files {
    border-radius: 10px;
    border: 1px solid var(--hairline);
    background: color-mix(in oklab, var(--ground-2) 62%, transparent);
    padding: 6px 10px;
  }
  .files-head {
    padding: 4px 0 6px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
  }
  .file-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
    text-align: left;
    text-underline-offset: 4px;
  }
  .file-name:hover {
    text-decoration: underline;
  }
  .versions {
    max-width: 100%;
    overflow-x: auto;
    border-radius: 10px;
    border: 1px solid var(--hairline);
  }
  .switch-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .switch {
    position: relative;
    flex: none;
    width: 40px;
    height: 24px;
    border-radius: 999px;
    border: 1px solid var(--hairline);
    background: var(--ground-2);
    transition: background-color var(--motion-duration) var(--motion-ease);
  }
  .switch[aria-checked='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .switch:disabled {
    opacity: 0.6;
  }
  .switch:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--plate-strong);
    box-shadow: 0 1px 2px rgb(28 25 21 / 0.2);
    transition: transform var(--motion-duration) var(--motion-ease);
  }
  .switch[aria-checked='true'] .knob {
    transform: translateX(16px);
  }
</style>
