import { describe, expect, it } from 'vitest';
import {
  formResponseDetailSchema,
  formResponseSchema,
  presentationUpdateSchema,
  shareTokenCreateSchema,
  shareTokenUpdateSchema
} from '../src/index.js';

/**
 * The forms fast-lane's contract pins (PRDCT-2328/2329/2330): a link
 * remembers its answers BY DEFAULT at the contract (the column default is
 * false, so pre-existing links keep their behaviour — that half is the
 * server's integration suite), the owner wire carries the revision and the
 * detail shape carries the history, and the deck's notification switch is
 * a valid PATCH on its own.
 */
describe('share tokens: remembersResponses', () => {
  it('defaults ON at create — a named link IS its recipient’s response', () => {
    const parsed = shareTokenCreateSchema.parse({ name: 'Alice' });
    expect(parsed.remembersResponses).toBe(true);
  });

  it('can be switched off at create and flipped on PATCH', () => {
    expect(
      shareTokenCreateSchema.parse({ name: 'Public', remembersResponses: false }).remembersResponses
    ).toBe(false);
    expect(shareTokenUpdateSchema.parse({ remembersResponses: false })).toEqual({
      remembersResponses: false
    });
    expect(shareTokenUpdateSchema.parse({ remembersResponses: true })).toEqual({ remembersResponses: true });
  });

  it('refuses a non-boolean', () => {
    expect(shareTokenCreateSchema.safeParse({ name: 'x', remembersResponses: 'yes' }).success).toBe(false);
  });
});

describe('form responses: revisions on the owner wire', () => {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    presentationId: '22222222-2222-2222-2222-222222222222',
    version: 1,
    formName: 'rsvp',
    shareTokenId: null,
    shareTokenName: null,
    source: 'link',
    placement: null,
    payload: { name: 'a' },
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z'
  };

  it('requires revision ≥ 1 on a response', () => {
    expect(formResponseSchema.safeParse({ ...base, revision: 1 }).success).toBe(true);
    expect(formResponseSchema.safeParse({ ...base, revision: 0 }).success).toBe(false);
    expect(formResponseSchema.safeParse(base).success).toBe(false);
  });

  it('the detail shape is the response plus its versions', () => {
    const detail = formResponseDetailSchema.parse({
      response: { ...base, revision: 2 },
      versions: [
        {
          revision: 2,
          version: 1,
          shareTokenId: null,
          shareTokenName: null,
          source: 'link',
          placement: null,
          payload: { name: 'b' },
          createdAt: '2026-09-15T00:01:00.000Z'
        },
        {
          revision: 1,
          version: 1,
          shareTokenId: null,
          shareTokenName: null,
          source: 'embed',
          placement: 'site',
          payload: { name: 'a' },
          createdAt: '2026-09-15T00:00:00.000Z'
        }
      ]
    });
    expect(detail.versions.map((v) => v.revision)).toEqual([2, 1]);
  });
});

describe('presentations: notifyOnResponse', () => {
  it('is a valid PATCH on its own, and an empty PATCH is still refused', () => {
    expect(presentationUpdateSchema.safeParse({ notifyOnResponse: false }).success).toBe(true);
    expect(presentationUpdateSchema.safeParse({}).success).toBe(false);
  });
});
