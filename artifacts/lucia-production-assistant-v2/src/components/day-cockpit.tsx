import type { DashboardSummary, Run, RunStatus } from '@workspace/api-client-react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Pause,
  Play,
  Radio,
  RotateCcw,
  WifiOff,
} from 'lucide-react';
import './day-cockpit.css';

export type CockpitRole = 'owner' | 'manager' | 'operator' | null;

export type DayCockpitProps = {
  summary: DashboardSummary | null;
  role: CockpitRole;
  online: boolean;
  focusedRunId: string | null;
  onFocusRun: (run: Run) => void;
  onOpenRun: (run: Run) => void;
  onStartRun?: (run: Run) => void;
  onPauseRun?: (run: Run) => void;
  onResumeRun?: (run: Run) => void;
  onCompleteRun?: (run: Run) => void;
  pending?: boolean;
  pendingRunId?: string | null;
  currentElapsedTime?: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  primaryActionLabel?: string | null;
  onPrimaryAction?: () => void;
  primaryActionNotice?: string | null;
  showContextStrip?: boolean;
};

type RunContextStripProps = Pick<
  DayCockpitProps,
  | 'summary'
  | 'role'
  | 'online'
  | 'focusedRunId'
  | 'onFocusRun'
  | 'onOpenRun'
  | 'onStartRun'
  | 'onPauseRun'
  | 'onResumeRun'
  | 'onCompleteRun'
  | 'pending'
  | 'pendingRunId'
  | 'currentElapsedTime'
> & {
  run?: Run | null;
  compact?: boolean;
};

const areaLabels: Record<string, string> = {
  dough_prep: 'Dough prep',
  sauce_prep: 'Sauce prep',
  dough_sauce_prep: 'Dough + sauce',
  production_line: 'Production line',
  freeze_tunnel: 'Freeze tunnel',
  freezing_packaging: 'Wrapper + pack',
  warehouse: 'Warehouse',
};

const statusLabels: Record<RunStatus, string> = {
  planned: 'Planned',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
};

function allRuns(summary: DashboardSummary) {
  const byId = new Map<string, Run>();
  [...summary.activeRuns, ...summary.plannedRuns, ...summary.recentRuns].forEach((run) => byId.set(run.id, run));
  return [...byId.values()];
}

function findRun(summary: DashboardSummary | null, id: string | null | undefined) {
  return id && summary ? allRuns(summary).find((run) => run.id === id) ?? null : null;
}

function statusClass(status: RunStatus) {
  return `day-status day-status-${status}`;
}

function RunAction({
  run,
  props,
  prominent = false,
}: {
  run: Run;
  props: RunContextStripProps;
  prominent?: boolean;
}) {
  const action = run.status === 'planned'
    ? { label: 'Start run', callback: props.onStartRun, icon: Play }
    : run.status === 'running'
      ? { label: 'Pause run', callback: props.onPauseRun, icon: Pause }
      : run.status === 'paused'
        ? { label: 'Resume run', callback: props.onResumeRun, icon: RotateCcw }
        : null;
  if (!action || !action.callback) return null;
  const Icon = action.icon;
  const isPending = Boolean(props.pending && (!props.pendingRunId || props.pendingRunId === run.id));
  return (
    <button
      className={`day-action${prominent ? ' day-action-primary' : ''}`}
      type="button"
      onClick={() => action.callback?.(run)}
      disabled={!props.online || isPending}
      aria-label={`${action.label}: ${run.setupSnapshot.label}`}
      data-testid={`button-cockpit-${run.status === 'planned' ? 'start' : run.status === 'running' ? 'pause' : 'resume'}-${run.id}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{isPending ? 'Saving…' : action.label}</span>
    </button>
  );
}

function CompleteRunAction({ run, props }: { run: Run; props: RunContextStripProps }) {
  if ((run.status !== 'running' && run.status !== 'paused') || !props.onCompleteRun) return null;
  const isPending = Boolean(props.pending && (!props.pendingRunId || props.pendingRunId === run.id));
  return (
    <button
      className="day-complete-action"
      type="button"
      onClick={() => props.onCompleteRun?.(run)}
      disabled={!props.online || isPending}
      aria-label={`Complete run: ${run.setupSnapshot.label}`}
      data-testid={`button-cockpit-complete-${run.id}`}
    >
      <Check size={13} aria-hidden="true" /><span>End run</span>
    </button>
  );
}

function RunCard({ run, props, progress }: {
  run: Run;
  props: RunContextStripProps;
  progress?: DashboardSummary['activeRunProgress'][number];
}) {
  const attention = props.summary?.qualityAttention.find((item) => item.runId === run.id);
  const selected = props.focusedRunId === run.id;
  const coverage = progress?.areas.reduce(
    (totals, area) => ({ reported: totals.reported + area.countedStations, stations: totals.stations + area.stationCount }),
    { reported: 0, stations: 0 },
  );
  const prep = progress?.preparationStatusCounts;
  return (
    <article className={`day-run-card${selected ? ' is-focused' : ''}`} data-testid={`card-cockpit-run-${run.id}`}>
      <button
        type="button"
        className="day-run-card-main"
        onClick={() => props.onFocusRun(run)}
        aria-pressed={selected}
        aria-label={`Focus ${run.setupSnapshot.label}, ${statusLabels[run.status]}`}
        data-testid={`button-focus-run-${run.id}`}
      >
        <span className="day-run-card-top">
          <span className={statusClass(run.status)}>{statusLabels[run.status]}</span>
          {attention && <span className="day-attention-tag"><CircleAlert size={12} /> Review</span>}
        </span>
        <strong className="day-run-name">{run.setupSnapshot.label}</strong>
        <span className="day-run-card-meta">
          <span>{run.setupSnapshot.targetCases.toLocaleString()} cases</span>
          {run.status === 'planned' && run.scheduledFor && <span>{formatTime(run.scheduledFor)}</span>}
          {run.status !== 'planned' && <span>Rev {run.revision}</span>}
        </span>
        {coverage && coverage.stations > 0 && (
          <span className="day-run-coverage" aria-label={`${coverage.reported} of ${coverage.stations} stations reported`}>
            <span className="day-run-coverage-track"><span style={{ width: `${Math.min(100, coverage.reported / coverage.stations * 100)}%` }} /></span>
            <span>{coverage.reported}/{coverage.stations} counted</span>
          </span>
        )}
        {prep && (
          <span className="day-run-prep">
            <Check size={12} aria-hidden="true" /> {prep.ready} ready
            {prep.inProgress > 0 && <span> · {prep.inProgress} underway</span>}
          </span>
        )}
      </button>
      <div className="day-run-card-actions">
        <RunAction run={run} props={props} />
        <CompleteRunAction run={run} props={props} />
        <button type="button" className="day-open-link" onClick={() => props.onOpenRun(run)} data-testid={`button-open-run-${run.id}`}>
          Open <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

export function RunContextStrip(props: RunContextStripProps) {
  const run = props.run ?? findRun(props.summary, props.focusedRunId);
  if (!run) {
    return (
      <aside className={`run-context-strip run-context-empty${props.compact ? ' is-compact' : ''}`} aria-label="Focused run context" data-testid="panel-run-context-empty">
        <span className="run-context-mark"><Radio size={16} aria-hidden="true" /></span>
        <span><strong>No run in focus</strong><small>Choose a run to keep its current state close at hand.</small></span>
        <span className="run-context-connectivity"><span className="day-live-dot" /> {props.online ? 'Live view' : 'Read-only'}</span>
      </aside>
    );
  }
  const attention = props.summary?.qualityAttention.find((item) => item.runId === run.id);
  const elapsed = props.currentElapsedTime;
  return (
    <aside className={`run-context-strip${props.compact ? ' is-compact' : ''}`} aria-label={`Focused run: ${run.setupSnapshot.label}`} data-testid={`panel-run-context-${run.id}`}>
      <span className={`run-context-mark run-context-mark-${run.status}`} aria-hidden="true">
        {run.status === 'paused' ? <Pause size={16} /> : run.status === 'completed' ? <Check size={16} /> : <Radio size={16} />}
      </span>
      <div className="run-context-identity">
        <span className="run-context-eyebrow">Run in focus <span className="day-context-separator">/</span> {statusLabels[run.status]}</span>
        <strong>{run.setupSnapshot.label}</strong>
        <small>{run.setupSnapshot.targetCases.toLocaleString()} target cases · Rev {run.revision}</small>
      </div>
      {elapsed && run.status !== 'planned' && (
        <div className="run-context-time"><Clock3 size={14} aria-hidden="true" /><span className="run-context-time-label">{run.status === 'paused' ? 'Paused at' : 'Elapsed'}</span><strong>{elapsed}</strong></div>
      )}
      {attention && (
        <div className="run-context-attention" role="status">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{attention.failedChecks + attention.unresolvedChecks} quality item{attention.failedChecks + attention.unresolvedChecks === 1 ? '' : 's'} need review</span>
        </div>
      )}
      <div className="run-context-actions">
        <RunAction run={run} props={props} prominent />
        <CompleteRunAction run={run} props={props} />
          <button className="day-context-open" type="button" aria-label={`Open live stations for ${run.setupSnapshot.label}`} onClick={() => props.onOpenRun(run)} data-testid={`button-context-open-${run.id}`}>
          <span>Open live stations</span><ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
      <span className={`run-context-sync ${props.online ? 'is-online' : 'is-offline'}`} role="status" data-testid="status-run-context-connection">
        {props.online ? <><span className="day-live-dot" /> Shared</> : <><WifiOff size={13} /> Cached</>}
      </span>
    </aside>
  );
}

export function DayCockpit(props: DayCockpitProps) {
  const { summary } = props;
  const focusedRun = findRun(summary, props.focusedRunId)
    ?? summary?.activeRuns[0]
    ?? summary?.plannedRuns[0]
    ?? null;
  const dashboardProps: RunContextStripProps = props;
  const progressMap = new Map((summary?.activeRunProgress ?? []).map((item) => [item.runId, item]));
  const active = summary?.activeRuns ?? [];
  const planned = summary?.plannedRuns ?? [];
  const completed = summary?.recentRuns.filter((run) => run.status === 'completed') ?? [];
  const qualityItems = summary?.qualityAttention ?? [];

  if (props.loading && !summary) {
    return (
      <main className="day-cockpit" aria-busy="true" data-testid="loading-day-cockpit">
        <div className="day-cockpit-skeleton-head" />
        <div className="day-cockpit-skeleton-metrics"><i /><i /><i /></div>
        <div className="day-cockpit-skeleton-body" />
      </main>
    );
  }
  if (props.error && !summary) {
    return (
      <main className="day-cockpit" data-testid="error-day-cockpit">
        <section className="day-cockpit-error" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <div><strong>Shift view unavailable</strong><p>{props.error}</p></div>
          {props.onRetry && <button type="button" onClick={props.onRetry} data-testid="button-retry-day-cockpit">Try again</button>}
        </section>
      </main>
    );
  }
  if (!summary) return null;

  return (
    <main className="day-cockpit" data-role={props.role ?? 'unknown'} data-testid="day-cockpit">
      <header className="day-cockpit-heading">
        <div>
          <div className="day-cockpit-kicker"><span className="day-live-dot" /> Shift control <span className="day-context-separator">/</span> {formatDate(new Date())}</div>
          <h1>{summary.facility.name}</h1>
          <p>Production state, confirmed across the floor.</p>
        </div>
        <div className="day-cockpit-heading-tools">
          {props.primaryActionLabel && props.onPrimaryAction && (
            <button type="button" className="day-primary-action" onClick={props.onPrimaryAction} disabled={!props.online} data-testid="button-cockpit-primary-action">
              {props.primaryActionLabel}
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
          {props.primaryActionNotice && <span className="day-primary-notice" role="status" data-testid="dashboard-primary-action">{props.primaryActionNotice}</span>}
          <div className={`day-cockpit-connection ${props.online ? 'is-online' : 'is-offline'}`} role="status" data-testid="status-cockpit-connection">
            {props.online ? <><span className="day-live-dot" /> Connected <span className="day-connection-divider" /> Updates shared</> : <><WifiOff size={15} /> Offline <span className="day-connection-divider" /> Saved view only</>}
          </div>
        </div>
      </header>

      {props.error && <div className="day-refresh-notice" role="status" data-testid="status-cockpit-refresh">{props.error} Showing the last saved shift view.</div>}

      <section className="day-metrics" aria-label="Shift totals">
        <div className="day-metric day-metric-active"><span className="day-metric-label">On the floor</span><strong>{summary.counts.active}</strong><small>{summary.counts.active === 1 ? 'active run' : 'active runs'}</small></div>
        <div className="day-metric"><span className="day-metric-label">Up next</span><strong>{summary.counts.planned}</strong><small>{summary.counts.planned === 1 ? 'planned run' : 'planned runs'}</small></div>
        <div className="day-metric"><span className="day-metric-label">Logged today</span><strong>{summary.counts.completed}</strong><small>completed runs</small></div>
        <div className={`day-attention-summary${qualityItems.length ? ' has-attention' : ''}`}>
          <span className="day-attention-icon">{qualityItems.length ? <CircleAlert size={17} /> : <Check size={17} />}</span>
          <span><strong>{qualityItems.length ? `${qualityItems.length} needs review` : 'Quality in view'}</strong><small>{qualityItems.length ? 'Checks need a second look' : 'No outstanding quality flags'}</small></span>
        </div>
      </section>

      <div className="day-board-layout">
        <section className="day-primary-column" aria-label="Current production">
          <div className="day-section-heading">
            <div><span className="day-section-index">01</span><div><h2>Running now</h2><p>Live station coverage and preparation status</p></div></div>
            <span className="day-section-count">{active.length.toString().padStart(2, '0')} active</span>
          </div>
          {active.length ? (
            <div className="day-active-stack">
              {active.map((run) => (
                <RunCard key={run.id} run={run} props={dashboardProps} progress={progressMap.get(run.id)} />
              ))}
            </div>
          ) : (
            <div className="day-empty-active" data-testid="empty-cockpit-active">
              <span className="day-empty-rule" />
              <strong>Floor is clear</strong>
              <p>When a run starts, its confirmed station progress will appear here.</p>
            </div>
          )}

          <div className="day-section-heading day-planned-heading">
            <div><span className="day-section-index">02</span><div><h2>Next in sequence</h2><p>Planned work, ready when the line is</p></div></div>
            <span className="day-section-count">{planned.length.toString().padStart(2, '0')} queued</span>
          </div>
          {planned.length ? (
            <div className="day-run-strip" aria-label="Planned runs">
              {planned.map((run) => <RunCard key={run.id} run={run} props={dashboardProps} />)}
            </div>
          ) : (
            <div className="day-empty-planned" data-testid="empty-cockpit-planned">
              <span>QUEUE EMPTY</span><p>No planned runs in the current schedule.</p>
            </div>
          )}
        </section>

        <aside className="day-side-column">
          <section className="day-side-panel" aria-labelledby="day-attention-title">
            <div className="day-side-head"><div><span className="day-side-label">Quality desk</span><h2 id="day-attention-title">Needs a look</h2></div><span className={qualityItems.length ? 'day-side-count has-attention' : 'day-side-count'}>{qualityItems.length.toString().padStart(2, '0')}</span></div>
            {qualityItems.length ? (
              <ul className="day-quality-list">
                {qualityItems.map((item) => {
                  const run = findRun(summary, item.runId);
                  const total = item.failedChecks + item.unresolvedChecks;
                  return (
                    <li key={item.runId}>
                      <button type="button" onClick={() => run && props.onFocusRun(run)} data-testid={`button-focus-quality-${item.runId}`}>
                        <span className="day-quality-marker"><CircleAlert size={14} aria-hidden="true" /></span>
                        <span className="day-quality-copy"><strong>{item.runLabel}</strong><small>{item.failedChecks > 0 ? `${item.failedChecks} failed` : ''}{item.failedChecks > 0 && item.unresolvedChecks > 0 ? ' · ' : ''}{item.unresolvedChecks > 0 ? `${item.unresolvedChecks} unresolved` : ''}</small></span>
                        <span className="day-quality-total">{total.toString().padStart(2, '0')}</span>
                      </button>
                      {run && <button className="day-quality-open" type="button" onClick={() => props.onOpenRun(run)} data-testid={`button-open-quality-${item.runId}`}>Review run <ArrowUpRight size={12} /></button>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="day-quality-clear"><Check size={17} aria-hidden="true" /><span>No outstanding checks. Quality flags will land here.</span></div>
            )}
          </section>

          <section className="day-side-panel day-side-recent" aria-labelledby="day-recent-title">
            <div className="day-side-head"><div><span className="day-side-label">Shift record</span><h2 id="day-recent-title">Recently closed</h2></div><span className="day-side-count">{completed.length.toString().padStart(2, '0')}</span></div>
            {completed.length ? (
              <ul className="day-recent-list">
                {completed.slice(0, 4).map((run) => (
                  <li key={run.id}>
                    <button type="button" onClick={() => props.onFocusRun(run)} data-testid={`button-focus-completed-${run.id}`}>
                      <span className="day-recent-check"><Check size={13} aria-hidden="true" /></span>
                      <span><strong>{run.setupSnapshot.label}</strong><small>{run.setupSnapshot.targetCases.toLocaleString()} cases · Rev {run.revision}</small></span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <div className="day-recent-empty">Completed runs from this shift will be recorded here.</div>}
          </section>

          <div className="day-shift-footnote"><span className="day-shift-footnote-line" /><span>Every update is revisioned<br />and visible to the whole team.</span></div>
        </aside>
      </div>

      {props.showContextStrip !== false && <RunContextStrip {...dashboardProps} run={focusedRun} />}
    </main>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(value);
}
