import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetRunStationProgressQueryKey,
  useGetRunStationProgress,
} from '@workspace/api-client-react';
import type {
  FacilityStationArea,
  RunStationProgressStatus,
} from '@workspace/api-client-react';
import { CircleAlert, MapPinned } from 'lucide-react';
import { elapsedMilliseconds, formatElapsed, type LineTimerRun } from '@/run-timer';
import './run-station-progress.css';

const areaLabels: Record<FacilityStationArea, string> = {
  dough_sauce_prep: 'Dough & sauce prep',
  production_line: 'Production line',
  freezing_packaging: 'Freezing & packaging',
  warehouse: 'Warehouse',
};

const statusLabels: Record<RunStationProgressStatus, string> = {
  not_started: 'Not started',
  in_progress: 'Running',
  paused: 'Paused',
  completed: 'Ended',
};

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Station timers could not be loaded. Check your connection and try again.';
}

function timestamp(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function stationEventLabel(
  status: RunStationProgressStatus,
  run: LineTimerRun,
  stationUpdatedAt: string | null,
) {
  if (status === 'not_started') return 'Starts with the line timer';
  if (status === 'completed') {
    return `Ended${timestamp(stationUpdatedAt) ? ` at ${timestamp(stationUpdatedAt)}` : ''}`;
  }
  if (status === 'paused') {
    return `Paused${timestamp(stationUpdatedAt) ? ` at ${timestamp(stationUpdatedAt)}` : ''}`;
  }
  const resumed = Boolean(run.resumedAt);
  const eventTime = timestamp(stationUpdatedAt);
  return `${resumed ? 'Resumed' : 'Started'}${eventTime ? ` at ${eventTime}` : ''}`;
}

export default function RunStationProgress({
  runId,
  run,
  online,
}: {
  runId: string;
  run: LineTimerRun;
  online: boolean;
}) {
  const client = useQueryClient();
  const queryKey = getGetRunStationProgressQueryKey(runId);
  const progressQuery = useGetRunStationProgress(runId, {
    query: {
      queryKey,
      enabled: Boolean(runId),
      refetchInterval: online ? 5_000 : false,
    },
    request: { credentials: 'include' },
  });
  const [now, setNow] = useState(() => Date.now());
  const stations = progressQuery.data?.stations ?? [];
  const elapsed = formatElapsed(elapsedMilliseconds(run, now));
  const isLegacyComplete =
    run.status === 'completed' && progressQuery.data?.initialized === false;

  useEffect(() => {
    setNow(Date.now());
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status, run.startedAt, run.pausedAt, run.resumedAt, run.completedAt]);

  const lineTimerLabel =
    run.status === 'planned'
      ? 'Waiting to start'
      : run.status === 'running'
        ? 'Running'
        : run.status === 'paused'
          ? 'Paused'
          : 'Ended';

  return (
    <section
      className="panel run-station-progress"
      aria-labelledby="run-station-progress-title"
      data-testid="section-run-station-progress"
    >
      <header className="run-station-progress-head">
        <div>
          <div className="eyebrow">Floor progress</div>
          <h2 id="run-station-progress-title">Station timers</h2>
          <p className="page-subtitle">
            Every station follows the production line timer.
          </p>
        </div>
        <span className="run-station-progress-mark" aria-hidden="true">
          <MapPinned size={19} />
        </span>
      </header>

      <div className="run-line-timer" data-testid="run-line-timer" aria-live="off">
        <span>{lineTimerLabel}</span>
        <strong className="mono" data-testid="text-line-timer-elapsed">{elapsed}</strong>
      </div>

      {progressQuery.isLoading && !progressQuery.data && (
        <div
          className="run-station-loading"
          aria-label="Loading station timers"
          aria-busy="true"
          data-testid="loading-run-station-progress"
        >
          <div /><div /><div />
        </div>
      )}

      {progressQuery.isError && !progressQuery.data && (
        <div className="run-station-feedback run-station-feedback-error" role="alert">
          <CircleAlert size={16} />
          <span>{errorMessage(progressQuery.error)}</span>
          <button type="button" onClick={() => void progressQuery.refetch()} data-testid="button-retry-run-station-progress">
            Try again
          </button>
        </div>
      )}

      {progressQuery.isError && progressQuery.data && (
        <div className="run-station-feedback" role="status">
          Could not refresh. Showing the last saved station timers.
        </div>
      )}

      {progressQuery.data && (
        <>
          {!online && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-offline">
              Offline view — the line timer and stations are read-only.
            </div>
          )}
          {!progressQuery.data.initialized && run.status === 'planned' && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-preview">
              The active lineup is ready. All station timers start when the line timer starts.
            </div>
          )}
          {!progressQuery.data.initialized && (run.status === 'running' || run.status === 'paused') && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-legacy">
              This run predates station snapshots. Its current lineup will be saved on the next line-timer action.
            </div>
          )}
          {isLegacyComplete && (
            <div className="run-station-empty" data-testid="empty-run-station-history">
              This run ended before station snapshots were available.
            </div>
          )}
          {!isLegacyComplete && stations.length === 0 && (
            <div className="run-station-empty" data-testid="empty-run-station-progress">
              No active stations are in the facility lineup.
            </div>
          )}
          {!isLegacyComplete && stations.length > 0 && (
            <div className="run-station-area-list">
              {(Object.keys(areaLabels) as FacilityStationArea[]).map((area) => {
                const areaStations = stations.filter((station) => station.area === area);
                if (!areaStations.length) return null;
                return (
                  <section className="run-station-area" key={area} aria-labelledby={`run-station-area-${area}`}>
                    <h3 id={`run-station-area-${area}`}>{areaLabels[area]}</h3>
                    <ol>
                      {areaStations.map((station) => (
                        <li className="run-station-row" key={station.stationId} data-testid={`row-run-station-${station.stationId}`}>
                          <span className="run-station-order" aria-label={`Station ${station.order + 1}`}>
                            {String(station.order + 1).padStart(2, '0')}
                          </span>
                          <div className="run-station-identity">
                            <strong>{station.stationName}</strong>
                            <span className={`run-station-state run-station-state-${station.status}`}>
                              {statusLabels[station.status]}
                            </span>
                            <span className="run-station-event">
                              {stationEventLabel(station.status, run, station.updatedAt)}
                            </span>
                          </div>
                          <div className="run-station-timer" aria-label={`Elapsed station time ${elapsed}`}>
                            <span>Line time</span>
                            <strong className="mono">{elapsed}</strong>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
