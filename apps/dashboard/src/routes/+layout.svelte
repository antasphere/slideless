<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { createHintWatch } from '$lib/hint-watch';
  import { consumePendingNext, pendingNextStorage } from '$lib/sso';
  import { signOutToLogin } from '$lib/session';

  let { children, data } = $props();

  // Return-to-origin (SL-3, decision 7): after a successful bootstrap with
  // a signed-in user, consume the pendingNext memory EXACTLY ONCE. The
  // navigation only fires from the app ROOT — that is where the journeys
  // that lost their deep link re-enter (the hub /verified CTA targets the
  // registry launchUrl = the tool origin); ordinary logins land on the
  // exact deep link via callbackURL, so their consume is a cleanup no-op —
  // and a root-only goto can never hijack an /invite or /collab landing.
  let pendingNextConsumed = false;
  $effect(() => {
    if (!data?.me || pendingNextConsumed) return;
    pendingNextConsumed = true;
    const pending = consumePendingNext(pendingNextStorage(), Date.now());
    if (pending && pending !== '/' && page.url.pathname === '/') void goto(pending);
  });

  onMount(() => {
    document.getElementById('splash')?.remove();

    // SL-4 hint-watch: on bootstrap + every visibilitychange→visible
    // (throttled), a signed-in ssoOnly user whose hub hint cookie vanished
    // (logout on the hub or a sibling tool) is signed out here too. Inert
    // on oss (no auth.sso) and for operators (never ssoOnly) — see
    // $lib/hint-watch.ts for the full predicate rationale.
    const watch = createHintWatch({
      getSso: () => data?.instance?.auth?.sso ?? null,
      getMe: () => data?.me,
      getCookies: () => document.cookie,
      signOut: () => signOutToLogin()
    });
    watch.check();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') watch.check();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  });
</script>

<Toaster richColors />

{@render children()}
