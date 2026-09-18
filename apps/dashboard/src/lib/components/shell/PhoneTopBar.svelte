<script lang="ts">
  /* The phone's header: where you are (the workspace, on its small field)
     and who you are (the way to the account), nothing else. Once the page's
     own header has scrolled away the workspace's name gives its place to the
     page's, and takes it back when the header returns. */
  import LogoTile from '$lib/components/brand/LogoTile.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    name: string;
    /** The open page's name, set while its own header is out of view. */
    title?: string;
    user: { name: string; email: string };
  }

  let { name, title, user }: Props = $props();

  // the last title stays in place while it fades out
  let shownTitle = $state('');
  $effect(() => {
    if (title) shownTitle = title;
  });

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

<header class="topbar">
  <a href="/" class="flex min-w-0 items-center gap-2.5">
    <LogoTile label={name} size={30} />
    <span class="names font-display text-[16px] tracking-[-0.005em]">
      <span class="truncate" class:away={!!title} aria-hidden={title ? 'true' : undefined}>{name}</span>
      <!-- SECURITY: a page's name may be user-authored (a deck's title): text interpolation only. -->
      <span class="truncate" class:away={!title} aria-hidden={title ? undefined : 'true'}>{shownTitle}</span>
    </span>
  </a>
  <a href="/account" class="me" aria-label={t('nav.myAccount')}>{initials}</a>
</header>

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 56px;
    padding: 0 16px;
    background: var(--bar);
    backdrop-filter: blur(18px) saturate(1.2);
    -webkit-backdrop-filter: blur(18px) saturate(1.2);
    border-bottom: 1px solid var(--hairline);
  }
  /* the two names share one cell; one is away at a time */
  .names {
    display: grid;
    min-width: 0;
  }
  .names > span {
    grid-area: 1 / 1;
    transition:
      opacity 200ms var(--motion-ease),
      transform 200ms var(--motion-ease);
  }
  .names > .away {
    opacity: 0;
    transform: translateY(4px);
  }
  .me {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 999px;
    border: 1px solid var(--hairline);
    background: var(--ground);
    font-size: 11.5px;
    font-weight: 500;
    color: var(--ink-soft);
  }
  /* a desk has its sidebar (a scoped rule outranks a utility class, so the
     breakpoint lives here) */
  @media (min-width: 768px) {
    .topbar {
      display: none;
    }
  }
</style>
