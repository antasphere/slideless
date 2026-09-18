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
      showBar: true,
      remembersResponses: true,
      canUploadFiles: true
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

  it('carries remembering switched OFF explicitly, and never ON when forms are off (PRDCT-2328)', () => {
    const off = buildShareTokenCreate({ ...defaultShareLinkForm(3), remembersResponses: false });
    expect(off.remembersResponses).toBe(false);
    expect('remembersResponses' in off).toBe(true);
    // Forms off = nothing to remember: the body says so rather than letting
    // the server default a remembering check onto a read-only link.
    const formsOff = buildShareTokenCreate({ ...defaultShareLinkForm(3), canSubmitForms: false });
    expect(formsOff.remembersResponses).toBe(false);
  });

  it('carries file uploads switched OFF explicitly, and never ON when forms are off (PRDCT-2403)', () => {
    const off = buildShareTokenCreate({ ...defaultShareLinkForm(3), canUploadFiles: false });
    expect(off.canUploadFiles).toBe(false);
    // Omitted, the server would default the public write back ON.
    expect('canUploadFiles' in off).toBe(true);
    // Uploads need submissions: forms off = no uploads, said in the body.
    const formsOff = buildShareTokenCreate({ ...defaultShareLinkForm(3), canSubmitForms: false });
    expect(formsOff.canUploadFiles).toBe(false);
    expect('canUploadFiles' in formsOff).toBe(true);
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
