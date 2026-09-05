/**
 * _peers — make the eval-time plugin imports resolvable WITHOUT publishing
 * or duplicating DSH packages: symlink the exact peer packages from the local
 * DSH installation into the repo's (gitignored) node_modules.
 *
 * Why not devDependencies from npm: several @deepseek-ai packages are only
 * available VENDORED inside a DSH install (e.g. @deepseek-ai/cordis is not
 * published at the version the plugins were built against). Symlinking the
 * local install measures against the exact seams that run in production.
 *
 * Resolution order for the DSH node_modules root:
 *   1. $DSH_APP_NODE_MODULES (explicit override)
 *   2. the app bundle of a native install (/Applications/DeepSeek Harness.app)
 *   3. derived from the `dsh` binary on PATH (…/node_modules/@deepseek-ai/dsh/lib/bin.js)
 *
 * Idempotent; npm ci wipes node_modules but the next eval run recreates the
 * links. Everything here is a symlink — nothing is copied or modified.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  'zod',
];

function candidateRoots() {
  const roots = [];
  if (process.env.DSH_APP_NODE_MODULES !== undefined) roots.push(process.env.DSH_APP_NODE_MODULES);
  roots.push('/Applications/DeepSeek Harness.app/Contents/Resources/app/node_modules');
  roots.push(join(homedir(), 'Library', 'Application Support', 'ai.deepseek.harness', 'runtime', 'node_modules'));
  try {
    const bin = execFileSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim();
    if (bin !== '') {
      roots.push(resolve(dirname(bin), '..')); // npm-style .bin/../<pkg> → walk to node_modules
      roots.push(resolve(dirname(bin), '..', '..', '..')); // …/@deepseek-ai/dsh/lib/bin.js → node_modules
      try {
        const real = realpathSync(bin);
        if (real !== bin) {
          roots.push(resolve(dirname(real), '..'));
          roots.push(resolve(dirname(real), '..', '..', '..'));
        }
      } catch { /* symlink resolution failed */ }
    }
  } catch { /* no dsh on PATH */ }
  roots.push(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules'));
  return roots;
}

export function findDshNodeModules() {
  for (const root of candidateRoots()) {
    if (existsSync(join(root, '@deepseek-ai', 'cordis', 'package.json'))) return root;
  }
  return null;
}

/** Ensure every peer resolves from the repo. Returns the source root used,
 *  or 'local' when real (non-symlink) packages are already installed — e.g.
 *  CI installs the published subset with npm since no DSH app exists there. */
export function ensurePeers() {
  const allLocal = PEERS.every((name) => {
    const dir = join(ROOT, 'node_modules', name);
    if (!existsSync(join(dir, 'package.json'))) return false;
    try { readlinkSync(dir); return false; } catch { return true; } // real dir, not a symlink
  });
  if (allLocal) return 'local';
  const source = findDshNodeModules();
  if (source === null) {
    throw new Error('no DSH installation found to borrow peer packages from — set DSH_APP_NODE_MODULES, or `npm i -D @deepseek-ai/cordis @deepseek-ai/schemastery @deepseek-ai/dsh-tools @deepseek-ai/dsh-storage-domain zod`');
  }
  for (const name of PEERS) {
    const target = join(source, name);
    if (!existsSync(join(target, 'package.json'))) throw new Error(`peer '${name}' missing under ${source}`);
    const link = join(ROOT, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
      try {
        if (readlinkSync(link) === target) continue; // already correct
      } catch { /* real dir — leave it alone */ continue; }
      rmSync(link, { recursive: true, force: true });
    }
    symlinkSync(target, link, 'dir');
  }
  return source;
}
