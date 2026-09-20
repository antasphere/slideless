<script lang="ts">
  /* Adding someone to a project. A project takes its members from the
     workspace's own people, so the dialog lists them to pick from: no
     invitation and no account is ever made here. The list is the workspace
     roster (`GET /members`), which any member who is not a guest may read
     today. The dialog does not lean on that: when the roster does not answer,
     or when it is longer than one page, the person's email does the same job,
     and the server says whether it is someone of this workspace. */
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import ProjectRoleSelect from './ProjectRoleSelect.svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Check from '@lucide/svelte/icons/check';
  import { api, errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { offeredMembers } from '$lib/projects/candidates';
  import { errorCode, errorStatus } from '$lib/projects/errors';
  import type { ProjectRole } from '$lib/projects/types';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Member } from '@antasphere/chassis-contract';

  interface Props {
    open: boolean;
    projectId: string;
    /** The user ids already in the project: never offered again. */
    alreadyIn: string[];
    onAdded: () => Promise<void> | void;
    /** A refusal may mean the project changed elsewhere (archived, a role lost): the page reads it again. */
    onRefused: () => Promise<void> | void;
  }
  let { open = $bindable(), projectId, alreadyIn, onAdded, onRefused }: Props = $props();

  // null until the roster answered; `false` once it refused or failed
  let roster = $state<Member[] | false | null>(null);
  let rosterPartial = $state(false);
  let byEmail = $state(false);
  let query = $state('');
  let pickedId = $state<string | null>(null);
  let email = $state('');
  let role = $state<ProjectRole>('viewer');
  let loading = $state(false);
  let refusal = $state<string | null>(null);

  async function readRoster() {
    try {
      const { members, nextCursor } = await api.members({ limit: 100 });
      roster = members;
      rosterPartial = nextCursor !== null;
    } catch {
      // 403 or anything else: the email field needs no roster
      roster = false;
    }
  }

  // each opening starts clean, on a fresh roster
  $effect(() => {
    if (!open) return;
    roster = null;
    byEmail = false;
    query = '';
    pickedId = null;
    email = '';
    role = 'viewer';
    refusal = null;
    void readRoster();
  });

  const usesEmail = $derived(roster === false || byEmail);
  const offered = $derived(roster ? offeredMembers(roster, alreadyIn, query) : []);
  const picked = $derived(roster ? (roster.find((m) => m.userId === pickedId) ?? null) : null);

  // The refusals that have a sentence of their own; the server's words otherwise.
  function refusalOf(e: unknown): string {
    const code = errorCode(e);
    const status = errorStatus(e);
    if (code === 'guest_target') return t('projects.addRefusedGuest');
    if (code === 'project_archived') return t('projects.refusedArchived');
    if (code === 'already_member' || status === 409) return t('projects.addRefusedAlready');
    if (code === 'not_a_member' || status === 404) return t('projects.addRefusedNotMember');
    return errorMessage(e, t('projects.addFailed'));
  }

  async function submit() {
    refusal = null;
    const typed = email.trim();
    const target = usesEmail ? (typed ? { email: typed } : null) : picked ? { userId: picked.userId } : null;
    if (!target) {
      refusal = usesEmail ? t('projects.addNeedsEmail') : t('projects.addNeedsPick');
      return;
    }
    loading = true;
    try {
      const added = await projects.addMember(projectId, { ...target, role });
      open = false;
      toast.success(t('projects.memberAddedToast', { email: added.email }));
      await onAdded();
    } catch (e) {
      refusal = refusalOf(e);
      await onRefused();
    } finally {
      loading = false;
    }
  }
</script>

<FormDialog
  bind:open
  title={t('projects.addMemberTitle')}
  description={t('projects.addMemberDescription')}
  onClose={() => (open = false)}
  onSubmit={() => void submit()}
  {loading}
  submitLabel={t('projects.addMemberSubmit')}
>
  {#if usesEmail}
    <div class="space-y-2">
      <Label for="project-add-email">{t('projects.addEmailLabel')}</Label>
      <Input
        id="project-add-email"
        type="email"
        autocomplete="off"
        bind:value={email}
        placeholder={t('invitations.emailPlaceholder')}
        required
      />
      <p class="text-xs text-muted-foreground">{t('projects.addEmailHint')}</p>
    </div>
  {:else}
    <div class="space-y-2">
      <Label for="project-add-search">{t('projects.addPickLabel')}</Label>
      <Input
        id="project-add-search"
        type="search"
        autocomplete="off"
        bind:value={query}
        placeholder={t('members.searchPlaceholder')}
      />
      <!-- the box keeps its height while the roster is on its way: nothing
           jumps, and no placeholder flashes for a load this short -->
      <ul
        class="h-48 divide-y divide-[var(--hairline)] overflow-y-auto rounded-md border border-[var(--hairline)]"
        aria-label={t('projects.addPickLabel')}
        aria-busy={roster === null}
      >
        {#each offered as person (person.userId)}
          {@const chosen = person.userId === pickedId}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--ground-3)] focus-visible:bg-[var(--ground-3)] focus-visible:outline-none"
              aria-pressed={chosen}
              onclick={() => (pickedId = chosen ? null : person.userId)}
            >
              <!-- names and emails are USER-AUTHORED: text interpolation only -->
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{person.name || person.email}</span>
                {#if person.name}
                  <span class="block truncate text-xs text-muted-foreground">{person.email}</span>
                {/if}
              </span>
              {#if chosen}<Check class="h-4 w-4 shrink-0" strokeWidth={2.2} />{/if}
            </button>
          </li>
        {:else}
          {#if roster}
            <li class="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.trim() ? t('projects.addNoMatch', { query: query.trim() }) : t('projects.addNobodyLeft')}
            </li>
          {/if}
        {/each}
      </ul>
      <p class="text-xs text-muted-foreground">
        {rosterPartial ? t('projects.addRosterPartial') : t('projects.addRosterHint')}
        <button type="button" class="underline underline-offset-2" onclick={() => (byEmail = true)}>
          {t('projects.addByEmail')}
        </button>
      </p>
    </div>
  {/if}

  <ProjectRoleSelect bind:value={role} id="project-add-role" />
  <FormError message={refusal} />
</FormDialog>
