<script lang="ts">
  import { goto } from '$app/navigation';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import LogOut from '@lucide/svelte/icons/log-out';
  import UserRound from '@lucide/svelte/icons/user-round';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import LanguageSwitcher from '$lib/components/shared/LanguageSwitcher.svelte';
  import { signOutToLogin } from '$lib/session';
  import { t } from '$lib/i18n';

  interface Props {
    user: { name: string; email: string };
  }

  let { user }: Props = $props();

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
</script>

<Sidebar.Menu class="px-1">
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="default"
            class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground {sidebar.state ===
            'collapsed'
              ? '!mx-auto !w-9 !justify-center !p-0'
              : '!px-1 !py-2'}"
          >
            <Avatar.Root class="{sidebar.state === 'collapsed' ? 'h-9 w-9' : 'h-7 w-7'} shrink-0 rounded-md">
              <Avatar.Fallback class="rounded-md text-xs">{initials}</Avatar.Fallback>
            </Avatar.Root>
            {#if sidebar.state !== 'collapsed'}
              <span class="truncate text-sm font-medium">{displayName}</span>
              <ChevronsUpDown class="ml-auto size-4 shrink-0" />
            {/if}
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-[var(--bits-dropdown-menu-anchor-width)] min-w-56 rounded-lg"
        side={sidebar.isMobile ? 'bottom' : 'right'}
        align="end"
        sideOffset={4}
      >
        <DropdownMenu.Label class="p-0 font-normal">
          <div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar.Root class="h-8 w-8 rounded-lg">
              <Avatar.Fallback class="rounded-lg">{initials}</Avatar.Fallback>
            </Avatar.Root>
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-medium">{displayName}</span>
              <span class="truncate text-xs">{user.email}</span>
            </div>
          </div>
        </DropdownMenu.Label>
        <DropdownMenu.Item onclick={() => goto('/account')}>
          <UserRound class="mr-2 h-4 w-4" />
          {t('nav.myAccount')}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <!-- Not a menu item: picking a language reloads the page anyway. -->
        <div class="flex items-center justify-between px-2 py-1.5 text-sm">
          <span class="text-muted-foreground">{t('common.language')}</span>
          <LanguageSwitcher />
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onclick={() => signOutToLogin()}>
          <LogOut class="mr-2 h-4 w-4" />
          {t('nav.signOut')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>
