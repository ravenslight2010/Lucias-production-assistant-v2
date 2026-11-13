import { useRef, useState } from 'react';
import {
  getGetRunPreparationTasksQueryKey,
  useGetRunPreparationTasks,
  useUpdateRunPreparationTask,
} from '@workspace/api-client-react';
import type { RunPreparationTask, RunStatus } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, RotateCcw } from 'lucide-react';
import './run-preparation-checklist.css';

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function statusLabel(status: RunPreparationTask['status']) {
  if (status === 'completed') return 'Pulled';
  if (status === 'in_progress') return 'In progress';
  return 'Not started';
}

export function RunPreparationChecklist({
  runId,
  runStatus,
  online,
  previewTasks,
}: {
  runId: string;
  runStatus: RunStatus;
  online: boolean;
  previewTasks?: RunPreparationTask[];
}) {
  const queryClient = useQueryClient();
  const queryKey = getGetRunPreparationTasksQueryKey(runId);
  const query = useGetRunPreparationTasks(runId, {
    query: { queryKey, enabled: Boolean(runId), refetchInterval: online ? 5_000 : false },
    request: { credentials: 'include' },
  });
  const update = useUpdateRunPreparationTask({ request: { credentials: 'include' } });
  const commandIds = useRef(new Map<string, string>());
  const [feedback, setFeedback] = useState('');
  const [previewState, setPreviewState] = useState<RunPreparationTask[] | null>(null);
  const previewMode = previewTasks !== undefined;
  const tasks = previewMode ? (previewState ?? previewTasks) : (query.data?.tasks ?? []);
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const runIsClosed = runStatus === 'completed';

  function save(task: RunPreparationTask, status: RunPreparationTask['status']) {
    if (!online || runIsClosed || update.isPending) return;
    setFeedback('');
    if (previewMode) {
      setPreviewState((current) => (current ?? previewTasks ?? []).map((item) =>
        item.id === task.id ? { ...item, status, revision: item.revision + 1 } : item,
      ));
      setFeedback(`Preview only: ${task.name} is ${statusLabel(status).toLowerCase()}. No data was saved.`);
      return;
    }
    const scope = `${task.id}:${task.revision}:${status}`;
    const commandId = commandIds.current.get(scope) ?? crypto.randomUUID();
    commandIds.current.set(scope, commandId);
    update.mutate({
      runId,
      taskId: task.id,
      data: { commandId, expectedRevision: task.revision, status },
    }, {
      onSuccess: (result) => {
        commandIds.current.delete(scope);
        void queryClient.invalidateQueries({ queryKey });
        setFeedback(`${result.replayed ? 'Already saved.' : 'Saved.'} ${task.name}: ${statusLabel(result.task.status)}.`);
      },
      onError: (error) => {
        if (errorStatus(error) === 409) {
          commandIds.current.delete(scope);
          setFeedback('This pull item changed on another device. The latest saved status is being refreshed.');
          void queryClient.invalidateQueries({ queryKey });
        } else {
          setFeedback('The pull status was not confirmed. Retry after checking your connection.');
        }
      },
    });
  }

  return (
    <section className="rr-pull-checklist" aria-labelledby={`pull-checklist-title-${runId}`}>
      <header className="rr-pull-checklist-head">
        <div>
          <h4 id={`pull-checklist-title-${runId}`}>Early-pull checklist</h4>
          <p className="field-help">Track each source-listed pull item separately. No station is assigned unless the source names one.</p>
        </div>
        {tasks.length > 0 && <span className="rr-chip">{completed} of {tasks.length} pulled</span>}
      </header>
      {!previewMode && query.isLoading && <p className="field-help" role="status">Loading saved pull status…</p>}
      {!previewMode && query.isError && (
        <p className="field-help" role="status">
          Pull status could not be refreshed. The captured source instructions remain unchanged.
          <button type="button" className="text-link rr-pull-retry" onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {!previewMode && query.data && tasks.length === 0 && <p className="field-help">This run has no individual early-pull items in its captured sources.</p>}
      {tasks.length > 0 && (
        <ul className="rr-pull-list">
          {tasks.map((task) => (
            <li key={task.id} className={`rr-pull-item is-${task.status}`}>
              <div className="rr-pull-copy">
                <div className="rr-pull-title">
                  <strong>{task.name}</strong>
                  <span className={`rr-chip ${task.status === 'completed' ? 'rr-chip-ok' : ''}`}>{statusLabel(task.status)}</span>
                </div>
                <p>{task.instruction}</p>
                <small>{task.daysEarly === null ? 'Pull timing not specified' : `Pull ${task.daysEarly} ${task.daysEarly === 1 ? 'day' : 'days'} early`} · {task.source}{task.sourceRow !== null ? ` · row ${task.sourceRow}` : ''}{task.sourceColumn ? ` · column ${task.sourceColumn}` : ''}</small>
              </div>
              <div className="rr-pull-actions" aria-label={`Actions for ${task.name}`}>
                {task.status === 'not_started' && (
                  <>
                    <button type="button" className="button button-secondary" disabled={!online || runIsClosed || update.isPending} onClick={() => save(task, 'in_progress')}>Start pull</button>
                    <button type="button" className="button button-primary" disabled={!online || runIsClosed || update.isPending} onClick={() => save(task, 'completed')}><Check size={15} aria-hidden="true" /> Mark pulled</button>
                  </>
                )}
                {task.status === 'in_progress' && (
                  <>
                    <button type="button" className="button button-secondary" disabled={!online || runIsClosed || update.isPending} onClick={() => save(task, 'not_started')}><RotateCcw size={14} aria-hidden="true" /> Reset</button>
                    <button type="button" className="button button-primary" disabled={!online || runIsClosed || update.isPending} onClick={() => save(task, 'completed')}><Check size={15} aria-hidden="true" /> Mark pulled</button>
                  </>
                )}
                {task.status === 'completed' && (
                  <button type="button" className="button button-secondary" disabled={!online || runIsClosed || update.isPending} onClick={() => save(task, 'not_started')}><RotateCcw size={14} aria-hidden="true" /> Reopen</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {update.isPending && <p className="field-help" role="status"><LoaderCircle size={14} aria-hidden="true" /> Saving pull status. Wait for confirmation before leaving.</p>}
      {feedback && <p className="field-help" role="status" aria-live="polite">{feedback}</p>}
      {previewMode && <p className="field-help">Development preview with synthetic source data. Button changes are temporary.</p>}
      {!previewMode && !online && <p className="field-help">Pull statuses are read-only while disconnected; changes are not queued.</p>}
      {runIsClosed && tasks.length > 0 && <p className="field-help">Completed runs are read-only.</p>}
    </section>
  );
}
