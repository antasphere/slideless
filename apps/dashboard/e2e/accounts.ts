/**
 * Accounts shared across the e2e projects: `smoke` runs first against the
 * fresh database and creates the instance + owner through the setup wizard;
 * `decks` (dependencies: ['smoke']) signs in as that same owner.
 */
export const INSTANCE_NAME = 'Smoke Test Instance';
export const OWNER = { name: 'Owner One', email: 'owner@example.com', password: 'owner-password-123' };
export const INVITEE = { name: 'Invited Member', email: 'invitee@example.com', password: 'invitee-password-123' };
