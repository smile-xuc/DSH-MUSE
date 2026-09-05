/**
 * dsh-drop-path-ref — unit tests for the pure path-resolution helpers.
 * Run: node --test plugins/dsh-drop-path-ref/test/paths.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_IMAGE_TYPES,
  isStockImage,
  fileUrlToPath,
  parseUriList,
  parseDownloadUrl,
  quotePath,
  resolveDropPaths,
} from '../lib/paths.mjs';

const dt = (map) => ({ getData: (type) => map[type] ?? '' });
const f = (type) => ({ type });

test('isStockImage: stock accept list matches upstream composer', () => {
  assert.equal(isStockImage(f('image/png')), true);
  assert.equal(isStockImage(f('image/jpeg')), true);
  assert.equal(isStockImage(f('image/webp')), true);
  assert.equal(isStockImage(f('image/gif')), true);
  assert.equal(isStockImage(f('image/svg+xml')), true);
  assert.equal(isStockImage(f('IMAGE/PNG')), true); // case-insensitive
  assert.equal(isStockImage(f('application/pdf')), false);
  assert.equal(isStockImage(f('')), false); // folders report empty type
  assert.equal(isStockImage({}), false);
  assert.equal(STOCK_IMAGE_TYPES.has('image/tiff'), false); // tiff stays a path ref
});

test('fileUrlToPath: decodes file URLs to absolute POSIX paths', () => {
  assert.equal(fileUrlToPath('file:///tmp/a.pdf'), '/tmp/a.pdf');
  assert.equal(fileUrlToPath('file://localhost/tmp/a.pdf'), '/tmp/a.pdf');
  assert.equal(fileUrlToPath('file:///Users/x/My%20Docs/a%20b.pdf'), '/Users/x/My Docs/a b.pdf');
  assert.equal(fileUrlToPath('file:///Users/x/%E8%AE%BA%E6%96%87.pdf'), '/Users/x/论文.pdf');
  assert.equal(fileUrlToPath('file:///Volumes/20Gb-Lib/x.zip'), '/Volumes/20Gb-Lib/x.zip');
});

test('fileUrlToPath: rejects non-file URLs and malformed input', () => {
  assert.equal(fileUrlToPath('https://example.com/a.pdf'), null);
  assert.equal(fileUrlToPath('file://remotehost/share/a.pdf'), null); // remote host
  assert.equal(fileUrlToPath('file://relative'), null);
  assert.equal(fileUrlToPath('file:///bad/%E4%A4'), null); // malformed percent-encoding
  assert.equal(fileUrlToPath(''), null);
  assert.equal(fileUrlToPath(null), null);
});

test('parseUriList: multi-line payload with comments and CRLF', () => {
  const payload = '# finder drag\r\nfile:///tmp/a.pdf\r\nfile:///tmp/b%20c.zip\n\n';
  assert.deepEqual(parseUriList(payload), ['/tmp/a.pdf', '/tmp/b c.zip']);
  assert.deepEqual(parseUriList(''), []);
  assert.deepEqual(parseUriList(null), []);
  assert.deepEqual(parseUriList('https://x.y/z'), []); // non-file URLs dropped
});

test('parseDownloadUrl: Chromium single-file payload', () => {
  assert.equal(parseDownloadUrl('application/pdf:a.pdf:file:///tmp/a.pdf'), '/tmp/a.pdf');
  assert.equal(parseDownloadUrl('image/png:x.png:https://remote/x.png'), null);
  assert.equal(parseDownloadUrl('garbage'), null);
  assert.equal(parseDownloadUrl(''), null);
});

test('quotePath: quotes only whitespace-bearing paths, escapes quotes', () => {
  assert.equal(quotePath('/tmp/a.pdf'), '/tmp/a.pdf');
  assert.equal(quotePath('/tmp/My Docs/a.pdf'), '"/tmp/My Docs/a.pdf"');
  assert.equal(quotePath('/tmp/say "hi".txt'), '"/tmp/say \\"hi\\".txt"');
  assert.equal(quotePath('/tmp/制表\t符'), '"/tmp/制表\t符"');
});

test('resolveDropPaths: uri-list aligned with files count wins', () => {
  const files = [f('application/pdf'), f('application/zip')];
  const d = dt({ 'text/uri-list': 'file:///tmp/a.pdf\nfile:///tmp/b.zip' });
  assert.deepEqual(resolveDropPaths(d, files), ['/tmp/a.pdf', '/tmp/b.zip']);
});

test('resolveDropPaths: count mismatch does not guess', () => {
  const files = [f('application/pdf'), f('application/zip')];
  const d = dt({ 'text/uri-list': 'file:///tmp/only-one.pdf' });
  assert.equal(resolveDropPaths(d, files), null);
});

test('resolveDropPaths: DownloadURL and text/plain single-file fallbacks', () => {
  const one = [f('application/pdf')];
  assert.deepEqual(resolveDropPaths(dt({ DownloadURL: 'application/pdf:a.pdf:file:///tmp/a.pdf' }), one), ['/tmp/a.pdf']);
  assert.deepEqual(resolveDropPaths(dt({ 'text/plain': 'file:///tmp/plain.pdf' }), one), ['/tmp/plain.pdf']);
  assert.deepEqual(resolveDropPaths(dt({ 'text/plain': '/tmp/raw.pdf' }), one), ['/tmp/raw.pdf']);
  assert.deepEqual(resolveDropPaths(dt({ 'text/plain': 'just some words' }), one), null);
});

test('resolveDropPaths: Chromium name-only drops return null (no interception)', () => {
  const files = [f('application/pdf')];
  assert.equal(resolveDropPaths(dt({}), files), null);
  assert.equal(resolveDropPaths(null, files), null);
  assert.equal(resolveDropPaths(dt({ 'text/uri-list': 'file:///tmp/a.pdf' }), []), null);
});
