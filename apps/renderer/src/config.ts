import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { isLogLevel, type LogLevel } from './log.js';

/**
 * The renderer's environment, read and checked by hand (no schema library in
 * this image). A bad value refuses the boot with one readable line per
 * problem.
 */
export interface RendererConfig {
  /** Where the renderer reaches Slideless: an http(s) origin, with an optional path prefix, no trailing slash. */
  slidelessUrl: string;
  /** What Slideless presents on `POST /capture`. Never logged. */
  secret: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  chromiumPath: string;
  queueDepth: number;
  captureTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`the renderer's environment is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/**
 * playwright-core's headless shell beside its full Chromium when it is there
 * (`<browsers>/chromium-<rev>/…` → `<browsers>/chromium_headless_shell-<rev>/*`):
 * a capture there takes about a second, several with the full Chrome.
 */
export function headlessShellBeside(fullChrome: string): string | null {
  const m = /^(.*)[/\\]chromium-(\d+)[/\\]/.exec(fullChrome);
  if (!m) return null;
  const root = join(m[1]!, `chromium_headless_shell-${m[2]}`);
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    for (const name of ['chrome-headless-shell', 'headless_shell']) {
      const candidate = join(root, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function defaultChromiumPath(): string | null {
  try {
    const full = chromium.executablePath();
    return headlessShellBeside(full) ?? full;
  } catch {
    // playwright-core throws when it knows no browser for this platform.
    return null;
  }
}

/** The Chromium the renderer launches, or the problem that stops the boot. */
export function readChromiumPath(env: Env): { path: string } | { problem: string } {
  const set = env.RENDERER_CHROMIUM_PATH?.trim();
  const path = set || defaultChromiumPath();
  if (!path)
    return { problem: 'RENDERER_CHROMIUM_PATH is not set and playwright-core knows no Chromium here' };
  if (!existsSync(path)) {
    return {
      problem: set
        ? `RENDERER_CHROMIUM_PATH points at ${path}, which does not exist`
        : `no Chromium at ${path} (set RENDERER_CHROMIUM_PATH, or run playwright-core install chromium-headless-shell)`
    };
  }
  return { path };
}

function int(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
    return fallback;
  }
  return n;
}

export function loadConfig(env: Env = process.env): RendererConfig {
  const problems: string[] = [];

  let slidelessUrl = '';
  const rawUrl = env.SLIDELESS_URL?.trim();
  if (!rawUrl) {
    problems.push('SLIDELESS_URL is required: where the renderer reaches Slideless (e.g. http://app:3000)');
  } else {
    let u: URL | null = null;
    try {
      u = new URL(rawUrl);
    } catch {
      problems.push(`SLIDELESS_URL is not a URL (got "${rawUrl}")`);
    }
    if (u) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        problems.push(`SLIDELESS_URL must be http or https (got ${u.protocol})`);
      } else if (u.username || u.password || u.search || u.hash) {
        problems.push('SLIDELESS_URL must carry no credentials, query or fragment');
      } else {
        slidelessUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
      }
    }
  }

  const secret = env.SLIDELESS_RENDERER_SECRET ?? '';
  if (!secret)
    problems.push('SLIDELESS_RENDERER_SECRET is required: the secret Slideless presents on POST /capture');
  else if (secret.length < 16) problems.push('SLIDELESS_RENDERER_SECRET must be 16 characters or more');

  const port = int(env, 'PORT', 3100, 1, 65_535, problems);
  const host = env.HOST?.trim() || '0.0.0.0';

  const rawLevel = env.LOG_LEVEL?.trim() || 'info';
  let logLevel: LogLevel = 'info';
  if (isLogLevel(rawLevel)) logLevel = rawLevel;
  else problems.push(`LOG_LEVEL must be one of debug, info, warn, error (got "${rawLevel}")`);

  const chromium = readChromiumPath(env);
  if ('problem' in chromium) problems.push(chromium.problem);

  const queueDepth = int(env, 'RENDERER_QUEUE_DEPTH', 4, 1, 64, problems);
  const captureTimeoutMs = int(env, 'RENDERER_CAPTURE_TIMEOUT_MS', 20_000, 1_000, 300_000, problems);

  if (problems.length) throw new ConfigError(problems);
  return {
    slidelessUrl,
    secret,
    port,
    host,
    logLevel,
    chromiumPath: (chromium as { path: string }).path,
    queueDepth,
    captureTimeoutMs
  };
}
