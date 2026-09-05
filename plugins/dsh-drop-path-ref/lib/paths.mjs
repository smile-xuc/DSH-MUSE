/**
 * dsh-drop-path-ref — pure path-resolution helpers (node-testable).
 *
 * The browser bundle (lib/client.js) is GENERATED from this file plus
 * lib/client-entry.js by build/build-drop-path-ref.mjs — edit here, never in
 * the bundle. Functions stay dependency-free and DOM-free: the drop event's
 * DataTransfer is duck-typed as `{ getData(type) }`.
 *
 * @module dsh-drop-path-ref/paths
 */

/** MIME types the stock composer attaches as images (accept list of
 *  dsh-client-ui-conversation); everything else is "unsupported" upstream. */
export const STOCK_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

/** True when the stock drop flow would attach this file as an image. */
export function isStockImage(file) {
  return typeof file?.type === 'string' && STOCK_IMAGE_TYPES.has(file.type.toLowerCase());
}

/** Decode a file:// URL to an absolute POSIX path; null for anything else. */
export function fileUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;
  const rest = url.slice('file://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const host = rest.slice(0, slash);
  if (host !== '' && host !== 'localhost') return null;
  let path = rest.slice(slash);
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  return path.startsWith('/') ? path : null;
}

/** Parse a text/uri-list payload (CRLF/LF lines, '#' comments skipped). */
export function parseUriList(payload) {
  if (typeof payload !== 'string' || payload.length === 0) return [];
  return payload
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map(fileUrlToPath)
    .filter((path) => path !== null);
}

/** Parse a Chromium-style DownloadURL payload: "<mime>:<name>:<url>". */
export function parseDownloadUrl(payload) {
  if (typeof payload !== 'string') return null;
  const first = payload.indexOf(':');
  const second = first < 0 ? -1 : payload.indexOf(':', first + 1);
  if (second < 0) return null;
  return fileUrlToPath(payload.slice(second + 1).trim());
}

/** Quote a path when it contains whitespace (agents split plain tokens on
 *  whitespace; a quoted absolute path survives as one reference). */
export function quotePath(path) {
  return /\s/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path;
}

/**
 * Resolve absolute paths for a drop's files from the DataTransfer payloads.
 *
 * Browser security note: only WebKit-family views (Safari / the packaged
 * WKWebView desktop shell) populate `text/uri-list` with file:// URLs for
 * Finder drags; Chromium exposes names only — there the resolver returns
 * null and the stock flow (unsupported-type notice) proceeds untouched.
 * In the packaged desktop app the native bridge (desktop/Sources/main.swift)
 * bypasses this entirely with real pasteboard URLs.
 *
 * Returns an array aligned with `files` order, or null when paths cannot be
 * resolved reliably (caller must NOT intercept the drop then).
 */
export function resolveDropPaths(dataTransfer, files) {
  if (!dataTransfer || typeof dataTransfer.getData !== 'function') return null;
  const count = Array.isArray(files) ? files.length : 0;
  if (count === 0) return null;
  const safe = (type) => {
    try {
      return dataTransfer.getData(type) ?? '';
    } catch {
      return '';
    }
  };
  /* 1. text/uri-list — WebKit populates it with one file:// URL per file. */
  const uriPaths = parseUriList(safe('text/uri-list'));
  if (uriPaths.length === count) return uriPaths;
  /* 2. DownloadURL — Chromium family, single file only. */
  const download = parseDownloadUrl(safe('DownloadURL'));
  if (download !== null && count === 1) return [download];
  /* 3. text/plain carrying a file URL or a raw absolute path (single file). */
  const plain = safe('text/plain').trim();
  if (count === 1 && plain.length > 0) {
    if (plain.startsWith('file://')) {
      const path = fileUrlToPath(plain);
      if (path !== null) return [path];
    } else if (plain.startsWith('/')) {
      return [plain];
    }
  }
  return null;
}
