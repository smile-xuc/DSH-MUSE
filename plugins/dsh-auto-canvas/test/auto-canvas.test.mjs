import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientJsPath = join(__dirname, '../lib/client.js');

function loadClientModule() {
  let loaded = null;
  const mockLoader = {
    load: (def) => {
      loaded = def.factory((id) => {
        throw new Error(`Unexpected require: ${id}`);
      });
    },
  };
  const code = readFileSync(clientJsPath, 'utf8');
  const fn = new Function('window', code);
  fn({ __ModuleLoader__: mockLoader });
  return loaded;
}

test('dsh-auto-canvas exports name and inject metadata', () => {
  const mod = loadClientModule();
  assert.equal(mod.name, 'dsh-auto-canvas');
  assert.ok(Array.isArray(mod.inject));
  assert.ok(mod.inject.includes('sessions'));
  assert.ok(mod.inject.includes('locale'));
});

test('normalizeCanvasUrl validates local design and dev server URLs', () => {
  const mod = loadClientModule();
  const { normalizeCanvasUrl } = mod;

  // Valid local URLs
  assert.equal(
    normalizeCanvasUrl('http://127.0.0.1:4720/design/WOBCM-pieJNhyr5fSbr1BjhAIYARVNY7/'),
    'http://127.0.0.1:4720/design/WOBCM-pieJNhyr5fSbr1BjhAIYARVNY7/'
  );
  assert.equal(
    normalizeCanvasUrl('http://localhost:5173/slides/deck-1?step=2'),
    'http://localhost:5173/slides/deck-1?step=2'
  );
  assert.equal(
    normalizeCanvasUrl('http://127.0.0.1:3000/'),
    'http://127.0.0.1:3000/'
  );

  // Strips trailing punctuation from markdown or prose
  assert.equal(
    normalizeCanvasUrl('http://127.0.0.1:4720/design/test.'),
    'http://127.0.0.1:4720/design/test'
  );
  assert.equal(
    normalizeCanvasUrl('http://127.0.0.1:4720/design/test)'),
    'http://127.0.0.1:4720/design/test'
  );
  assert.equal(
    normalizeCanvasUrl('http://127.0.0.1:4720/design/test"'),
    'http://127.0.0.1:4720/design/test'
  );

  // Invalid or external URLs
  assert.equal(normalizeCanvasUrl('https://github.com/JimLiu/baoyu-design'), null);
  assert.equal(normalizeCanvasUrl('https://google.com'), null);
  assert.equal(normalizeCanvasUrl('javascript:alert(1)'), null);
  assert.equal(normalizeCanvasUrl('file:///Users/bruce/file.html'), null);
  assert.equal(normalizeCanvasUrl('not-a-url'), null);

  // Excluded internal API paths
  assert.equal(normalizeCanvasUrl('http://127.0.0.1:4720/api/sessions'), null);
  assert.equal(normalizeCanvasUrl('http://127.0.0.1:4720/ws'), null);
});

test('extractUrlsFromElement detects URLs in text and anchor tags', () => {
  const mod = loadClientModule();
  const { extractUrlsFromElement } = mod;

  const mockElement = {
    tagName: 'DIV',
    textContent: 'Check out the canvas at http://127.0.0.1:4720/design/abc and also http://localhost:5173/app',
    querySelectorAll: () => [
      { href: 'http://127.0.0.1:4720/design/abc' },
      { href: 'https://github.com/example' },
    ],
  };

  const urls = extractUrlsFromElement(mockElement);
  assert.ok(urls.includes('http://127.0.0.1:4720/design/abc'));
  assert.ok(urls.includes('http://localhost:5173/app'));
  assert.equal(urls.includes('https://github.com/example'), false);
});

test('sessionState isolates baseline from newly produced canvas URLs', () => {
  const mod = loadClientModule();
  const { getSessionState } = mod;

  const s1 = getSessionState('session-test-1');
  assert.ok(s1);
  assert.equal(s1.initialized, false);

  // Baseline seeding
  s1.baseline.add('http://127.0.0.1:4720/design/old');
  s1.initialized = true;

  // Verify baseline URL is not considered new
  assert.ok(s1.baseline.has('http://127.0.0.1:4720/design/old'));

  // Newly emitted URL
  const newUrl = 'http://127.0.0.1:4720/design/new';
  assert.equal(s1.baseline.has(newUrl), false);
  assert.equal(s1.opened.has(newUrl), false);

  s1.opened.add(newUrl);
  assert.ok(s1.opened.has(newUrl));

  // Isolated per session
  const s2 = getSessionState('session-test-2');
  assert.equal(s2.opened.has(newUrl), false);
});
