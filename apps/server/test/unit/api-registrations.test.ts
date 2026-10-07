import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two source audits over this app's routers (`src/api`). The chassis runs the
 * same two over its own routers in its own repository
 * (`test/unit/head-rewrite.test.ts` and `test/unit/openapi-doc.test.ts` of
 * `@antasphere/chassis-server`); the routers live in two places since the
 * chassis extraction, and each side audits its own.
 *
 * PLT-39: Hono answers a HEAD request by running the GET handler, so a separate
 * `app.on('HEAD', …)` registration NEVER fires. The chassis pins the framework
 * behaviour; this keeps the dead idiom off the tool's routes.
 *
 * PLT-3: `api.doc()` runs the whole synchronous OpenAPI generator inside the
 * request handler, on an endpoint that is unauthenticated by design. The
 * chassis's API app registers the document once, through `registerOpenApiDoc`;
 * the tool's routers never register one of their own.
 */
const apiDirs = [join(import.meta.dirname, '../../src/api')];

function sourceFiles(): string[] {
  return apiDirs.flatMap((dir) => readdirSync(dir).map((file) => join(dir, file)));
}

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('no dead HEAD registrations under /api/v1', () => {
  it('has none', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith('.ts')) continue;
      if (/\.on\(\s*(\[[^\]]*)?['"]HEAD['"]/.test(codeOf(file))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the API app does not register a per-request document generator', () => {
  it('never calls api.doc() — registerOpenApiDoc is the only registration', () => {
    const offenders: string[] = [];
    let registrations = 0;
    for (const file of sourceFiles()) {
      if (!file.endsWith('.ts')) continue;
      const code = codeOf(file);
      if (/\bapi\.doc\d?\s*\(/.test(code)) offenders.push(file);
      registrations += (code.match(/registerOpenApiDoc\s*\(/g) ?? []).length;
    }
    expect(offenders).toEqual([]);
    // The chassis's API app calls it exactly once; a tool router never calls it a second time.
    expect(registrations).toBe(0);
  });
});
