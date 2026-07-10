<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Download from '@lucide/svelte/icons/download';
  import Eye from '@lucide/svelte/icons/eye';
  import Pencil from '@lucide/svelte/icons/pencil';
  import UserRound from '@lucide/svelte/icons/user-round';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { safeHttpUrl } from '$lib/utils.js';
  import { t } from '$lib/i18n';

  /**
   * OAuth consent screen. The query string carries the SIGNED authorize
   * params — it is opaque: never reordered, rebuilt, or edited. It goes back
   * to the server verbatim as `oauth_query`; the server (fail-closed) is the
   * only validator of the signature. The checks here only pick the right UI
   * state early.
   */

  // Captured once, verbatim — this exact string is the signature's payload.
  const oauthQuery = window.location.search.slice(1);
  const params = new URLSearchParams(window.location.search);

  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
  const exp = Number(params.get('exp') ?? '0');

  const redirectHost = (() => {
    try {
      return redirectUri ? new URL(redirectUri).host : null;
    } catch {
      return null;
    }
  })();

  // Missing signature material or an expired request can never be approved —
  // show the dead-request card without a round-trip.
  const looksValid = Boolean(
    clientId && redirectUri && redirectHost && params.get('sig') && exp * 1000 > Date.now()
  );

  interface PublicClient {
    client_name?: string;
    name?: string;
    client_uri?: string;
    uri?: string;
    logo_uri?: string;
    icon?: string;
  }

  let view = $state<'loading' | 'ok' | 'invalid' | 'error'>(looksValid ? 'loading' : 'invalid');
  let client = $state<PublicClient | null>(null);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  const clientName = $derived(client?.client_name ?? client?.name ?? t('consent.unknownApp'));
  // Registered client metadata is untrusted (unauthenticated DCR): only
  // http(s) URLs may reach href/src.
  const clientUri = $derived(safeHttpUrl(client?.client_uri ?? client?.uri));
  const clientIcon = $derived(safeHttpUrl(client?.logo_uri ?? client?.icon));

  async function loadClient() {
    if (!looksValid) return;
    view = 'loading';
    try {
      const res = await fetch(
        `/api/v1/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId!)}`,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      if (res.ok) {
        client = (await res.json()) as PublicClient;
        view = 'ok';
      } else if (res.status >= 400 && res.status < 500) {
        view = 'invalid';
      } else {
        view = 'error';
      }
    } catch {
      view = 'error';
    }
  }

  $effect(() => {
    void loadClient();
  });

  const scopeLines = $derived.by(() => {
    const lines: { icon: typeof Eye; text: string }[] = [];
    if (scopes.includes('presentations:read')) lines.push({ icon: Eye, text: t('consent.scopeRead') });
    if (scopes.includes('presentations:write')) lines.push({ icon: Pencil, text: t('consent.scopeWrite') });
    if (scopes.includes('data:export')) {
      lines.push({ icon: Download, text: t('consent.scopeExport') });
    }
    if (
      scopes.includes('openid') ||
      scopes.includes('profile') ||
      scopes.includes('email') ||
      scopes.includes('offline_access')
    ) {
      lines.push({ icon: UserRound, text: t('consent.scopeIdentity') });
    }
    return lines;
  });

  async function decide(accept: boolean) {
    submitting = true;
    error = null;
    try {
      const res = await fetch('/api/v1/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accept, oauth_query: oauthQuery })
      });
      const body = (await res.json().catch(() => null)) as {
        redirect_uri?: string;
        redirect?: boolean;
        url?: string;
      } | null;

      if (res.ok) {
        const target = body?.redirect_uri ?? body?.url;
        if (target) {
          window.location.href = target;
          return;
        }
        error = t('consent.errorUnexpectedResponse');
      } else if (res.status === 400 || res.status === 401 || res.status === 403) {
        view = 'invalid';
      } else {
        error = t('common.errorGenericRetry');
      }
    } catch {
      error = t('consent.errorConnection');
    } finally {
      submitting = false;
    }
  }
</script>

<LanguageSwitcher class="fixed right-4 top-4" />

<div class="flex min-h-dvh items-center justify-center bg-surface-secondary p-6">
  <Card.Root class="w-full max-w-md">
    {#if view === 'invalid'}
      <Card.Header class="text-center">
        <Card.Title class="text-xl">{t('consent.invalidTitle')}</Card.Title>
        <Card.Description>
          {t('consent.invalidDescription')}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" class="w-full" onclick={() => window.location.assign('/')}>
          {t('common.backToDashboard')}
        </Button>
      </Card.Content>
    {:else if view === 'error'}
      <Card.Header class="text-center">
        <Card.Title class="text-xl">{t('consent.errorTitle')}</Card.Title>
        <Card.Description>{t('consent.errorDescription')}</Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" class="w-full" onclick={() => void loadClient()}>
          {t('common.tryAgain')}
        </Button>
      </Card.Content>
    {:else if view === 'loading'}
      <Card.Header class="text-center">
        <Card.Title class="text-xl">{t('consent.loading')}</Card.Title>
      </Card.Header>
    {:else}
      <Card.Header class="text-center">
        {#if clientIcon}
          <img src={clientIcon} alt="" class="mx-auto mb-2 h-12 w-12 rounded-lg object-contain" />
        {:else}
          <div class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck class="h-6 w-6 text-primary" />
          </div>
        {/if}
        <Card.Title class="text-xl">{t('consent.title')}</Card.Title>
        <Card.Description>
          <span class="font-medium text-foreground">{clientName}</span>
          {t('consent.wantsAccess')}
          {#if clientUri}
            <a
              href={clientUri}
              target="_blank"
              rel="noopener noreferrer"
              class="block truncate text-xs underline-offset-4 hover:underline">{clientUri}</a
            >
          {/if}
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if error}
          <div class="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        {/if}

        {#if scopeLines.length > 0}
          <div>
            <p class="mb-2 text-sm font-medium">{t('consent.allowLabel')}</p>
            <ul class="space-y-2">
              {#each scopeLines as line (line.text)}
                <li class="flex items-start gap-2 text-sm text-muted-foreground">
                  <line.icon class="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{line.text}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- Anti-phishing: the redirect host is the registered, validated
             destination — unlike the self-declared client name. -->
        <p class="text-xs text-muted-foreground">
          {t('consent.redirectNotice')}
          <span class="font-mono font-medium text-foreground">{redirectHost}</span>
        </p>

        <div class="flex gap-3">
          <Button variant="outline" class="flex-1" disabled={submitting} onclick={() => void decide(false)}>
            {t('consent.deny')}
          </Button>
          <Button class="flex-1" disabled={submitting} onclick={() => void decide(true)}>
            {submitting ? t('common.working') : t('consent.approve')}
          </Button>
        </div>
      </Card.Content>
    {/if}
  </Card.Root>
</div>
