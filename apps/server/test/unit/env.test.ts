import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/env.js';

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
});
