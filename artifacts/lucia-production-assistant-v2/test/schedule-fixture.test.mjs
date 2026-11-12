import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkbookFile, parseScheduleWorkbook } from '../src/importing/workbook.ts';
import { scheduleFixture } from './browser/schedule-fixture.mjs';
import { scheduledDate } from './browser/schedule-import.mjs';
import browserAssert from './browser/assertions.mjs';

test('notebook-compatible assertions reject mismatches and compare JSON objects independent of key order', () => {
  browserAssert.deepEqual({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 });
  assert.throws(() => browserAssert.deepEqual({ a: [1, 2] }, { a: [2, 1] }));
  assert.throws(() => browserAssert.equal('planned', 'Planned'));
  assert.throws(() => browserAssert.ok(false));
  assert.throws(() => browserAssert.match('invalid', /^\d{4}-/));
});

test('browser assertions compare scheduled calendar dates across API serialization', () => {
  assert.equal(scheduledDate('2026-11-12T00:00:00.000Z'), '2026-11-12');
  assert.equal(scheduledDate('2026-11-12'), '2026-11-12');
  assert.throws(() => scheduledDate(null));
  assert.throws(() => scheduledDate('not a date'));
  assert.throws(() => scheduledDate('2026-11-12T12:00:00.000Z'));
});

test('browser schedule fixture retains today and future rows with precise provenance, excluding the past', async () => {
  const fixture = scheduleFixture('2026-12-31', 'fixture');
  const workbook = await parseWorkbookFile(new File([fixture.buffer], fixture.name));
  assert.equal(workbook.kind, 'schedule');
  const parsed = parseScheduleWorkbook(workbook, '2026-12-31');
  assert.equal(parsed.ignoredPastCount, 1);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.runs, fixture.expected.map((run) => ({
    ...run, source: { file: fixture.name, ...run.source },
  })));
  assert.equal(parsed.runs[1].date, '2027-01-02');
});
