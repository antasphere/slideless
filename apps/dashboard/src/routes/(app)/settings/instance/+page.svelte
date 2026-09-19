<script lang="ts">
  /* The instance (the second tab of Settings): what the operator deployed,
     read only. One card of facts, one line on where they come from. */
  import { Tag, TagList } from '$lib/components/ui/tag';
  import { methodTag } from '$lib/tags';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import Plug from '@lucide/svelte/icons/plug';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Folder from '@lucide/svelte/icons/folder';
  import { settingsTabs } from '$lib/settings-tabs';
  import { t } from '$lib/i18n';
  import type { TagSpec } from '$lib/tags';

  let { data } = $props();

  const features = $derived<TagSpec[]>([
    ...(data.instance.features.mcp
      ? [{ label: t('settings.featureMcp'), tone: 'indigo' as const, icon: Plug }]
      : []),
    ...(data.instance.features.oauth
      ? [{ label: t('settings.featureOauth'), tone: 'green' as const, icon: ShieldCheck }]
      : []),
    ...(data.instance.features.files
      ? [{ label: t('settings.featureFiles'), tone: 'slate' as const, icon: Folder }]
      : [])
  ]);
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('nav.settings')}
  lede={t('settings.instanceLede')}
  pageTitle={t('settings.tabInstance')}
  tabs={settingsTabs()}
  drawing="meridians"
/>

<div class="grid gap-6 lg:grid-cols-5">
  <Card.Root class="lg:col-span-3">
    <Card.Header>
      <Card.Title class="text-base">{t('settings.instanceTitle')}</Card.Title>
      <Card.Description>{t('settings.instanceDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="facts text-sm">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.name')}</span>
        <span class="font-medium">{data.instance.name}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.version')}</span>
        <span>{data.instance.version}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.edition')}</span>
        <span>{data.instance.edition}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.apiVersion')}</span>
        <Tag label={data.instance.apiVersion} mono />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">{t('settings.instanceId')}</span>
        {#if data.instance.instanceId}
          <Tag label={data.instance.instanceId} mono />
        {:else}
          <span class="text-muted-foreground">—</span>
        {/if}
      </div>
      <div class="flex items-center justify-between gap-4">
        <span class="text-muted-foreground">{t('settings.signInMethods')}</span>
        <span class="flex justify-end"><TagList tags={data.instance.auth.methods.map(methodTag)} /></span>
      </div>
      <div class="flex items-center justify-between gap-4">
        <span class="text-muted-foreground">{t('settings.features')}</span>
        <span class="flex justify-end"><TagList tags={features} /></span>
      </div>
    </Card.Content>
  </Card.Root>
  <p class="notice self-start lg:col-span-2">{t('settings.instanceHint')}</p>
</div>
