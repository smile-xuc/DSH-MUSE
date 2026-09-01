#!/usr/bin/env node
/**
 * check-repo — structural consistency between the manifest (bin/manifest.mjs,
 * the single source of truth) and the files on disk.
 *
 * Run in CI and before committing; every check fails loudly with a numbered
 * list of violations and a non-zero exit code.
 *
 * Checks:
 *   1. every manifest plugin has plugins/<name>/ with a package.json whose
 *      `name` matches and whose `main` file exists
 *   2. no stray directory under plugins/ that the manifest does not know
 *   3. manifest ids and names are unique; exactly one plugin is browser-only
 *   4. patchBlock() renders every plugin as `id` + `name` insert rows
 *   5. the committed UI browser bundle exists (plugins/dsh-muse-ui/lib/client.js)
 *   6. skills/ on disk == manifest SKILLS
 *   7. a manifest plugin `config` carrying a guardrails allowlist pattern is
 *      byte-identical to the plugin's exported ALLOW_GIT_PUSH_SAFE (the
 *      manifest cannot import the plugin — cordis deps — so the pattern is
 *      inlined in both places and this check keeps them from drifting)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGINS, SKILLS, UI_BUNDLE, patchBlock } from '../bin/manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

/* 1+2: plugins on disk ↔ manifest ---------------------------------------- */
const pluginDirs = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .sort();
const manifestNames = PLUGINS.map((p) => p.name).sort();

for (const name of manifestNames.filter((n) => !pluginDirs.includes(n))) {
  violations.push(`manifest plugin '${name}' has no plugins/${name}/ directory`);
}
for (const dir of pluginDirs.filter((d) => !manifestNames.includes(d))) {
  violations.push(`plugins/${dir}/ exists but is not in bin/manifest.mjs PLUGINS`);
}
for (const plugin of PLUGINS) {
  const dir = join(ROOT, 'plugins', plugin.name);
  if (!existsSync(dir)) continue; // already reported
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) { violations.push(`plugins/${plugin.name}/package.json missing`); continue; }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== plugin.name) violations.push(`plugins/${plugin.name}/package.json name is '${pkg.name}'`);
  const main = join(dir, pkg.main ?? 'lib/index.js');
  if (!existsSync(main)) violations.push(`plugins/${plugin.name} main '${pkg.main}' does not exist`);
}

/* 3: manifest shape ------------------------------------------------------- */
const ids = PLUGINS.map((p) => p.id);
if (new Set(ids).size !== ids.length) violations.push('duplicate plugin ids in manifest');
if (new Set(manifestNames).size !== manifestNames.length) violations.push('duplicate plugin names in manifest');
const browserOnly = PLUGINS.filter((p) => !p.host);
if (browserOnly.length !== 1 || browserOnly[0]?.name !== 'dsh-muse-ui') {
  violations.push(`expected exactly one browser-only plugin (dsh-muse-ui), got: ${browserOnly.map((p) => p.name).join(', ') || '(none)'}`);
}

/* 4: patch block renders every plugin -------------------------------------- */
const block = patchBlock();
for (const plugin of PLUGINS) {
  if (!block.includes(`- id: ${plugin.id}\n      name: ${plugin.name}`)) {
    violations.push(`patchBlock() does not render ${plugin.id}/${plugin.name}`);
  }
}

/* 5: committed UI bundle ---------------------------------------------------- */
if (!existsSync(join(ROOT, UI_BUNDLE))) {
  violations.push(`${UI_BUNDLE} missing — run \`npm ci && npm run build:ui\` and commit the result`);
}

/* 6: skills on disk ↔ manifest --------------------------------------------- */
const skillDirs = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .sort();
for (const name of SKILLS.filter((s) => !skillDirs.includes(s))) {
  violations.push(`manifest skill '${name}' has no skills/${name}/ directory`);
}
for (const dir of skillDirs.filter((d) => !SKILLS.includes(d))) {
  violations.push(`skills/${dir}/ exists but is not in bin/manifest.mjs SKILLS`);
}

/* 7: guardrails allowlist pattern — manifest config ≡ plugin export -------- */
const guardrailsEntry = PLUGINS.find((p) => p.name === 'dsh-guardrails');
const manifestPatterns = guardrailsEntry?.config?.dangerousAllowPatterns ?? [];
if (manifestPatterns.length > 0) {
  const source = readFileSync(join(ROOT, 'plugins', 'dsh-guardrails', 'lib', 'index.js'), 'utf8');
  const match = /export const ALLOW_GIT_PUSH_SAFE = String\.raw`([^`]*)`/.exec(source);
  if (match === null) {
    violations.push('manifest ships a guardrails allowlist but plugins/dsh-guardrails does not export ALLOW_GIT_PUSH_SAFE');
  } else if (match[1] !== manifestPatterns[0]) {
    violations.push(`manifest dangerousAllowPatterns[0] ≠ plugin ALLOW_GIT_PUSH_SAFE — keep them byte-identical (anti-laundering semantics live in the pattern)`);
  }
}

/* ------------------------------------------------------------------------- */
if (violations.length > 0) {
  console.error(`[check-repo] ${violations.length} violation(s):`);
  violations.forEach((v, i) => console.error(`  ${i + 1}. ${v}`));
  process.exit(1);
}
console.log(`[check-repo] ok — ${PLUGINS.length} plugins (${PLUGINS.filter((p) => p.host).length} host + 1 browser), ${SKILLS.length} skill(s), patch block and UI bundle consistent`);
