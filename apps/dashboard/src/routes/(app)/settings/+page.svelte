<script lang="ts">
  /* The workspace's own settings (the first tab of Settings, 2026-09-19):
     its identity, the name and the look everyone sees, tried live on the
     whole shell as the person picks and saved in one PATCH; the export of
     its data for an admin; the person's membership of it. A member reads
     the identity and cannot change it. */
  import { Tag } from '$lib/components/ui/tag';
  import { roleTag } from '$lib/tags';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import LookPicker from '$lib/components/settings/LookPicker.svelte';
  import LevelSlider from '$lib/components/settings/LevelSlider.svelte';
  import BrandTile from '$lib/components/sidebar/BrandTile.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import Download from '@lucide/svelte/icons/download';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { api, errorMessage } from '$lib/api';
  import { download } from '$lib/download';
  import { BRAND_LOOK, look, resolveLook, sameLook, type Look } from '$lib/look.svelte';
  import { settingsTabs } from '$lib/settings-tabs';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const isAdmin = $derived(data.me.role === 'owner' || data.me.role === 'admin');
  const hubManaged = $derived(data.me.workspace.hubOrigin);
  const workspaceId = $derived(data.me.workspace.id);

  // ── Identity: the name and the look, edited together ──────────────────
  // The saved look is what /me carries; the picker tries a look on the
  // whole shell through the store, and Save makes it the workspace's.
  const savedLook = $derived(resolveLook(workspaceId, data.me.workspace.look));
  let name = $state(data.me.workspace.name);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const nameChanged = $derived(name.trim() !== data.me.workspace.name && name.trim() !== '');
  const lookChanged = $derived(!sameLook(look.value, savedLook));
  const dirty = $derived(nameChanged || lookChanged);
  const isDefault = $derived(sameLook(look.value, look.defaults));

  function tryLook(patch: Partial<Look>) {
    if (!isAdmin) return;
    look.try(patch);
  }

  function discard() {
    name = data.me.workspace.name;
    look.try(savedLook);
    error = null;
  }

  async function save() {
    if (!dirty || saving) return;
    error = null;
    saving = true;
    const tried = $state.snapshot(look.value);
    try {
      await api.updateWorkspace({
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(lookChanged ? { look: tried } : {})
      });
      // Every loader re-reads /me: the switcher, the phone bar and this
      // page's saved look follow, and the store's `use` sees the new wire.
      await invalidateAll();
      toast.success(t('settings.savedToast'));
    } catch (e) {
      error = errorMessage(e, t('settings.saveFailed'));
    } finally {
      saving = false;
    }
  }

  // Leaving the page with a look tried and not saved puts the saved one back.
  $effect(() => {
    return () => {
      if (look.workspaceId === workspaceId) look.try(savedLook);
    };
  });

  // ── Export ────────────────────────────────────────────────────────────
  let exporting = $state(false);
  /**
   * Export through $lib/download, the dashboard's one download path, not a
   * plain <a href>: an anchor cannot carry the X-Workspace-Id header, so on
   * a multi-workspace account it would export the DEFAULT workspace instead
   * of the active one (ADR 014). The file keeps the name the server gives it;
   * the dated name below is only the fallback.
   */
  async function handleExport() {
    exporting = true;
    try {
      await download(() => api.downloadExport(), {
        fallbackName: `workspace-export-${new Date().toISOString().slice(0, 10)}.zip`
      });
    } finally {
      exporting = false;
    }
  }
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  lede={t('settings.workspaceLede')}
  pageTitle={t('settings.tabWorkspace')}
  tabs={settingsTabs()}
  drawing="meridians"
/>

<div class="grid gap-6 lg:grid-cols-5">
  <Card.Root class="lg:col-span-3">
    <Card.Header>
      <Card.Title class="text-base">{t('settings.identityTitle')}</Card.Title>
      <Card.Description>{t('settings.identityDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-6">
      <!-- how it sits in the sidebar, live: the tile follows the store.
           SECURITY: the name is user-authored: text interpolation only. -->
      <div class="preview" data-testid="workspace-identity-preview">
        <BrandTile label={name.trim() || data.me.workspace.name} size={56} />
        <span class="grid min-w-0 flex-1 leading-tight">
          <span class="truncate font-display text-[22px] font-normal tracking-[-0.01em] text-[var(--ink)]">
            {name.trim() || data.me.workspace.name}
          </span>
          <span class="mt-1 flex items-center gap-2">
            <Tag {...roleTag(data.me.role)} />
            <span class="eyebrow">{t('settings.previewLabel')}</span>
          </span>
        </span>
      </div>

      {#if isAdmin}
        <form
          class="space-y-6"
          onsubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div class="space-y-2">
            <Label for="workspace-name">{t('settings.workspaceName')}</Label>
            <Input
              id="workspace-name"
              bind:value={name}
              maxlength={120}
              autocomplete="off"
              readonly={hubManaged}
              data-testid="workspace-name-field"
            />
            {#if hubManaged}
              <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                {t('settings.renameAtHub')}
                {#if data.me.hubManageUrl}
                  <a
                    class="inline-flex items-center gap-1 font-medium text-[var(--accent-deep)] underline-offset-4 hover:underline"
                    href={data.me.hubManageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('settings.renameAtHubLink')}
                    <ExternalLink class="size-3" />
                  </a>
                {/if}
              </p>
            {/if}
          </div>

          <LookPicker value={look.value} onchange={tryLook} />

          <!-- the page under the app: how much of the colour's gradient
               reaches it and how much grain sits on it, tried live like the
               colour and the same for every member once saved -->
          <div class="grid gap-5 sm:grid-cols-2">
            <LevelSlider
              label={t('settings.field')}
              value={look.value.field}
              mark={BRAND_LOOK.field}
              oninput={(field) => tryLook({ field })}
              testid="workspace-look-field"
            />
            <LevelSlider
              label={t('settings.grain')}
              value={look.value.grain}
              mark={BRAND_LOOK.grain}
              oninput={(grain) => tryLook({ grain })}
              testid="workspace-look-grain"
            />
          </div>

          <FormError message={error} />
          <div class="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || saving} data-testid="workspace-save">
              {saving ? t('common.saving') : t('settings.saveChanges')}
            </Button>
            <Reveal open={dirty}>
              <Button type="button" variant="outline" onclick={discard} disabled={saving}>
                {t('settings.discard')}
              </Button>
            </Reveal>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="ml-auto gap-1.5 text-muted-foreground"
              disabled={isDefault}
              onclick={() => look.try(look.defaults)}
            >
              <RotateCcw class="size-3.5" />
              {t('settings.resetLook')}
            </Button>
          </div>
        </form>
      {:else}
        <p class="notice">{t('settings.identityReadonly')}</p>
      {/if}
    </Card.Content>
  </Card.Root>

  <div class="grid content-start gap-6 lg:col-span-2">
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">{t('settings.yourMembership')}</Card.Title>
        <Card.Description>
          {t('settings.membershipOf', { role: roleTag(data.me.role).label, via: data.me.via })}
        </Card.Description>
      </Card.Header>
      <Card.Content class="facts text-sm">
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{t('settings.role')}</span>
          <Tag {...roleTag(data.me.role)} />
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{t('settings.email')}</span>
          <span>{data.me.user.email}</span>
        </div>
        {#if data.me.origin !== 'guest'}
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">{t('nav.people')}</span>
            <Button variant="link" size="sm" class="h-auto p-0" href="/members"
              >{t('settings.openPeople')}</Button
            >
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    {#if isAdmin}
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">{t('settings.exportTitle')}</Card.Title>
          <Card.Description>{t('settings.exportDescription')}</Card.Description>
        </Card.Header>
        <Card.Content>
          <Button variant="outline" onclick={() => void handleExport()} disabled={exporting}>
            <Download class="mr-2 h-4 w-4" />
            {exporting ? t('common.working') : t('settings.exportButton')}
          </Button>
          <p class="pt-3 text-xs text-muted-foreground">{t('settings.exportHint')}</p>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
</div>

<style>
  .preview {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    background: color-mix(in oklab, var(--ground-2) 46%, transparent);
  }
</style>
