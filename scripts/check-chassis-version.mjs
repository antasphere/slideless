#!/usr/bin/env node
// The chassis is a DEPENDENCY. `@antasphere/chassis-cli`, `-contract`, `-db`, `-sdk`
// and `-server` come from the registry at one exact version, the same for every
// package of this workspace, and a tool never edits them: a change the tool needs
// inside the chassis is a chassis change, made in the chassis repository and
// published, then taken here by moving the pin.
//
//   node scripts/check-chassis-version.mjs     (pnpm chassis:check) fails, with a named reason, when the pin is broken
//
// Nothing stops a hand from editing a file under node_modules or pointing the
// dependency somewhere else, so this check is what keeps "never edited" true by
// construction. It refuses the ways around the registry, each under its own reason:
//
//   pin        a package.json declares a chassis package with anything but the one exact version
//              (a range, `workspace:`, `link:`, `file:`, a git url, or two different versions)
//   lockfile   pnpm-lock.yaml resolves a chassis package to another version, or without the
//              registry's integrity (a tarball, a directory or a link means the registry was bypassed)
//   patch      pnpm-workspace.yaml, package.json or the lockfile patches or overrides a chassis package
//   copy       a `packages/chassis-*` folder or `chassis-source.json` is back: the chassis as copies
//   installed  node_modules holds a chassis package at another version than the pin
//
// Node builtins only: the lockfile is read line by line, by its indentation.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.CHASSIS_CHECK_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@antasphere/chassis-';
const CHASSIS = ['cli', 'contract', 'db', 'sdk', 'server'].map((name) => `${SCOPE}${name}`);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const failures = [];
const fail = (reason, message) => failures.push(`chassis: ${reason}: ${message}`);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const unquote = (text) =>
  text
    .trim()
    .replace(/^'(.*)'$/, '$1')
    .replace(/^"(.*)"$/, '$1');
const indentOf = (line) => line.length - line.trimStart().length;

// The workspace packages: the root, apps/* and packages/*.
function workspacePackages() {
  const dirs = [root];
  for (const parent of ['apps', 'packages']) {
    const abs = join(root, parent);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      const dir = join(abs, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.map((dir) => ({ dir, file: relative(root, join(dir, 'package.json')) || 'package.json' }));
}

// The top-level block of a YAML file under `key:`, as its lines (the rest of the key's own line included).
function yamlBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return [];
  const block = [lines[start].slice(key.length + 1)];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) === 0 && !line.startsWith('#')) break;
    block.push(line);
  }
  return block;
}

// The pin: every declaration in every workspace package.json.
function readDeclarations(packages) {
  const declarations = [];
  for (const { dir, file } of packages) {
    const manifest = readJson(join(dir, 'package.json'));
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith(SCOPE)) declarations.push({ dir, file, name, spec });
      }
    }
  }
  return declarations;
}

function checkPin(declarations) {
  if (declarations.length === 0) {
    fail('pin', `no workspace package declares a ${SCOPE}* dependency`);
    return undefined;
  }
  for (const { file, name, spec } of declarations) {
    if (!CHASSIS.includes(name)) fail('pin', `${file} declares ${name}, which is not a chassis package`);
    if (!EXACT.test(spec)) {
      fail('pin', `${file} declares ${name} as "${spec}", not an exact version from the registry`);
    }
  }
  const versions = [...new Set(declarations.map((d) => d.spec))];
  if (versions.length > 1) {
    fail('pin', `the workspace declares the chassis at ${versions.length} versions (${versions.join(', ')})`);
  }
  return EXACT.test(versions[0]) && versions.length === 1 ? versions[0] : undefined;
}

// The lockfile: each importer's specifier and version, each package entry's resolution,
// each snapshot's chassis dependencies.
function checkLockfile(declarations, pin) {
  const file = join(root, 'pnpm-lock.yaml');
  if (!existsSync(file)) {
    fail('lockfile', 'pnpm-lock.yaml is missing');
    return;
  }
  const text = readFileSync(file, 'utf8');

  // importers:  <2>importer  <4>dependencies  <6>name  <8>specifier / version
  let importer;
  let dependency;
  const seen = new Set();
  for (const line of yamlBlock(text, 'importers')) {
    const indent = indentOf(line);
    const content = line.trim();
    if (content === '') continue;
    if (indent === 2) importer = unquote(content.replace(/:$/, ''));
    else if (indent === 6) dependency = unquote(content.replace(/:$/, ''));
    else if (indent === 8 && dependency?.startsWith(SCOPE)) {
      const [, key, value] = /^(\w+):\s*(.*)$/.exec(content) ?? [];
      const where = `pnpm-lock.yaml importer ${importer} ${dependency}`;
      seen.add(`${importer === '.' ? '' : importer}|${dependency}`);
      if (key === 'specifier' && unquote(value) !== pin) {
        fail('lockfile', `${where} has specifier ${unquote(value)}, not ${pin}`);
      }
      if (key === 'version' && !isPinned(unquote(value), pin)) {
        fail('lockfile', `${where} resolves to ${unquote(value)}, not ${pin} from the registry`);
      }
    }
  }
  for (const { dir, name } of declarations) {
    const id = `${relative(root, dir)}|${name}`;
    if (!seen.has(id)) {
      fail('lockfile', `pnpm-lock.yaml has no entry for ${name} in ${relative(root, dir) || '.'}`);
    }
  }

  // packages:  <2>'name@version':  <4>resolution: {integrity: ...}
  const resolved = new Map();
  let entry;
  for (const line of yamlBlock(text, 'packages')) {
    const indent = indentOf(line);
    const content = line.trim();
    if (indent === 2 && content.endsWith(':')) {
      const key = unquote(content.slice(0, -1));
      entry = key.startsWith(SCOPE) ? key : undefined;
      if (entry) resolved.set(entry, '');
    } else if (entry && indent === 4 && content.startsWith('resolution:')) {
      resolved.set(entry, content);
    }
  }
  for (const [key, resolution] of resolved) {
    const at = key.lastIndexOf('@');
    const version = key.slice(at + 1);
    if (version !== pin) fail('lockfile', `pnpm-lock.yaml holds ${key}, not version ${pin}`);
    if (!/\bintegrity:/.test(resolution) || /\b(tarball|directory|repo|type):/.test(resolution)) {
      fail(
        'lockfile',
        `pnpm-lock.yaml resolves ${key} without the registry's integrity (${resolution || 'none'})`
      );
    }
  }
  for (const name of new Set(declarations.map((d) => d.name))) {
    if (!resolved.has(`${name}@${pin}`)) {
      fail('lockfile', `pnpm-lock.yaml has no package entry ${name}@${pin}`);
    }
  }

  // snapshots:  <6>'name': version   (a chassis package depending on another)
  for (const line of yamlBlock(text, 'snapshots')) {
    const match = /^\s{6}'?(@antasphere\/chassis-[a-z]+)'?:\s*(\S+)/.exec(line);
    if (match && !isPinned(unquote(match[2]), pin)) {
      fail('lockfile', `pnpm-lock.yaml snapshot depends on ${match[1]} at ${match[2]}, not ${pin}`);
    }
  }
}

// `1.0.0` or `1.0.0(peer@x)`: the pinned version from the registry, peers resolved.
function isPinned(version, pin) {
  return version === pin || version.startsWith(`${pin}(`);
}

function checkPatches() {
  const sources = [
    ['pnpm-workspace.yaml', ['overrides', 'patchedDependencies']],
    ['pnpm-lock.yaml', ['overrides', 'patchedDependencies']]
  ];
  for (const [name, keys] of sources) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const key of keys) {
      for (const line of yamlBlock(text, key)) {
        if (line.includes(SCOPE)) fail('patch', `${name} ${key} names a chassis package: ${line.trim()}`);
      }
    }
  }
  const manifest = readJson(join(root, 'package.json'));
  const blocks = {
    overrides: manifest.overrides,
    resolutions: manifest.resolutions,
    'pnpm.overrides': manifest.pnpm?.overrides,
    'pnpm.patchedDependencies': manifest.pnpm?.patchedDependencies
  };
  for (const [key, block] of Object.entries(blocks)) {
    if (block && JSON.stringify(block).includes(SCOPE)) {
      fail('patch', `package.json ${key} names a chassis package`);
    }
  }
}

function checkCopies() {
  const packages = join(root, 'packages');
  if (existsSync(packages)) {
    for (const name of readdirSync(packages).sort()) {
      if (name.startsWith('chassis-') && statSync(join(packages, name)).isDirectory()) {
        fail('copy', `packages/${name} exists: the chassis is a dependency, never a copy in the tree`);
      }
    }
  }
  if (existsSync(join(root, 'chassis-source.json'))) {
    fail(
      'copy',
      'chassis-source.json exists: the record of the copies has no place beside a pinned dependency'
    );
  }
}

// What pnpm installed: each declaring package's own node_modules, and the root's when hoisted.
function checkInstalled(declarations, pin) {
  if (!existsSync(join(root, 'node_modules'))) return false;
  const places = declarations.map(({ dir, name }) => ({ dir, name, required: true }));
  for (const name of CHASSIS) {
    places.push({ dir: root, name, required: false });
    places.push({ dir: join(root, 'node_modules/.pnpm'), name, required: false });
  }
  for (const { dir, name, required } of places) {
    const file = join(dir, 'node_modules', name, 'package.json');
    const where = relative(root, file);
    if (!existsSync(file)) {
      if (required) fail('installed', `${where} is missing: run pnpm install`);
      continue;
    }
    const version = readJson(file).version;
    if (version !== pin) fail('installed', `${where} reports ${version}, not the pinned ${pin}`);
  }
  return true;
}

function main() {
  const declarations = readDeclarations(workspacePackages());
  const pin = checkPin(declarations);
  // The lockfile and node_modules are read against the pin: without one there is nothing to compare.
  if (pin) checkLockfile(declarations, pin);
  checkPatches();
  checkCopies();
  const installed = pin ? checkInstalled(declarations, pin) : false;
  if (failures.length > 0) {
    for (const line of failures) console.error(line);
    return 1;
  }
  console.log(
    `chassis: ${SCOPE}* pinned at ${pin}, ${installed ? `installed ${pin}` : 'not installed yet'}, nothing patches it`
  );
  return 0;
}

process.exit(main());
