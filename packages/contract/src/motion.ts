/**
 * The product's ONE motion (PRDCT-2308): a duration and an easing for every
 * popover, menu and fold — the dashboard's title menu, the recipient bar's
 * fold and its download menu. CSS cannot import a constant, so the two
 * values are MIRRORED where they are used: `apps/dashboard/src/lib/tokens.css`
 * (`--motion-duration`, `--motion-ease`) and the bar runtime's inline
 * stylesheet (`apps/server/src/viewer/topbar.ts`, which interpolates these
 * exports). A unit test on each side pins its mirror against this file, so
 * a change here that is not carried over goes red instead of drifting.
 * Reduced-motion preferences zero the duration on every surface.
 */
export const MOTION_DURATION_MS = 160;
export const MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
