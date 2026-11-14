import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dateInTimeZone,
  formatProductionDate,
  isRunCarriedOver,
  PRODUCTION_DAY_TIMEZONE,
} from '../src/production-day.ts';

test('Chicago production day changes at local midnight and follows daylight saving time', () => {
  assert.equal(dateInTimeZone('2026-11-13T05:59:00.000Z', PRODUCTION_DAY_TIMEZONE), '2026-11-12');
  assert.equal(dateInTimeZone('2026-11-13T06:00:00.000Z', PRODUCTION_DAY_TIMEZONE), '2026-11-13');
  assert.equal(dateInTimeZone('2026-07-14T04:59:00.000Z', PRODUCTION_DAY_TIMEZONE), '2026-07-13');
  assert.equal(dateInTimeZone('2026-07-14T05:00:00.000Z', PRODUCTION_DAY_TIMEZONE), '2026-07-14');
});

test('only unfinished runs from before today are labeled as carryover', () => {
  const base = {
    createdAt: '2026-11-12T14:00:00.000Z',
    scheduledFor: null,
    startedAt: null,
  };
  assert.equal(isRunCarriedOver({ ...base, status: 'planned' }, '2026-11-13', PRODUCTION_DAY_TIMEZONE), true);
  assert.equal(isRunCarriedOver({
    ...base,
    status: 'planned',
    scheduledFor: '2026-11-13',
  }, '2026-11-13', PRODUCTION_DAY_TIMEZONE), false);
  assert.equal(isRunCarriedOver({
    ...base,
    status: 'running',
    startedAt: '2026-11-12T15:00:00.000Z',
  }, '2026-11-13', PRODUCTION_DAY_TIMEZONE), true);
  assert.equal(isRunCarriedOver({ ...base, status: 'completed' }, '2026-11-13', PRODUCTION_DAY_TIMEZONE), false);
});

test('production date formatting uses the facility timezone', () => {
  assert.equal(
    formatProductionDate('2026-11-13', PRODUCTION_DAY_TIMEZONE),
    new Intl.DateTimeFormat(undefined, {
      timeZone: PRODUCTION_DAY_TIMEZONE,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(new Date('2026-11-13T12:00:00.000Z')),
  );
});
