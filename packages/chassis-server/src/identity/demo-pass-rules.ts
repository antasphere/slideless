import { isLoopbackHost } from '../setup-transport.js';

/**
 * The demo pass's pure rules (the demo pass spec, sections 1 to 3): which
 * hosts the switch may be on, which addresses a pass may open, and which
 * paths a pass may land on. No I/O here, so the env schema, the mint route
 * and the redeem endpoint all judge through the same functions.
 *
 * A demo pass is a sign-in-equivalent link an owner hands out for a
 * demonstration. What keeps it from being a takeover tool is the narrowness
 * of these rules: the switch refuses to boot on a public host nobody named,
 * and a pass only ever opens an address on a domain reserved for examples
 * and tests (RFC 2606 / RFC 6761) or one the operator named on purpose.
 */

/** A pass's lifetime when the mint names none: one day. */
export const DEMO_PASS_DEFAULT_MINUTES = 1440;
/** The longest lifetime a mint may ask for: one week. */
export const DEMO_PASS_MAX_MINUTES = 10080;
/** The longest target path a pass may carry. */
export const DEMO_PASS_MAX_PATH_LENGTH = 2048;

/** The second-level domains reserved for documentation (RFC 2606 §3); their subdomains too. */
const RESERVED_EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;
/** The top-level names reserved for testing and examples (RFC 2606 §2, RFC 6761). */
const RESERVED_TOP_LABELS = new Set(['test', 'example', 'invalid', 'localhost']);

/** One DNS label as the lists accept it: letters, digits and hyphens, lowercased. */
const LABEL_RE = /^[a-z0-9-]+$/;

/**
 * Why one list entry is not a bare hostname, or null when it is. Checked in
 * the order an operator's typo most likely takes: a pasted URL, a port, a
 * wildcard. A refusal names the entry so the boot table says which one.
 */
function entryProblem(entry: string): string | null {
  if (/\s/.test(entry)) return 'contains a space';
  if (entry.includes('://')) return 'carries a scheme (list the bare hostname)';
  if (entry.includes('/')) return 'carries a path (list the bare hostname)';
  if (entry.includes(':')) return 'carries a port (list the bare hostname)';
  if (entry.includes('*')) return 'is a wildcard (list each hostname exactly)';
  const labels = entry.split('.');
  if (labels.some((label) => label.length === 0)) return 'has an empty label';
  if (labels.some((label) => !LABEL_RE.test(label))) return 'is not a hostname';
  return null;
}

/**
 * Parse one comma-separated list of hostnames into a lowercased set. Unset
 * or blank is the empty set; a list that is only separators, or any entry
 * that is not a bare hostname, THROWS, so the env schema refuses the boot:
 * a typo must never silently widen (or silently empty) the list.
 */
function parseHostList(variable: string, raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (raw === undefined || raw.trim() === '') return set;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error(`${variable} must list at least one hostname`);
  for (const entry of entries) {
    const lowered = entry.toLowerCase();
    const problem = entryProblem(lowered);
    if (problem) throw new Error(`${variable} entry "${entry}" ${problem}`);
    set.add(lowered);
  }
  return set;
}

/** `DEMO_SIGN_IN_HOSTS`: the public hosts the switch may be on, beside loopback. Exact match. */
export function parseDemoHosts(raw: string | undefined): ReadonlySet<string> {
  return parseHostList('DEMO_SIGN_IN_HOSTS', raw);
}

/** `DEMO_SIGN_IN_EMAIL_DOMAINS`: the domains the operator adds to the reserved ones (subdomains included). */
export function parseDemoEmailDomains(raw: string | undefined): ReadonlySet<string> {
  return parseHostList('DEMO_SIGN_IN_EMAIL_DOMAINS', raw);
}

/**
 * The boot rule: the switch may be on only where the host of PUBLIC_BASE_URL
 * is loopback (the same test the setup wizard uses, never a second copy) or
 * listed, exactly, in `DEMO_SIGN_IN_HOSTS`. An unparseable URL fails closed.
 */
export function isDemoSignInHost(publicBaseUrl: string, hosts: ReadonlySet<string>): boolean {
  let hostname: string;
  try {
    hostname = new URL(publicBaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return isLoopbackHost(hostname) || hosts.has(hostname);
}

/** `domain` equals `parent` or sits under it, on a label boundary. */
function isDomainOrSubdomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Who a pass may open (spec section 2): an address whose domain (the part
 * after the LAST `@`, lowercased) is a reserved example domain or under one,
 * ends in a reserved top-level name, or is an operator-listed domain or under
 * one. Matching is on label boundaries, so `notexample.com` and
 * `example.com.evil.io` are refused. A domain with an empty label is refused
 * outright: it is no mailbox anybody holds.
 */
export function isDemoAddress(email: string, extraDomains: ReadonlySet<string>): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  const labels = domain.split('.');
  if (labels.some((label) => label.length === 0)) return false;
  if (RESERVED_TOP_LABELS.has(labels[labels.length - 1]!)) return true;
  if (RESERVED_EXAMPLE_DOMAINS.some((parent) => isDomainOrSubdomain(domain, parent))) return true;
  for (const parent of extraDomains) {
    if (isDomainOrSubdomain(domain, parent)) return true;
  }
  return false;
}

/**
 * The page a pass lands on (spec section 3): one leading `/` and never `//`
 * or `/\` (both resolve to another origin in a browser, LESSONS.md M8), no
 * control character, space or DEL, no fragment, at most 2048 characters. The
 * server checks it at mint; the dashboard still passes it through `safeNext`.
 */
export function isSafeDemoPath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.length < 1 || path.length > DEMO_PASS_MAX_PATH_LENGTH) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) return false;
  }
  return !path.includes('#');
}
