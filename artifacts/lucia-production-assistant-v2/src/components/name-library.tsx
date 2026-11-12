import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey,
  getGetFacilityContextQueryKey,
  getGetNameLibraryQueryKey,
  getListProductProfilesQueryKey,
  useChangeLibraryName,
  useGetFacilityContext,
  useGetNameLibrary,
} from '@workspace/api-client-react';
import type { LibraryNameEntry, NameLibrary, NameReference, NameReferenceKind } from '@workspace/api-client-react';
import './name-library.css';

const PAGE = 50;
const KINDS: { kind: NameReferenceKind; label: string; singular: string }[] = [
  { kind: 'brand', label: 'Brands', singular: 'brand' },
  { kind: 'flavor', label: 'Flavors', singular: 'flavor' },
  { kind: 'recipe', label: 'Recipes & spec references', singular: 'recipe' },
  { kind: 'ingredient', label: 'Ingredients', singular: 'ingredient' },
];

type Draft = {
  mode: 'rename' | 'merge';
  source: LibraryNameEntry;
  expectedVersion: string;
  newName: string;
  targetKey: string;
  confirming: boolean;
  error: string;
  conflict: boolean;
  reviewing: boolean;
};
type Feedback = { id: string; text: string };

const refKey = (r: NameReference) => `${r.kind}\u0000${r.brand}\u0000${r.name}`;
const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const testKey = (r: NameReference) => `${r.kind}-${r.brand}-${r.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
const brandLabel = (r: NameReference) => (r.kind === 'brand' ? 'Brand name' : r.brand ? `Brand: ${r.brand}` : 'No brand');
const describe = (r: NameReference) => (r.kind === 'brand' ? r.name : `${r.name} (${r.brand || 'no brand'})`);

function errorStatus(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) {
    const s = (error as { status?: unknown }).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
}
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

function Counts({ entry }: { entry: LibraryNameEntry }) {
  const isRecipe = entry.reference.kind === 'recipe';
  return (
    <div className="nl-counts" data-testid={`text-counts-${testKey(entry.reference)}`}>
      <span className="nl-chip">{entry.profileIds.length} profile{entry.profileIds.length === 1 ? '' : 's'}</span>
      {isRecipe && (entry.formulaCount > 0
        ? <span className="nl-chip nl-chip-formula">{entry.formulaCount} batch formula reference{entry.formulaCount === 1 ? '' : 's'}</span>
        : <span className="nl-chip nl-chip-spec">Spec reference only, no formula</span>)}
      {!isRecipe && entry.formulaCount > 0 && <span className="nl-chip">{entry.formulaCount} formula{entry.formulaCount === 1 ? '' : 's'}</span>}
      {entry.specReferenceCount > 0 && <span className="nl-chip">{entry.specReferenceCount} spec reference{entry.specReferenceCount === 1 ? '' : 's'}</span>}
      {entry.ingredientReferenceCount > 0 && <span className="nl-chip">{entry.ingredientReferenceCount} ingredient line{entry.ingredientReferenceCount === 1 ? '' : 's'}</span>}
      {entry.aliases.length > 0 && <span className="nl-chip">{entry.aliases.length} alias{entry.aliases.length === 1 ? '' : 'es'}</span>}
    </div>
  );
}

function EntryCard({ label, entry, reference }: { label: string; entry?: LibraryNameEntry; reference: NameReference }) {
  return (
    <div className="nl-compare-card">
      <span className="nl-compare-label">{label}</span>
      <strong>{reference.name}</strong>
      <span className="nl-brand">{brandLabel(reference)}</span>
      {entry ? <Counts entry={entry} /> : <div className="nl-brand">New name, no existing entry</div>}
    </div>
  );
}

export function NameLibraryPanel() {
  const online = useOnline();
  const client = useQueryClient();
  const library = useGetNameLibrary({
    query: { queryKey: getGetNameLibraryQueryKey() },
    request: { credentials: 'include' },
  });
  const facility = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const change = useChangeLibraryName({ request: { credentials: 'include' } });

  const [kind, setKind] = useState<NameReferenceKind>('brand');
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [feedback, setFeedback] = useState<Feedback[]>([]);

  const data = library.data;
  // Role: null means no facility membership; writes need a facility role.
  const canWrite = Boolean(facility.data?.facility && facility.data.role);
  const writesDisabled = !online || !canWrite || change.isPending || !data;

  const entries = data?.entries ?? [];
  const byKey = useMemo(() => new Map(entries.map((e) => [refKey(e.reference), e])), [entries]);
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.reference.kind] = (c[e.reference.kind] ?? 0) + 1;
    return c;
  }, [entries]);
  const brands = useMemo(
    () => [...new Set(entries.filter((e) => e.reference.kind !== 'brand').map((e) => e.reference.brand))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const filtered = useMemo(() => {
    const q = norm(search);
    return entries
      .filter((e) => e.reference.kind === kind)
      .filter((e) => kind === 'brand' || !brandFilter || e.reference.brand === brandFilter)
      .filter((e) => !q || norm(e.reference.name).includes(q) || norm(e.reference.brand).includes(q) || e.aliases.some((a) => norm(a.name).includes(q) || norm(a.brand).includes(q)))
      .sort((a, b) => a.reference.brand.localeCompare(b.reference.brand) || a.reference.name.localeCompare(b.reference.name));
  }, [entries, kind, brandFilter, search]);
  const visible = filtered.slice(0, limit);

  useEffect(() => { setLimit(PAGE); }, [kind, brandFilter, search]);

  const startDraft = (entry: LibraryNameEntry, mode: Draft['mode']) => {
    if (!data) return;
    change.reset();
    setDraft({ mode, source: entry, expectedVersion: data.version, newName: entry.reference.name, targetKey: '', confirming: false, error: '', conflict: false, reviewing: false });
  };
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const sourceRef = draft?.source.reference;
  const mergeCandidates = useMemo(() => {
    if (!sourceRef) return [];
    return entries
      .filter((e) => e.reference.kind === sourceRef.kind && refKey(e.reference) !== refKey(sourceRef))
      .sort((a, b) => {
        const sa = a.reference.brand === sourceRef.brand ? 0 : 1;
        const sb = b.reference.brand === sourceRef.brand ? 0 : 1;
        return sa - sb || a.reference.brand.localeCompare(b.reference.brand) || a.reference.name.localeCompare(b.reference.name);
      });
  }, [entries, sourceRef]);

  const target: NameReference | null = draft && sourceRef
    ? draft.mode === 'rename'
      ? { kind: sourceRef.kind, brand: sourceRef.brand, name: draft.newName.trim() }
      : (byKey.get(draft.targetKey)?.reference ?? null)
    : null;
  const targetEntry = target ? byKey.get(refKey(target)) : undefined;

  let validation = '';
  if (draft && sourceRef && target) {
    if (draft.mode === 'rename') {
      if (!target.name) validation = 'Enter a new name.';
      else if (target.name.length > (target.kind === 'brand' || target.kind === 'flavor' ? 120 : 300)) validation = 'Brand and flavor names allow 120 characters; recipe and ingredient names allow 300.';
      else if (target.name === sourceRef.name) validation = 'The new name is the same as the current name.';
      else if ([...byKey.values()].some((e) => e.reference.kind === target.kind && e.reference.brand === target.brand && norm(e.reference.name) === norm(target.name) && refKey(e.reference) !== refKey(sourceRef)))
        validation = 'That name already exists here. Use Merge to combine with the existing entry instead.';
    }
  } else if (draft?.mode === 'merge') validation = 'Choose the entry to merge into.';
  const crossBrand = Boolean(draft && sourceRef && target && sourceRef.kind !== 'brand' && target.brand !== sourceRef.brand);
  const versionMoved = Boolean(draft && data && data.version !== draft.expectedVersion);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !sourceRef || !target || validation) return;
    if (!draft.confirming) { patch({ confirming: true, error: '' }); return; }
    const source = sourceRef;
    const tgt = target;
    const mode = draft.mode;
    change.mutate(
      { data: { operation: mode, source, target: tgt, expectedVersion: draft.expectedVersion } },
      {
        onSuccess: (updated: NameLibrary) => {
          client.setQueryData(getGetNameLibraryQueryKey(), updated);
          if (source.kind === 'brand' && norm(brandFilter) === norm(source.name)) setBrandFilter(tgt.name);
          void client.invalidateQueries({ queryKey: getGetNameLibraryQueryKey() });
          void client.invalidateQueries({ queryKey: getListProductProfilesQueryKey() });
          void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          const text = mode === 'rename'
            ? `Renamed ${describe(source)} to ${describe(tgt)}. Formulas, source data, and historical runs were not changed.`
            : `Merged the name ${describe(source)} into ${describe(tgt)}. The old name now resolves as an alias; separate formulas and source data were kept.`;
          setFeedback((f) => [{ id: `${Date.now()}-${refKey(source)}`, text }, ...f].slice(0, 6));
          setDraft(null);
        },
        onError: (error) => {
          const conflict = errorStatus(error) === 409;
          patch({ confirming: false, conflict, reviewing: false, error: errorMessage(error, conflict ? 'The name library changed since you started. Review before trying again.' : 'The name change could not be saved.') });
        },
      },
    );
  };

  const reviewLatest = async () => {
    patch({ reviewing: true });
    await library.refetch();
  };
  const acceptLatest = () => {
    if (!data || !draft) return;
    const fresh = byKey.get(refKey(draft.source.reference));
    if (!fresh) { patch({ error: 'This name no longer exists in the latest library. Close this edit and pick again.', reviewing: false }); return; }
    patch({ source: fresh, expectedVersion: data.version, conflict: false, reviewing: false, error: '', confirming: false });
  };

  const kindLabel = KINDS.find((k) => k.kind === kind)!;

  return (
    <section className="panel nl" aria-labelledby="nl-title" data-testid="panel-name-library">
      <div className="nl-head">
        <div>
          <div className="eyebrow">Workbook references</div>
          <h2 id="nl-title" tabIndex={-1}>Name library</h2>
          <p>Rename or merge how workbook names resolve. Changes affect names only. Batch formulas, per-pizza usage, source files, and historical runs stay exactly as recorded.</p>
        </div>
        <div className="nl-meta" data-testid="text-library-revision">
          {data ? <>Resolution rev {data.resolution.revision} · {data.resolution.rules.length} rule{data.resolution.rules.length === 1 ? '' : 's'}</> : null}
          {library.isFetching && data ? ' · refreshing' : ''}
        </div>
      </div>

      {!online && <div className="connection-banner" role="status">Offline. Name changes are paused until connection returns.</div>}
      {facility.data && !canWrite && <div className="notice" role="status">Your account has read-only access to the name library.</div>}

      {feedback.length > 0 && (
        <div className="nl-feedback" role="status" aria-live="polite">
          {feedback.map((f) => (
            <div className="nl-feedback-item" key={f.id} data-testid="status-name-change">
              <Check size={15} aria-hidden="true" />
              <div>{f.text}</div>
              <button type="button" className="nl-dismiss" aria-label="Dismiss message" onClick={() => setFeedback((all) => all.filter((x) => x.id !== f.id))} data-testid="button-dismiss-feedback"><X size={14} aria-hidden="true" /></button>
            </div>
          ))}
        </div>
      )}

      {library.isLoading && !data && <div aria-label="Loading name library">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton nl-skeleton" />)}</div>}
      {library.isError && !data && (
        <div className="error-banner" role="alert">
          {errorMessage(library.error, 'The name library could not be loaded.')}{' '}
          <button type="button" className="button button-secondary" onClick={() => void library.refetch()} data-testid="button-retry-library"><RefreshCw size={14} aria-hidden="true" /> Retry</button>
        </div>
      )}
      {library.isError && data && <div className="error-banner" role="status">Could not refresh. Showing the last loaded library.</div>}

      {data && (
        <>
          <div className="nl-tabs" role="group" aria-label="Name type">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" className="nl-tab" aria-pressed={kind === k.kind} onClick={() => { setKind(k.kind); setBrandFilter(''); }} data-testid={`button-kind-${k.kind}`}>
                {k.label} <span>{kindCounts[k.kind] ?? 0}</span>
              </button>
            ))}
          </div>
          {kind === 'recipe' && <p className="field-help" style={{ marginTop: 0 }}>Recipe entries combine batch formulas and spec labels that share a name within a brand. A shared name does not mean shared formulas or the same per-pizza usage. Entries marked spec reference only have no approved formula.</p>}
          <div className="nl-filters" style={kind === 'brand' ? { gridTemplateColumns: '1fr' } : undefined}>
            <div className="nl-field">
              <label htmlFor="nl-search">Search {kindLabel.label.toLowerCase()}</label>
              <input id="nl-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, brand, or alias" data-testid="input-library-search" />
            </div>
            {kind !== 'brand' && (
              <div className="nl-field">
                <label htmlFor="nl-brand">Brand</label>
                <select id="nl-brand" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} data-testid="select-library-brand">
                  <option value="">All brands</option>
                  {brands.map((b) => <option key={b} value={b}>{b || 'No brand'}</option>)}
                </select>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state" data-testid="empty-library">
              <h3>{entries.length === 0 ? 'No names yet' : `No matching ${kindLabel.label.toLowerCase()}`}</h3>
              <p>{entries.length === 0 ? 'Import a product workbook and its brands, flavors, recipes, and ingredients will appear here.' : 'Try a different search or brand filter.'}</p>
              {(search || brandFilter) && <button type="button" className="button button-secondary" onClick={() => { setSearch(''); setBrandFilter(''); }} data-testid="button-clear-filters">Clear filters</button>}
            </div>
          ) : (
            <ul className="nl-list" aria-label={kindLabel.label}>
              {visible.map((entry) => {
                const key = refKey(entry.reference);
                const active = draft !== null && refKey(draft.source.reference) === key;
                const tk = testKey(entry.reference);
                return (
                  <li key={key} className="nl-row" data-active={active} data-testid={`row-name-${tk}`}>
                    <div className="nl-row-main">
                      <div>
                        <div className="nl-name">{entry.reference.name}</div>
                        <div className="nl-brand">{brandLabel(entry.reference)}</div>
                        <Counts entry={entry} />
                      </div>
                      <div className="nl-row-actions">
                        <button type="button" className="button button-secondary" disabled={writesDisabled || active} onClick={() => startDraft(entry, 'rename')} aria-label={`Rename ${describe(entry.reference)}`} data-testid={`button-rename-${tk}`}>Rename</button>
                        <button type="button" className="button button-quiet" disabled={writesDisabled || active} onClick={() => startDraft(entry, 'merge')} aria-label={`Merge ${describe(entry.reference)}`} data-testid={`button-merge-${tk}`}>Merge</button>
                      </div>
                    </div>
                    {entry.aliases.length > 0 && (
                      <details className="nl-aliases">
                        <summary>Alias history ({entry.aliases.length})</summary>
                        <ul>{entry.aliases.map((a) => <li key={refKey(a)}>{describe(a)}</li>)}</ul>
                      </details>
                    )}
                    {active && draft && (
                      <form className="nl-editor" onSubmit={submit} noValidate aria-labelledby={`nl-ed-${tk}`}>
                        <h3 id={`nl-ed-${tk}`}>{draft.mode === 'rename' ? 'Rename' : 'Merge'} {KINDS.find((k) => k.kind === entry.reference.kind)!.singular}</h3>
                        {draft.mode === 'rename' ? (
                          <div className="nl-field">
                            <label htmlFor={`nl-new-${tk}`}>New name{entry.reference.kind !== 'brand' ? ` (stays in brand ${entry.reference.brand || 'none'})` : ''}</label>
                            <input id={`nl-new-${tk}`} value={draft.newName} maxLength={entry.reference.kind === 'brand' || entry.reference.kind === 'flavor' ? 120 : 300} autoFocus disabled={change.isPending} aria-invalid={Boolean(validation)} aria-describedby={`nl-val-${tk}`} onChange={(e) => patch({ newName: e.target.value, confirming: false })} data-testid="input-new-name" />
                          </div>
                        ) : (
                          <div className="nl-field">
                            <label htmlFor={`nl-target-${tk}`}>Merge into</label>
                            <select id={`nl-target-${tk}`} value={draft.targetKey} autoFocus disabled={change.isPending} aria-describedby={`nl-val-${tk}`} onChange={(e) => patch({ targetKey: e.target.value, confirming: false })} data-testid="select-merge-target">
                              <option value="">Choose an existing {KINDS.find((k) => k.kind === entry.reference.kind)!.singular}</option>
                              {mergeCandidates.map((c) => (
                                <option key={refKey(c.reference)} value={refKey(c.reference)}>
                                  {describe(c.reference)}{c.reference.kind !== 'brand' && c.reference.brand !== entry.reference.brand ? ' [other brand]' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {validation && <span className="field-help" id={`nl-val-${tk}`} role="alert">{validation}</span>}

                        {target && !validation && (
                          <div className="nl-compare" data-testid="panel-change-preview">
                            <EntryCard label="Source" entry={draft.source} reference={draft.source.reference} />
                            <div className="nl-compare-arrow" aria-hidden="true"><ArrowRight size={18} /></div>
                            <EntryCard label={draft.mode === 'rename' ? 'New name' : 'Target'} entry={targetEntry} reference={target} />
                          </div>
                        )}
                        {target && !validation && (
                          <div className="nl-warn">
                            <strong>What changes:</strong>
                            <ul>
                              <li>Only the name reference changes. Formulas, source workbook data, and historical runs are preserved.</li>
                              {draft.mode === 'merge' && <li>{describe(draft.source.reference)} becomes an alias that resolves to {describe(target)}.</li>}
                              {draft.mode === 'merge' && entry.reference.kind === 'recipe' && <li>Recipes with the same name can still have different formulas and per-pizza usage. Each formula stays separate; nothing is combined or recalculated.</li>}
                              {draft.mode === 'merge' && entry.reference.kind === 'flavor' && <li>Matching product profiles will be merged, keeping both sets of source data. Quantities are not combined or recalculated, and existing runs stay unchanged.</li>}
                              {draft.mode === 'merge' && entry.reference.kind === 'brand' && <li>If both brands contain a flavor with the same name, the server will refuse. Rename or merge those product profiles first.</li>}
                              {crossBrand && <li>Cross-brand merge: you explicitly chose a name from a different brand ({target.brand || 'no brand'}).</li>}
                              {draft.source.aliases.length > 0 && <li>Existing aliases ({draft.source.aliases.length}) move with this name.</li>}
                            </ul>
                          </div>
                        )}
                        {versionMoved && !draft.conflict && <div className="notice nl-error" role="status">The library refreshed in the background. Your edit still uses the version captured when you started.</div>}
                        {draft.error && (
                          <div className="error-banner nl-error" role="alert" data-testid="text-change-error">
                            {draft.error} Your draft has been kept.
                          </div>
                        )}
                        {draft.conflict && (
                          <div className="nl-warn">
                            {!draft.reviewing ? (
                              <>Someone else changed the library. Load the latest version and compare before submitting again.{' '}
                                <button type="button" className="button button-secondary" disabled={!online || library.isFetching} onClick={() => void reviewLatest()} data-testid="button-review-latest"><RefreshCw size={14} aria-hidden="true" /> Refresh and review</button></>
                            ) : library.isFetching ? <>Loading latest library...</> : (
                              <>Latest library loaded. Check the source and target above against current counts, then confirm you want to continue with this version.{' '}
                                <button type="button" className="button button-secondary" onClick={acceptLatest} data-testid="button-accept-latest">I have compared, use latest</button></>
                            )}
                          </div>
                        )}
                        <div className="nl-actions">
                          {!draft.confirming ? (
                            <button type="submit" className="button button-primary" disabled={writesDisabled || Boolean(validation) || !target || draft.conflict} data-testid="button-review-change">Review change</button>
                          ) : (
                            <button type="submit" className={`button ${draft.mode === 'merge' ? 'button-warn' : 'button-primary'}`} disabled={writesDisabled || draft.conflict} data-testid="button-confirm-change">
                              {change.isPending ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                              {change.isPending ? 'Saving...' : draft.mode === 'rename' ? 'Confirm rename' : 'Confirm merge'}
                            </button>
                          )}
                          {draft.confirming && !change.isPending && <button type="button" className="button button-secondary" onClick={() => patch({ confirming: false })} data-testid="button-back-edit">Back to edit</button>}
                          <button type="button" className="button button-quiet" disabled={change.isPending} onClick={() => { setDraft(null); change.reset(); }} data-testid="button-cancel-change">Close</button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {/* Keep the edit visible even if a background refresh removed or filtered out the source row. */}
          {draft && !visible.some((e) => refKey(e.reference) === refKey(draft.source.reference)) && (
            <div className="notice" role="status">
              Editing {describe(draft.source.reference)}, which is not in the current list view.{' '}
              <button type="button" className="button button-quiet" onClick={() => { setKind(draft.source.reference.kind); setBrandFilter(''); setSearch(draft.source.reference.name); }} data-testid="button-show-draft">Show it</button>{' '}
              <button type="button" className="button button-quiet" disabled={change.isPending} onClick={() => setDraft(null)} data-testid="button-discard-draft">Close edit</button>
            </div>
          )}
          {filtered.length > 0 && (
            <div className="nl-more">
              <span className="nl-meta" data-testid="text-library-count">Showing {visible.length} of {filtered.length}</span>
              {visible.length < filtered.length && <button type="button" className="button button-secondary" onClick={() => setLimit((l) => l + PAGE)} data-testid="button-load-more">Load {Math.min(PAGE, filtered.length - visible.length)} more</button>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default NameLibraryPanel;
