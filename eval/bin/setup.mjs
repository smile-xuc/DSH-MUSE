#!/usr/bin/env node
/**
 * eval setup — create the two benchmark profiles under $DSH_HOME/profiles:
 *
 *   eval-vanilla  stock DSH headless (dsh-base + dsh-headless), nothing else
 *   eval-muse     same base + storage trio + the Muse host plugins
 *
 * Both profiles share the user's global ~/.dsh settings (model provider,
 * credentials) so the ONLY difference between the two arms is the Muse layer.
 *
 * Muse coverage note: every HOST plugin is mounted (see bin/manifest.mjs).
 * dsh-muse-ui is browser-only (inert host marker) and stays out of headless;
 * dsh-muse-bridge mounts but its `ctx.inject(['sessionProjections'], …)`
 * never fires under the dsh-headless assembly (no projection registry), so it
 * is inert today and automatically joins the benchmark if a future headless
 * bundle mounts projections.
 *
 * Prerequisite for eval-muse: `node bin/install.mjs install` must have run
 * (the profile links against the installed plugin copies).
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOST_PLUGINS, insertRows } from '../../bin/manifest.mjs';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PROFILES = join(HOME, 'profiles');
const PLUGINS = HOST_PLUGINS.map((p) => p.name);

const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'];

function writeProfile(name, { muse }) {
  const dir = join(PROFILES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });

  const pkg = {
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles: [...BUNDLES] } },
  };
  if (muse) {
    pkg.dependencies = Object.fromEntries(PLUGINS.map((p) => [p, `link:../plugins/dsh-muse/${p}`]));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  if (muse) {
    for (const p of PLUGINS) {
      symlinkSync(join('..', '..', 'plugins', 'dsh-muse', p), join(dir, 'node_modules', p));
    }
    writeFileSync(join(dir, 'cordis.patch.yml'), `# eval-muse: stock headless lacks the storage plugins, add them first.
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
${insertRows(HOST_PLUGINS)}`);
  }
  console.log(`[eval:setup] profile '${name}' ready at ${dir}`);
}

if (!existsSync(join(PROFILES, 'plugins', 'dsh-muse'))) {
  console.error('[eval:setup] dsh-muse plugins are not installed — run `node bin/install.mjs install` first');
  process.exit(1);
}

writeProfile('eval-vanilla', { muse: false });
writeProfile('eval-muse', { muse: true });
console.log('[eval:setup] done. Run a benchmark: node eval/bin/run.mjs all');
