import { describe, expect, it } from 'vitest';
import { buildShareTokenCreate, defaultShareLinkForm } from './share-form';

/**
 * The share-link create body (PRDCT-2299): every capability switch reaches
 * the server as the person set it. A switch the payload drops falls back to
 * the server default, and a person who turned it OFF gets a link that has
 * it ON — the verifier gap of the deck's-own-page lane (M9), now pinned for
 * all four switches and the bar in particular.
 */
describe('buildShareTokenCreate', () => {
  it('sends every switch on by default except annotations, the bar included', () => {
    const body = buildShareTokenCreate(defaultShareLinkForm(3));
    expect(body).toMatchObject({
      versionMode: 'latest',
      canAnnotate: false,
      canSubmitForms: true,
      canDownload: true,
      showBar: true
    });
    expect(body).not.toHaveProperty('pinnedVersion');
    expect(body).not.toHaveProperty('expiresAt');
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('badgePosition');
  });

  it('carries the bar switched OFF explicitly (a bare link), never by omission', () => {
    const body = buildShareTokenCreate({ ...defaultShareLinkForm(3), showBar: false });
    expect(body.showBar).toBe(false);
    expect('showBar' in body).toBe(true);
  });

  it('carries downloads and forms switched OFF explicitly too', () => {
    const body = buildShareTokenCreate({
      ...defaultShareLinkForm(3),
      canDownload: false,
      canSubmitForms: false
    });
    expect(body.canDownload).toBe(false);
    expect(body.canSubmitForms).toBe(false);
  });

  it('pins a version as a number only when pinned, and the badge slot only with annotations on', () => {
    const pinned = buildShareTokenCreate({
      ...defaultShareLinkForm(3),
      versionMode: 'pinned',
      pinnedVersion: '2',
      canAnnotate: true,
      badgePosition: 'top-right'
    });
    expect(pinned.pinnedVersion).toBe(2);
    expect(pinned.badgePosition).toBe('top-right');

    const noNotes = buildShareTokenCreate({
      ...defaultShareLinkForm(3),
      badgePosition: 'top-right'
    });
    expect(noNotes).not.toHaveProperty('badgePosition');
  });

  it('turns an expiry in days into an ISO instant, and sends a password only when typed', () => {
    const now = Date.parse('2026-09-14T10:00:00Z');
    const body = buildShareTokenCreate(
      { ...defaultShareLinkForm(1), expiresIn: '7', password: 'hunter22' },
      now
    );
    expect(body.expiresAt).toBe('2026-09-21T10:00:00.000Z');
    expect(body.password).toBe('hunter22');
  });
});
