import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, Show, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowLeft, ArrowRight, Check, ChevronRight, CircleAlert, Package,
  ClipboardList, Factory, Gauge, LoaderCircle, LogOut, Pause, Play,
  MapPinned, Plus, RefreshCw, ShieldCheck, Square, Users, WifiOff,
} from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey,
  getGetFacilityContextQueryKey,
  getGetRunQueryKey,
  getGetRunStationProgressQueryKey,
  getListProductProfilesQueryKey,
  getListRunsQueryKey,
  revokeV2Session,
  setV2CsrfToken,
  useApplyRunCommand,
  useCreateFacility,
  useCreateRun,
  useGetDashboardSummary,
  useGetFacilityContext,
  useGetRun,
  useHealthCheck,
  useListRuns,
  useListProductProfiles,
} from '@workspace/api-client-react';
import type { DashboardSummary, HealthStatus, Run, RunCommandRequest, RunStatus, RunPlanningReview } from '@workspace/api-client-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useRoute } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { OperationalSetupSummary } from '@/components/operational-setup-summary';
import { ProductSpecSummary } from '@/components/product-spec-summary';
import { RunRequirementsEditor, RunRequirementsSummary } from '@/components/run-requirements';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { elapsedMilliseconds, formatElapsed } from '@/run-timer';

const SignInPage = lazy(() => import('@/pages/sign-in'));
const SignUpPage = lazy(() => import('@/pages/sign-up'));
const ImportsPage = lazy(() => import('@/pages/imports'));
const ImportsVisualPreviewPage = lazy(() => import('@/pages/imports').then((module) => ({ default: module.ImportsVisualPreviewPage })));
const FacilityMembersPage = lazy(() => import('@/components/facility-members-page'));
const StationLineupPage = lazy(() => import('@/components/station-lineup-page'));
const InventoryPage = lazy(() => import('@/components/inventory-page'));
const RunStationProgressSection = lazy(() => import('@/components/run-station-progress'));
const StationCalculatorVisualPreviewPage = lazy(() => import('@/pages/station-calculator-visual-preview'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => count < 1 && getErrorStatus(error) !== 401 && getErrorStatus(error) !== 403,
    },
  },
});
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function useConnection() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const queryClientInstance = useQueryClient();
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void queryClientInstance.invalidateQueries();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [queryClientInstance]);
  return online;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand" aria-label="Lucia Production Assistant">
      <span className="brand-mark" aria-hidden="true"><Factory size={19} strokeWidth={1.7} /></span>
      {!compact && <span><span className="brand-name">Lucia</span><span className="brand-sub">Production assistant</span></span>}
    </span>
  );
}

function SiteShell({ children, facilityName }: { children: ReactNode; facilityName?: string }) {
  const { signOut } = useClerk();
  const [location] = useLocation();
  const handleSignOut = async () => {
    try {
      await revokeV2Session();
    } catch {
      setV2CsrfToken(null);
    }
    await signOut({ redirectUrl: basePath || '/' });
  };
  const facilityContext = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const currentFacilityName = facilityName || facilityContext.data?.facility?.name;
  const links = [
    { href: '/', label: 'Overview', icon: Gauge },
    { href: '/runs', label: 'Production runs', icon: ClipboardList },
    { href: '/imports', label: 'Product profiles', icon: Factory },
    { href: '/stations', label: 'Stations', icon: MapPinned },
    { href: '/inventory', label: 'Inventory', icon: Package },
  ];
  if (facilityContext.data?.role === 'owner') {
    links.push({ href: '/team', label: 'Team members', icon: Users });
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand"><Brand /></Link>
        <div className="nav-label">Operations</div>
        <nav className="nav-links" aria-label="Main navigation">
          {links.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className="nav-link" aria-current={location === href ? 'page' : undefined} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}>
              <Icon size={17} aria-hidden="true" /><span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="facility-mini">Current facility</div>
          <div className="facility-mini-name" data-testid="text-current-facility">{currentFacilityName || 'Facility setup'}</div>
          <button className="logout" type="button" onClick={() => void handleSignOut()} data-testid="button-sign-out">
            <LogOut size={15} aria-hidden="true" /> <span>Sign out</span>
          </button>
        </div>
      </aside>
      <div className="main-area">
        <header className="mobile-topbar">
          <Link href="/" aria-label="Lucia home"><Brand compact /></Link>
          <nav className="mobile-links" aria-label="Main navigation">
            {links.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} aria-label={label} aria-current={location === href ? 'page' : undefined} data-testid={`mobile-nav-${label.toLowerCase().replaceAll(' ', '-')}`}>
                <Icon size={18} aria-hidden="true" />
              </Link>
            ))}
            <button type="button" aria-label="Sign out" title="Sign out" onClick={() => void handleSignOut()} data-testid="mobile-button-sign-out" style={{ display: 'grid', placeItems: 'center', minWidth: 42, minHeight: 42, border: 0, borderRadius: 8, background: 'transparent', color: '#e5eee8', cursor: 'pointer' }}>
              <LogOut size={17} aria-hidden="true" />
            </button>
          </nav>
        </header>
        {children}
      </div>
    </div>
  );
}

function OfflineNotice({ hasCache }: { hasCache: boolean }) {
  const online = useConnection();
  if (online) return null;
  return (
    <div className="connection-banner" role="status" data-testid="status-offline">
      <WifiOff size={17} aria-hidden="true" />
      <span><strong>Offline — controls are paused.</strong> {hasCache ? 'Showing the last saved view; it is read-only until connection returns.' : 'Reconnect to load the current run state.'}</span>
    </div>
  );
}

function WorkerAvailabilityNotice({ health }: { health?: HealthStatus }) {
  const worker = health?.worker;
  if (!health || (worker !== 'starting' && worker !== 'restarting')) return null;

  const workerLabel = worker === 'restarting' ? 'restarting' : 'starting';
  const describeStatus = (status: string) => status === 'ok' ? 'healthy' : status;

  return (
    <div className="worker-health-banner" role="status" data-testid="status-worker-availability">
      <CircleAlert size={17} aria-hidden="true" />
      <span>
        <strong>Background worker is {workerLabel}.</strong>
        <span className="worker-health-details">
          API: {describeStatus(health.api)} · Database: {describeStatus(health.database)}.
        </span>
      </span>
    </div>
  );
}

function PublicHome() {
  return (
    <main className="public-shell">
      <header className="public-nav">
        <Link href="/" aria-label="Lucia home"><Brand /></Link>
        <nav className="public-actions" aria-label="Account">
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up" className="button button-primary">Get started <ArrowRight size={15} /></Link>
        </nav>
      </header>
      <section className="hero" aria-labelledby="home-title">
        <div className="hero-copy">
          <div className="hero-kicker">Production, in step</div>
          <h1 id="home-title">One clear view of <em>what’s running.</em></h1>
          <p>Keep every shift aligned. Lucia gives facility teams a dependable place to start runs, track state, and know what has actually saved.</p>
          <div className="hero-actions">
            <Link href="/sign-up" className="button button-primary">Create your workspace <ArrowRight size={16} /></Link>
            <Link href="/sign-in" className="button button-quiet">Sign in</Link>
          </div>
          <div className="hero-note"><ShieldCheck size={15} /><span>Revision-aware updates</span> keep shared run state consistent.</div>
        </div>
        <div className="hero-visual" aria-label="Illustrative sample of a production operations view">
          <div className="ops-board">
            <div className="ops-top"><div className="ops-title">Shift overview · example</div><div className="ops-time">ILLUSTRATIVE / SAMPLE</div></div>
            <div className="ops-active">Active production</div>
            <div className="ops-run">
              <div className="ops-run-head"><div className="ops-run-title">Morning blend / Lot 024</div><div className="ops-chip">Running</div></div>
              <div className="ops-run-info"><span>REV 08</span><span>STARTED 07:42</span></div>
            </div>
            <div className="ops-run">
              <div className="ops-run-head"><div className="ops-run-title">Packaging line / Batch 11</div><div className="ops-chip">Running</div></div>
              <div className="ops-run-info"><span>REV 03</span><span>STARTED 08:16</span></div>
            </div>
            <div className="ops-divider" />
            <div className="ops-sync"><span>Shared state</span><span className="sync-good">After save</span></div>
            <div className="ops-footer"><span>EXAMPLE VIEW</span><span>SAMPLE DATA</span></div>
          </div>
        </div>
      </section>
      <footer className="public-band"><span><strong>Built for the handoff.</strong> The current state should never be a guess.</span><span>Lucia Production Assistant <span className="mono">/ V2</span></span></footer>
    </main>
  );
}

function HomeRoute() {
  return (
    <>
      <Show when="signed-out"><PublicHome /></Show>
      <Show when="signed-in"><Dashboard /></Show>
    </>
  );
}

function Dashboard() {
  const online = useConnection();
  const facilityQuery = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const facilityContext = facilityQuery.data;
  if (facilityQuery.isLoading) return <LoadingPage title="Loading your workspace" />;
  if (!facilityContext && facilityQuery.isError) {
    return <SiteShell><DataError message={getErrorMessage(facilityQuery.error, 'Could not load facility access.')} onRetry={() => void facilityQuery.refetch()} /></SiteShell>;
  }
  if (facilityContext && !facilityContext.facility) {
    return <FacilitySetup online={online} />;
  }
  if (!facilityContext?.facility) return <LoadingPage title="Preparing your workspace" />;
  return <FacilityDashboard facilityName={facilityContext.facility.name} />;
}

function FacilitySetup({ online }: { online: boolean }) {
  const createFacility = useCreateFacility({ request: { credentials: 'include' } });
  const queryClientInstance = useQueryClient();
  const [name, setName] = useState('');
  const [validation, setValidation] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = name.trim();
    if (cleaned.length < 1 || cleaned.length > 120) {
      setValidation('Enter a facility name between 1 and 120 characters.');
      return;
    }
    setValidation('');
    createFacility.mutate({ data: { name: cleaned } }, {
      onSuccess: (context) => {
        queryClientInstance.setQueryData(getGetFacilityContextQueryKey(), context);
        void queryClientInstance.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
    });
  };
  return (
    <SiteShell>
      <OfflineNotice hasCache={false} />
      <section className="panel facility-card">
        <div className="facility-symbol"><Factory size={24} /></div>
        <div className="eyebrow">Workspace setup</div>
        <h1>Start with your facility.</h1>
        <p className="page-subtitle">Runs are scoped to a facility so every operator sees the same operational picture. Add the facility your team works from.</p>
        <form onSubmit={submit} noValidate>
          <div className="form-field">
            <label htmlFor="facility-name">Facility name</label>
            <input id="facility-name" data-testid="input-facility-name" value={name} maxLength={120} autoComplete="organization" onChange={(event) => setName(event.target.value)} aria-describedby={validation ? 'facility-error' : 'facility-hint'} required />
            <span className="field-help" id="facility-hint">This name is visible to your facility team.</span>
            {validation && <span className="field-help" id="facility-error" role="alert">{validation}</span>}
          </div>
          {createFacility.isError && <div className="error-banner" role="alert">{getErrorMessage(createFacility.error, 'Facility could not be created.')}</div>}
          <button className="button button-primary" type="submit" disabled={!online || createFacility.isPending} data-testid="button-create-facility">
            {createFacility.isPending ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
            {createFacility.isPending ? 'Saving facility…' : 'Create facility'}
          </button>
        </form>
      </section>
    </SiteShell>
  );
}

function FacilityDashboard({ facilityName }: { facilityName: string }) {
  const online = useConnection();
  const summary = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: online ? 5000 : false },
    request: { credentials: 'include' },
  });
  const data = summary.data;
  const latestRuns = data?.recentRuns ?? [];
  const activeRuns = data?.activeRuns ?? [];
  const plannedRuns = data?.plannedRuns ?? [];
  const activeRunProgress = new Map((data?.activeRunProgress ?? []).map((item) => [item.runId, item.areas]));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeRuns.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeRuns.length]);
  return (
    <SiteShell facilityName={data?.facility.name || facilityName}>
      <main className="workspace">
        <OfflineNotice hasCache={Boolean(data)} />
        <div className="page-head">
          <div><div className="eyebrow">Shift dashboard</div><h1>Good to have you back.</h1><p className="page-subtitle">{data?.facility.name || facilityName} · Current production at a glance.</p></div>
          <Link href="/runs" className="button button-primary"><Plus size={16} /> New production run</Link>
        </div>
        {summary.isLoading && !data ? <><div className="skeleton" /><div className="skeleton" /></> : null}
        {summary.isError && !data && <DataError message={getErrorMessage(summary.error, 'Dashboard data could not be loaded.')} onRetry={() => void summary.refetch()} />}
        {summary.isError && data && <div className="error-banner" role="status">Could not refresh. Showing the last saved dashboard view.</div>}
        {data && <>
          <section className="stats-grid" aria-label="Run totals">
            <Stat label="In progress" value={data.counts.active} detail="Running or paused" icon={<Activity size={16} />} />
            <Stat label="Planned" value={data.counts.planned} detail="Ready to start" icon={<ClipboardList size={16} />} />
            <Stat label="Completed" value={data.counts.completed} detail="Recorded runs" icon={<Check size={16} />} />
          </section>
          <div className="section-heading"><div><h2>Active now</h2><p className="field-help">Line timers and saved station counts update with shared run state.</p></div><Link href="/runs" className="text-link">All runs <ArrowRight size={14} /></Link></div>
          <section className="active-run-grid" aria-label="Live production overview">
            {activeRuns.length ? activeRuns.map((run) => <ActiveRunCard key={run.id} run={run} areas={activeRunProgress.get(run.id) ?? []} now={now} />) : <div className="panel active-run-empty"><EmptyState title="No active runs" copy="When a run starts, its line timer and saved station counts will show here for the whole team." /></div>}
          </section>
          <div className="section-heading" style={{ marginTop: 30 }}><h2>Planned runs</h2><Link href="/runs" className="text-link">Manage schedule <ArrowRight size={14} /></Link></div>
          <section className="panel run-list" aria-label="Planned production runs">
            {plannedRuns.length ? plannedRuns.map((run) => <RunRow key={run.id} run={run} />) : <EmptyState title="No planned runs" copy="Create a planned run or import a schedule to build the production queue." action={<Link href="/runs" className="button button-secondary">Create a run <ArrowRight size={15} /></Link>} />}
          </section>
          <div className="section-heading" style={{ marginTop: 30 }}><h2>Recently updated</h2><span className="eyebrow">Latest activity</span></div>
          <section className="panel run-list" aria-label="Recently updated runs">
            {latestRuns.length ? latestRuns.map((run) => <RunRow key={run.id} run={run} />) : <EmptyState title="Nothing recorded yet" copy="Create the first production run to start a shared shift record." action={<Link href="/runs" className="button button-secondary">Create a run <ArrowRight size={15} /></Link>} />}
          </section>
        </>}
        {!online && data && <p className="field-help" style={{ marginTop: 14 }}>Read-only cached data. No changes are being queued offline.</p>}
      </main>
    </SiteShell>
  );
}

type DashboardAreaProgress = DashboardSummary['activeRunProgress'][number]['areas'][number];

const stationAreaLabels: Record<DashboardAreaProgress['area'], string> = {
  dough_sauce_prep: 'Dough & sauce prep',
  production_line: 'Production line',
  freezing_packaging: 'Freezing & packaging',
  warehouse: 'Warehouse',
};

function ActiveRunCard({
  run,
  areas,
  now,
}: {
  run: Run;
  areas: DashboardAreaProgress[];
  now: number;
}) {
  const targetCases = run.setupSnapshot.targetCases;
  const elapsed = formatElapsed(elapsedMilliseconds(run, now));
  return (
    <article className="panel active-run-card" data-testid={`card-active-run-${run.id}`}>
      <div className="active-run-card-head">
        <div>
          <span className="eyebrow">Live production</span>
          <Link href={`/runs/${encodeURIComponent(run.id)}`} className="active-run-title">{run.setupSnapshot.label}</Link>
        </div>
        <Status status={run.status} />
      </div>
      <div className="active-run-clock">
        <div><span className="eyebrow">Line timer</span><strong className="mono" data-testid={`text-dashboard-timer-${run.id}`}>{elapsed}</strong></div>
        <span>{run.status === 'paused' ? 'Paused' : 'Elapsed time'}</span>
      </div>
      <div className="active-run-area-list">
        {areas.length ? areas.map((area) => {
          const label = stationAreaLabels[area.area];
          const count = area.lowestReportedCases;
          return (
            <div className="active-run-area" key={area.area}>
              <div className="active-run-area-head">
                <strong>{label}</strong>
                <span>{area.countedStations} of {area.stationCount} station{area.stationCount === 1 ? '' : 's'} reported</span>
              </div>
              {count === null
                ? <p className="field-help">No case count saved yet.</p>
                : <div className="active-run-case-progress">
                    <span>Lowest saved count</span>
                    <strong>{count} / {targetCases} cases</strong>
                    <progress aria-label={`${label}: lowest saved station count`} value={Math.min(count, targetCases)} max={targetCases} />
                  </div>}
            </div>
          );
        }) : <p className="field-help">Station progress is not available for this run yet.</p>}
      </div>
      <div className="active-run-card-foot">
        <span>{targetCases} target cases</span>
        <Link href={`/runs/${encodeURIComponent(run.id)}`} className="text-link">Open run <ArrowRight size={14} /></Link>
      </div>
    </article>
  );
}

function Stat({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: ReactNode }) {
  return <article className="panel stat" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div style={{ display: 'flex', justifyContent: 'space-between', color: 'hsl(var(--primary))' }}><span className="stat-label">{label}</span>{icon}</div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></article>;
}

function RunRow({ run }: { run: Run }) {
  return (
    <Link href={`/runs/${encodeURIComponent(run.id)}`} className="run-row" data-testid={`link-run-${run.id}`}>
      <div><div className="run-name">{run.setupSnapshot.label}</div><div className="run-meta">{run.setupSnapshot.targetCases} target cases{run.scheduledFor ? ` · Scheduled ${run.scheduledFor}` : ''} · REV {String(run.revision).padStart(2, '0')} <span aria-hidden="true">·</span> Updated {formatTime(run.updatedAt)}</div></div>
      <div className="run-row-end"><Status status={run.status} /><ChevronRight size={16} aria-hidden="true" /></div>
    </Link>
  );
}

function Status({ status }: { status: RunStatus }) {
  return <span className={`status status-${status}`} data-testid={`status-run-${status}`}>{status}</span>;
}

function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark"><ClipboardList size={22} /></div><h3>{title}</h3><p>{copy}</p>{action}</div>;
}

function RunsPage() {
  const online = useConnection();
  const [isCreating, setIsCreating] = useState(false);
  const [brand, setBrand] = useState('');
  const [productProfileId, setProductProfileId] = useState('');
  const [targetCases, setTargetCases] = useState('1');
  const [planning, setPlanning] = useState<{ profileId: string; targetCases: number; review: RunPlanningReview } | null>(null);
  const [validation, setValidation] = useState('');
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  const queryArgs = { limit: 100 };
  const queryKey = getListRunsQueryKey(queryArgs);
  const runsQuery = useListRuns(queryArgs, {
    query: { queryKey, refetchInterval: online ? 5000 : false },
    request: { credentials: 'include' },
  });
  const profilesQuery = useListProductProfiles({
    query: { queryKey: getListProductProfilesQueryKey() },
    request: { credentials: 'include' },
  });
  const createRun = useCreateRun({ request: { credentials: 'include' } });
  const client = useQueryClient();
  const createAttempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const allRuns = runsQuery.data?.runs ?? [];
  const runs = filter === 'all' ? allRuns : allRuns.filter((run) => run.status === filter);
  const profiles = profilesQuery.data?.profiles ?? [];
  const brands = [...new Set(profiles.map((profile) => profile.brand))].sort((a, b) => a.localeCompare(b));
  const flavors = profiles
    .filter((profile) => profile.brand === brand)
    .sort((a, b) => a.flavor.localeCompare(b.flavor));
  const selectedProfile = profiles.find((profile) => profile.id === productProfileId);
  const reviewedPlanning = planning?.profileId === productProfileId && planning.targetCases === Number(targetCases) ? planning.review : null;

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const countValue = Number(targetCases);
    if (!selectedProfile || !Number.isSafeInteger(countValue) || countValue < 1) {
      setValidation('Choose a brand and flavor, then enter a whole target case count of at least one.');
      return;
    }
    if (!reviewedPlanning) {
      setValidation('Wait for the current requirements preview and review its warnings before saving this planned run.');
      return;
    }
    setValidation('');
    const label = `${selectedProfile.brand} / ${selectedProfile.flavor}`;
    const fingerprint = JSON.stringify({ label, targetCases: countValue, productProfileId: selectedProfile.id, planning: reviewedPlanning });
    if (!createAttempt.current || createAttempt.current.fingerprint !== fingerprint) {
      createAttempt.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    createRun.mutate({
      data: {
        requestId: createAttempt.current.requestId,
        setupSnapshot: { label, targetCases: countValue, productProfileId: selectedProfile.id, planning: reviewedPlanning },
      },
    }, {
      onSuccess: (created) => {
        setBrand('');
        setTargetCases('1');
        setProductProfileId('');
        setIsCreating(false);
        createAttempt.current = null;
        client.setQueryData<{ runs: Run[] }>(queryKey, (old) => ({
          runs: [created.run, ...(old?.runs ?? []).filter((run) => run.id !== created.run.id)],
        }));
        void client.invalidateQueries({ queryKey: getListRunsQueryKey() });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
    });
  };
  return (
    <SiteShell>
      <main className="workspace">
        <OfflineNotice hasCache={Boolean(runsQuery.data)} />
        <div className="page-head">
          <div><div className="eyebrow">Facility runs</div><h1>Production runs</h1><p className="page-subtitle">A shared record of what is prepared, running, paused, and complete.</p></div>
          <button className="button button-primary" type="button" onClick={() => { setIsCreating((open) => !open); setValidation(''); }} disabled={!online || profilesQuery.isLoading || profilesQuery.isError || profiles.length === 0} data-testid="button-toggle-create-run">
            <Plus size={16} /> {isCreating ? 'Close form' : 'New run'}
          </button>
        </div>
        {runsQuery.isLoading && !runsQuery.data && <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></>}
        {runsQuery.isError && !runsQuery.data && <DataError message={getErrorMessage(runsQuery.error, 'Runs could not be loaded.')} onRetry={() => void runsQuery.refetch()} />}
        {runsQuery.isError && runsQuery.data && <div className="error-banner" role="status">Refresh failed. Showing cached run records.</div>}
        {profilesQuery.isLoading && !profilesQuery.data && <div className="skeleton" aria-label="Loading product profiles" />}
        {profilesQuery.isError && !profilesQuery.data && <DataError message={getErrorMessage(profilesQuery.error, 'Product profiles could not be loaded.')} onRetry={() => void profilesQuery.refetch()} />}
        {profilesQuery.isError && profilesQuery.data && <div className="error-banner" role="status">Could not refresh product profiles. Run setup is paused until the profile list is available.</div>}
        {profilesQuery.data && profiles.length === 0 && <section className="panel empty-state" data-testid="empty-run-profiles">
          <div className="empty-mark"><Factory size={21} /></div>
          <h3>Product setup comes first</h3>
          <p>Import a product workbook to create an approved facility profile. Then select its brand and flavor here to start a run.</p>
          <Link href="/imports" className="button button-primary" data-testid="link-import-product-setup">Go to product profiles <ArrowRight size={15} /></Link>
        </section>}
        {isCreating && <form className="panel form-card" onSubmit={handleCreate} noValidate>
          <div className="eyebrow">New planned run</div><h2>Set up this production run</h2>
          <div className="form-field">
            <label htmlFor="run-brand">Brand</label>
            <select id="run-brand" data-testid="select-run-brand" autoFocus value={brand} onChange={(event) => { setBrand(event.target.value); setProductProfileId(''); setValidation(''); }} aria-describedby={validation ? 'run-error' : 'run-brand-help'} required disabled={!profiles.length} style={{ width: '100%', minHeight: 48, padding: '0 13px', border: '1px solid hsl(var(--input))', borderRadius: 8, background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
              <option value="">Select a brand</option>
              {brands.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <span className="field-help" id="run-brand-help">Choose a brand to see its available flavors.</span>
          </div>
          <div className="form-field">
            <label htmlFor="run-flavor">Flavor</label>
            <select id="run-flavor" data-testid="select-run-flavor" value={productProfileId} onChange={(event) => { setProductProfileId(event.target.value); setValidation(''); }} aria-describedby={validation ? 'run-error' : 'run-flavor-help'} required disabled={!brand || !flavors.length} style={{ width: '100%', minHeight: 48, padding: '0 13px', border: '1px solid hsl(var(--input))', borderRadius: 8, background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
              <option value="">{brand ? 'Select a flavor' : 'Choose a brand first'}</option>
              {flavors.map((profile) => <option key={profile.id} value={profile.id}>{profile.flavor} · rev {profile.revision}</option>)}
            </select>
            <span className="field-help" id="run-flavor-help">The selected profile is captured as an immutable snapshot when the run is created.</span>
          </div>
          <div className="form-field"><label htmlFor="run-target-cases">Target cases</label><input id="run-target-cases" data-testid="input-run-target-cases" type="number" inputMode="numeric" min={1} step={1} value={targetCases} onChange={(event) => setTargetCases(event.target.value)} aria-describedby={validation ? 'run-error' : undefined} required /></div>
          {selectedProfile && <RunRequirementsEditor key={selectedProfile.id} profileId={selectedProfile.id} targetCases={Number(targetCases)} online={online}
            onReviewChange={(review) => setPlanning(review ? { profileId: selectedProfile.id, targetCases: Number(targetCases), review } : null)} />}
          {validation && <span className="field-help" id="run-error" role="alert">{validation}</span>}
          {createRun.isError && <div className="error-banner" role="alert">{getErrorMessage(createRun.error, 'Run could not be created.')}</div>}
          <div className="control-row"><button className="button button-primary" type="submit" disabled={!online || createRun.isPending || !selectedProfile || !reviewedPlanning}>{createRun.isPending ? <LoaderCircle size={16} /> : <Plus size={16} />} {createRun.isPending ? 'Saving planned run…' : 'Create planned run'}</button><button className="button button-secondary" type="button" onClick={() => { setIsCreating(false); setValidation(''); }} data-testid="button-cancel-create-run">Cancel</button></div>
        </form>}
        <div className="section-heading" style={{ marginTop: 26 }}>
          <h2>{filter === 'all' ? 'All facility runs' : `${filter[0].toUpperCase()}${filter.slice(1)} runs`}</h2>
          <label className="sr-only" htmlFor="run-filter">Filter runs by status</label>
          <select id="run-filter" aria-label="Filter runs by status" data-testid="select-run-filter" value={filter} onChange={(event) => setFilter(event.target.value as RunStatus | 'all')} style={{ minHeight: 40, padding: '0 12px', border: '1px solid hsl(var(--input))', borderRadius: 8, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}>
            <option value="all">All statuses</option><option value="planned">Planned</option><option value="running">Running</option><option value="paused">Paused</option><option value="completed">Completed</option>
          </select>
        </div>
        {runsQuery.data && <section className="panel run-list" aria-label="Facility production runs">
          {runs.length ? runs.map((run) => <RunRow key={run.id} run={run} />) : <EmptyState title={filter === 'all' ? 'No runs to show' : `No ${filter} runs`} copy={filter === 'all' ? 'Create a planned run to give your next shift a shared starting point.' : 'Try another status or create a new planned run.'} action={filter === 'all' ? profiles.length
            ? <button className="button button-secondary" type="button" onClick={() => setIsCreating(true)} disabled={!online}>Create a run <ArrowRight size={15} /></button>
            : profilesQuery.data ? <Link href="/imports" className="button button-secondary" data-testid="link-empty-import-profiles">Set up product profiles <ArrowRight size={15} /></Link>
              : undefined : undefined} />}
        </section>}
        {!online && runsQuery.data && <p className="field-help" style={{ marginTop: 14 }}>Cached run list only. Creating and lifecycle controls are unavailable offline.</p>}
      </main>
    </SiteShell>
  );
}

function RunDetailPage() {
  const [, params] = useRoute('/runs/:runId');
  const rawRunId = params?.runId || '';
  const runId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawRunId) ? rawRunId : '';
  const online = useConnection();
  const runQuery = useGetRun(runId, {
    query: { queryKey: getGetRunQueryKey(runId), enabled: Boolean(runId), refetchInterval: online ? 5000 : false },
    request: { credentials: 'include' },
  });
  const command = useApplyRunCommand({ request: { credentials: 'include' } });
  const client = useQueryClient();
  const [conflict, setConflict] = useState('');
  const commandKeys = useRef(new Map<string, string>());
  const run = runQuery.data?.run;
  const actions: { action: RunCommandRequest['commandType']; label: string; icon: ReactNode; className: string }[] = run ? (
    run.status === 'planned' ? [{ action: 'start', label: 'Start run', icon: <Play size={16} />, className: 'button-primary' }]
      : run.status === 'running' ? [{ action: 'pause', label: 'Pause run', icon: <Pause size={16} />, className: 'button-secondary' }, { action: 'complete', label: 'Complete run', icon: <Square size={15} />, className: 'button-warn' }]
        : run.status === 'paused' ? [{ action: 'resume', label: 'Resume run', icon: <Play size={16} />, className: 'button-primary' }, { action: 'complete', label: 'Complete run', icon: <Square size={15} />, className: 'button-warn' }]
          : []
  ) : [];
  const runAction = (action: RunCommandRequest['commandType']) => {
    if (!run || !online || command.isPending) return;
    setConflict('');
    const commandScope = `${run.id}:${run.revision}:${action}`;
    const idempotencyKey = commandKeys.current.get(commandScope) || crypto.randomUUID();
    commandKeys.current.set(commandScope, idempotencyKey);
    command.mutate({
      runId: run.id,
      data: { commandType: action, expectedRevision: run.revision, commandId: idempotencyKey },
    }, {
      onSuccess: (result) => {
        commandKeys.current.delete(commandScope);
        client.setQueryData(getGetRunQueryKey(run.id), { run: result.run });
        void client.invalidateQueries({ queryKey: getGetRunStationProgressQueryKey(run.id) });
        void client.invalidateQueries({ queryKey: getListRunsQueryKey() });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        setConflict(result.replayed
          ? `Already processed. Current saved state: ${result.run.status}, revision ${result.run.revision}.`
          : `Saved. Run is ${result.run.status} at revision ${result.run.revision}.`);
      },
      onError: (error) => {
        if (getErrorStatus(error) === 409) {
          commandKeys.current.delete(commandScope);
          setConflict('This run changed on another device. Your command was not applied. The latest state is being refreshed; review it before trying again.');
          void client.invalidateQueries({ queryKey: getGetRunQueryKey(run.id) });
          void client.invalidateQueries({ queryKey: getGetRunStationProgressQueryKey(run.id) });
          void client.invalidateQueries({ queryKey: getListRunsQueryKey() });
        }
      },
    });
  };
  return (
    <SiteShell>
      <main className="workspace">
        <OfflineNotice hasCache={Boolean(run)} />
        <Link href="/runs" className="text-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 22 }}><ArrowLeft size={15} /> All runs</Link>
        {!runId && <DataError message="This run address is not valid. Return to the facility run list and select a run." />}
        {runQuery.isLoading && !run && <><div className="skeleton" /><div className="skeleton" /></>}
        {runQuery.isError && !run && <DataError message={getErrorMessage(runQuery.error, 'This run could not be loaded.')} onRetry={() => void runQuery.refetch()} />}
        {runQuery.isError && run && <div className="error-banner" role="status">Could not refresh. Showing the last saved run state.</div>}
        {run && <>
          <div className="page-head"><div><div className="eyebrow">Run detail · revision {run.revision}</div><h1 data-testid={`text-run-name-${run.id}`}>{run.setupSnapshot.label}</h1><p className="page-subtitle">{run.setupSnapshot.targetCases} target cases{run.scheduledFor ? ` · Scheduled ${run.scheduledFor}` : ''} · Last updated {formatDateTime(run.updatedAt)}</p></div><Status status={run.status} /></div>
          {run.scheduleNotes && <div className="notice" role="note" aria-label="Schedule notes" style={{ marginBottom: 16 }}>{run.scheduleNotes}</div>}
          {run.scheduleSource && <p className="field-help" style={{ marginBottom: 16 }}>Imported from {run.scheduleSource.file} · {run.scheduleSource.sheet}, row {run.scheduleSource.row} · listed as {run.scheduleSource.brand}{run.scheduleSource.flavor ? ` / ${run.scheduleSource.flavor}` : ''}</p>}
          {(conflict || command.isError) && <div className={getErrorStatus(command.error) === 409 || conflict ? 'notice' : 'error-banner'} role="status" data-testid="status-command-feedback">{conflict || getErrorMessage(command.error, 'The command could not be saved. Check your connection and retry.')}</div>}
          <div className="detail-grid">
            <section className="panel detail-main">
              <div className="eyebrow">Current state</div>
              <Status status={run.status} />
              <p className="page-subtitle">{stateDescription(run.status)}</p>
              <div className="lifecycle">
                <h2>Lifecycle controls</h2>
                <p className="page-subtitle">Every change is checked against revision {run.revision}. Other devices see the confirmed state after it saves.</p>
                {run.status === 'completed' && <div className="notice"><Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />This run is complete. Its lifecycle is closed.</div>}
                {actions.length > 0 && <div className="control-row">
                  {actions.map((item) => <button key={item.action} type="button" className={`button ${item.className}`} disabled={!online || command.isPending} onClick={() => runAction(item.action)} data-testid={`button-run-${item.action}`}>
                    {command.isPending && command.variables?.data.commandType === item.action ? <LoaderCircle size={16} /> : item.icon}
                    {command.isPending && command.variables?.data.commandType === item.action ? 'Saving state…' : item.label}
                  </button>)}
                </div>}
                {!online && <p className="field-help" style={{ marginTop: 13 }}>Lifecycle commands are read-only while disconnected. No changes will be queued.</p>}
              </div>
            </section>
            <aside className="panel detail-aside" aria-label="Run record details">
              <h3>Run record</h3>
              <Property label="Status" value={<Status status={run.status} />} />
              <Property label="Revision" value={<span className="mono">#{run.revision}</span>} />
              <Property label="Created" value={formatDateTime(run.createdAt)} />
              <Property label="Scheduled for" value={run.scheduledFor ?? 'Not scheduled'} />
              <Property label="Started" value={run.startedAt ? formatDateTime(run.startedAt) : 'Not started'} />
              <Property label="Paused" value={run.pausedAt ? formatDateTime(run.pausedAt) : '—'} />
              <Property label="Resumed" value={run.resumedAt ? formatDateTime(run.resumedAt) : '—'} />
              <Property label="Completed" value={run.completedAt ? formatDateTime(run.completedAt) : '—'} />
            </aside>
          </div>
          <section className="panel snapshot-panel" style={{ marginTop: 16 }} aria-labelledby="product-snapshot-heading">
            <div className="snapshot-title">
              <div className="snapshot-mark"><Factory size={18} aria-hidden="true" /></div>
              <div><div className="eyebrow">Captured at run creation</div><h2 id="product-snapshot-heading">Product setup snapshot</h2></div>
            </div>
            {run.productSnapshot
              ? <>
                <div className="property-row"><span>Profile</span><strong>{run.productSnapshot.brand} / {run.productSnapshot.flavor}</strong></div>
                <div className="property-row"><span>Captured revision</span><strong className="mono">#{run.productSnapshot.revision}</strong></div>
                <div className="property-row"><span>Source profile last updated</span><strong>{formatDateTime(run.productSnapshot.updatedAt)}</strong></div>
                <p style={{ marginTop: 14 }}>This is the immutable product profile captured for this run. It may differ from the profile currently in the facility list.</p>
                <OperationalSetupSummary data={run.productSnapshot.productData} brand={run.productSnapshot.brand} nameResolution={run.productSnapshot.nameResolution} title="Captured recipe and process details" />
                <ProductSpecSummary data={run.productSnapshot.productData} brand={run.productSnapshot.brand} flavor={run.productSnapshot.flavor} nameResolution={run.productSnapshot.nameResolution} title="Captured product specifications" defaultOpen />
                <details className="profile-bundle"><summary>View captured source data</summary><pre>{JSON.stringify(run.productSnapshot.productData, null, 2)}</pre></details>
              </>
              : <div className="notice" role="status">No product profile snapshot was attached when this run was created. The run setup remains unchanged.</div>}
          </section>
          {run.productSnapshot?.runRequirements && <RunRequirementsSummary plan={run.productSnapshot.runRequirements} runId={run.id} runStatus={run.status} online={online} />}
          {!run.productSnapshot?.runRequirements && <div className="notice" role="status">This run has no captured requirements plan. Its original snapshot has not been changed.</div>}
          <RunStationProgressSection
            runId={run.id}
            run={run}
            online={online}
            targetCases={run.setupSnapshot.targetCases}
            requirementsPlan={run.productSnapshot?.runRequirements ?? null}
          />
          {command.isPending && <div className="notice" role="status"><LoaderCircle size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Sending the revision-checked command. Wait for confirmation before leaving this page.</div>}
        </>}
      </main>
    </SiteShell>
  );
}

function FacilityTeamRoute() {
  const online = useConnection();
  const context = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  if (context.isLoading) return <LoadingPage title="Checking facility access" />;
  if (!context.data && context.isError) {
    return <SiteShell><DataError message={getErrorMessage(context.error, 'Could not load facility access.')} onRetry={() => void context.refetch()} /></SiteShell>;
  }
  if (context.data && !context.data.facility) {
    return <FacilitySetup online={online} />;
  }
  if (!context.data?.facility) return <LoadingPage title="Preparing your workspace" />;
  if (context.data.role !== 'owner') {
    return (
      <SiteShell facilityName={context.data.facility.name}>
        <main className="workspace">
          <section className="panel empty-state" role="status" data-testid="status-team-owner-only">
            <div className="empty-mark"><ShieldCheck size={21} /></div>
            <h1>Owner access required</h1>
            <p>Only facility owners can manage team members and roles.</p>
            <Link href="/" className="button button-secondary">Return to overview</Link>
          </section>
        </main>
      </SiteShell>
    );
  }
  return (
    <SiteShell facilityName={context.data.facility.name}>
      <FacilityMembersPage />
    </SiteShell>
  );
}

function Property({ label, value }: { label: string; value: ReactNode }) {
  return <div className="property-row"><span>{label}</span><span>{value}</span></div>;
}

function stateDescription(status: RunStatus) {
  switch (status) {
    case 'planned': return 'This planned run is ready for an operator to start when the line is prepared.';
    case 'running': return 'This run is in progress. Changes to its state are shared after confirmation.';
    case 'paused': return 'This run is paused. Resume when the team is ready to continue.';
    case 'completed': return 'This run has been completed and recorded.';
    default: return 'Run state is unavailable.';
  }
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'time unavailable';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function LoadingPage({ title }: { title: string }) {
  return <main className="workspace" aria-live="polite" aria-busy="true"><div className="eyebrow">Lucia</div><h1>{title}</h1><div className="skeleton" /><div className="skeleton" /></main>;
}

function DataError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="panel empty-state"><div className="empty-mark"><CircleAlert size={21} /></div><h2>We couldn’t load this view.</h2><p>{message}</p>{onRetry && <button className="button button-secondary" type="button" onClick={onRetry}><RefreshCw size={15} /> Try again</button>}</div>;
}

function Protected({ children }: { children: ReactNode }) {
  return <><Show when="signed-in"><FacilityGate>{children}</FacilityGate></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function FacilityGate({ children }: { children: ReactNode }) {
  const context = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const online = useConnection();
  if (context.isLoading) return <LoadingPage title="Checking facility access" />;
  if (!context.data && context.isError) {
    return <SiteShell><DataError message={getErrorMessage(context.error, 'Could not load facility access.')} onRetry={() => void context.refetch()} /></SiteShell>;
  }
  if (context.data && !context.data.facility) return <FacilitySetup online={online} />;
  if (!context.data?.facility) return <LoadingPage title="Preparing your workspace" />;
  return <>{children}</>;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#376e5e',
    colorForeground: '#293d3a',
    colorMutedForeground: '#68776f',
    colorDanger: '#a34838',
    colorBackground: '#fbfaf5',
    colorInput: '#f4f1e8',
    colorInputForeground: '#293d3a',
    colorNeutral: '#293d3a',
    fontFamily: 'DM Sans',
    borderRadius: '10px',
  },
  elements: {
    rootBox: 'w-full min-w-0 max-w-full flex justify-center',
    cardBox: 'bg-[#fbfaf5] rounded-2xl w-full min-w-0 max-w-full box-border overflow-hidden border border-[#ded9cd]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#293d3a] font-bold',
    headerSubtitle: 'text-[#68776f]',
    socialButtonsBlockButtonText: 'text-[#293d3a] font-semibold',
    formFieldLabel: 'text-[#293d3a] font-semibold',
    footerActionLink: 'text-[#376e5e] font-semibold',
    footerActionText: 'text-[#68776f]',
    dividerText: 'text-[#68776f]',
    identityPreviewEditButton: 'text-[#376e5e]',
    formFieldSuccessText: 'text-[#376e5e]',
    alertText: 'text-[#783e31]',
    logoBox: 'mb-3',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border border-[#ded9cd] rounded-lg',
    formButtonPrimary: 'bg-[#376e5e] hover:bg-[#2c5c4e] text-white',
    formFieldInput: 'rounded-lg border-[#d7d1c4] text-[#293d3a]',
    footerAction: 'text-[#68776f]',
    dividerLine: 'bg-[#ded9cd]',
    alert: 'rounded-lg',
    otpCodeFieldInput: 'border-[#d7d1c4] text-[#293d3a]',
    formFieldRow: 'mb-4',
    main: 'text-[#293d3a]',
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClientInstance = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        queryClientInstance.clear();
        setV2CsrfToken(null);
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClientInstance]);
  return null;
}

function V2SessionBootstrapper() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const client = useQueryClient();
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn || !userId) {
      setV2CsrfToken(null);
      return;
    }

    let active = true;
    let bootstrapping = false;
    const bootstrap = async () => {
      if (bootstrapping) return;
      bootstrapping = true;
      try {
        const response = await fetch('/api/v2/session', {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('The API session could not be refreshed.');
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('csrfToken' in body) || typeof body.csrfToken !== 'string') {
          throw new Error('The API session response was invalid.');
        }
        if (active) {
          setV2CsrfToken(body.csrfToken);
          await client.invalidateQueries();
        }
      } finally {
        bootstrapping = false;
      }
    };

    const onOnline = () => {
      void bootstrap().catch(() => {
        if (active) setV2CsrfToken(null);
      });
    };
    void bootstrap().catch(() => {
      if (active) setV2CsrfToken(null);
    });
    window.addEventListener('online', onOnline);
    const interval = window.setInterval(() => {
      void bootstrap().catch(() => {
        if (active) setV2CsrfToken(null);
      });
    }, 4 * 60 * 60 * 1000);

    return () => {
      active = false;
      window.removeEventListener('online', onOnline);
      window.clearInterval(interval);
    };
  }, [client, isLoaded, isSignedIn, userId]);
  return null;
}

function RouterContent() {
  const [, setLocation] = useLocation();
  const health = useHealthCheck({
    query: {
      queryKey: ['/api/healthz'],
      staleTime: 10_000,
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    },
    request: { credentials: 'include' },
  });
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your production workspace' } },
        signUp: { start: { title: 'Create your account', subtitle: 'Set up your production workspace' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <V2SessionBootstrapper />
      <WorkerAvailabilityNotice health={health.data} />
      <ErrorBoundary resetKey={window.location.pathname}>
        <Suspense fallback={<LoadingPage title="Loading your workspace" />}>
          <Switch>
            <Route path="/" component={HomeRoute} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/runs" component={() => <Protected><RunsPage /></Protected>} />
            <Route path="/imports" component={() => <Protected><SiteShell><ImportsPage /></SiteShell></Protected>} />
            <Route path="/runs/:runId" component={() => <Protected><RunDetailPage /></Protected>} />
            <Route path="/stations" component={() => <Protected><SiteShell><StationLineupPage /></SiteShell></Protected>} />
            <Route path="/inventory" component={() => <Protected><SiteShell><InventoryPage /></SiteShell></Protected>} />
            <Route path="/team" component={() => <Protected><FacilityTeamRoute /></Protected>} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    </ClerkProvider>
  );
}

function App() {
  const visualPath = stripBase(window.location.pathname);
  const isVisualPreview = import.meta.env.DEV && visualPath === '/__visual-preview/imports';
  const isStationCalculatorPreview = import.meta.env.DEV && visualPath === '/__visual-preview/station-calculator';
  if (!clerkPubKey && !isVisualPreview && !isStationCalculatorPreview) {
    throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  }
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {isVisualPreview
          ? <Suspense fallback={<LoadingPage title="Loading importer preview" />}><ImportsVisualPreviewPage /></Suspense>
          : isStationCalculatorPreview
            ? <Suspense fallback={<LoadingPage title="Loading station calculator preview" />}><StationCalculatorVisualPreviewPage /></Suspense>
            : <WouterRouter base={basePath}><RouterContent /></WouterRouter>}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
