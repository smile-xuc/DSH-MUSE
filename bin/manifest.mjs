/**
 * dsh-muse manifest — the SINGLE source of truth for what the layer ships.
 *
 * bin/install.mjs, eval/bin/setup.mjs and build/check-repo.mjs all consume
 * this module, so the plugin list, the cordis patch insert rows and the
 * marker block can never drift apart (the pre-manifest tree had three copies;
 * the eval profile silently missed dsh-muse-bridge/ui because of it).
 *
 * @module dsh-muse/manifest
 */

/**
 * Every plugin the layer ships, in load order. `id` is the cordis loader row
 * id, `name` is the npm package / plugins/<dir> name.
 * `host: false` marks the browser-only plugin (its host `apply` is inert; it
 * exists so the loader carries the client bundle into the web runtime).
 */
/**
 * The guardrails allowlist shipped as the project default: routine,
 * non-force `git push` is demoted from approval-gated to ledgered-only on
 * every install (trusted-device automation; force/delete/mirror stay gated).
 * MUST stay byte-identical to the exported ALLOW_GIT_PUSH_SAFE in
 * plugins/dsh-guardrails/lib/index.js — build/check-repo.mjs enforces it
 * (the manifest cannot import the plugin: its cordis imports would not
 * resolve outside a DSH runtime). Remove this key to restore strict mode.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GUARDRAILS_ALLOW_PUSH = String.raw`^\s*(?:cd\s+[a-zA-Z0-9._/:~^ \t-]+\s*&&\s*)?git\s+(?:-\w+\s+\S+\s+|-\w+\s+)*push\b(?![^\n|;&]*(?:--force\b|-\w*f\b|--delete\b|--mirror\b))\s*[a-zA-Z0-9._/:~^@ \t-]*$`;

export const PLUGINS = [
  { id: 'muse-workunit', name: 'dsh-workunit', host: true },
  { id: 'muse-effect-ledger', name: 'dsh-effect-ledger', host: true },
  { id: 'muse-evidence', name: 'dsh-evidence', host: true },
  { id: 'muse-guardrails', name: 'dsh-guardrails', host: true, config: { dangerousAllowPatterns: [GUARDRAILS_ALLOW_PUSH] } },
  { id: 'muse-eval', name: 'dsh-eval', host: true },
  { id: 'muse-skill-workshop', name: 'dsh-skill-workshop', host: true },
  { id: 'muse-bridge', name: 'dsh-muse-bridge', host: true },
  { id: 'muse-ui', name: 'dsh-muse-ui', host: false },
  /* Token usage observability: real host apply (Connection RPC +
   * sessionPersistence) plus a sidebar client bundle. webOnly because the
   * `connection` service exists only in the web assembly — headless profiles
   * must not mount it (a missing inject keeps the entry pending forever). */
  { id: 'muse-token-stats', name: 'dsh-token-stats', host: true, webOnly: true },
  /* Durable session pinning: header pin toggle + sidebar pins panel, pins in
   * ~/.dsh/storages/session-pins.json (host-side ⇒ survive the per-launch
   * random port that resets the stock browser-local order). webOnly for the
   * same `connection`-service reason as token-stats. */
  { id: 'muse-session-pins', name: 'dsh-session-pins', host: true, webOnly: true },
  /* Drop-any-file support: files the stock image-only drop flow rejects are
   * inserted into the composer as absolute-path references (capture-phase
   * interception client-side; the packaged desktop shell adds a native
   * WKWebView drag bridge for guaranteed paths). Host apply is inert;
   * webOnly because the feature is DOM-bound and must stay out of headless
   * eval profiles. */
  { id: 'muse-drop-path-ref', name: 'dsh-drop-path-ref', host: true, webOnly: true },
];

/** Plugins that run on the host (everything except the browser-only UI).
 *  The headless eval profile mounts exactly these: dsh-muse-bridge's
 *  `ctx.inject(['sessionProjections'], …)` simply never fires where the
 *  projection registry is not mounted (e.g. the dsh-headless bundle), so the
 *  bridge is inert there today and automatically covered the day a headless
 *  assembly gains projections. */
export const HOST_PLUGINS = PLUGINS.filter((p) => p.host && p.webOnly !== true);

/** Skills shipped under skills/ (copied to $DSH_HOME/skills/). */
export const SKILLS = ['muse-orchestrator'];

/** Marker block identity for cordis.patch.yml management. */
export const MARK_BEGIN = '# >>> dsh-muse (managed — do not edit between markers) >>>';
export const MARK_END = '# <<< dsh-muse <<<';

/** Single-quote a scalar for YAML (only ' needs doubling; backslashes and
 *  regex syntax pass through literally — exactly what patterns need). */
function yamlQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** YAML insert rows for the given plugin entries (4-space list indent,
 *  matching the profile patch style DSH ships). An entry's optional `config`
 *  object renders as a nested mapping (string-array values supported). */
export function insertRows(entries = PLUGINS) {
  return entries.map((p) => {
    let row = `    - id: ${p.id}\n      name: ${p.name}\n`;
    if (p.config !== undefined) {
      row += '      config:\n';
      for (const [key, value] of Object.entries(p.config)) {
        if (Array.isArray(value)) {
          row += `        ${key}:\n${value.map((item) => `          - ${yamlQuoted(item)}\n`).join('')}`;
        } else {
          row += `        ${key}: ${yamlQuoted(value)}\n`;
        }
      }
    }
    return row;
  }).join('');
}

/** The full managed patch block (markers included), as written by install. */
export function patchBlock(entries = PLUGINS) {
  return `${MARK_BEGIN}\n- insert:\n${insertRows(entries)}${MARK_END}\n`;
}

/** Repo-relative path of the committed browser bundle the UI plugin needs. */
export const UI_BUNDLE = 'plugins/dsh-muse-ui/lib/client.js';

/** Every plugin that ships a browser bundle, derived from its package.json
 *  `dsh.client` declaration — check-repo enforces the bundle's presence. */
export function clientBundlePaths(pluginDirs) {
  return pluginDirs
    .filter((dir) => {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        return pkg.dsh?.client !== undefined;
      } catch { return false; }
    })
    .map((dir) => join(dir, 'lib', 'client.js'));
}
