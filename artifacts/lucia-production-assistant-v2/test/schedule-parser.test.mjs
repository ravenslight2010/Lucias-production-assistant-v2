import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseScheduleWorkbook, parseWorkbookFile } from '../src/importing/workbook.ts';

function schedule(date, rows = [['Example', 'Cheese', 12]]) {
  return {
    fileName: 'Schedule.xlsx', sizeBytes: 100, sheetCount: 1, cellCount: 30,
    kind: 'schedule', kindConfidence: 'high',
    sheets: [{ name: 'Week', rows: [
      [date, 'Brand', 'Flavor', 'Units'],
      ...rows.map(row => [null, ...row]),
    ] }],
  };
}

test('schedule dates are real calendar dates, with leap years and no truncated suffixes', () => {
  for (const date of ['2026-02-29', '02/30/26', '2026-13-01', '2026-00-10', '2026-11-12junk']) {
    const result = parseScheduleWorkbook(schedule(date), '2026-01-01');
    assert.equal(result.runs.length, 0, date);
    assert.match(result.errors[0].message, /no valid day date/);
  }
  for (const date of ['2028-02-29', '2/29/28', '2028-02-29T00:00:00.000Z']) {
    assert.equal(parseScheduleWorkbook(schedule(date)).runs[0].date, '2028-02-29');
  }
});

test('fractional Excel times stay on their production day and today is eligible', () => {
  const serial = Date.UTC(2026, 10, 12) / 86_400_000 + 25_569;
  const result = parseScheduleWorkbook(schedule(serial + 0.99999999), '2026-11-12');
  assert.equal(result.runs[0].date, '2026-11-12');
  assert.equal(result.ignoredPastCount, 0);
  const past = parseScheduleWorkbook(schedule(serial + 0.99999999), '2026-11-13');
  assert.equal(past.runs.length, 0);
  assert.equal(past.ignoredPastCount, 1);
});

test('case quantities never silently round, accept malformed grouping, or use numeric code notation', () => {
  const invalid = [1.5, -1, 0, '', '1e3', '0x10', '12,3', '1 2', 2_147_483_648];
  const parsed = parseScheduleWorkbook(schedule('2026-11-12',
    [...invalid.map(n => ['Example', `Invalid ${String(n)}`, n]),
      ['Example', 'Grouped', '1,200'], ['Example', 'Whole decimal', '12.0']]), '2026-11-12');
  assert.equal(parsed.errors.length, invalid.length);
  assert.deepEqual(parsed.runs.map(r => r.casesPlanned), [1200, 12]);
  assert.deepEqual(parsed.runs.map(r => r.source.row), [11, 12]);
});

test('past rows are excluded before quantity validation without hiding current-day errors', () => {
  const workbook = schedule('2026-11-11', [['Example', 'Past', 'invalid']]);
  workbook.sheets[0].rows.push(
    ['2026-11-12', 'Brand', 'Flavor', 'Units'],
    [null, 'Example', 'Today', 25],
    [null, 'Example', 'Needs correction', 2.5],
  );
  const parsed = parseScheduleWorkbook(workbook, '2026-11-12');
  assert.equal(parsed.ignoredPastCount, 1);
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].flavor, 'Today');
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 5);
});

test('uploaded schedule preserves eligible dates and provenance without rolling old plans forward', async () => {
  const name = 'Production_Schedule_10-20-26_1794437309242.xlsx';
  const bytes = readFileSync(new URL(`../../../attached_assets/${name}`, import.meta.url));
  const workbook = await parseWorkbookFile(new File([bytes], name));
  assert.equal(workbook.sheetCount, 96);
  const historicalReview = parseScheduleWorkbook(workbook, '2026-10-20');
  assert.equal(historicalReview.runs.length, 48);
  assert.equal(historicalReview.ignoredPastCount, 2103);
  assert.deepEqual(historicalReview.errors, []);
  assert.ok(historicalReview.runs.every(r => r.date >= '2026-10-20' && r.source.file === name));
  assert.deepEqual(historicalReview.runs[0].source, { file: name, sheet: '10-19', row: 54 });
  const currentReview = parseScheduleWorkbook(workbook, '2026-11-12');
  assert.deepEqual(currentReview.runs, []);
  assert.deepEqual(currentReview.errors, []);
  assert.equal(currentReview.ignoredPastCount, 2151);
});
