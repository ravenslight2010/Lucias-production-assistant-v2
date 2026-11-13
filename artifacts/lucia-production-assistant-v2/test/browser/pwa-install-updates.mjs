import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

async function workerDigest(page, workerUrl) {
  const response = await page.request.get(workerUrl);
  assert.equal(response.status(), 200, `Expected service worker at ${workerUrl}`);
  return createHash('sha256').update(await response.body()).digest('hex');
}

/**
 * Run with a production deployment fixture that can switch builds at the same
 * origin and base path. This scenario never signs in or performs data writes.
 */
export async function verifyPwaInstallAndUpdate(page, baseURL, deployNextVersion) {
  assert.equal(typeof deployNextVersion, 'function', 'A same-origin second-build deployment callback is required');
  const appUrl = new URL(baseURL);
  await page.goto(baseURL);
  await page.waitForSelector('[data-testid="pwa-controls"]');

  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  assert.ok(manifestUrl);
  const manifestResponse = await page.request.get(new URL(manifestUrl, baseURL).href);
  assert.equal(manifestResponse.status(), 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(new URL(manifest.start_url, baseURL).pathname, new URL(manifest.scope, baseURL).pathname);
  assert.ok(new URL(manifest.scope, baseURL).pathname.startsWith(appUrl.pathname));
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, baseURL).href);
    assert.equal(response.status(), 200, `Install icon failed to load: ${icon.src}`);
    assert.match(response.headers()['content-type'] ?? '', /image\/png/);
  }

  const installHelp = page.locator('.pwa-install-help').first();
  if (await installHelp.count()) {
    await installHelp.locator('summary').click();
    assert.ok((await installHelp.textContent())?.includes('Add to Home Screen')
      || (await installHelp.textContent())?.includes('browser menu'));
  } else {
    assert.equal(await page.getByTestId('button-install-app').isVisible(), true);
  }

  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperties(event, {
      prompt: { value: async () => { window.__pwaPromptInvoked = true; } },
      userChoice: { value: Promise.resolve({ outcome: 'accepted', platform: 'test' }) },
    });
    window.dispatchEvent(event);
  });
  await page.getByTestId('button-install-app').click();
  assert.equal(await page.evaluate(() => window.__pwaPromptInvoked), true);

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
    await page.waitForSelector('[data-testid="pwa-controls"]');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  }
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.evaluate(async () => {
    const response = await fetch('/api/facility/context', { credentials: 'include' });
    return response.status;
  });
  const apiCacheEntries = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return entries.flat().map((request) => new URL(request.url).pathname).filter((pathname) => pathname.startsWith('/api/'));
  });
  assert.deepEqual(apiCacheEntries, [], 'Authenticated facility/API responses must not be cached');
  const workerUrl = new URL('sw.js', new URL(manifest.scope, baseURL)).href;
  const oldWorkerDigest = await workerDigest(page, workerUrl);
  const originalUrl = page.url();
  let navigationsAfterDeploy = 0;
  const countNavigation = (frame) => {
    if (frame === page.mainFrame()) navigationsAfterDeploy += 1;
  };
  page.on('framenavigated', countNavigation);

  await deployNextVersion();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('Lucia service worker was not registered');
    await registration.update();
  });
  await page.getByTestId('pwa-update-notice').waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(page.url(), originalUrl);
  assert.equal(navigationsAfterDeploy, 0, 'A detected update must not reload the current page automatically');
  page.off('framenavigated', countNavigation);

  const refresh = page.waitForEvent('load', { timeout: 30_000 });
  await page.getByTestId('button-apply-app-update').click();
  await refresh;
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const newWorkerDigest = await workerDigest(page, workerUrl);
  assert.notEqual(newWorkerDigest, oldWorkerDigest, 'The user-confirmed refresh should activate the new deployment worker');
  return { manifestScope: manifest.scope, oldWorkerDigest, newWorkerDigest };
}

/**
 * Run with an authenticated disposable production-run fixture that has at
 * least one lifecycle action and one station control visible.
 */
export async function verifyOfflineRunReadOnly(page, runURL) {
  await page.goto(runURL);
  await page.waitForSelector('[data-testid^="text-run-name-"]');
  await page.waitForSelector('[data-testid^="row-run-station-"]');
  const apiCacheEntries = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return entries.flat().map((request) => new URL(request.url).pathname).filter((pathname) => pathname.startsWith('/api/'));
  });
  assert.deepEqual(apiCacheEntries, [], 'Authenticated run responses must not be cached by the service worker');
  await page.context().setOffline(true);
  try {
    await page.waitForSelector('[data-testid="status-offline"]');
    const controls = page.locator(
      'button[data-testid^="button-run-"], input[data-testid^="input-station-produced-"], ' +
      'select[data-testid^="select-station-preparation-"], button[data-testid^="button-save-station-"], ' +
      'input[data-testid^="input-station-count-"]',
    );
    await page.waitForFunction(() => document.querySelector('[data-testid="status-offline"]') !== null);
    const states = await controls.evaluateAll((elements) => elements.map((element) => ({
      testId: element.getAttribute('data-testid'),
      disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.disabled
        : false,
    })));
    assert.ok(states.length > 0, 'The offline fixture must expose run and station controls');
    assert.ok(states.every((control) => control.disabled), 'Every production mutation control must be disabled offline');
    assert.ok((await page.locator('[data-testid="status-offline"]').textContent())?.includes('read-only'));
  } finally {
    await page.context().setOffline(false);
  }
}
