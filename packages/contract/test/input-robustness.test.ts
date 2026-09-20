import { describe, expect, it } from 'vitest';
import {
  hasNulDeep,
  isValidMediaType,
  jsonDepthOf,
  MAX_OPAQUE_JSON_DEPTH,
  memberUpdateSchema
} from '@antasphere/chassis-contract';
import { versionNumberSchema, versionParamSchema } from '../src/schemas/versions.js';
import {
  annotationCreateSchema,
  formResponsePayloadSchema,
  formResponsesListQuerySchema,
  manifestEntrySchema,
  presentationMetadataSchema
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

  it('terminates on a circular graph instead of spinning forever', () => {
    // The contract is documented safe to run outside the server, where a caller
    // may hand it a live object with a back-reference. Without the seen-set this
    // hangs; the assertion completing at all is the test.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    cyclic.arr = [cyclic];
    expect(hasNulDeep(cyclic)).toBe(false);
    cyclic.tainted = 'x\u0000';
    expect(hasNulDeep(cyclic)).toBe(true);
  });
});

describe('jsonDepthOf', () => {
  it('measures depth iteratively', () => {
    expect(jsonDepthOf('scalar')).toBe(0);
    expect(jsonDepthOf({ a: 1 })).toBe(1);
    expect(jsonDepthOf({ a: [{ b: 1 }] })).toBe(3);
    expect(jsonDepthOf(nested(50_000))).toBe(50_000);
  });

  it('terminates on a circular graph', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonDepthOf(cyclic)).toBeGreaterThanOrEqual(1);
  });
});

describe('opaqueJsonChecks short-circuits depth before the size stringify', () => {
  it('a value past the depth cap is refused without the recursive stringify ever running', () => {
    // The size refine calls JSON.stringify (recursive — the SL-B5 hazard); the
    // depth refine carries `abort: true` so a hostile-depth value fails FIRST
    // and the stringify never runs. A `toJSON` that throws proves the ordering
    // on any host: the depth walk uses Object.values and never calls toJSON, so
    // it does not throw; JSON.stringify calls toJSON first and would. If the
    // size refine ran, safeParse would throw instead of returning a clean
    // validation failure.
    const trap = {
      toJSON() {
        throw new Error('JSON.stringify reached the value — depth did not short-circuit');
      }
    };
    let overDeep: unknown = trap;
    for (let i = 0; i < MAX_OPAQUE_JSON_DEPTH + 2; i++) overDeep = { k: overDeep };
    let result: ReturnType<typeof presentationMetadataSchema.safeParse> | undefined;
    expect(() => {
      result = presentationMetadataSchema.safeParse(overDeep as Record<string, unknown>);
    }).not.toThrow();
    expect(result!.success).toBe(false);
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
      'text/html; charset', // parameter without value
      '', // empty
      'a'.repeat(300) + '/b' // over 255
    ]) {
      expect(isValidMediaType(v), JSON.stringify(v)).toBe(false);
    }
  });

  it('refuses any code point above Latin-1 — the real ByteString trap (PLT-5)', () => {
    // These pass RFC 7231's quoted-string grammar but carry a unit > 0xFF, so
    // `new Headers().set('content-type', v)` throws a ByteString TypeError. A
    // grammar-only gate would admit them; the guard must reject them too.
    for (const v of ['text/html; charset="€"', 'text/plain; name="café☕"']) {
      expect(isValidMediaType(v), JSON.stringify(v)).toBe(false);
      // Prove the premise: this value genuinely throws at the header set.
      expect(() => new Headers().set('content-type', v), JSON.stringify(v)).toThrow();
    }
    // A Latin-1 code point above 0x7F but ≤ 0xFF is header-safe (no throw): the
    // ceiling is the ByteString limit 0xFF, not ASCII. `ø` is still refused as a
    // media type because it is not a token character, but for the GRAMMAR
    // reason, not the ByteString one.
    expect(() => new Headers().set('content-type', 'text/html; charset=" é"')).not.toThrow();
    expect(isValidMediaType('application/x-ø')).toBe(false);
  });

  it('manifest entries carry the media-type rule', () => {
    const entry = { path: 'index.html', sha256: 'a'.repeat(64), sizeBytes: 1 };
    expect(manifestEntrySchema.safeParse({ ...entry, contentType: 'text/html' }).success).toBe(true);
    expect(manifestEntrySchema.safeParse({ ...entry, contentType: 'text/html; charset="€"' }).success).toBe(
      false
    );
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
