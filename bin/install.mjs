#!/usr/bin/env node
/**
 * dsh-muse installer — idempotently installs the Muse plugin layer into a
 * DSH profile without touching the DSH runtime itself.
 *
 *   node bin/install.mjs install   [--profile web] [--home ~/.dsh]
 *   node bin/install.mjs uninstall [--profile web] [--home ~/.dsh]
 *   node bin/install.mjs status    [--profile web] [--home ~/.dsh]
 *
 * What install does (every step is reversible and re-runnable):
 *   1. copies plugins/  -> $DSH_HOME/profiles/plugins/dsh-muse/<name>
 *   2. copies skills/   -> $DSH_HOME/skills/
 *   3. adds `link:` deps to the profile's package.json (documented trail)
 *   4. symlinks the plugins into the profile's node_modules
 *   5. inserts a MARKED block into the profile's cordis.patch.yml
 *
 * Uninstall removes exactly those artifacts — nothing else is ever touched,
 * so DSH mainline updates can never conflict with this layer.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PLUGINS = ['dsh-workunit', 'dsh-effect-ledger', 'dsh-evidence', 'dsh-guardrails', 'dsh-eval', 'dsh-skill-workshop', 'dsh-muse-bridge', 'dsh-muse-ui'];
const SKILLS = ['muse-orchestrator'];
const MARK_BEGIN = '# >>> dsh-muse (managed — do not edit between markers) >>>';
const MARK_END = '# <<< dsh-muse <<<';

const PATCH_BLOCK = `${MARK_BEGIN}
- insert:
    - id: muse-workunit
      name: dsh-workunit
    - id: muse-effect-ledger
      name: dsh-effect-ledger
    - id: muse-evidence
      name: dsh-evidence
    - id: muse-guardrails
      name: dsh-guardrails
    - id: muse-eval
      name: dsh-eval
    - id: muse-skill-workshop
      name: dsh-skill-workshop
    - id: muse-bridge
      name: dsh-muse-bridge
    - id: muse-ui
      name: dsh-muse-ui
${MARK_END}
`;

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { command: argv[2] ?? 'install', profile: 'web', home: process.env.DSH_HOME ?? join(homedir(), '.dsh') };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--profile') args.profile = argv[++i];
    else if (argv[i] === '--home') args.home = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function log(step, msg) {
  console.log(`[dsh-muse] ${step}: ${msg}`);
}

/** Legacy entry ids used by pre-repo manual installs (same package names). */
const LEGACY = [['workunit', 'dsh-workunit'], ['effect-ledger', 'dsh-effect-ledger'], ['evidence', 'dsh-evidence'], ['guardrails', 'dsh-guardrails'], ['eval', 'dsh-eval'], ['skill-workshop', 'dsh-skill-workshop']];

/** Remove unmanaged legacy entries/dirs from earlier manual installs so the
 *  managed block is the single registration point. */
function cleanLegacy(home, profile) {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    let text = readFileSync(patchPath, 'utf8');
    for (const [id, pkg] of LEGACY) {
      const re = new RegExp(`\\n?[ \\t]*-[ \\t]*id:[ \\t]*${id}\\s*\\n[ \\t]*name:[ \\t]*${pkg}\\s*\\n(?:[ \\t]+[^\\n]*\\n)*`, 'g');
      text = text.replace(re, '\n');
    }
    writeFileSync(patchPath, text);
  }
  for (const [, pkg] of LEGACY) {
    const dir = join(home, 'profiles', 'plugins', pkg);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      log('legacy', `removed old plugin dir ${pkg}`);
    }
  }
}

/** Insert or replace the managed block in a cordis.patch.yml text. */
function upsertPatch(text) {
  /* DSH ships profiles with a bare `[]` placeholder as the whole document;
   * strip it before appending, otherwise `[]` followed by a list is invalid
   * YAML and dsh refuses to boot the profile. */
  text = text.replace(/^[ \t]*\[][ \t]*\r?\n?/, '').replace(/\n[ \t]*\[][ \t]*(?=\r?\n|$)/g, '');
  if (text.includes(MARK_BEGIN)) {
    const re = new RegExp(`${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
    return text.replace(re, PATCH_BLOCK);
  }
  const sep = text.trim() === '' ? '' : '\n';
  return `${text}${sep}${PATCH_BLOCK}`;
}

/** Remove the managed block (returns text unchanged when absent). */
function removePatch(text) {
  if (!text.includes(MARK_BEGIN)) return text;
  const re = new RegExp(`\\n?${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  const out = text.replace(re, '\n');
  /* comments only -> restore the shipped `[]` placeholder document */
  return out.trim().startsWith('#') && out.trim().replace(/^#[^\n]*\n?/gm, '').trim() === '' ? `${out.replace(/\n*$/, '\n')}[]\n` : out;
}

function installPlugins(home) {
  const target = join(home, 'profiles', 'plugins', 'dsh-muse');
  mkdirSync(target, { recursive: true });
  for (const name of PLUGINS) {
    rmSync(join(target, name), { recursive: true, force: true });
    cpSync(join(ROOT, 'plugins', name), join(target, name), { recursive: true });
    log('plugin', `${name} -> ${join(target, name)}`);
  }
}

function installSkills(home) {
  for (const name of SKILLS) {
    const target = join(home, 'skills', name);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(ROOT, 'skills', name), target, { recursive: true });
    log('skill', `${name} -> ${target}`);
  }
}

function linkIntoProfile(home, profile) {
  const profileDir = join(home, 'profiles', profile);
  if (!existsSync(profileDir)) throw new Error(`profile '${profile}' not found at ${profileDir}`);
  const nmDir = join(profileDir, 'node_modules');
  mkdirSync(nmDir, { recursive: true });
  for (const name of PLUGINS) {
    const link = join(nmDir, name);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join('..', '..', 'plugins', 'dsh-muse', name), link);
    log('link', `${profile}/node_modules/${name}`);
  }
  /* documented trail in the profile's package.json */
  const pkgPath = join(profileDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dependencies = pkg.dependencies ?? {};
    let changed = false;
    for (const name of PLUGINS) {
      const want = 'link:../plugins/dsh-muse/' + name;
      if (pkg.dependencies[name] !== want) { pkg.dependencies[name] = want; changed = true; }
    }
    if (changed) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      log('package.json', `${profile} dependencies updated`);
    }
  }
}

function patchProfile(home, profile) {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml');
  const before = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  writeFileSync(patchPath, upsertPatch(before));
  log('patch', `${patchPath} (managed block)`);
}

function uninstall(home, profile) {
  rmSync(join(home, 'profiles', 'plugins', 'dsh-muse'), { recursive: true, force: true });
  for (const name of SKILLS) rmSync(join(home, 'skills', name), { recursive: true, force: true });
  const nmDir = join(home, 'profiles', profile, 'node_modules');
  for (const name of PLUGINS) rmSync(join(nmDir, name), { recursive: true, force: true });
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml');
  if (existsSync(patchPath)) writeFileSync(patchPath, removePatch(readFileSync(patchPath, 'utf8')));
  const pkgPath = join(home, 'profiles', profile, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const name of PLUGINS) delete pkg.dependencies?.[name];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  log('uninstall', 'all dsh-muse artifacts removed');
}

function status(home, profile) {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml');
  const patched = existsSync(patchPath) && readFileSync(patchPath, 'utf8').includes(MARK_BEGIN);
  const pluginsDir = join(home, 'profiles', 'plugins', 'dsh-muse');
  const installed = existsSync(pluginsDir) ? readdirSync(pluginsDir) : [];
  console.log(`profile '${profile}': patch ${patched ? 'ACTIVE' : 'absent'}, plugins installed: ${installed.length ? installed.join(', ') : '(none)'}`);
}

/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv);
switch (args.command) {
  case 'install':
    cleanLegacy(args.home, args.profile);
    installPlugins(args.home);
    installSkills(args.home);
    linkIntoProfile(args.home, args.profile);
    patchProfile(args.home, args.profile);
    console.log(`\n[dsh-muse] installed into profile '${args.profile}'. Restart DSH to activate. Rollback: node bin/install.mjs uninstall`);
    break;
  case 'uninstall':
    uninstall(args.home, args.profile);
    console.log(`\n[dsh-muse] removed from profile '${args.profile}'. Restart DSH to apply.`);
    break;
  case 'status':
    status(args.home, args.profile);
    break;
  default:
    throw new Error(`unknown command '${args.command}' (install|uninstall|status)`);
}
