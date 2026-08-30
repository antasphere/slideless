import { describe, expect, it } from 'vitest';
import {
  annotationCreateSchema,
  formResponsePayloadSchema,
  formResponsesListQuerySchema,
  hasNulDeep,
  isValidMediaType,
  jsonDepthOf,
  manifestEntrySchema,
  MAX_OPAQUE_JSON_DEPTH,
  memberUpdateSchema,
  presentationMetadataSchema,
  versionNumberSchema,
  versionParamSchema
} from '../src/index.js';

/**
 * PRDCT-1358 — the contract half of the input-validation 500 family. Every
 * case here used to reach Postgres, the Headers constructor, or a recursive
 * JSON.stringify and come back as a 500; the contract now refuses each one as
 * an ordinary validation failure.
 */

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = { k: value };
  return value;
}

describe('hasNulDeep', () => {
  it('finds NUL in values, keys, arrays, and nested objects', () => {
    expect(hasNulDeep('a\u0000b')).toBe(true);
    expect(hasNulDeep({ a: 'x\u0000' })).toBe(true);
    expect(hasNulDeep({ ['k\u0000ey']: 'v' })).toBe(true);
    expect(hasNulDeep({ a: { b: ['ok', 'bad\u0000'] } })).toBe(true);
    expect(hasNulDeep({ a: { b: ['clean', 1, null, true] } })).toBe(false);
  });

  it('survives a hostile depth without recursing', () => {
    expect(hasNulDeep(nested(200_000))).toBe(false);
  });
});

describe('jsonDepthOf', () => {
  it('measures depth iteratively', () => {
    expect(jsonDepthOf('scalar')).toBe(0);
    expect(jsonDepthOf({ a: 1 })).toBe(1);
    expect(jsonDepthOf({ a: [{ b: 1 }] })).toBe(3);
    expect(jsonDepthOf(nested(50_000))).toBe(50_000);
  });
});

describe('media type (PLT-5)', () => {
  it('accepts real media types, with and without parameters', () => {
    for (const v of [
      'text/html',
      'application/json',
      'image/svg+xml',
      'text/html; charset=utf-8',
      'multipart/form-data; boundary=abc123',
      'application/vnd.api+json;profile="https://example.com"'
    ]) {
      expect(isValidMediaType(v), v).toBe(true);
    }
  });

  it('refuses what the Headers constructor or header splitting would choke on', () => {
    for (const v of [
      'texthtml', // no slash
      'text/', // empty subtype
      'text/ht ml', // raw space in token
      'text/html\r\nx-evil: 1', // header injection
      'text/héml', // non-Latin1 → ByteString TypeError at the Headers set
      'text/html; charset', // parameter without value
      '', // empty
      'a'.repeat(300) + '/b' // over 255
    ]) {
      expect(isValidMediaType(v), JSON.stringify(v)).toBe(false);
    }
  });

  it('manifest entries carry the media-type rule', () => {
    const entry = { path: 'index.html', sha256: 'a'.repeat(64), sizeBytes: 1 };
    expect(manifestEntrySchema.safeParse({ ...entry, contentType: 'text/html' }).success).toBe(true);
    expect(manifestEntrySchema.safeParse({ ...entry, contentType: 'text/h éml' }).success).toBe(false);
  });
});

describe('member update (FUZZ-5)', () => {
  it('refuses an empty patch instead of building an empty SQL SET', () => {
    expect(memberUpdateSchema.safeParse({}).success).toBe(false);
    expect(memberUpdateSchema.safeParse({ role: 'admin' }).success).toBe(true);
    expect(memberUpdateSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

describe('version numbers (FUZZ-9)', () => {
  it('string params are strict digits, int4-bounded', () => {
    expect(versionParamSchema.safeParse('1').success).toBe(true);
    expect(versionParamSchema.safeParse('2147483647').success).toBe(true);
    for (const v of ['0', '-1', '1e5', '0x10', ' 1', '1.0', '99999999999999999999', '2147483648', 'abc']) {
      expect(versionParamSchema.safeParse(v).success, v).toBe(false);
    }
  });

  it('body versions are int4-bounded', () => {
    expect(versionNumberSchema.safeParse(1).success).toBe(true);
    expect(versionNumberSchema.safeParse(1e15).success).toBe(false);
  });
});

describe('opaque JSON objects (SL-B4/SL-B5)', () => {
  it('metadata refuses NUL and hostile depth before stringifying', () => {
    expect(presentationMetadataSchema.safeParse({ ok: 'value' }).success).toBe(true);
    expect(presentationMetadataSchema.safeParse({ bad: 'x\u0000' }).success).toBe(false);
    expect(
      presentationMetadataSchema.safeParse(nested(MAX_OPAQUE_JSON_DEPTH + 5) as Record<string, unknown>)
        .success
    ).toBe(false);
    // The depth refine must short-circuit: a graph past the cap never reaches
    // the recursive stringify in the size refine.
    expect(presentationMetadataSchema.safeParse(nested(50_000) as Record<string, unknown>).success).toBe(
      false
    );
  });

  it('annotation selections refuse NUL, depth, and oversize', () => {
    const base = { version: 1, body: 'note' };
    expect(annotationCreateSchema.safeParse({ ...base, selection: { a: 'b' } }).success).toBe(true);
    expect(annotationCreateSchema.safeParse({ ...base, selection: { a: 'b\u0000' } }).success).toBe(false);
    expect(annotationCreateSchema.safeParse({ ...base, selection: nested(40) }).success).toBe(false);
    expect(
      annotationCreateSchema.safeParse({ ...base, selection: { big: 'x'.repeat(10_000) } }).success
    ).toBe(false);
  });

  it('form payloads refuse NUL in keys and values', () => {
    expect(formResponsePayloadSchema.safeParse({ field: 'ok', multi: ['a', 'b'] }).success).toBe(true);
    expect(formResponsePayloadSchema.safeParse({ field: 'x\u0000' }).success).toBe(false);
    expect(formResponsePayloadSchema.safeParse({ ['f\u0000']: 'x' }).success).toBe(false);
    expect(formResponsePayloadSchema.safeParse({ multi: ['ok', 'x\u0000'] }).success).toBe(false);
  });

  it('the responses placement filter is control-char-free (the read side)', () => {
    expect(formResponsesListQuerySchema.safeParse({ placement: 'hero' }).success).toBe(true);
    expect(formResponsesListQuerySchema.safeParse({ placement: 'he\u0000ro' }).success).toBe(false);
  });
});
