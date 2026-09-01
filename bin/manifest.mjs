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
export const PLUGINS = [
  { id: 'muse-workunit', name: 'dsh-workunit', host: true },
  { id: 'muse-effect-ledger', name: 'dsh-effect-ledger', host: true },
  { id: 'muse-evidence', name: 'dsh-evidence', host: true },
  { id: 'muse-guardrails', name: 'dsh-guardrails', host: true },
  { id: 'muse-eval', name: 'dsh-eval', host: true },
  { id: 'muse-skill-workshop', name: 'dsh-skill-workshop', host: true },
  { id: 'muse-bridge', name: 'dsh-muse-bridge', host: true },
  { id: 'muse-ui', name: 'dsh-muse-ui', host: false },
];

/** Plugins that run on the host (everything except the browser-only UI).
 *  The headless eval profile mounts exactly these: dsh-muse-bridge's
 *  `ctx.inject(['sessionProjections'], …)` simply never fires where the
 *  projection registry is not mounted (e.g. the dsh-headless bundle), so the
 *  bridge is inert there today and automatically covered the day a headless
 *  assembly gains projections. */
export const HOST_PLUGINS = PLUGINS.filter((p) => p.host);

/** Skills shipped under skills/ (copied to $DSH_HOME/skills/). */
export const SKILLS = ['muse-orchestrator'];

/** Marker block identity for cordis.patch.yml management. */
export const MARK_BEGIN = '# >>> dsh-muse (managed — do not edit between markers) >>>';
export const MARK_END = '# <<< dsh-muse <<<';

/** YAML insert rows for the given plugin entries (4-space list indent,
 *  matching the profile patch style DSH ships). */
export function insertRows(entries = PLUGINS) {
  return entries.map((p) => `    - id: ${p.id}\n      name: ${p.name}\n`).join('');
}

/** The full managed patch block (markers included), as written by install. */
export function patchBlock(entries = PLUGINS) {
  return `${MARK_BEGIN}\n- insert:\n${insertRows(entries)}${MARK_END}\n`;
}

/** Repo-relative path of the committed browser bundle the UI plugin needs. */
export const UI_BUNDLE = 'plugins/dsh-muse-ui/lib/client.js';
