import assert from './assertions.mjs';
import { scheduleFixture, profileWorkbook } from './schedule-fixture.mjs';

export function scheduledDate(value) {
  assert.equal(typeof value, 'string', 'A scheduled run must include its scheduled date');
  assert.match(value, /^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/, 'Expected a date or serialized UTC date');
  return value.slice(0, 10);
}

// Accepts a real Playwright Page signed in through Clerk. No API interception,
// authentication bypass, fixed clock, database mutations, or existing data needed.
export async function verifyScheduleImport(page, baseURL, resumeAfterImport = null) {
  const origin = new URL(baseURL).origin;
  const go = (path) => page.goto(new URL(path, baseURL).href);
  const eventually = async (check) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { return await check(); } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  };
  const visibleText = async (locator, text) => eventually(async () => {
    assert.equal(await locator.isVisible(), true);
    assert.ok((await locator.innerText()).includes(text), `Expected visible text: ${text}`);
  });
  const enabled = (locator, expected) => eventually(async () => {
    assert.equal(await locator.isEnabled(), expected);
  });
  const api = async (path) => {
    // Use the actual browser's Clerk session and V2 cookie, not a mocked API.
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      return { status: response.status, body: await response.json() };
    }, new URL(path, origin).href);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const suffix = resumeAfterImport?.suffix ?? globalThis.crypto.randomUUID().slice(0, 8);
  if (!resumeAfterImport) {
    await go('/');
    await page.getByTestId('input-facility-name').waitFor();
    // The caller must use a fresh disposable account; never operate a real facility.
    const context = await api('/api/facility/context');
    assert.equal(context.facility, null, 'Use a fresh synthetic Clerk account with no facility');
    await page.getByTestId('input-facility-name').fill(`Schedule import QA ${suffix}`);
    await page.getByTestId('button-create-facility').click();
    await eventually(async () => assert.ok((await api('/api/facility/context')).facility));
  } else {
    assert.equal((await api('/api/facility/context')).facility?.name, `Schedule import QA ${suffix}`,
      'Resume is restricted to the synthetic facility created by this scenario');
  }
  await go('/imports');
  await page.getByTestId('input-workbook-file').waitFor();
  const today = resumeAfterImport?.today ?? await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const fixture = scheduleFixture(today, suffix);
  const upload = (name, buffer) => page.getByTestId('input-workbook-file').setInputFiles({
    name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(buffer),
  });
  const profiles = resumeAfterImport ? (await api('/api/v2/product-profiles')).profiles
    .sort((a, b) => a.flavor.localeCompare(b.flavor)) : [];
  if (!resumeAfterImport) for (const flavor of ['Cheese', 'Pepperoni']) {
    await upload(`profile-${flavor}-${suffix}.xlsx`, profileWorkbook(`${suffix} ${flavor}`));
    await page.getByTestId('select-workbook-kind').selectOption('product_specs');
    await page.getByLabel('Brand', { exact: true }).fill(fixture.brand);
    await page.getByLabel('Flavor', { exact: true }).fill(flavor);
    const response = page.waitForResponse((r) => r.url().endsWith('/api/v2/product-profiles') && r.request().method() === 'POST');
    await page.getByTestId('button-import-profile').click();
    const saved = await response;
    assert.ok(saved.ok(), `Profile import failed with HTTP ${saved.status()}`);
    const { profile } = await saved.json();
    assert.equal(profile.mergedIntoId, null);
    profiles.push(profile);
    await page.getByTestId(`card-profile-${profile.id}`).waitFor();
  }
  if (!resumeAfterImport) {
    assert.deepEqual((await api('/api/v2/runs')).runs, []);
    assert.equal((await api('/api/v2/import-batches')).imports.filter((b) => b.importKind === 'schedule').length, 0);
  }

  const reviewAndMap = async () => {
    await upload(fixture.name, fixture.buffer);
    await eventually(async () => assert.equal(await page.getByTestId('select-workbook-kind').inputValue(), 'schedule'));
    await visibleText(page.getByTestId('text-schedule-run-count'), '3 eligible rows');
    await visibleText(page.getByTestId('schedule-past-rows-notice'), '1 past schedule row was ignored');
    await visibleText(page.getByTestId('schedule-past-rows-notice'), today);
    for (const [index, row] of fixture.expected.entries()) {
      const preview = page.getByTestId(`schedule-row-${index}`);
      for (const text of [row.date, row.brand, row.flavor, String(row.casesPlanned), `${row.source.sheet} · row ${row.source.row}`]) {
        await visibleText(preview, text);
      }
      if (row.notes) await visibleText(preview, row.notes);
    }
    assert.equal(await page.getByTestId('schedule-preview').getByText('Past-only flavor', { exact: true }).count(), 0);
    assert.equal(await page.getByTestId('schedule-preview').locator('tbody tr').count(), 3);
    const exact = page.getByLabel(`${fixture.brand} / Cheese · 2 rows`, { exact: true });
    const alias = page.getByLabel(`${fixture.brand} / Pepperoni alias · 1 row`, { exact: true });
    assert.equal(await page.getByTestId('schedule-preview').locator('.schedule-mappings select').count(), 2);
    assert.equal(await exact.inputValue(), profiles[0].id, 'Exact matches should be preselected');
    assert.equal(await alias.inputValue(), '', 'Aliases require explicit mapping');
    await enabled(page.getByTestId('button-import-schedule'), false);
    await alias.selectOption(profiles[1].id);
    await exact.selectOption(profiles[0].id);
    await enabled(page.getByTestId('button-import-schedule'), true);
  };
  const submit = async () => {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/v2/schedule-imports') && r.request().method() === 'POST');
    await page.getByTestId('button-import-schedule').click();
    const saved = await response;
    assert.ok(saved.ok(), `Schedule import failed with HTTP ${saved.status()}`);
    return saved.json();
  };
  let first;
  if (!resumeAfterImport) {
    await reviewAndMap();
    assert.deepEqual((await api('/api/v2/runs')).runs, [], 'Review must not create runs');
    first = await submit();
  } else {
    const batches = (await api('/api/v2/import-batches')).imports.filter((b) => b.importKind === 'schedule');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].sourceName, fixture.name);
    assert.equal(profiles.length, 2);
    first = { importId: batches[0].id, importedCount: batches[0].scheduleRunCount, ignoredPastCount: 1, replayed: false };
  }
  assert.equal(first.replayed, false);
  assert.equal(first.importedCount, 3);
  assert.equal(first.ignoredPastCount, 1);
  if (!resumeAfterImport) await visibleText(page.getByTestId('schedule-preview'), '3 planned runs were created. 1 past row was ignored.');
  const history = page.getByTestId(`row-import-${first.importId}`);
  await visibleText(history, fixture.name);
  await visibleText(history, 'Production schedule · 3 planned runs');
  await visibleText(history, 'Applied');
  const runs = (await api('/api/v2/runs')).runs;
  assert.equal(runs.length, 3);
  const verifyRuns = async () => {
    await go('/runs');
    for (const expected of fixture.expected) {
      const run = runs.find((r) => r.scheduleSource?.row === expected.source.row);
      assert.ok(run, `Missing run for source row ${expected.source.row}`);
      const profile = expected.flavor === 'Pepperoni alias' ? profiles[1] : profiles[0];
      assert.equal(run.status, 'planned');
      assert.equal(scheduledDate(run.scheduledFor), expected.date);
      assert.equal(run.setupSnapshot.targetCases, expected.casesPlanned);
      assert.equal(run.setupSnapshot.productProfileId, profile.id);
      assert.deepEqual(run.productSnapshot, profile);
      assert.equal(run.scheduleNotes, expected.notes || null);
      assert.deepEqual(run.scheduleSource, {
        importId: first.importId, file: fixture.name, ...expected.source,
        brand: expected.brand, flavor: expected.flavor,
      });
      const link = page.getByTestId(`link-run-${run.id}`);
      await visibleText(link, `${profile.brand} / ${profile.flavor}`);
      await visibleText(link, `${expected.casesPlanned} target cases · Scheduled ${expected.date}`);
      await eventually(async () => assert.equal((await link.getByTestId('status-run-planned').innerText()).trim().toLowerCase(), 'planned'));
      await link.click();
      await visibleText(page.locator('main'), `Scheduled ${expected.date}`);
      await visibleText(page.locator('main'), `Imported from ${fixture.name} · ${expected.source.sheet}, row ${expected.source.row} · listed as ${expected.brand} / ${expected.flavor}`);
      if (expected.notes) await visibleText(page.getByRole('note', { name: 'Schedule notes' }), expected.notes);
      await go('/runs');
    }
  };
  await verifyRuns();
  await go('/imports');
  await reviewAndMap(); // Re-select the identical bytes, not merely re-click submit.
  const replay = await submit();
  assert.equal(replay.replayed, true);
  assert.equal(replay.importId, first.importId);
  assert.equal(replay.importedCount, 3);
  assert.equal(replay.ignoredPastCount, 1);
  await visibleText(page.getByTestId('schedule-preview'), 'This schedule was already imported. 3 planned runs are linked to it.');
  const after = (await api('/api/v2/runs')).runs;
  assert.deepEqual(after, runs, 'Replay must leave all run IDs, snapshots, revisions and source data unchanged');
  const batches = (await api('/api/v2/import-batches')).imports.filter((b) => b.importKind === 'schedule');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, first.importId);
  await page.reload();
  await visibleText(page.getByTestId(`row-import-${first.importId}`), '3 planned runs');
  await verifyRuns();
  return { importId: first.importId, runIds: runs.map((run) => run.id), file: fixture.name, today };
}
