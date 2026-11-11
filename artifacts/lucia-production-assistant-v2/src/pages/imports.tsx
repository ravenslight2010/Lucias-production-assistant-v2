import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDownToLine, ChevronDown, CircleAlert, FileSpreadsheet,
  GitMerge, LoaderCircle, Pencil, RefreshCw, ShieldCheck, Upload,
} from 'lucide-react';
import {
  getListProductProfilesQueryKey,
  getListImportBatchesQueryKey,
  getListRunsQueryKey,
  useImportProductProfile,
  useListProductProfiles,
  useListImportBatches,
  useMergeProductProfile,
  useRenameProductProfile,
} from '@workspace/api-client-react';
import type { ProductProfile, ProductProfileImportInput } from '@workspace/api-client-react';
import { IMPORT_KINDS, parseWorkbookFile, type ImportKind, type ParsedWorkbook } from '../importing/workbook';

const kindLabels: Record<ImportKind, string> = {
  product_specs: 'Product specifications',
  premix: 'Premix',
  cheese: 'Cheese',
  shipping: 'Shipping',
  sauce_guide: 'Sauce guide',
  dough_guide: 'Dough guide',
  schedule: 'Production schedule',
};

function errorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function toSparseWorkbook(workbook: ParsedWorkbook) {
  return {
    format: 'lucia.workbook.sparse.v1',
    sheets: workbook.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.rows.flatMap((row, rowIndex) => row.flatMap((value, columnIndex) =>
        value === null || value === '' ? [] : [{ r: rowIndex, c: columnIndex, v: value }],
      )),
    })),
  };
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function WorkbookReview() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  const client = useQueryClient();
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [kind, setKind] = useState<ImportKind | ''>('');
  const [brand, setBrand] = useState('');
  const [flavor, setFlavor] = useState('');
  const [parseError, setParseError] = useState('');
  const [validation, setValidation] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const importer = useImportProductProfile({ request: { credentials: 'include' } });

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setParseError('');
    setValidation('');
    setSavedMessage('');
    setWorkbook(null);
    setSourceFile(file);
    try {
      const parsed = await parseWorkbookFile(file);
      setWorkbook(parsed);
      setKind(parsed.kind ?? '');
    } catch (error) {
      setParseError(errorText(error, 'This workbook could not be opened.'));
    }
    event.currentTarget.value = '';
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workbook || !sourceFile || !kind || kind === 'schedule') return;
    const cleanBrand = brand.trim();
    const cleanFlavor = flavor.trim();
    if (!cleanBrand || cleanBrand.length > 120 || !cleanFlavor || cleanFlavor.length > 120) {
      setValidation('Brand and flavor are required and must each be 120 characters or fewer.');
      return;
    }
    setValidation('');
    setSavedMessage('');
    try {
      const productData = toSparseWorkbook(workbook);
      const productDataSize = JSON.stringify(productData).length;
      if (productDataSize > 700_000) {
        setValidation('The compact workbook data is over the 700,000-character API limit. Remove excess content from the source workbook and review it again.');
        return;
      }
      const input: ProductProfileImportInput = {
        brand: cleanBrand,
        flavor: cleanFlavor,
        sourceName: workbook.fileName,
        sourceHash: await sha256(sourceFile),
        importKind: kind,
        productData,
      };
      const serializedRequestBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      if (serializedRequestBytes > 1_000_000) {
        setValidation('This request is over the 1 MB API limit after adding its source details. Reduce the workbook content before importing.');
        return;
      }
      importer.mutate({ data: input }, {
        onSuccess: (result) => {
          setSavedMessage(result.imported
            ? `${result.profile.brand} / ${result.profile.flavor} was saved as revision ${result.profile.revision}.`
            : 'This source is already saved. No duplicate profile was created.');
          void client.invalidateQueries({ queryKey: getListProductProfilesQueryKey() });
          void client.invalidateQueries({ queryKey: getListImportBatchesQueryKey() });
        },
      });
    } catch (error) {
      setValidation(errorText(error, 'The workbook source could not be prepared.'));
    }
  };

  return (
    <section className="panel import-panel" aria-labelledby="workbook-heading">
      <div className="eyebrow">Reviewed source</div>
      <h2 id="workbook-heading">Bring in setup data</h2>
      <p className="field-help" style={{ display: 'block', lineHeight: 1.6, marginBottom: 17 }}>
        Choose a workbook, inspect its source cells, then explicitly save it as a facility profile. Nothing is applied until you import.
      </p>
      <div className="upload-zone">
        <label htmlFor="workbook-file">
          <Upload size={21} aria-hidden="true" />
          <span style={{ color: 'hsl(var(--foreground))' }}>Choose an .xlsx or .xlsm workbook</span>
          <span>Up to 25 MB · workbook limits are checked during review</span>
        </label>
        <input id="workbook-file" type="file" accept=".xlsx,.xlsm" onChange={(event) => void chooseFile(event)} aria-label="Choose a product or process workbook" data-testid="input-workbook-file" />
      </div>
      {parseError && <div className="error-banner" role="alert">{parseError}</div>}
      {workbook && <>
        <div className="workbook-preview" aria-live="polite">
          <div className="workbook-preview-head">
            <span><FileSpreadsheet size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{workbook.fileName}</span>
            <span>{workbook.sheetCount} sheets · {workbook.cellCount.toLocaleString()} grid cells</span>
          </div>
          <div className="workbook-sheet">
            <strong>Workbook content preview</strong>
            <div className="field-help" style={{ marginTop: 4 }}>Showing the first 6 populated cells per sheet, for up to 4 sheets. Lucia has not normalized these into operational fields; the compact import retains every populated source cell.</div>
          </div>
          {workbook.sheets.slice(0, 4).map((sheet) => {
            const previewCells = sheet.rows.flatMap((row, r) => row.flatMap((value, c) =>
              value === null || value === '' ? [] : [{ r, c, value }],
            )).slice(0, 6);
            return <div className="workbook-sheet" key={sheet.name}>
              <strong>{sheet.name}</strong>
              {previewCells.length ? <div className="sheet-cells">
                {previewCells.map(({ r, c, value }) => <div className="sheet-cell" key={`${r}:${c}`}><b>R{r + 1}C{c + 1}</b><span>{String(value)}</span></div>)}
              </div> : <div className="field-help" style={{ marginTop: 7 }}>No populated cells in this worksheet.</div>}
            </div>;
          })}
          {workbook.sheets.length > 4 && <div className="workbook-sheet field-help">Preview limited to the first 4 of {workbook.sheets.length} worksheets. All source cells are retained in the compact import payload.</div>}
        </div>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <div className="import-fields">
            <div className="form-field"><label htmlFor="profile-brand">Brand</label><input id="profile-brand" autoComplete="organization" maxLength={120} value={brand} onChange={(event) => setBrand(event.target.value)} required /></div>
            <div className="form-field"><label htmlFor="profile-flavor">Flavor</label><input id="profile-flavor" maxLength={120} value={flavor} onChange={(event) => setFlavor(event.target.value)} required /></div>
          </div>
          <div className="form-field">
            <label htmlFor="workbook-kind">Workbook type</label>
            <select id="workbook-kind" value={kind} onChange={(event) => setKind(event.target.value as ImportKind | '')} required>
              <option value="">Select type to continue</option>
              {IMPORT_KINDS.map((item) => <option key={item} value={item}>{kindLabels[item]}{item === 'schedule' ? ' · preview only' : ''}</option>)}
            </select>
            <span className="field-help">Detected: {workbook.kind ? `${kindLabels[workbook.kind]} (${workbook.kindConfidence === 'high' ? 'high confidence' : 'review suggested'})` : 'No confident type; choose one after reviewing.'}</span>
          </div>
          {kind === 'schedule' && <div className="notice" role="status"><AlertTriangle size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Schedule workbooks can be previewed, but cannot be saved as product profiles. Schedule rows need a separate run-mapping review.</div>}
          {validation && <div className="error-banner" role="alert">{validation}</div>}
          {importer.isError && <div className={errorStatus(importer.error) === 409 ? 'notice' : 'error-banner'} role="alert">{errorStatus(importer.error) === 409 ? 'The source conflicts with a change made elsewhere. Refresh profiles and review the current setup before retrying.' : errorText(importer.error, 'The profile was not saved. Check the connection and try again.')}</div>}
          {savedMessage && <div className="notice" role="status"><ShieldCheck size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{savedMessage}</div>}
          <button className="button button-primary" type="submit" disabled={!online || importer.isPending || !kind || kind === 'schedule'} data-testid="button-import-profile">
            {importer.isPending ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}
            {importer.isPending ? 'Saving source profile…' : 'Save product profile'}
          </button>
          {!online && <p className="field-help" style={{ marginTop: 10 }}>Offline: workbook review is available, but profiles cannot be saved.</p>}
        </form>
      </>}
    </section>
  );
}

function ProfileCard({ profile, profiles }: { profile: ProductProfile; profiles: ProductProfile[] }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [brand, setBrand] = useState(profile.brand);
  const [flavor, setFlavor] = useState(profile.flavor);
  const [targetId, setTargetId] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [validation, setValidation] = useState('');
  const rename = useRenameProductProfile({ request: { credentials: 'include' } });
  const merge = useMergeProductProfile({ request: { credentials: 'include' } });
  const targets = profiles.filter((item) => item.id !== profile.id && !item.mergedIntoId);
  const importedSources = useMemo(() => {
    const raw = profile.productData as Record<string, unknown>;
    const sheets = Array.isArray(raw.sheets) ? raw.sheets.length : null;
    return sheets === null ? 'Saved source bundle' : `${sheets} worksheet${sheets === 1 ? '' : 's'}`;
  }, [profile.productData]);

  const saveRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextBrand = brand.trim();
    const nextFlavor = flavor.trim();
    if (!nextBrand || !nextFlavor || nextBrand.length > 120 || nextFlavor.length > 120) {
      setValidation('Enter a brand and flavor, each no longer than 120 characters.');
      return;
    }
    setValidation('');
    setFeedback('');
    rename.mutate({ profileId: profile.id, data: { brand: nextBrand, flavor: nextFlavor, expectedRevision: profile.revision } }, {
      onSuccess: (result) => {
        setEditing(false);
        setFeedback(`Renamed at revision ${result.profile.revision}.`);
        void client.invalidateQueries({ queryKey: getListProductProfilesQueryKey() });
      },
      onError: (error) => {
        setFeedback(errorStatus(error) === 409
          ? 'Conflict: this profile changed on another device. No rename was applied; refresh and review its current revision.'
          : errorText(error, 'Rename failed. No change was applied.'));
      },
    });
  };

  const submitMerge = () => {
    const target = targets.find((item) => item.id === targetId);
    if (!target) return;
    setFeedback('');
    merge.mutate({
      profileId: profile.id,
      data: { targetProfileId: target.id, expectedSourceRevision: profile.revision, expectedTargetRevision: target.revision },
    }, {
      onSuccess: (result) => {
        setConfirmMerge(false);
        setFeedback(`Merged into ${result.profile.brand} / ${result.profile.flavor}. Both source bundles remain preserved.`);
        void client.invalidateQueries({ queryKey: getListProductProfilesQueryKey() });
        void client.invalidateQueries({ queryKey: getListRunsQueryKey() });
      },
      onError: (error) => {
        setConfirmMerge(false);
        setFeedback(errorStatus(error) === 409
          ? 'Conflict: one of these profiles changed elsewhere. The merge was not applied. Refresh and compare revisions before confirming again.'
          : errorText(error, 'Merge failed. Neither source bundle was discarded.'));
      },
    });
  };

  return (
    <article className="panel profile-card" data-testid={`card-profile-${profile.id}`}>
      <div className="profile-card-head">
        <div>
          <h3>{profile.brand} <span style={{ color: 'hsl(var(--muted-foreground))' }}>/</span> {profile.flavor}</h3>
          <div className="profile-meta">REV {String(profile.revision).padStart(2, '0')} · {importedSources} · Updated {new Date(profile.updatedAt).toLocaleDateString()}</div>
        </div>
        <span className="status status-running">Active profile</span>
      </div>
      {editing && <form onSubmit={saveRename} noValidate className="import-fields" style={{ marginTop: 10 }}>
        <div className="form-field"><label htmlFor={`rename-brand-${profile.id}`}>Brand</label><input id={`rename-brand-${profile.id}`} value={brand} maxLength={120} onChange={(event) => setBrand(event.target.value)} /></div>
        <div className="form-field"><label htmlFor={`rename-flavor-${profile.id}`}>Flavor</label><input id={`rename-flavor-${profile.id}`} value={flavor} maxLength={120} onChange={(event) => setFlavor(event.target.value)} /></div>
        {validation && <div className="field-help" role="alert" style={{ gridColumn: '1/-1' }}>{validation}</div>}
        {rename.isError && <div className="error-banner" role="alert" style={{ gridColumn: '1/-1' }}>{errorStatus(rename.error) === 409 ? 'Revision conflict: rename was not applied. Refresh and review the latest profile.' : errorText(rename.error, 'Rename failed.')}</div>}
        <div className="control-row" style={{ gridColumn: '1/-1', marginTop: 0 }}>
          <button className="button button-primary" type="submit" disabled={rename.isPending}>{rename.isPending ? 'Saving rename…' : 'Save rename'}</button>
          <button className="button button-secondary" type="button" onClick={() => { setEditing(false); setBrand(profile.brand); setFlavor(profile.flavor); }}>Cancel</button>
        </div>
      </form>}
      <details className="profile-bundle">
        <summary>View preserved source data <ChevronDown size={13} style={{ verticalAlign: 'middle' }} /></summary>
        <pre>{JSON.stringify(profile.productData, null, 2)}</pre>
      </details>
      <div className="profile-actions">
        {!editing && <button className="button button-secondary" type="button" onClick={() => { setEditing(true); setFeedback(''); }} data-testid={`button-rename-${profile.id}`}><Pencil size={14} /> Rename profile</button>}
        {targets.length > 0 && <>
          <label className="sr-only" htmlFor={`merge-target-${profile.id}`}>Select profile to merge into</label>
          <select id={`merge-target-${profile.id}`} value={targetId} onChange={(event) => { setTargetId(event.target.value); setConfirmMerge(false); }} aria-label={`Select merge destination for ${profile.brand} ${profile.flavor}`}>
            <option value="">Merge into another profile…</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.brand} / {target.flavor} · rev {target.revision}</option>)}
          </select>
          <button className="button button-quiet" type="button" onClick={() => { setConfirmMerge(true); setFeedback(''); }} disabled={!targetId || merge.isPending} data-testid={`button-merge-${profile.id}`}><GitMerge size={14} /> Merge profiles</button>
        </>}
        {confirmMerge && targetId && <div className="confirm-merge" role="group" aria-label="Confirm profile merge">
          <strong>Confirm merge?</strong> The source profile will leave the active list and be linked into the selected profile. Both original source bundles are preserved; existing run snapshots do not change.
          <div className="control-row">
            <button className="button button-warn" type="button" onClick={submitMerge} disabled={merge.isPending}>{merge.isPending ? 'Merging…' : 'Confirm and merge'}</button>
            <button className="button button-secondary" type="button" onClick={() => setConfirmMerge(false)}>Keep profiles separate</button>
          </div>
        </div>}
        {feedback && <div className={feedback.startsWith('Conflict') || feedback.includes('failed') ? 'error-banner' : 'notice'} role="status" style={{ flexBasis: '100%' }}>{feedback}</div>}
      </div>
    </article>
  );
}

export default function ImportsPage() {
  const profilesQuery = useListProductProfiles({
    query: { queryKey: getListProductProfilesQueryKey() },
    request: { credentials: 'include' },
  });
  const profiles = profilesQuery.data?.profiles ?? [];
  const historyQuery = useListImportBatches({
    query: { queryKey: getListImportBatchesQueryKey() },
    request: { credentials: 'include' },
  });
  const importBatches = historyQuery.data?.imports ?? [];
  return (
    <main className="workspace">
      <div className="page-head">
        <div><div className="eyebrow">Facility setup library</div><h1>Product profiles</h1><p className="page-subtitle">Approved workbook source data used to set up new production runs.</p></div>
      </div>
      <p className="import-intro">Profiles are shared setup references, not an archive. New runs capture an immutable product snapshot at creation; later profile edits do not rewrite existing runs.</p>
      <div className="import-layout">
        <WorkbookReview />
        <section aria-labelledby="profiles-heading">
          <div className="section-heading"><h2 id="profiles-heading">Active profiles</h2><span className="eyebrow">{profiles.length} saved</span></div>
          {profilesQuery.isLoading && !profilesQuery.data && <><div className="skeleton" /><div className="skeleton" /></>}
          {profilesQuery.isError && !profilesQuery.data && <div className="panel empty-state"><div className="empty-mark"><CircleAlert size={20} /></div><h3>Profiles are unavailable</h3><p>{errorText(profilesQuery.error, 'Could not load facility profiles.')}</p><button className="button button-secondary" type="button" onClick={() => void profilesQuery.refetch()}><RefreshCw size={14} /> Try again</button></div>}
          {profilesQuery.isError && profilesQuery.data && <div className="error-banner" role="status">Could not refresh profiles. Showing the last loaded list.</div>}
          {profilesQuery.data && (profiles.length
            ? <div className="profile-list">{profiles.map((profile) => <ProfileCard key={profile.id} profile={profile} profiles={profiles} />)}</div>
            : <div className="panel empty-state"><div className="empty-mark"><FileSpreadsheet size={21} /></div><h3>No approved profiles yet</h3><p>Review a product or process workbook to create the facility’s first run setup profile. Nothing is imported automatically.</p></div>)}
        </section>
      </div>
      <section className="import-history-section" aria-labelledby="import-history-heading">
        <div className="section-heading"><div><div className="eyebrow">Source activity</div><h2 id="import-history-heading">Recent imports</h2></div><span className="field-help">Metadata only · workbook contents are not available here</span></div>
        {historyQuery.isLoading && !historyQuery.data && <div className="history-loading" aria-label="Loading recent imports"><div className="skeleton" /><div className="skeleton" /></div>}
        {historyQuery.isError && !historyQuery.data && <div className="panel empty-state"><div className="empty-mark"><CircleAlert size={20} /></div><h3>Import history is unavailable</h3><p>{errorText(historyQuery.error, 'Could not load recent import activity.')}</p><button className="button button-secondary" type="button" onClick={() => void historyQuery.refetch()}><RefreshCw size={14} /> Try again</button></div>}
        {historyQuery.isError && historyQuery.data && <div className="error-banner" role="status">Could not refresh import history. Showing the last loaded activity.</div>}
        {historyQuery.data && (importBatches.length ? <div className="panel import-history" role="list" aria-label="Recent workbook imports">
          {importBatches.map((batch) => <article className="history-row" role="listitem" key={batch.id} data-testid={`row-import-${batch.id}`}>
            <div className="history-file"><FileSpreadsheet size={17} aria-hidden="true" /><div><strong>{batch.sourceName}</strong><span>{kindLabels[batch.importKind]} · {batch.proposedBrand && batch.proposedFlavor ? `${batch.proposedBrand} / ${batch.proposedFlavor}` : 'No proposed profile name'}</span></div></div>
            <div className="history-state"><span className={`import-state import-state-${batch.status}`}>{batch.status === 'applied' ? 'Applied' : 'Draft'}</span><span>{batch.status === 'applied' && batch.appliedAt ? `Applied ${new Date(batch.appliedAt).toLocaleString()}` : `Reviewed ${new Date(batch.createdAt).toLocaleString()}`}</span></div>
          </article>)}
        </div> : <div className="panel empty-state"><div className="empty-mark"><FileSpreadsheet size={20} /></div><h3>No import activity yet</h3><p>Reviewed workbook sources will appear here after the import service records them. This history contains metadata only.</p></div>)}
      </section>
    </main>
  );
}
