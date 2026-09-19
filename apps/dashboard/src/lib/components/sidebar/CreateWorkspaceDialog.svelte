<script lang="ts">
  /* "New workspace" (PRDCT-2443 cloud, PRDCT-2444 self-hosted), as a walk of
     three steps and a door: the name; the look, dealt from the name and
     changed at will, the tile taking shape as the words are typed; the
     first people, invited now or later; then the workspace is made, the
     invitations sent in it, and the door opens on it. ONE dialog on both
     editions, offered only while /me's `canCreateWorkspace` is true; the
     wording is a Slideless workspace everywhere (`$lib/workspace-create`
     owns the refusal sentences): where it is created behind the scenes is
     not the person's business. */
  import { fly } from 'svelte/transition';
  import { MOTION_DURATION_MS } from '@slideless/contract';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import DialogDrawing from '$lib/components/decks/drawings/DialogDrawing.svelte';
  import LookPicker from '$lib/components/settings/LookPicker.svelte';
  import AutoHeight from '$lib/components/shared/AutoHeight.svelte';
  import BrandTile from './BrandTile.svelte';
  import { api, switchWorkspace } from '$lib/api';
  import {
    newIdempotencyKey,
    signInAgain as decideSignInAgain,
    workspaceCreateFailure
  } from '$lib/workspace-create';
  import { authClient } from '$lib/auth-client';
  import { copyText } from '$lib/clipboard';
  import { accentOf, DEFAULT_LOOK, dealtPattern, dealtTheme, tintStyle, type Look } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';
  import { roleTag } from '$lib/tags';
  import { stagger } from '$lib/stagger';
  import { t } from '$lib/i18n';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import Check from '@lucide/svelte/icons/check';
  import Link from '@lucide/svelte/icons/link';
  import MailCheck from '@lucide/svelte/icons/mail-check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { WorkspaceRole } from '@antasphere/chassis-contract';

  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  const NAME_MAX = 120;
  const INVITES_MAX = 5;
  const STEPS = 3;

  type Step = 1 | 2 | 3 | 'done';
  let step = $state<Step>(1);
  // which way the next step slides in from: forward from the right, back from the left
  let direction = $state<1 | -1>(1);

  let name = $state('');
  let nameInput = $state<HTMLInputElement | null>(null);
  const trimmedName = $derived(name.trim());

  // The look: dealt from the name until the person picks (the tile takes
  // shape with the words), then theirs. "Deal another" deals from a fresh
  // key so the same name can be dealt again and again.
  let picked = $state<Partial<Look>>({});
  let dealSalt = $state(0);
  const preview = $derived<Look>({
    ...DEFAULT_LOOK,
    theme: picked.theme ?? dealtTheme(`${trimmedName || 'workspace'}#${dealSalt}`),
    pattern: picked.pattern ?? dealtPattern(`${trimmedName || 'workspace'}#${dealSalt}`)
  });
  function deal() {
    picked = {};
    dealSalt += 1;
  }

  // The first people: a few rows, each an email and a role, all optional.
  interface InviteRow {
    email: string;
    role: WorkspaceRole;
  }
  let invites = $state<InviteRow[]>([{ email: '', role: 'member' }]);
  const inviteRoles: WorkspaceRole[] = ['member', 'admin'];
  const wantedInvites = $derived(invites.filter((r) => r.email.trim() !== ''));
  const invitesValid = $derived(
    wantedInvites.every((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim()))
  );

  let loading = $state(false);
  let error = $state<string | null>(null);
  let signInAgain = $state(false);
  let freshSignIn = $state(false);
  // One key per OPENING: a double click, or a retry of an answer that never
  // arrived, replays the first creation instead of making a second one. A
  // refused attempt releases its claim server-side, so the same key serves
  // the corrected name too.
  let idempotencyKey = $state(newIdempotencyKey());

  // What the door opens on: the workspace made, and how each invitation went.
  interface Sent {
    email: string;
    role: WorkspaceRole;
    acceptUrl: string | null;
    emailSent: boolean;
  }
  let created = $state<{ id: string; name: string } | null>(null);
  let sent = $state<Sent[]>([]);

  // Keyed on `open` itself, not on the primitive's onOpenChange: the menu
  // entry and the Cancel button move `open` from outside the primitive.
  $effect(() => {
    if (open) {
      idempotencyKey = newIdempotencyKey();
    } else {
      // Closing the door after the workspace exists opens it: the person
      // made it, landing in it is what they came for.
      if (created) {
        switchWorkspace(created.id);
        return;
      }
      step = 1;
      direction = 1;
      name = '';
      picked = {};
      dealSalt = 0;
      invites = [{ email: '', role: 'member' }];
      error = null;
      signInAgain = false;
      freshSignIn = false;
      sent = [];
    }
  });

  function go(next: Step) {
    direction = typeof next === 'number' && typeof step === 'number' && next < step ? -1 : 1;
    error = null;
    step = next;
  }

  /** The "Sign in again" control: `signInAgain` in $lib/workspace-create owns the decision. */
  function signInAgainNow() {
    return decideSignInAgain({
      freshSignIn,
      oauth2: (options) => authClient.signIn.oauth2(options),
      returnTo: window.location.pathname + window.location.search,
      reload: () => window.location.reload()
    });
  }

  async function create() {
    if (!trimmedName || loading || !invitesValid) return;
    error = null;
    signInAgain = false;
    freshSignIn = false;
    loading = true;
    try {
      const { workspace } = await api.createWorkspace(trimmedName, {
        idempotencyKey,
        look: { theme: preview.theme, pattern: preview.pattern }
      });
      created = { id: workspace.id, name: workspace.name };
      // The invitations are the NEW workspace's: the client names it from
      // here on (every later call, until the switch, is in it).
      api.setWorkspace(workspace.id);
      const results: Sent[] = [];
      for (const row of wantedInvites) {
        try {
          const r = await api.createInvitation({ email: row.email.trim(), role: row.role });
          results.push({
            email: row.email.trim(),
            role: row.role,
            acceptUrl: r.acceptUrl,
            emailSent: r.emailSent
          });
        } catch {
          results.push({ email: row.email.trim(), role: row.role, acceptUrl: null, emailSent: false });
        }
      }
      sent = results;
      go('done');
    } catch (e) {
      const failure = workspaceCreateFailure(e);
      error = failure.message;
      signInAgain = failure.signInAgain;
      freshSignIn = failure.freshSignIn;
      // a refused name is corrected on the first step
      go(1);
    } finally {
      loading = false;
    }
  }

  function openIt() {
    if (created) switchWorkspace(created.id);
  }

  const captions = $derived({
    1: t('workspace.asideCaption1'),
    2: t('workspace.asideCaption2'),
    3: t('workspace.asideCaption3'),
    done: t('workspace.asideCaptionDone')
  });
  const eyebrow = $derived(
    step === 'done' ? t('workspace.doneEyebrow') : t('workspace.stepOf', { n: step, total: STEPS })
  );
  const flyIn = $derived({ x: 28 * direction, duration: MOTION_DURATION_MS * 2.2, delay: 40 });
  // the glyphs and the door's rings in the colour being chosen, not the page's
  $effect(() => theme.start());
  const previewAccent = $derived(accentOf(preview.theme, theme.dark).accent);
  // the whole dialog in the colour being chosen: its drawing, its marks, its rings
  const tint = $derived(tintStyle(preview.theme, theme.dark));
</script>

{#snippet aside()}
  <Dialog.Illustration eyebrow={t('workspace.asideEyebrow')} caption={captions[step]}>
    <!-- the drawing stays for the door: its ring closes and lets go, and the
         tile blooms out of where it was -->
    <div class="door">
      <DialogDrawing kind="workspace" steps={STEPS} done={typeof step === 'number' ? step - 1 : STEPS} />
      {#if step === 'done'}
        <div class="bloom" aria-hidden="true" style="--bloom-accent: {previewAccent}">
          <span class="bloom-wash"></span>
          <span class="bloom-ring bloom-ring--1"></span>
          <span class="bloom-ring bloom-ring--2"></span>
          <span class="bloom-ring bloom-ring--3"></span>
          <BrandTile
            preview={$state.snapshot(preview)}
            label={created?.name ?? ''}
            size={112}
            class="bloom-tile"
          />
        </div>
      {/if}
    </div>
  </Dialog.Illustration>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Content
    size="lg"
    style={tint}
    data-tinted
    {aside}
    framed
    data-testid="workspace-create-dialog"
    onOpenAutoFocus={(e) => {
      // Focus lands in the field, not on whatever the trap finds first.
      e.preventDefault();
      nameInput?.focus();
    }}
  >
    <form
      class="dlg-form"
      onsubmit={(e) => {
        e.preventDefault();
        if (step === 1 && trimmedName) go(2);
        else if (step === 2) go(3);
        else if (step === 3) void create();
        else if (step === 'done') openIt();
      }}
    >
      <Dialog.Header>
        <p class="eyebrow pb-1">{eyebrow}</p>
        <AutoHeight>
          {#key step}
            <div in:fly={flyIn}>
              {#if step === 1}
                <Dialog.Title>{t('workspace.step1Title')}</Dialog.Title>
                <Dialog.Description>{t('workspace.step1Description')}</Dialog.Description>
              {:else if step === 2}
                <Dialog.Title>{t('workspace.step2Title')}</Dialog.Title>
                <Dialog.Description>{t('workspace.step2Description')}</Dialog.Description>
              {:else if step === 3}
                <Dialog.Title>{t('workspace.step3Title')}</Dialog.Title>
                <Dialog.Description>{t('workspace.step3Description')}</Dialog.Description>
              {:else}
                <Dialog.Title>{t('workspace.doneTitle', { name: created?.name ?? trimmedName })}</Dialog.Title
                >
                <Dialog.Description>{t('workspace.doneBody')}</Dialog.Description>
              {/if}
            </div>
          {/key}
        </AutoHeight>
        <!-- where you are: one mark per step, the passed ones filled -->
        {#if step !== 'done'}
          <ol class="steps" aria-hidden="true">
            {#each [1, 2, 3] as n (n)}
              <li class:on={n === step} class:past={n < step}></li>
            {/each}
          </ol>
        {/if}
      </Dialog.Header>

      <Dialog.Body>
        <AutoHeight>
          {#key step}
            <div class="space-y-5" in:fly={flyIn} use:stagger>
              {#if step === 1}
                <div class="space-y-2">
                  <Label for="workspace-name">{t('workspace.nameLabel')}</Label>
                  <Input
                    id="workspace-name"
                    bind:ref={nameInput}
                    bind:value={name}
                    required
                    maxlength={NAME_MAX}
                    autocomplete="off"
                    placeholder={t('workspace.namePlaceholder')}
                    aria-invalid={error ? 'true' : undefined}
                    aria-describedby={error ? 'workspace-name-error' : undefined}
                    data-testid="workspace-name-input"
                  />
                  {#if error}
                    <p id="workspace-name-error" role="alert" class="text-sm text-destructive">
                      {error}
                      {#if signInAgain}
                        <button
                          type="button"
                          class="font-medium underline underline-offset-4"
                          onclick={signInAgainNow}
                        >
                          {t('workspace.signInAgain')}
                        </button>
                      {/if}
                    </p>
                  {/if}
                </div>
              {:else if step === 2}
                <!-- how it will sit in the sidebar. SECURITY: the name is user-authored: text interpolation only. -->
                <div class="preview" data-testid="workspace-preview">
                  <BrandTile {preview} label={trimmedName} size={56} />
                  <span class="grid min-w-0 flex-1 leading-tight">
                    <span
                      class="truncate font-display text-[21px] font-normal tracking-[-0.01em] text-[var(--ink)]"
                    >
                      {trimmedName}
                    </span>
                    <span class="role truncate">{roleTag('owner').label}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="gap-1.5 text-muted-foreground"
                    onclick={deal}
                  >
                    <Shuffle class="size-3.5" />
                    {t('workspace.deal')}
                  </Button>
                </div>
                <LookPicker
                  value={preview}
                  onchange={(patch) => (picked = { ...picked, ...patch })}
                  dot={22}
                  glyph={48}
                  accent={previewAccent}
                />
              {:else if step === 3}
                <div class="space-y-3">
                  {#each invites as row, i (i)}
                    <div class="invite">
                      <div class="min-w-0 flex-1 space-y-1.5">
                        {#if i === 0}<Label for="invite-email-{i}">{t('workspace.inviteEmail')}</Label>{/if}
                        <Input
                          id="invite-email-{i}"
                          type="email"
                          autocomplete="off"
                          placeholder={t('invitations.emailPlaceholder')}
                          bind:value={row.email}
                        />
                      </div>
                      <div class="w-[132px] shrink-0 space-y-1.5">
                        {#if i === 0}<Label for="invite-role-{i}">{t('invitations.roleLabel')}</Label>{/if}
                        <Select.Root
                          type="single"
                          value={row.role}
                          onValueChange={(v) => {
                            if (v) row.role = v as WorkspaceRole;
                          }}
                        >
                          <Select.Trigger id="invite-role-{i}" class="w-full">
                            {roleTag(row.role).label}
                          </Select.Trigger>
                          <Select.Content>
                            {#each inviteRoles as r (r)}
                              <Select.Item value={r} label={roleTag(r).label} />
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>
                      <button
                        type="button"
                        class="remove"
                        class:first={i === 0}
                        disabled={invites.length === 1}
                        aria-label={t('workspace.inviteRemove')}
                        title={t('workspace.inviteRemove')}
                        onclick={() => (invites = invites.filter((_, j) => j !== i))}
                      >
                        <X class="size-3.5" />
                      </button>
                    </div>
                  {/each}
                  {#if invites.length < INVITES_MAX}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="gap-1.5 text-muted-foreground"
                      onclick={() => (invites = [...invites, { email: '', role: 'member' }])}
                    >
                      <Plus class="size-3.5" />
                      {t('workspace.inviteAdd')}
                    </Button>
                  {/if}
                  {#if error}
                    <p role="alert" class="text-sm text-destructive">{error}</p>
                  {/if}
                </div>
              {:else if sent.length}
                <div class="space-y-2">
                  <p class="eyebrow">{t('workspace.doneInvites')}</p>
                  <ul class="sent">
                    {#each sent as s (s.email)}
                      <li>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[13.5px]">{s.email}</span>
                          <span class="role">{roleTag(s.role).label}</span>
                        </span>
                        {#if s.acceptUrl}
                          {#if s.emailSent}
                            <span class="mark ok" title={t('workspace.doneInviteSent')}>
                              <MailCheck class="size-3.5" />
                            </span>
                          {/if}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            class="h-8 gap-1.5"
                            onclick={() => void copyText(s.acceptUrl!, t('invitations.linkCopied'))}
                          >
                            <Link class="size-3.5" />
                            {t('workspace.doneInviteLink')}
                          </Button>
                        {:else}
                          <span class="mark bad" title={t('workspace.doneInviteFailed')}>
                            <TriangleAlert class="size-3.5" />
                            {t('workspace.doneInviteFailed')}
                          </span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {:else}
                <p class="done-check"><Check class="size-4" /> <span>{t('workspace.doneNoInvites')}</span></p>
              {/if}
            </div>
          {/key}
        </AutoHeight>
      </Dialog.Body>

      <Dialog.Footer>
        {#if step === 1}
          <Button type="button" variant="outline" onclick={() => (open = false)} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!trimmedName} data-testid="workspace-step-next">
            {t('workspace.next')}
          </Button>
        {:else if step === 2}
          <Button type="button" variant="outline" onclick={() => go(1)} disabled={loading}>
            {t('workspace.back')}
          </Button>
          <Button type="submit" data-testid="workspace-step-next">{t('workspace.next')}</Button>
        {:else if step === 3}
          <!-- `mr-auto` here, not on a note beside it: it is what pushes the
               submit to the far edge, and it has to survive whether or not
               anything is written next to Back. -->
          <Button type="button" variant="outline" class="mr-auto" onclick={() => go(2)} disabled={loading}>
            {t('workspace.back')}
          </Button>
          <Button
            type="submit"
            disabled={loading || !trimmedName || !invitesValid}
            data-testid="workspace-create-submit"
          >
            {loading ? t('workspace.creating') : t('workspace.createSubmit')}
          </Button>
        {:else}
          <Button type="submit" class="min-w-40" data-testid="workspace-open">
            {t('workspace.open', { name: created?.name ?? trimmedName })}
          </Button>
        {/if}
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* the form's side takes a breath of the colour being chosen too, pooled
     from its top corner, so the whole dialog answers a pick and not only
     the drawing's panel */
  :global(.dlg[data-tinted] .dlg-main) {
    background: radial-gradient(
      130% 95% at 100% 0%,
      color-mix(in oklab, var(--accent) 11%, transparent),
      transparent 62%
    );
    transition: background-color calc(var(--motion-duration) * 2) var(--motion-ease);
  }
  :global(.dlg[data-tinted]) {
    border-color: color-mix(in oklab, var(--accent) 26%, var(--hairline));
  }
  .preview {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    background: color-mix(in oklab, var(--ground-2) 46%, transparent);
  }
  .role {
    font-family: var(--second);
    font-weight: 300;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  /* the three marks under the title: a short bar each, the current one in the accent */
  .steps {
    display: flex;
    gap: 6px;
    margin-top: 12px;
  }
  .steps li {
    width: 18px;
    height: 3px;
    border-radius: 3px;
    background: var(--hairline);
    transition:
      width calc(var(--motion-duration) * 2.4) cubic-bezier(0.22, 1, 0.36, 1),
      background-color calc(var(--motion-duration) * 2.4) var(--motion-ease);
  }
  .steps li.past {
    background: color-mix(in oklab, var(--accent) 55%, var(--hairline));
  }
  /* where you are: the long stroke, which travels along the row as you do */
  .steps li.on {
    width: 44px;
    background: var(--accent);
  }
  .invite {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    color: var(--muted);
  }
  .remove:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .remove:disabled {
    opacity: 0.3;
  }
  .sent {
    display: grid;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    overflow: hidden;
  }
  .sent li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
  }
  .sent li + li {
    border-top: 1px solid var(--hairline);
  }
  .mark {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
  }
  .mark.ok {
    color: var(--ok);
  }
  .mark.bad {
    color: var(--danger);
  }
  .done-check {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ink-soft);
    font-size: 14px;
  }
  .done-check :global(svg) {
    color: var(--ok);
  }

  /* the door: the tile blooms in the aside, two rings leaving it */
  .door {
    display: grid;
    place-items: center;
    width: 100%;
    /* the ring's last arc, then its release, before the tile lands */
    --door: calc(var(--motion-duration) * 3.4 + 400ms);
  }
  .door > :global(*) {
    grid-area: 1 / 1;
  }
  .bloom {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1;
    max-width: 220px;
  }
  .bloom :global(.bloom-tile) {
    position: relative;
    z-index: 1;
    box-shadow:
      inset 0 0 0 1px var(--t-hair),
      var(--shadow-md);
  }
  .bloom-ring {
    position: absolute;
    width: 112px;
    height: 112px;
    border-radius: 30px;
    border: 1.5px solid var(--bloom-accent, var(--accent));
    opacity: 0;
  }
  /* the wash: one breath of the colour that swells from under the tile and
     fades as it goes — the water a droplet leaves, not a flash */
  .bloom-wash {
    position: absolute;
    width: 132px;
    height: 132px;
    border-radius: 999px;
    background: radial-gradient(
      circle,
      color-mix(in oklab, var(--bloom-accent, var(--accent)) 34%, transparent),
      transparent 68%
    );
    opacity: 0;
  }
  @media (prefers-reduced-motion: no-preference) {
    .bloom :global(.bloom-tile) {
      animation: bloom-drop 760ms cubic-bezier(0.22, 1.5, 0.36, 1) var(--door) both;
    }
    .bloom-wash {
      animation: bloom-wash 1700ms cubic-bezier(0.16, 1, 0.3, 1) calc(var(--door) + 180ms) both;
    }
    .bloom-ring--1 {
      animation: bloom-ring 1600ms cubic-bezier(0.16, 1, 0.3, 1) calc(var(--door) + 260ms) forwards;
    }
    .bloom-ring--2 {
      animation: bloom-ring 1600ms cubic-bezier(0.16, 1, 0.3, 1) calc(var(--door) + 520ms) forwards;
    }
    .bloom-ring--3 {
      animation: bloom-ring 1600ms cubic-bezier(0.16, 1, 0.3, 1) calc(var(--door) + 800ms) forwards;
    }
  }
  /* the tile lands: it falls in, turns once on itself and settles */
  @keyframes bloom-drop {
    0% {
      opacity: 0;
      transform: scale(0.45) rotate(-200deg);
    }
    62% {
      opacity: 1;
      transform: scale(1.06) rotate(8deg);
    }
    100% {
      opacity: 1;
      transform: scale(1) rotate(0deg);
    }
  }
  @keyframes bloom-wash {
    0% {
      opacity: 0;
      transform: scale(0.3);
    }
    30% {
      opacity: 0.85;
    }
    100% {
      opacity: 0;
      transform: scale(2.6);
    }
  }
  @keyframes bloom-ring {
    0% {
      opacity: 0.65;
      transform: scale(0.92);
    }
    100% {
      opacity: 0;
      transform: scale(2.3);
    }
  }
</style>
