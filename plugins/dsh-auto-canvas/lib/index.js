/**
 * dsh-auto-canvas — host half.
 *
 * The feature lives in the client bundle (detecting local canvas/artifact
 * server URLs from conversation streaming and auto-expanding the DSH Right Sidebar
 * to open the sandboxed in-app browser tab).
 *
 * @module dsh-auto-canvas
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'muse-auto-canvas';

/** No host services required. */
export const inject = [];

/** Host body: intentionally empty. */
export function apply() {}
