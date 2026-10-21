import { describe, expect, it } from 'vitest';
import { DECK_ACTIONS, DECK_ROUTE_ENTITLEMENTS } from '@slideless/contract/routes';
import { slidelessTool } from '../../src/tool.js';

/**
 * The upload cap Slideless declares, by the operator's cap (PRDCT-2653): the
 * paid tier IS `MAX_FILE_SIZE_MB`, the free value 100 MB or the cap when the
 * cap is smaller. What discovery advertises is what the instance serves, on
 * a 50 MB self-hosted instance as on the 500 MB cloud the seed intends.
 * Pinned after the verifier's round 1: the `min` was covered by no suite,
 * and its `max` twin refused the boot of every instance capped below 100 MB.
 */
const MB = 1024 * 1024;

function declaredAt(maxFileSizeMb: number) {
  // The slot's context (the database and the late-bound domain) feeds the
  // actor hooks alone, which this test never calls.
  const declared = slidelessTool.entitlements!({ MAX_FILE_SIZE_MB: maxFileSizeMb } as never, {
    db: null as never,
    getTool: () => null
  });
  return declared.limits['files.maxBytes']!;
}

describe('the upload cap Slideless declares, by the operator’s cap (PRDCT-2653)', () => {
  it('capped below 100 MB: free, pro and oss are all the cap', () => {
    expect(declaredAt(50)).toEqual({ oss: 50 * MB, free: 50 * MB, pro: 50 * MB });
  });

  it('capped at 100 MB (today’s cloud): free equals pro equals the cap', () => {
    expect(declaredAt(100)).toEqual({ oss: 100 * MB, free: 100 * MB, pro: 100 * MB });
  });

  it('capped at 500 MB (the seed’s intent): free stays 100 MB, pro is the cap', () => {
    expect(declaredAt(500)).toEqual({ oss: 500 * MB, free: 100 * MB, pro: 500 * MB });
  });

  it('no tier ever advertises more than the operator’s cap', () => {
    for (const cap of [1, 50, 100, 500, 2048]) {
      const { oss, free, pro } = declaredAt(cap);
      expect(free).toBeLessThanOrEqual(oss!);
      expect(pro).toBeLessThanOrEqual(oss!);
    }
  });
});

describe('a document’s writes meter the commit action (PRDCT-3641)', () => {
  const WRITES = [
    'POST /presentations/{id}/instances',
    'PUT /presentations/{id}/data',
    'PATCH /presentations/{id}/data',
    'POST /presentations/{id}/upgrade',
    'PUT /presentations/{id}/schema',
    'DELETE /presentations/{id}/answers/{form}'
  ];

  it('each of the six write routes is declared, metering DECK_ACTIONS.commit per call', () => {
    for (const key of WRITES) {
      const entry = DECK_ROUTE_ENTITLEMENTS.get(key);
      expect(entry, key).toBeDefined();
      expect(entry!.meter, key).toMatchObject({ key: DECK_ACTIONS.commit, unit: 'call' });
      expect(entry!.limit, key).toBeUndefined();
      expect(entry!.feature, key).toBeUndefined();
    }
  });

  it('the server’s own declarations (the tool’s slot) carry the same six', () => {
    const declared = slidelessTool.entitlements!({ MAX_FILE_SIZE_MB: 100 } as never, {
      db: null as never,
      getTool: () => null
    });
    for (const key of WRITES) {
      expect(declared.routes!.get(key)?.meter, key).toMatchObject({ key: DECK_ACTIONS.commit, unit: 'call' });
    }
  });

  it('the reads meter nothing', () => {
    for (const key of [
      'GET /presentations/{id}/schema',
      'GET /presentations/{id}/data',
      'GET /presentations/{id}/data/versions',
      'GET /presentations/{id}/data/versions/{version}',
      'GET /presentations/{id}/answers'
    ]) {
      expect(DECK_ROUTE_ENTITLEMENTS.get(key), key).toBeUndefined();
    }
  });
});
