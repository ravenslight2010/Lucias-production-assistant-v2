import assert from 'node:assert/strict';
import test from 'node:test';
import { elapsedMilliseconds, formatElapsed } from '../src/run-timer.ts';

const at = (value) => Date.parse(`2026-11-11T${value}:00.000Z`);

test('line timer excludes completed pause intervals', () => {
  const run = {
    status: 'running',
    startedAt: new Date(at('10:00')).toISOString(),
    pausedAt: null,
    resumedAt: new Date(at('10:30')).toISOString(),
    completedAt: null,
    pauseIntervals: [
      {
        startedAt: new Date(at('10:15')).toISOString(),
        endedAt: new Date(at('10:30')).toISOString(),
      },
    ],
  };

  assert.equal(elapsedMilliseconds(run, at('11:00')), 45 * 60 * 1000);
});

test('paused line timer stays fixed while the pause is open', () => {
  const run = {
    status: 'paused',
    startedAt: new Date(at('10:00')).toISOString(),
    pausedAt: new Date(at('10:15')).toISOString(),
    resumedAt: null,
    completedAt: null,
    pauseIntervals: [
      {
        startedAt: new Date(at('10:15')).toISOString(),
        endedAt: null,
      },
    ],
  };

  assert.equal(elapsedMilliseconds(run, at('10:45')), 15 * 60 * 1000);
  assert.equal(elapsedMilliseconds(run, at('11:30')), 15 * 60 * 1000);
});

test('completed line timer stops at end and excludes all paused time', () => {
  const run = {
    status: 'completed',
    startedAt: new Date(at('10:00')).toISOString(),
    pausedAt: null,
    resumedAt: new Date(at('10:30')).toISOString(),
    completedAt: new Date(at('11:00')).toISOString(),
    pauseIntervals: [
      {
        startedAt: new Date(at('10:15')).toISOString(),
        endedAt: new Date(at('10:30')).toISOString(),
      },
      {
        startedAt: new Date(at('10:40')).toISOString(),
        endedAt: new Date(at('11:00')).toISOString(),
      },
    ],
  };

  assert.equal(elapsedMilliseconds(run, at('12:00')), 25 * 60 * 1000);
});

test('timer displays hours, minutes, and seconds', () => {
  assert.equal(formatElapsed(3_723_000), '01:02:03');
});
