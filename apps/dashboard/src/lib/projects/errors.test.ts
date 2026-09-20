import { describe, expect, it } from 'vitest';
import { errorCode, errorStatus, isNotFound } from './errors';

describe('reading a refusal of the projects API', () => {
  it('reads the status and the code off any error that carries them', () => {
    const refused = Object.assign(new Error('Already a member'), { status: 409, code: 'already_member' });
    expect(errorStatus(refused)).toBe(409);
    expect(errorCode(refused)).toBe('already_member');
    expect(isNotFound(refused)).toBe(false);
    expect(isNotFound(Object.assign(new Error('no'), { status: 404 }))).toBe(true);
  });

  it('reads nothing off what is not an API error', () => {
    for (const e of [new Error('network'), null, undefined, 'text', { status: '404', code: 7 }]) {
      expect(errorStatus(e)).toBeNull();
      expect(errorCode(e)).toBeNull();
    }
  });
});
