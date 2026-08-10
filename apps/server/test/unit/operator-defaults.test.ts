import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The shipped operator surface — compose port binds, .gitignore, setup.sh,
 * update.sh, install.sh, the DR scripts — is code that runs on every
 * self-hosted instance, and it is the only part of the product no test used
 * to touch. These assertions pin the defaults that were wrong (PLT-10, OPS-5,
 * A8/PLT-11) so a later edit cannot quietly put them back.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * Every `host:container` mapping published by a compose file, with the host
 * interface it binds. A two-part mapping (`3000:3000`) has no host IP, which
 * docker resolves to 0.0.0.0 — reachable from the internet.
 */
function publishedPorts(yaml: string): Array<{ raw: string; bind: string | null }> {
  const out: Array<{ raw: string; bind: string | null }> = [];
  const lines = yaml.split('\n');
  let inPorts = false;
  let portsIndent = 0;
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (!inPorts) continue;
    const item = /^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (!item || indent <= portsIndent) {
      if (line.trim() !== '') inPorts = false;
      if (!item) continue;
    }
    const raw = item[1]!;
    // Split on the mapping colons only: `${APP_PORT:-3000}` carries colons of
    // its own, so scan and skip whatever sits inside an interpolation.
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === '$' && raw[i + 1] === '{') depth++;
      else if (ch === '}' && depth > 0) depth--;
      if (ch === ':' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);
    out.push({ raw, bind: parts.length >= 3 ? parts.slice(0, parts.length - 2).join(':') : null });
  }
  return out;
}

/** 127.0.0.0/8, ::1, or a `${VAR:-<loopback>}` default. */
function isLoopbackBind(bind: string | null): boolean {
  if (bind === null) return false;
  const templated = /^\$\{[A-Za-z0-9_]+:-([^}]*)\}$/.exec(bind);
  const value = templated ? templated[1]! : bind;
  return /^127(\.\d{1,3}){3}$/.test(value) || value === '::1' || value === 'localhost';
}

describe('PLT-10 — compose publishes on loopback by default', () => {
  const composeFiles = readdirSync(repoRoot).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));

  it('has compose files to check', () => {
    expect(composeFiles).toContain('docker-compose.yml');
  });

  it.each(composeFiles)('%s binds every published port to loopback', (file) => {
    const ports = publishedPorts(read(file));
    for (const { raw, bind } of ports) {
      // Docker publishes ports with DNAT rules evaluated BEFORE ufw's INPUT
      // chain, so a 0.0.0.0 bind is internet-reachable no matter what the
      // documented firewall step says. The bind address is the only control
      // that holds. Deliberate exposure is APP_BIND=0.0.0.0 in .env.
      expect(isLoopbackBind(bind), `${file}: "${raw}" publishes on ${bind ?? '0.0.0.0'}`).toBe(true);
    }
  });

  it('the app port is operator-overridable without editing the compose file', () => {
    expect(read('docker-compose.yml')).toContain("'${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}:3000'");
  });
});

describe('A8/PLT-11 — backup artifacts are not committable and not world-readable', () => {
  it('git ignores backups/ and .claude/', () => {
    // The real acceptance check, run against real git.
    const matched = execFileSync('git', ['check-ignore', 'backups', '.claude'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
      .trim()
      .split('\n');
    expect(matched).toContain('backups');
    expect(matched).toContain('.claude');
  });

  it('backup.sh sets umask 077 before writing anything', () => {
    const sh = read('scripts/backup.sh');
    const umask = sh.indexOf('umask 077');
    expect(umask, 'backup.sh must set umask 077').toBeGreaterThan(-1);
    // …and before the first artifact is created, or there is a 0644 window.
    expect(umask).toBeLessThan(sh.indexOf('pg_dump'));
  });

  it('backup.sh chmods every artifact it produces (the tar runs under the image umask)', () => {
    const sh = read('scripts/backup.sh');
    for (const artifact of ['db-$STAMP.sql.gz', 'data-$STAMP.tar.gz', 'config-$STAMP.tar.gz.enc']) {
      expect(sh, artifact).toContain(`chmod 600 "$BACKUP_DIR/${artifact}"`);
    }
  });

  // "No cleartext .env in any produced backup" (PRDCT-1348) is pinned
  // BEHAVIORALLY — a real backup.sh run under a stubbed docker, scanned for
  // secret canaries — in backup-script.test.ts, not as a string assertion
  // here: a string can stay green through a behaviorally identical
  // regression (different tar spelling, cp, another extension).

  it('BACKUP_DIR defaults outside the checkout in both DR scripts', () => {
    for (const script of ['scripts/backup.sh', 'scripts/restore.sh']) {
      const sh = read(script);
      expect(sh, script).toMatch(/BACKUP_DIR="\$\{BACKUP_DIR:-\/var\/backups\//);
      expect(sh, `${script} must not default into the repo`).not.toContain('BACKUP_DIR:-./backups');
    }
  });

  it('backup.sh can encrypt the config archive, which holds AUTH_SECRET', () => {
    const sh = read('scripts/backup.sh');
    expect(sh).toContain('BACKUP_PASSPHRASE');
    expect(sh).toMatch(/openssl enc -aes-256-cbc -pbkdf2/);
    // The passphrase must never reach argv or the process environment.
    expect(sh).toContain('-pass fd:3');
    expect(sh).not.toMatch(/-pass\s+(env|pass):/);
  });
});

describe('PLT-12 — restore.sh verifies before it destroys', () => {
  const sh = read('scripts/restore.sh');
  // The straight-line script, i.e. everything after the failure handler is
  // installed. The handler itself legitimately drops the scratch database.
  const body = sh.slice(sh.indexOf('trap on_exit EXIT'));

  it('runs psql with ON_ERROR_STOP=1 everywhere, so a partial replay cannot exit 0', () => {
    const psqlCalls = sh.match(/docker compose exec -T db psql[^\n]*/g) ?? [];
    expect(psqlCalls.length).toBeGreaterThan(0);
    for (const call of psqlCalls) expect(call, call).toContain('-v ON_ERROR_STOP=1');
  });

  it('verifies every archive BEFORE the first destructive command', () => {
    // EVERY archive, named individually. A `Math.max` over the two lookups
    // was a false green: deleting the /data verification left the dump's
    // lookup to satisfy the ordering, so an empty or corrupt tarball would
    // have been extracted over a /data that had just been swapped away.
    const dumpVerified = body.indexOf('dr_verify_pg_dump "$DB_DUMP"');
    const dataVerified = body.indexOf('dr_verify_tar "$DATA_TAR"');
    expect(dumpVerified, 'the database dump must be verified').toBeGreaterThan(-1);
    expect(dataVerified, 'the /data tarball must be verified').toBeGreaterThan(-1);
    const verified = Math.max(dumpVerified, dataVerified);
    for (const destructive of ['docker compose stop app', 'DROP DATABASE', 'ALTER DATABASE']) {
      expect(body.indexOf(destructive), destructive).toBeGreaterThan(verified);
    }
  });

  it('asks for confirmation only after the archives have been proven readable', () => {
    const dataVerified = body.indexOf('dr_verify_tar "$DATA_TAR"');
    expect(dataVerified).toBeGreaterThan(-1);
    expect(body.indexOf("Type 'restore' to continue")).toBeGreaterThan(dataVerified);
  });

  it('loads into a scratch database and swaps, instead of dropping the live one first', () => {
    expect(sh).toContain('SCRATCH_DB=');
    expect(sh).toMatch(/ALTER DATABASE .*RENAME TO/);
    // The pre-restore database survives the swap under a _prev_ name.
    expect(sh).toContain('PREV_DB=');
    // No DROP of the live database anywhere.
    expect(sh).not.toMatch(/DROP DATABASE IF EXISTS \\?"?\$DB_NAME/);
  });

  it('asserts constraints and row counts against the scratch database', () => {
    expect(sh).toContain('pg_constraint');
    expect(sh).toContain('convalidated');
    expect(sh).toMatch(/row counts do not match the dump/);
  });

  /**
   * The row-count query is BUILT by interpolating a table identifier that
   * came out of the backup file's own COPY header. A crafted dump could
   * otherwise carry a statement into a psql running as the database owner —
   * the one place in this script where file content reaches SQL.
   */
  it('pins the identifier taken from the dump before it reaches the SQL it builds', () => {
    const guard = sh.indexOf('*[!A-Za-z0-9_.\\"]*) dr_fail "unexpected table identifier in dump');
    expect(guard, 'the COPY-header identifier must be shape-checked').toBeGreaterThan(-1);
    expect(sh.indexOf('(SELECT count(*) FROM $tbl)'), 'checked BEFORE interpolation').toBeGreaterThan(guard);
  });

  it('installs a trap that brings the previous instance back up on failure', () => {
    expect(sh).toContain('trap on_exit EXIT');
    const handler = sh.slice(sh.indexOf('on_exit() {'), sh.indexOf('trap on_exit EXIT'));
    // A COMMAND, not the same text quoted inside the fallback warning. A plain
    // `toContain` was a false green: replacing the restart with `true` left the
    // dr_warn string "…run: docker compose up -d app" behind and the test
    // passed while the handler no longer restarted anything.
    const restart = handler.split('\n').find((line) => /^\s*docker compose up -d app\b/.test(line));
    expect(restart, 'the handler must RUN the restart, not merely mention it').toBeTruthy();
    expect(handler, 'must roll the database swap back').toMatch(/RENAME TO/);
    expect(handler, 'must roll the /data swap back').toContain('.restore-old');
  });

  it('restores the pepper material from the config archive (OPS-1)', () => {
    expect(sh).toContain('dr_merge_pepper_env');
    // …and refuses by default when the archive that carries it is missing.
    expect(sh).toMatch(/no config archive for \$STAMP/);
  });

  /**
   * OPS-1 has two shapes, because AUTH_SECRET is OPTIONAL: unset, the server
   * generates one into $DATA_DIR/secret and reuses it forever. Merging the
   * archived .env covers only the first shape. On the second, setup.sh's
   * freshly generated AUTH_SECRET in the live .env SHADOWS the pepper root
   * that just came back inside the data volume — an env value always beats
   * the file — and the instance boots, reports ready, and resolves none of its
   * credentials.
   */
  it('works out where the pepper root actually is, before anything is destroyed', () => {
    expect(sh).toContain('PEPPER_SOURCE');
    expect(sh).toContain('dr_tar_has_entry "$DATA_TAR" secret');
    const decided = sh.indexOf('PEPPER_SOURCE=data_volume');
    expect(decided).toBeGreaterThan(-1);
    for (const destructive of ['docker compose stop app', 'ALTER DATABASE']) {
      expect(body.indexOf(destructive), destructive).toBeGreaterThan(
        body.indexOf('PEPPER_SOURCE=data_volume')
      );
    }
  });

  it('stops the live .env from shadowing a pepper root restored inside /data', () => {
    const branch = sh.slice(sh.indexOf('  data_volume)'), sh.indexOf('  none)'));
    expect(branch).toContain('dr_env_unset .env AUTH_SECRET');
  });

  it('refuses a backup that carries no pepper root at all, unless --no-config', () => {
    expect(sh).toMatch(/if \[ "\$PEPPER_SOURCE" = none \] && \[ "\$REQUIRE_CONFIG" = 1 \]; then/);
    expect(sh).toMatch(/carries no pepper root/);
  });

  /**
   * The rollback has to put the .env back too. Rolling the DATABASE back to
   * the pre-restore state while leaving the BACKUP's AUTH_SECRET in .env
   * recreates OPS-1 pointed the other way: the instance that was working five
   * minutes ago comes back peppered with the wrong secret and every one of
   * its API keys, share links and edit secrets stops resolving. The pepper
   * and the database are one unit.
   */
  it('rolls the .env pepper merge back together with the database (OPS-1 on the failure path)', () => {
    const handler = sh.slice(sh.indexOf('on_exit() {'), sh.indexOf('trap on_exit EXIT'));
    expect(handler, 'the handler must restore the pre-merge .env').toMatch(/ENV_MERGED/);
    expect(handler).toMatch(/> \.env/);
    // …from a snapshot taken BEFORE the merge, not after it.
    const snapshot = sh.indexOf('ENV_BACKUP="$WORKDIR/.env.pre-restore"');
    expect(snapshot, 'restore.sh must snapshot .env before merging').toBeGreaterThan(-1);
    expect(sh.indexOf('dr_merge_pepper_env')).toBeGreaterThan(snapshot);
    // …and the snapshot has to outlive the WORKDIR cleanup, which used to be
    // the first thing the handler did.
    expect(handler.indexOf('ENV_MERGED')).toBeLessThan(handler.lastIndexOf('rm -rf "$WORKDIR"'));
    // The app must come back up only after the .env is correct again.
    expect(handler.indexOf('docker compose up -d app')).toBeGreaterThan(handler.indexOf('ENV_MERGED'));
  });

  it('never extracts the data tarball over a pre-emptied /data', () => {
    expect(sh, 'the old `rm -rf /data/*` then extract was the whole problem').not.toMatch(
      /rm -rf \/data\/\*/
    );
    expect(sh).toContain('/data/.restore-new');
  });
});

describe('OPS-5 — a custom APP_PORT survives setup and upgrade', () => {
  it('setup.sh writes APP_PORT and APP_BIND into the generated .env', () => {
    const sh = read('setup.sh');
    const generated = sh.slice(sh.indexOf('cat > .env <<EOF'), sh.indexOf('\nEOF'));
    expect(generated).toContain('APP_PORT=${APP_PORT}');
    expect(generated).toContain('APP_BIND=${APP_BIND}');
  });

  it('setup.sh backfills them into a pre-existing .env instead of silently moving the port', () => {
    const sh = read('setup.sh');
    expect(sh).toMatch(/APP_PORT=\$\{APP_PORT\}" "APP_BIND=\$\{APP_BIND\}/);
  });

  it('setup.sh leaves the generated .env at 0600 — it holds the pepper root', () => {
    expect(read('setup.sh')).toMatch(/^\s*chmod 600 \.env$/m);
  });

  it('update.sh reads the port from .env and never hardcodes localhost:3000', () => {
    const sh = read('update.sh');
    expect(sh).not.toContain('localhost:3000');
    expect(sh).toContain('dr_env_get .env APP_PORT');
    expect(sh).toContain('$BASE/readyz');
  });
});

describe('PLT-10 — install.sh does not walk the operator into plaintext exposure', () => {
  const sh = read('install.sh');

  it('opens the app port in the firewall ONLY behind the explicit --expose-port opt-in', () => {
    expect(sh).toContain('--expose-port');
    // Scoped to the firewall block, and matched against the IMMEDIATELY
    // enclosing conditional. Searching the whole file for the guard text was a
    // false green: `lastIndexOf('if [ "$EXPOSE_PORT" = 1 ]; then')` happily
    // matched the `if` inside the unrelated `elif` in the setup block above,
    // so replacing the real guard with `if true` still passed.
    const firewall = sh.slice(sh.indexOf('# 4. Firewall'), sh.indexOf('success "install complete"'));
    const lines = firewall.split('\n');
    const ruleAt = lines.findIndex((l) => /ufw allow "\$APP_PORT"\/tcp/.test(l));
    expect(ruleAt, 'the app port must still be openable, deliberately').toBeGreaterThan(0);
    const guard = [...lines.slice(0, ruleAt)].reverse().find((l) => /^\s*(el)?if\s/.test(l));
    expect(guard, 'the ufw rule must sit inside the --expose-port branch').toMatch(
      /EXPOSE_PORT["']?\s*=\s*1/
    );
    expect(firewall.indexOf('ufw --force enable')).toBeGreaterThan(
      firewall.indexOf('ufw allow "$APP_PORT"/tcp')
    );
  });

  it('never tells the operator to finish setup over plaintext on the default path', () => {
    const noDomainTail = sh.slice(sh.lastIndexOf('success "install complete"'));
    const defaultBranch = noDomainTail.slice(noDomainTail.lastIndexOf('else'));
    expect(defaultBranch).toContain('ssh -N -L');
    expect(defaultBranch).not.toMatch(/open http:\/\/<server-ip>/);
  });

  it('passes an explicit loopback bind to setup.sh on both non-exposed paths', () => {
    expect(sh.match(/APP_BIND=127\.0\.0\.1/g) ?? []).toHaveLength(2);
    expect(sh).toContain('APP_BIND=0.0.0.0 ALLOW_INSECURE_SETUP=true');
  });

  /**
   * `hostname -I` is Linux-only and prints nothing on a host with no
   * non-loopback address. Interpolated unguarded it produced
   * PUBLIC_BASE_URL="http://:3000", which fails the server's env schema — the
   * stack comes up and crash-loops with nothing pointing at the cause.
   */
  it('refuses --expose-port rather than building an empty-host PUBLIC_BASE_URL', () => {
    const ip = sh.indexOf('hostname -I');
    expect(ip).toBeGreaterThan(-1);
    const guard = sh.indexOf('[ -n "$HOST_IP" ] ||', ip);
    expect(guard, 'an empty host must fail, not be interpolated').toBeGreaterThan(ip);
    expect(sh.indexOf('PUBLIC_BASE_URL="http://$HOST_IP:$APP_PORT"')).toBeGreaterThan(guard);
    expect(sh, 'never interpolate the command substitution straight into the URL').not.toMatch(
      /PUBLIC_BASE_URL="http:\/\/\$\(hostname/
    );
  });
});

/**
 * PLT-10 — setup.sh must not re-implement the transport rule by hand. The
 * first version did (`http://localhost*`) and therefore stayed silent for
 * `http://localhost.evil.test`, the exact class of origin the finding is
 * about. It now calls dr_origin_is_secure, which is tested against the same
 * URL table as the server's isSecureSetupOrigin.
 */
describe('setup.sh asks the shared rule instead of pattern-matching the URL', () => {
  const sh = read('setup.sh');

  it('sources dr-lib.sh and calls dr_origin_is_secure', () => {
    expect(sh).toContain('scripts/lib/dr-lib.sh');
    expect(sh).toContain('dr_origin_is_secure "$PUBLIC_BASE_URL"');
  });

  it('carries no hand-rolled loopback prefix match', () => {
    expect(sh).not.toContain('http://localhost*');
    expect(sh).not.toContain('http://127.0.0.1*');
  });

  it('still tells the operator the tunnel command and the opt-in', () => {
    expect(sh).toContain('ssh -N -L ${APP_PORT}:127.0.0.1:${APP_PORT}');
    expect(sh).toContain('ALLOW_INSECURE_SETUP=true');
  });
});
