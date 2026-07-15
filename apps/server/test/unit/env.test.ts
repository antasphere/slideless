import { describe, expect, it } from 'vitest';
import { envSchema, hubConfig } from '../../src/env.js';

const minimal = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('env schema', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const env = envSchema.parse(minimal);
    expect(env.PORT).toBe(3000);
    expect(env.AUTO_MIGRATE).toBe(true);
    expect(env.SERVICE_ROLE).toBe('all');
    expect(env.PUBLIC_BASE_URL).toBe('http://localhost:3000');
    expect(env.DATA_DIR).toBe('/data');
    expect(env.NODE_ENV).toBe('production');
  });

  it('rejects a missing DATABASE_URL', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('parses booleanish AUTO_MIGRATE values', () => {
    expect(envSchema.parse({ ...minimal, AUTO_MIGRATE: 'false' }).AUTO_MIGRATE).toBe(false);
    expect(envSchema.parse({ ...minimal, AUTO_MIGRATE: '1' }).AUTO_MIGRATE).toBe(true);
  });

  it('rejects an invalid SERVICE_ROLE and out-of-range PORT', () => {
    expect(envSchema.safeParse({ ...minimal, SERVICE_ROLE: 'both' }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, PORT: '70000' }).success).toBe(false);
  });

  it('requires AUTH_SECRET to be at least 32 chars when provided', () => {
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'short' }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'x'.repeat(32) }).success).toBe(true);
  });

  it('treats an empty AUTH_SECRET (VAR= in compose) as unset', () => {
    const env = envSchema.parse({ ...minimal, AUTH_SECRET: '' });
    expect(env.AUTH_SECRET).toBeUndefined();
  });

  it('defaults the general API quota and treats empty strings as unset (not 0/disabled)', () => {
    const env = envSchema.parse(minimal);
    expect(env.API_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(env.API_RATE_LIMIT_BURST).toBe(100);
    // `VAR=` in compose must mean "use the default", never "coerce to 0 and
    // silently disable the limiter".
    const empty = envSchema.parse({
      ...minimal,
      API_RATE_LIMIT_PER_MINUTE: '',
      API_RATE_LIMIT_BURST: ''
    });
    expect(empty.API_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(empty.API_RATE_LIMIT_BURST).toBe(100);
    // An explicit 0 is the conscious opt-out.
    expect(envSchema.parse({ ...minimal, API_RATE_LIMIT_PER_MINUTE: '0' }).API_RATE_LIMIT_PER_MINUTE).toBe(0);
    expect(envSchema.safeParse({ ...minimal, API_RATE_LIMIT_PER_MINUTE: '-1' }).success).toBe(false);
    // Whitespace-only is ALSO unset — `Number(' ') === 0` must not silently
    // disable the limiter (the preprocessor trims).
    const blank = envSchema.parse({
      ...minimal,
      API_RATE_LIMIT_PER_MINUTE: '  ',
      API_RATE_LIMIT_BURST: '\t'
    });
    expect(blank.API_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(blank.API_RATE_LIMIT_BURST).toBe(100);
  });

  it('validates SUPERADMIN_EMAILS loudly and treats blank as unset (dormant)', () => {
    expect(envSchema.parse(minimal).SUPERADMIN_EMAILS).toBeUndefined();
    expect(envSchema.parse({ ...minimal, SUPERADMIN_EMAILS: '' }).SUPERADMIN_EMAILS).toBeUndefined();
    expect(envSchema.parse({ ...minimal, SUPERADMIN_EMAILS: '  ' }).SUPERADMIN_EMAILS).toBeUndefined();
    expect(
      envSchema.parse({ ...minimal, SUPERADMIN_EMAILS: ' Ops@Example.com , two@x.io ' }).SUPERADMIN_EMAILS
    ).toBe(' Ops@Example.com , two@x.io '); // raw value kept; parsing happens at the route
    // A typo must fail the boot, never silently disarm break-glass.
    expect(envSchema.safeParse({ ...minimal, SUPERADMIN_EMAILS: 'not-an-email' }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, SUPERADMIN_EMAILS: 'ok@x.io,broken' }).success).toBe(false);
  });

  it('defaults ORPHAN_USER_RETENTION_HOURS to 72 and keeps 0 as the conscious opt-out', () => {
    expect(envSchema.parse(minimal).ORPHAN_USER_RETENTION_HOURS).toBe(72);
    // `VAR=` / whitespace in compose means "default", never "coerce to 0".
    expect(envSchema.parse({ ...minimal, ORPHAN_USER_RETENTION_HOURS: '' }).ORPHAN_USER_RETENTION_HOURS).toBe(
      72
    );
    expect(
      envSchema.parse({ ...minimal, ORPHAN_USER_RETENTION_HOURS: ' ' }).ORPHAN_USER_RETENTION_HOURS
    ).toBe(72);
    expect(
      envSchema.parse({ ...minimal, ORPHAN_USER_RETENTION_HOURS: '0' }).ORPHAN_USER_RETENTION_HOURS
    ).toBe(0);
    expect(envSchema.safeParse({ ...minimal, ORPHAN_USER_RETENTION_HOURS: '-1' }).success).toBe(false);
  });

  describe('edition split (docs/federation.md)', () => {
    const hubVars = {
      HUB_ISSUER_URL: 'https://account.antasphere.com',
      HUB_CLIENT_ID: 'tool-slideless-cloud',
      HUB_CLIENT_SECRET: 'a-dev-secret-of-sixteen-chars'
    };

    it('defaults to the oss edition with no hub config read', () => {
      const env = envSchema.parse(minimal);
      expect(env.EDITION).toBe('oss');
      expect(env.HUB_ISSUER_URL).toBeUndefined();
      expect(env.EDITION_CHANGE_ALLOWED).toBe(false);
      expect(hubConfig(env)).toBeNull();
    });

    it('oss boots without any HUB_* var, and hubConfig stays null even when they are set', () => {
      const env = envSchema.parse({ ...minimal, ...hubVars });
      expect(hubConfig(env)).toBeNull(); // EDITION=oss: the cloud seams never see hub config
    });

    it('EDITION=cloud fails LOUDLY listing every missing hub var', () => {
      const result = envSchema.safeParse({ ...minimal, EDITION: 'cloud' });
      expect(result.success).toBe(false);
      const paths = result.error!.issues.map((i) => i.path.join('.'));
      for (const key of ['HUB_ISSUER_URL', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET']) {
        expect(paths, `issue for ${key}`).toContain(key);
      }
    });

    it('EDITION=cloud reports the SPECIFIC missing vars, not a blanket failure', () => {
      const result = envSchema.safeParse({
        ...minimal,
        EDITION: 'cloud',
        HUB_ISSUER_URL: hubVars.HUB_ISSUER_URL,
        HUB_CLIENT_ID: hubVars.HUB_CLIENT_ID
      });
      expect(result.success).toBe(false);
      const paths = result.error!.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('HUB_CLIENT_SECRET');
      expect(paths).not.toContain('HUB_ISSUER_URL');
      expect(paths).not.toContain('HUB_CLIENT_ID');
    });

    it('a blank hub var (VAR= in compose) counts as missing on cloud', () => {
      const result = envSchema.safeParse({ ...minimal, EDITION: 'cloud', ...hubVars, HUB_CLIENT_ID: ' ' });
      expect(result.success).toBe(false);
      expect(result.error!.issues.map((i) => i.path.join('.'))).toContain('HUB_CLIENT_ID');
    });

    it('EDITION=cloud with the full hub block parses; hubConfig carries it', () => {
      const env = envSchema.parse({ ...minimal, EDITION: 'cloud', ...hubVars });
      expect(hubConfig(env)).toEqual({
        issuerUrl: hubVars.HUB_ISSUER_URL,
        clientId: hubVars.HUB_CLIENT_ID,
        clientSecret: hubVars.HUB_CLIENT_SECRET
      });
    });

    it('validates hub var FORMATS whenever set (a typo fails the boot, per the env philosophy)', () => {
      expect(
        envSchema.safeParse({ ...minimal, EDITION: 'cloud', ...hubVars, HUB_ISSUER_URL: 'not-a-url' }).success
      ).toBe(false);
      expect(
        envSchema.safeParse({ ...minimal, EDITION: 'cloud', ...hubVars, HUB_CLIENT_SECRET: 'short' }).success
      ).toBe(false);
    });

    it('parses booleanish EDITION_CHANGE_ALLOWED (unset defaults to false)', () => {
      expect(envSchema.parse(minimal).EDITION_CHANGE_ALLOWED).toBe(false);
      expect(envSchema.parse({ ...minimal, EDITION_CHANGE_ALLOWED: 'true' }).EDITION_CHANGE_ALLOWED).toBe(
        true
      );
    });

    it('refuses any EDITION other than oss/cloud — a typo must never silently bind oss', () => {
      const result = envSchema.safeParse({ ...minimal, EDITION: 'clould', ...hubVars });
      expect(result.success).toBe(false);
      expect(result.error!.issues.map((i) => i.path.join('.'))).toContain('EDITION');
      // Blank (EDITION= in compose) still means unset, i.e. the oss default.
      expect(envSchema.parse({ ...minimal, EDITION: ' ' }).EDITION).toBe('oss');
    });
  });
});
