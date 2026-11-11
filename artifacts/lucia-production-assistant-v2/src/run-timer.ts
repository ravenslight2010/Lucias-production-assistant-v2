import type { RunStatus } from '@workspace/api-client-react';

export type LineTimerRun = {
  status: RunStatus;
  startedAt: string | null;
  pausedAt: string | null;
  resumedAt: string | null;
  completedAt: string | null;
  pauseIntervals: Array<{ startedAt: string; endedAt: string | null }>;
};

export function elapsedMilliseconds(run: LineTimerRun, now: number) {
  if (!run.startedAt) return 0;
  const startedAt = Date.parse(run.startedAt);
  if (Number.isNaN(startedAt)) return 0;
  const endedAt =
    run.status === 'completed' && run.completedAt
      ? Date.parse(run.completedAt)
      : now;
  const wallTime = Math.max(0, endedAt - startedAt);
  const pausedTime = run.pauseIntervals.reduce((total, interval) => {
    const pauseStart = Date.parse(interval.startedAt);
    const pauseEnd = interval.endedAt ? Date.parse(interval.endedAt) : endedAt;
    if (Number.isNaN(pauseStart) || Number.isNaN(pauseEnd)) return total;
    return total + Math.max(0, pauseEnd - pauseStart);
  }, 0);
  return Math.max(0, wallTime - pausedTime);
}

export function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
