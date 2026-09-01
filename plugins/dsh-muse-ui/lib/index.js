/**
 * dsh-muse-ui — host half.
 *
 * A pure dual-face marker: this entry exists so the host loader carries the
 * plugin (and dsh-muse-bridge's projection reaches the client), while the
 * browser half (`./client`) registers the Muse 工作台 conversation view tab.
 * All real work happens client-side; this file must stay inert.
 *
 * @module dsh-muse-ui
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'muse-ui';

/** No host services required. */
export const inject = [];

/** Host body: intentionally empty. */
export function apply() {}
