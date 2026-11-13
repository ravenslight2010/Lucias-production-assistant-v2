import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(packageRoot, 'dist', 'public');
const basePath = '/lucia-preview/';

test('production PWA build keeps its manifest, icons, and worker in the configured base path', () => {
  const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Lucia Production Assistant');
  assert.equal(manifest.short_name, 'Lucia');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, basePath);
  assert.equal(manifest.scope, basePath);
  assert.deepEqual(
    manifest.icons.map(({ sizes }) => sizes).sort(),
    ['192x192', '512x512'],
  );

  for (const icon of manifest.icons) {
    assert.equal(icon.src, `${basePath}pwa-${icon.sizes}.png`);
    const iconPath = path.join(publicDir, path.basename(icon.src));
    assert.ok(existsSync(iconPath), `Missing install icon ${icon.src}`);
    const png = readFileSync(iconPath);
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), Number.parseInt(icon.sizes, 10));
    assert.equal(png.readUInt32BE(20), Number.parseInt(icon.sizes, 10));
  }

  const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`href="${basePath.replaceAll('/', '\\/') }manifest\\.webmanifest"`));
  assert.match(html, new RegExp(`href="${basePath.replaceAll('/', '\\/') }pwa-192x192\\.png"`));
  assert.equal((html.match(/rel="manifest"/g) ?? []).length, 1);
});

test('production worker versions static assets and leaves API traffic network-only', () => {
  const worker = readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  const workerSource = readFileSync(path.join(packageRoot, 'src', 'sw.js'), 'utf8');
  assert.match(workerSource, /precacheAndRoute/);
  assert.match(workerSource, /cleanupOutdatedCaches/);
  assert.match(workerSource, /new NavigationRoute/);
  assert.match(workerSource, /denylist:\s*\[\/\^\\\/api/);
  assert.match(workerSource, /event\.waitUntil\(self\.skipWaiting\(\)\)/);
  assert.match(worker, /SKIP_WAITING/);
  assert.match(worker, /\.waitUntil\(self\.skipWaiting\(\)\)/);
  assert.match(worker, /denylist:\[\/\^\\\/api/);

  const precacheUrls = [...worker.matchAll(/"revision":(?:null|"[^"]+"),"url":"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(precacheUrls.some((url) => url.startsWith('assets/') && url.endsWith('.js')));
  assert.ok(precacheUrls.some((url) => url.startsWith('assets/') && url.endsWith('.css')));
  assert.ok(precacheUrls.every((url) => !/^\/?api(?:\/|$)/i.test(url)));
  for (const url of precacheUrls) {
    assert.ok(existsSync(path.join(publicDir, url)), `Missing precached static asset ${url}`);
  }

  const runtimeRoutes = workerSource.match(/registerRoute\(/g) ?? [];
  assert.equal(runtimeRoutes.length, 1, 'Only the denylisted navigation-shell route should be registered');

  const appChunks = readdirSync(path.join(publicDir, 'assets'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(path.join(publicDir, 'assets', file), 'utf8'))
    .join('\n');
  assert.ok(appChunks.includes(`${basePath}sw.js`), 'The app should register the worker under the Vite base path');
  assert.ok(appChunks.includes(`scope:\`${basePath}\``), 'The worker scope should match the Vite base path');
  assert.ok(appChunks.includes('Refresh to update'), 'A waiting worker must require an explicit user action');
  assert.ok(appChunks.includes('Save or finish your work before refreshing'), 'The update action should warn about unsaved work');
});
