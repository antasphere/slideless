<script lang="ts">
  /* The person at the foot of the sidebar, and the card that opens from them.
     The card says who is signed in and as what (the name in the display serif,
     the email, the role in this workspace as its tag), then where they can go
     from here, each destination with a line on what it holds, and last, apart
     and quiet, the way out. The language is not here: it lives on the account
     page, first card. */
  import { goto } from '$app/navigation';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import LogOut from '@lucide/svelte/icons/log-out';
  import UserRound from '@lucide/svelte/icons/user-round';
  import Settings from '@lucide/svelte/icons/settings';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import { Tag } from '$lib/components/ui/tag';
  import { roleTag } from '$lib/tags';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';
  import type { WorkspaceRole } from '@antasphere/chassis-contract';

  interface Props {
    user: { name: string; email: string };
    /** The person's role in the workspace this session targets. */
    role: WorkspaceRole;
    /** That workspace's name (the instance's, for a single-membership user). */
    workspaceName: string;
  }

  let { user, role, workspaceName }: Props = $props();

  const sidebar = useSidebar();

  const displayName = $derived(user.name || user.email.split('@')[0] || t('common.user'));
  const initials = $derived(
    displayName
      .split(' ')
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  );

  const destinations = $derived([
    { href: '/account', icon: UserRound, title: t('nav.myAccount'), blurb: t('userMenu.accountBlurb') },
    { href: '/settings', icon: Settings, title: t('nav.settings'), blurb: t('userMenu.settingsBlurb') }
  ]);
</script>

<Sidebar.Menu class="px-1">
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="default"
            class="!h-auto {sidebar.state === 'collapsed'
              ? '!size-8 !justify-center !gap-0 !p-0'
              : '!w-full !gap-2.5 !px-1.5 !py-1.5'}"
          >
            <span class="disc" class:lone={sidebar.state === 'collapsed'}>{initials}</span>
            <!-- fades with the rail rather than being destroyed; see the switcher -->
            <div
              class="label"
              class:away={sidebar.state === 'collapsed'}
              aria-hidden={sidebar.state === 'collapsed'}
            >
              <span class="grid min-w-0 flex-1 text-left leading-tight">
                <span class="truncate text-[13.5px] font-medium text-[var(--ink)]">{displayName}</span>
                <span class="truncate text-[11.5px] text-[var(--muted)]">{user.email}</span>
              </span>
              <ChevronsUpDown class="ml-auto !size-3.5 shrink-0 text-[var(--muted)] opacity-70" />
            </div>
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-[300px] max-w-[calc(100vw-24px)] p-0"
        side={sidebar.isMobile ? 'bottom' : 'right'}
        align="end"
        sideOffset={8}
      >
        <!-- who, and as what. SECURITY: the name, the email and the workspace
             name are user-authored: text interpolation only. -->
        <div class="who">
          <span class="disc big">{initials}</span>
          <div class="min-w-0 flex-1">
            <p class="name truncate">{displayName}</p>
            <p class="truncate text-[12.5px] text-[var(--muted)]">{user.email}</p>
          </div>
        </div>
        <div class="as">
          <Tag {...roleTag(role)} />
          <span class="truncate">{workspaceName}</span>
        </div>

        <div class="p-1">
          {#each destinations as place (place.href)}
            <DropdownMenu.Item class="!items-start !gap-3 px-2 py-2" onclick={() => goto(place.href)}>
              <span class="well"><place.icon class="size-4" strokeWidth={1.7} /></span>
              <span class="grid min-w-0 leading-snug">
                <span class="text-[13.5px] font-medium">{place.title}</span>
                <span class="text-[12.5px] text-[var(--muted)]">{place.blurb}</span>
              </span>
            </DropdownMenu.Item>
          {/each}
        </div>

        <!-- the way out: apart, quiet at rest, the danger tone under the hand -->
        <div class="out">
          <DropdownMenu.Item
            variant="destructive"
            class="px-2 py-2 [&:not([data-highlighted])>svg]:!text-[var(--muted)] [&:not([data-highlighted])]:!text-[var(--muted)]"
            onclick={() => signOutToLogin()}
          >
            <LogOut />
            {t('nav.signOut')}
          </DropdownMenu.Item>
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>

<style>
  /* the initials, as on the phone's top bar: a small disc of paper */
  .disc {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    border: 1px solid var(--hairline);
    background: var(--ground);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--ink-soft);
  }
  /* collapsed: the same 28px mark the workspace's tile shows, so the two
     ends of the rail read as one column */
  .disc.lone {
    width: 28px;
    height: 28px;
  }
  .label {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
    opacity: 1;
    transition:
      opacity 180ms var(--motion-ease),
      transform 300ms ease-out,
      visibility 0s linear 0s;
  }
  .label.away {
    opacity: 0;
    transform: translateX(-6px);
    visibility: hidden;
    /* width, not just visibility: a hidden flex child still takes its
       basis, and the row's gap still counts it, which pushed the mark a
       few px off the rail's centre. */
    flex: 0 0 0;
    width: 0;
    min-width: 0;
    overflow: hidden;
    pointer-events: none;
    transition:
      opacity 140ms var(--motion-ease),
      transform 300ms ease-out,
      visibility 0s linear 300ms;
  }
  @media (prefers-reduced-motion: reduce) {
    .label,
    .label.away {
      transition: none;
      transform: none;
    }
  }
  /* in the card the disc takes the accent's wash: this is the person, lit */
  .disc.big {
    width: 42px;
    height: 42px;
    border-color: color-mix(in oklab, var(--accent) 30%, var(--hairline));
    background: var(--accent-soft);
    font-family: var(--display);
    font-size: 15px;
    font-weight: 400;
    color: var(--accent-deep);
  }
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 10px;
  }
  .name {
    font-family: var(--display);
    font-size: 17px;
    font-weight: 400;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--ink);
  }
  .as {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 0 16px 14px;
    font-size: 12.5px;
    color: var(--muted);
    border-bottom: 1px solid var(--hairline);
  }
  .well {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 30px;
    height: 30px;
    margin-top: 1px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent-deep);
  }
  .out {
    padding: 4px;
    border-top: 1px solid var(--hairline);
  }
</style>
