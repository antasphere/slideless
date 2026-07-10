import { goto, invalidateAll } from '$app/navigation';
import { authClient } from '$lib/auth-client';

/** Signs out, refreshes the bootstrap data, and lands on /login. */
export async function signOutToLogin(): Promise<void> {
  try {
    await authClient.signOut();
  } catch {
    // Even if the call fails the session may be gone — fall through to login.
  }
  await invalidateAll();
  await goto('/login');
}

/** Re-runs the root bootstrap (instance + session + me) after auth changes. */
export async function refreshSession(): Promise<void> {
  await invalidateAll();
}
