import { describe, expect, it } from 'vitest';
import { envSchema, hubConfig, shannonEntropyBits, weakSecretReason } from '../../src/env.js';

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

  it('requires AUTH_SECRET to be at least 32 chars AND high-entropy when provided', () => {
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'short' }).success).toBe(false);
    // Changed by PLT-25: 32 repeated characters used to be accepted here. On
    // the hub a low-entropy AUTH_SECRET is forgeable session/JWKS material for
    // the whole fleet, so length alone is no longer sufficient.
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'x'.repeat(32) }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: '9f14c0b3a7d25e6810f4bb93cd7a2e58' }).success).toBe(
      true
    );
  });

  it('refuses a LOW-ENTROPY AUTH_SECRET even at 32+ chars (PLT-25)', () => {
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'changeme'.repeat(4) }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'abcdefgh'.repeat(4) }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, AUTH_SECRET: 'ab'.repeat(24) }).success).toBe(false);
    // The message must tell the operator what to do, not just "invalid".
    const issue = envSchema.safeParse({ ...minimal, AUTH_SECRET: 'x'.repeat(40) }).error?.issues[0];
    expect(issue?.message).toMatch(/openssl rand/);
  });

  it('scores secrets the way the entropy floor documents', () => {
    expect(shannonEntropyBits('x'.repeat(32))).toBe(0);
    expect(shannonEntropyBits('9f14c0b3a7d25e6810f4bb93cd7a2e58')).toBeGreaterThan(100);
    expect(weakSecretReason('9f14c0b3a7d25e6810f4bb93cd7a2e58')).toBeNull();
    expect(weakSecretReason('x'.repeat(32))).toContain('distinct characters');
    expect(weakSecretReason('abcdefgh'.repeat(4))).toContain('pattern repeated');
  });

  it('constrains PUBLIC_BASE_URL to http(s) (PLT-26)', () => {
    // z.url() alone accepts these on the pinned zod, and PUBLIC_BASE_URL is the
    // OIDC issuer + the Better Auth baseURL on this repo.
    expect(envSchema.safeParse({ ...minimal, PUBLIC_BASE_URL: 'javascript:alert(1)' }).success).toBe(false);
    expect(
      envSchema.safeParse({ ...minimal, PUBLIC_BASE_URL: 'data:text/html,<script>x</script>' }).success
    ).toBe(false);
    expect(envSchema.safeParse({ ...minimal, PUBLIC_BASE_URL: 'file:///etc/passwd' }).success).toBe(false);
    expect(envSchema.parse({ ...minimal, PUBLIC_BASE_URL: 'https://app.example.com' }).PUBLIC_BASE_URL).toBe(
      'https://app.example.com'
    );
    // Same gate on every other parsed-URL knob. This repo has two the others
    // do not: VIEWER_BASE_URL (the isolated user-content origin) and
    // HUB_ISSUER_URL (the Antasphere hub it federates to) — a non-http scheme
    // in either is a redirect/XSS primitive on the viewer or the SSO dance.
    expect(envSchema.safeParse({ ...minimal, S3_ENDPOINT: 'javascript:alert(1)' }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, VIEWER_BASE_URL: 'javascript:alert(1)' }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, HUB_ISSUER_URL: 'javascript:alert(1)' }).success).toBe(false);
    expect(
      envSchema.safeParse({ ...minimal, OTEL_EXPORTER_OTLP_ENDPOINT: 'javascript:alert(1)' }).success
    ).toBe(false);
  });

  it('refuses a blank DATA_DIR instead of silently using "" (PLT-27)', () => {
    expect(envSchema.safeParse({ ...minimal, DATA_DIR: '' }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimal, DATA_DIR: '   ' }).success).toBe(false);
    expect(envSchema.parse({ ...minimal, DATA_DIR: '/srv/data' }).DATA_DIR).toBe('/srv/data');
  });

  /**
   * PLT-13. This repo's docker-compose.yml does NOT currently feed the two
   * retention knobs blank (unlike the hub's), so the bug was latent here — but
   * `Number('')` is 0 and 0 means keep-forever, so the day someone adds
   * `AUDIT_RETENTION_DAYS=${AUDIT_RETENTION_DAYS:-}` to compose it would go
   * live silently. Every numeric knob rides `numeric()` now, including the two
   * view-analytics ones this repo adds.
   */
  it('treats blank retention/window knobs as their documented defaults, never 0 (PLT-13)', () => {
    expect(envSchema.parse(minimal).AUDIT_RETENTION_DAYS).toBe(365);
    expect(envSchema.parse({ ...minimal, AUDIT_RETENTION_DAYS: '' }).AUDIT_RETENTION_DAYS).toBe(365);
    expect(envSchema.parse({ ...minimal, AUDIT_RETENTION_DAYS: '  ' }).AUDIT_RETENTION_DAYS).toBe(365);
    expect(envSchema.parse(minimal).VIEW_EVENTS_RETENTION_DAYS).toBe(90);
    expect(envSchema.parse({ ...minimal, VIEW_EVENTS_RETENTION_DAYS: '' }).VIEW_EVENTS_RETENTION_DAYS).toBe(
      90
    );
    expect(envSchema.parse({ ...minimal, VIEW_DEDUPE_WINDOW_MINUTES: '' }).VIEW_DEDUPE_WINDOW_MINUTES).toBe(
      10
    );
    expect(envSchema.parse({ ...minimal, ORPHAN_USER_RETENTION_HOURS: '' }).ORPHAN_USER_RETENTION_HOURS).toBe(
      72
    );
    // An explicit 0 stays the conscious opt-out.
    expect(envSchema.parse({ ...minimal, AUDIT_RETENTION_DAYS: '0' }).AUDIT_RETENTION_DAYS).toBe(0);
    expect(envSchema.safeParse({ ...minimal, AUDIT_RETENTION_DAYS: '-1' }).success).toBe(false);
  });

  it('exposes the DCR and HSTS switches with their current-behaviour defaults', () => {
    // PLT-29: the default is UNCHANGED — the fleet-wide decision on open
    // dynamic client registration belongs to the OIDC audit. This adds the knob.
    expect(envSchema.parse(minimal).OAUTH_DYNAMIC_CLIENT_REGISTRATION).toBe(true);
    expect(
      envSchema.parse({ ...minimal, OAUTH_DYNAMIC_CLIENT_REGISTRATION: 'false' })
        .OAUTH_DYNAMIC_CLIENT_REGISTRATION
    ).toBe(false);
    expect(envSchema.parse(minimal).HSTS_MAX_AGE).toBe(15552000);
    expect(envSchema.parse({ ...minimal, HSTS_MAX_AGE: '' }).HSTS_MAX_AGE).toBe(15552000);
    expect(envSchema.parse({ ...minimal, HSTS_MAX_AGE: '0' }).HSTS_MAX_AGE).toBe(0);
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

  it('defaults VIEW_DEDUPE_WINDOW_MINUTES to 10 and keeps 0 as the conscious opt-out', () => {
    expect(envSchema.parse(minimal).VIEW_DEDUPE_WINDOW_MINUTES).toBe(10);
    // `VAR=` / whitespace in compose means "default", never "coerce to 0
    // and silently disable de-dupe".
    expect(envSchema.parse({ ...minimal, VIEW_DEDUPE_WINDOW_MINUTES: '' }).VIEW_DEDUPE_WINDOW_MINUTES).toBe(
      10
    );
    expect(envSchema.parse({ ...minimal, VIEW_DEDUPE_WINDOW_MINUTES: ' ' }).VIEW_DEDUPE_WINDOW_MINUTES).toBe(
      10
    );
    expect(envSchema.parse({ ...minimal, VIEW_DEDUPE_WINDOW_MINUTES: '0' }).VIEW_DEDUPE_WINDOW_MINUTES).toBe(
      0
    );
    expect(envSchema.safeParse({ ...minimal, VIEW_DEDUPE_WINDOW_MINUTES: '-1' }).success).toBe(false);
  });

  describe('edition split (internal/federation.md)', () => {
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
        clientSecret: hubVars.HUB_CLIENT_SECRET,
        hintCookieName: 'ant_sso_hint',
        hintCookieDomain: 'antasphere.com'
      });
    });

    it('derives the hint-cookie defaults: name ant_sso_hint, domain = issuer host minus its first label', () => {
      const env = envSchema.parse({
        ...minimal,
        EDITION: 'cloud',
        ...hubVars,
        HUB_ISSUER_URL: 'https://account.antasphere.com'
      });
      const hub = hubConfig(env)!;
      expect(hub.hintCookieName).toBe('ant_sso_hint');
      expect(hub.hintCookieDomain).toBe('antasphere.com');
      // A single-label issuer host has no parent to strip to — fall back to
      // the host itself rather than an empty cookie domain.
      const single = hubConfig(
        envSchema.parse({ ...minimal, EDITION: 'cloud', ...hubVars, HUB_ISSUER_URL: 'http://localhost:3300' })
      )!;
      expect(single.hintCookieDomain).toBe('localhost');
    });

    it('HUB_HINT_COOKIE_NAME/DOMAIN override the derived defaults (blank = unset)', () => {
      const env = envSchema.parse({
        ...minimal,
        EDITION: 'cloud',
        ...hubVars,
        HUB_HINT_COOKIE_NAME: 'custom_hint',
        HUB_HINT_COOKIE_DOMAIN: 'example.test'
      });
      const hub = hubConfig(env)!;
      expect(hub.hintCookieName).toBe('custom_hint');
      expect(hub.hintCookieDomain).toBe('example.test');
      const blank = hubConfig(
        envSchema.parse({ ...minimal, EDITION: 'cloud', ...hubVars, HUB_HINT_COOKIE_NAME: ' ' })
      )!;
      expect(blank.hintCookieName).toBe('ant_sso_hint');
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
