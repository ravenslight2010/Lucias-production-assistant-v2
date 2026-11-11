import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetRunStationProgressQueryKey,
  useGetRunStationProgress,
  useUpdateRunStationProgress,
} from '@workspace/api-client-react';
import type {
  FacilityStationArea,
  RunStationProgressList,
  RunStationProgressStatus,
  RunStatus,
} from '@workspace/api-client-react';
import { Check, CircleAlert, LoaderCircle, MapPinned } from 'lucide-react';
import './run-station-progress.css';

const areaLabels: Record<FacilityStationArea, string> = {
  dough_sauce_prep: 'Dough & sauce prep',
  production_line: 'Production line',
  freezing_packaging: 'Freezing & packaging',
  warehouse: 'Warehouse',
};

const statusLabels: Record<RunStationProgressStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Complete',
};

function errorStatus(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Station progress could not be loaded or saved. Check your connection and try again.';
}

function formatTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export default function RunStationProgress({
  runId,
  runStatus,
  online,
}: {
  runId: string;
  runStatus: RunStatus;
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
  const updateProgress = useUpdateRunStationProgress({
    request: { credentials: 'include' },
  });
  const [feedback, setFeedback] = useState('');
  const stations = progressQuery.data?.stations ?? [];
  const completeCount = stations.filter(
    (station) => station.status === 'completed',
  ).length;
  const isOperational = runStatus === 'running' || runStatus === 'paused';
  const isLegacyComplete =
    runStatus === 'completed' && progressQuery.data?.initialized === false;

  const setStationStatus = (
    stationId: string,
    expectedRevision: number,
    status: RunStationProgressStatus,
  ) => {
    if (!isOperational || !online || updateProgress.isPending) return;
    setFeedback('');
    updateProgress.mutate(
      {
        runId,
        stationId,
        data: { expectedRevision, status },
      },
      {
        onSuccess: (result) => {
          client.setQueryData<RunStationProgressList>(queryKey, result);
          setFeedback('Station progress is shared with the facility team.');
          void client.invalidateQueries({ queryKey });
        },
        onError: (error) => {
          if (errorStatus(error) === 409) {
            setFeedback('This station changed on another device. Latest progress loaded.');
            void client.invalidateQueries({ queryKey });
            return;
          }
          setFeedback(errorMessage(error));
        },
      },
    );
  };

  return (
    <section
      className="panel run-station-progress"
      aria-labelledby="run-station-progress-title"
      data-testid="section-run-station-progress"
    >
      <header className="run-station-progress-head">
        <div>
          <div className="eyebrow">Floor progress</div>
          <h2 id="run-station-progress-title">Stations on this run</h2>
          <p className="page-subtitle">
            {stations.length
              ? `${completeCount} of ${stations.length} stations complete`
              : 'Track work across the facility lineup.'}
          </p>
        </div>
        <span className="run-station-progress-mark" aria-hidden="true">
          <MapPinned size={19} />
        </span>
      </header>

      {progressQuery.isLoading && !progressQuery.data && (
        <div
          className="run-station-loading"
          aria-label="Loading station progress"
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
          Could not refresh. Showing the last saved station progress.
        </div>
      )}

      {progressQuery.data && (
        <>
          {!online && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-offline">
              Offline view — station updates are paused.
            </div>
          )}
          {!progressQuery.data.initialized && runStatus === 'planned' && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-preview">
              This lineup will be saved to the run when production starts.
            </div>
          )}
          {!progressQuery.data.initialized && isOperational && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-legacy">
              This run started before station tracking. Its current active lineup will be saved with the first update.
            </div>
          )}
          {isLegacyComplete && (
            <div className="run-station-empty" data-testid="empty-run-station-history">
              This run was completed before station tracking was available.
            </div>
          )}
          {feedback && (
            <div
              className={`run-station-feedback ${updateProgress.isError ? 'run-station-feedback-error' : 'run-station-feedback-success'}`}
              role={updateProgress.isError ? 'alert' : 'status'}
              data-testid="status-run-station-feedback"
            >
              {updateProgress.isError ? <CircleAlert size={15} /> : <Check size={15} />}
              <span>{feedback}</span>
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
                      {areaStations.map((station) => {
                        const pending =
                          updateProgress.isPending &&
                          updateProgress.variables?.stationId === station.stationId;
                        const updatedTime = formatTime(station.updatedAt);
                        return (
                          <li className="run-station-row" key={station.stationId} data-testid={`row-run-station-${station.stationId}`}>
                            <span className="run-station-order" aria-label={`Station ${station.order + 1}`}>
                              {String(station.order + 1).padStart(2, '0')}
                            </span>
                            <div className="run-station-identity">
                              <strong>{station.stationName}</strong>
                              <span className={`run-station-state run-station-state-${station.status}`}>
                                {statusLabels[station.status]}
                                {updatedTime ? ` · Updated ${updatedTime}` : ''}
                              </span>
                            </div>
                            <label className="sr-only" htmlFor={`run-station-status-${station.stationId}`}>
                              Progress for {station.stationName}
                            </label>
                            <select
                              id={`run-station-status-${station.stationId}`}
                              className="run-station-status-select"
                              value={station.status}
                              disabled={!isOperational || !online || updateProgress.isPending}
                              onChange={(event) => setStationStatus(
                                station.stationId,
                                station.revision,
                                event.target.value as RunStationProgressStatus,
                              )}
                              data-testid={`select-run-station-status-${station.stationId}`}
                            >
                              {Object.entries(statusLabels).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            {pending && <LoaderCircle className="run-station-spinner" size={16} aria-label="Saving station status" />}
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                );
              })}
            </div>
          )}
          {progressQuery.data.initialized && runStatus === 'completed' && (
            <div className="run-station-feedback" role="status">
              This run is complete. Station progress is read-only.
            </div>
          )}
        </>
      )}
    </section>
  );
}
