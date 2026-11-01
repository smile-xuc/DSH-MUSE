#!/usr/bin/env node
/**
 * sync.mjs — synchronizes the 4 baoyu-design plugins from upstream npm registry
 * into integrations/baoyu-design/, keeping the vendored copy in git up-to-date.
 *
 * Usage:
 *   node integrations/baoyu-design/sync.mjs           # sync remote packages to local repo
 *   node integrations/baoyu-design/sync.mjs --check   # check for updates only
 *   node integrations/baoyu-design/sync.mjs --install # sync and install into DSH web profile
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BAOYU_DIR = __dirname;

export const PACKAGES = [
  'dsh-claude-slides',
  'dsh-claude-design',
  'dsh-claude-design-system',
  'dsh-claude-dashboard',
];

const REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

async function fetchMetadata(pkgName) {
  for (const registry of REGISTRIES) {
    try {
      const url = `${registry}/${pkgName}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        return await res.json();
      }
    } catch (_) {}
  }
  throw new Error(`Failed to fetch metadata for ${pkgName} from all registries`);
}

function getLocalVersion(pkgName) {
  const pkgJsonPath = join(BAOYU_DIR, pkgName, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

async function downloadAndExtract(pkgName, tarballUrl, targetDir) {
  console.log(`[sync] downloading ${pkgName} from ${tarballUrl}...`);
  const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${tarballUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const tmpTarball = join(tmpdir(), `${pkgName}-${Date.now()}.tgz`);
  const tmpExtract = join(tmpdir(), `${pkgName}-extracted-${Date.now()}`);

  try {
    writeFileSync(tmpTarball, buffer);
    mkdirSync(tmpExtract, { recursive: true });

    // Extract tarball (tar strips the top-level 'package/' folder)
    execFileSync('tar', ['-xzf', tmpTarball, '-C', tmpExtract]);

    const sourceDir = join(tmpExtract, 'package');
    if (!existsSync(sourceDir)) {
      throw new Error(`Invalid tarball structure: missing package directory`);
    }

    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    execFileSync('cp', ['-R', `${sourceDir}/.`, targetDir]);
    console.log(`[sync] successfully updated ${pkgName} -> ${targetDir}`);
  } finally {
    rmSync(tmpTarball, { force: true });
    rmSync(tmpExtract, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const installAfter = args.includes('--install');
  const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'web';

  let hasUpdates = false;
  const plan = [];

  console.log(`[sync] checking latest versions of baoyu-design plugins...`);

  for (const pkgName of PACKAGES) {
    const localVer = getLocalVersion(pkgName);
    const meta = await fetchMetadata(pkgName);
    const latestVer = meta['dist-tags']?.latest;
    const versionData = meta.versions?.[latestVer];
    const tarball = versionData?.dist?.tarball;

    console.log(`[sync] ${pkgName}: local=${localVer || 'none'} latest=${latestVer}`);

    if (!localVer || localVer !== latestVer) {
      hasUpdates = true;
      plan.push({ pkgName, localVer, latestVer, tarball });
    }
  }

  if (checkOnly) {
    if (hasUpdates) {
      console.log(`[sync] updates available:`);
      for (const item of plan) {
        console.log(`  - ${item.pkgName}: ${item.localVer || 'none'} -> ${item.latestVer}`);
      }
      process.exit(2);
    } else {
      console.log(`[sync] all plugins are up-to-date.`);
      process.exit(0);
    }
  }

  if (!hasUpdates) {
    console.log(`[sync] all baoyu-design plugins are already at the latest versions.`);
  } else {
    for (const item of plan) {
      const target = join(BAOYU_DIR, item.pkgName);
      await downloadAndExtract(item.pkgName, item.tarball, target);
    }
    console.log(`[sync] all baoyu-design plugin sources have been updated!`);
  }

  if (installAfter) {
    console.log(`[sync] installing updated plugins into DSH profile '${profile}'...`);
    const specs = PACKAGES.map((name) => `${name}@${getLocalVersion(name) || 'latest'}`);
    const res = spawnSync('dsh', ['plugin', '--profile', profile, 'add', ...specs], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    if (res.status !== 0) {
      console.error(`[sync] failed to install plugins into DSH profile '${profile}'`);
      process.exit(res.status || 1);
    }
    console.log(`[sync] successfully installed baoyu-design plugins into profile '${profile}'.`);
  }
}

main().catch((err) => {
  console.error(`[sync] error:`, err);
  process.exit(1);
});
