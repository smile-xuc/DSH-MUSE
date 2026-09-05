/**
 * dsh-drop-path-ref — host half.
 *
 * Inert by design (same pattern as dsh-muse-ui): the feature lives in the
 * client bundle (capture-phase drop interception + composer insertion) and,
 * in the packaged desktop shell, in the native WKWebView drag bridge. This
 * entry exists so the loader row carries the plugin and its client bundle
 * into the web runtime.
 *
 * @module dsh-drop-path-ref
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'muse-drop-path-ref';

/** No host services required. */
export const inject = [];

/** Host body: intentionally empty. */
export function apply() {}
