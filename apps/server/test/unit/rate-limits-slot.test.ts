import { describe, expect, it } from 'vitest';
import { slidelessTool } from '../../src/tool.js';

/**
 * The per-address wall in front of the two priced viewer doors (PRDCT-2634,
 * the code review): registered by the tool's `rateLimits` slot on the cloud
 * edition only, where the billing gate asks the hub; on oss the doors keep
 * their handlers' own walls and nothing else. The slot is called on a fake
 * `api` that records the paths it is given.
 */
const DOORS = ['/viewer/:secret/forms/:form/responses', '/viewer/:secret/forms/:form/uploads'];

function registeredPaths(hubSso: unknown): string[] {
  const paths: string[] = [];
  const api = { use: (path: string) => void paths.push(path) };
  const limiters = new Proxy({}, { get: () => ({}) });
  slidelessTool.api.rateLimits!(api as never, { limiters, clientIp: () => '1.1.1.1', hubSso } as never);
  return paths;
}

describe('the rateLimits slot', () => {
  it('the wall in front of the viewer doors is registered on cloud only', () => {
    const oss = registeredPaths(undefined);
    for (const door of DOORS) expect(oss).not.toContain(door);
    const cloud = registeredPaths({});
    for (const door of DOORS) expect(cloud.filter((p) => p === door)).toHaveLength(1);
  });
});
