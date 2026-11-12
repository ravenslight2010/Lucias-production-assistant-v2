import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetRunStationProgressQueryKey,
  useGetRunStationProgress,
  useUpdateRunStationProgress,
} from '@workspace/api-client-react';
import type {
  FacilityStationArea,
  RunStationPreparationStatus,
  RunStationProgressList,
  RunStationProgressStatus,
} from '@workspace/api-client-react';
import { Check, CircleAlert, LoaderCircle, MapPinned, Save } from 'lucide-react';
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

const preparationLabels: Record<RunStationPreparationStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  ready: 'Ready',
  not_required: 'Not required',
};

type StationDraft = {
  producedCount: string;
  preparationStatus: RunStationPreparationStatus;
  expectedRevision: number;
  dirty: boolean;
};
type StationDrafts = Record<string, StationDraft>;

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Station progress could not be saved. Check your connection and try again.';
}

function statusOf(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status?: number }).status;
  }
  return undefined;
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

function stationEventLabel(status: RunStationProgressStatus, run: LineTimerRun) {
  if (status === 'not_started') return 'Starts with the line timer';
  const eventAt =
    status === 'completed'
      ? run.completedAt
      : status === 'paused'
        ? run.pausedAt
        : run.resumedAt ?? run.startedAt;
  const time = timestamp(eventAt);
  const label =
    status === 'completed'
      ? 'Ended'
      : status === 'paused'
        ? 'Paused'
        : run.resumedAt
          ? 'Resumed'
          : 'Started';
  return `${label}${time ? ` at ${time}` : ''}`;
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
  const updateProgress = useUpdateRunStationProgress({
    request: { credentials: 'include' },
  });
  const [drafts, setDrafts] = useState<StationDrafts>({});
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState('');
  const commandIds = useRef<Record<string, { signature: string; id: string }>>({});
  const [now, setNow] = useState(() => Date.now());
  const stations = progressQuery.data?.stations ?? [];
  const elapsed = formatElapsed(elapsedMilliseconds(run, now));
  const totalProduced = stations.reduce((total, station) => total + station.producedCount, 0);
  const preparedCount = stations.filter(
    (station) =>
      station.preparationStatus === 'ready' ||
      station.preparationStatus === 'not_required',
  ).length;
  const isLegacyComplete =
    run.status === 'completed' && progressQuery.data?.initialized === false;

  useEffect(() => {
    setDrafts({});
    setConflicts({});
    commandIds.current = {};
    setFeedback('');
  }, [runId]);

  useEffect(() => {
    setNow(Date.now());
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status, run.startedAt, run.pausedAt, run.resumedAt, run.completedAt]);

  useEffect(() => {
    const savedStations = progressQuery.data?.stations;
    if (!savedStations) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const station of savedStations) {
        if (current[station.stationId]?.dirty) continue;
        next[station.stationId] = {
          producedCount: String(station.producedCount),
          preparationStatus: station.preparationStatus,
          expectedRevision: station.revision,
          dirty: false,
        };
      }
      return next;
    });
  }, [progressQuery.data]);

  const lineTimerLabel =
    run.status === 'planned'
      ? 'Waiting to start'
      : run.status === 'running'
        ? 'Running'
        : run.status === 'paused'
          ? 'Paused'
          : 'Ended';

  const changeDraft = (
    stationId: string,
    changes: Partial<Pick<StationDraft, 'producedCount' | 'preparationStatus'>>,
  ) => {
    const station = stations.find((item) => item.stationId === stationId);
    if (!station) return;
    setDrafts((current) => {
      const prior = current[stationId];
      return {
        ...current,
        [stationId]: {
          producedCount: prior?.producedCount ?? String(station.producedCount),
          preparationStatus: prior?.preparationStatus ?? station.preparationStatus,
          expectedRevision: prior?.expectedRevision ?? station.revision,
          ...changes,
          dirty: true,
        },
      };
    });
    updateProgress.reset();
    setFeedback('');
  };

  const saveStation = (stationId: string) => {
    const draft = drafts[stationId];
    if (!draft || !online || updateProgress.isPending) return;
    const producedCount = Number(draft.producedCount);
    if (
      !Number.isSafeInteger(producedCount) ||
      producedCount < 0 ||
      producedCount > 2_147_483_647
    ) {
      setFeedback('Enter a whole production count between 0 and 2,147,483,647.');
      return;
    }
    const body = {
      expectedRevision: draft.expectedRevision,
      producedCount,
      preparationStatus: draft.preparationStatus,
    };
    const signature = JSON.stringify(body);
    const existing = commandIds.current[stationId];
    const commandId =
      existing?.signature === signature ? existing.id : crypto.randomUUID();
    commandIds.current[stationId] = { signature, id: commandId };
    setFeedback('');
    updateProgress.mutate(
      {
        runId,
        stationId,
        data: { commandId, ...body },
      },
      {
        onSuccess: (result) => {
          delete commandIds.current[stationId];
          setConflicts((current) => ({ ...current, [stationId]: false }));
          setFeedback(
            result.replayed
              ? 'This update was already saved. Showing the latest station values.'
              : 'Station progress saved.',
          );
          client.setQueryData<RunStationProgressList>(queryKey, (current) =>
            current
              ? {
                  ...current,
                  initialized: true,
                  stations: current.stations.map((station) =>
                    station.stationId === stationId ? result.station : station,
                  ),
                }
              : current,
          );
          setDrafts((current) => ({
            ...current,
            [stationId]: {
              producedCount: String(result.station.producedCount),
              preparationStatus: result.station.preparationStatus,
              expectedRevision: result.station.revision,
              dirty: false,
            },
          }));
          void client.invalidateQueries({ queryKey });
        },
        onError: (error) => {
          setFeedback(errorMessage(error));
          if (statusOf(error) === 409) {
            void progressQuery.refetch().then(({ data }) => {
              if (data?.stations.some((station) => station.stationId === stationId)) {
                setConflicts((current) => ({ ...current, [stationId]: true }));
              }
            });
          }
        },
      },
    );
  };

  const useLatestRevision = (stationId: string) => {
    const latest = stations.find((station) => station.stationId === stationId);
    if (!latest) return;
    setDrafts((current) => {
      const draft = current[stationId];
      if (!draft) return current;
      return {
        ...current,
        [stationId]: { ...draft, expectedRevision: latest.revision, dirty: true },
      };
    });
    delete commandIds.current[stationId];
    setConflicts((current) => ({ ...current, [stationId]: false }));
    updateProgress.reset();
    setFeedback('Latest revision loaded. Review your entries, then save again.');
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
          <h2 id="run-station-progress-title">Station progress</h2>
          <p className="page-subtitle">
            Record production and preparation. Station timing follows the line timer.
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

      {progressQuery.data && !isLegacyComplete && (
        <div className="run-station-summary" aria-label="Run production totals">
          <div><strong data-testid="text-run-produced-total">{totalProduced}</strong><span>Total produced</span></div>
          <div><strong data-testid="text-run-preparation-ready-count">{preparedCount} / {stations.length}</strong><span>Preparation ready</span></div>
        </div>
      )}

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

      {feedback && (
        <div
          className={`run-station-feedback ${updateProgress.isError ? 'run-station-feedback-error' : 'run-station-feedback-success'}`}
          role={updateProgress.isError ? 'alert' : 'status'}
          data-testid="status-run-station-save"
        >
          {updateProgress.isError ? <CircleAlert size={16} /> : <Check size={16} />}
          <span>{feedback}</span>
        </div>
      )}

      {progressQuery.data && (
        <>
          {!online && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-offline">
              Offline view — saved station progress is read-only.
            </div>
          )}
          {!progressQuery.data.initialized && run.status === 'planned' && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-preview">
              The active lineup is ready. Every station starts with the line timer.
            </div>
          )}
          {!progressQuery.data.initialized && (run.status === 'running' || run.status === 'paused') && (
            <div className="run-station-feedback" role="status" data-testid="status-run-station-legacy">
              This run predates station snapshots. Its current lineup will be saved with your first station update or line-timer action.
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
                      {areaStations.map((station) => {
                        const draft = drafts[station.stationId] ?? {
                          producedCount: String(station.producedCount),
                          preparationStatus: station.preparationStatus,
                          expectedRevision: station.revision,
                          dirty: false,
                        };
                        const isSaving =
                          updateProgress.isPending &&
                          updateProgress.variables?.stationId === station.stationId;
                        return (
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
                                {stationEventLabel(station.status, run)}
                              </span>
                            </div>
                            <div className="run-station-fields">
                              <label>
                                <span>Produced</span>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  max={2_147_483_647}
                                  step={1}
                                  value={draft.producedCount}
                                  disabled={!online || updateProgress.isPending}
                                  aria-label={`${station.stationName} produced count`}
                                  data-testid={`input-station-produced-${station.stationId}`}
                                  onChange={(event) => changeDraft(station.stationId, { producedCount: event.target.value })}
                                />
                              </label>
                              <label>
                                <span>Preparation pull</span>
                                <select
                                  value={draft.preparationStatus}
                                  disabled={!online || updateProgress.isPending}
                                  aria-label={`${station.stationName} preparation status`}
                                  data-testid={`select-station-preparation-${station.stationId}`}
                                  onChange={(event) => changeDraft(station.stationId, { preparationStatus: event.target.value as RunStationPreparationStatus })}
                                >
                                  {(Object.keys(preparationLabels) as RunStationPreparationStatus[]).map((value) => (
                                    <option value={value} key={value}>{preparationLabels[value]}</option>
                                  ))}
                                </select>
                              </label>
                              <button
                                className="button button-secondary run-station-save"
                                type="button"
                                onClick={() => saveStation(station.stationId)}
                                disabled={!online || !draft.dirty || updateProgress.isPending}
                                data-testid={`button-save-station-${station.stationId}`}
                              >
                                {isSaving ? <LoaderCircle size={15} className="station-spin" /> : <Save size={15} />}
                                {isSaving ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                            <div className="run-station-saved" aria-live="polite">
                              Saved: {station.producedCount} produced · {preparationLabels[station.preparationStatus]} · Rev {station.revision}
                              {conflicts[station.stationId] && (
                                  <button type="button" onClick={() => useLatestRevision(station.stationId)} disabled={progressQuery.isFetching} data-testid={`button-use-latest-station-${station.stationId}`}>
                                  {progressQuery.isFetching ? 'Loading latest…' : 'Use latest revision'}
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
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
