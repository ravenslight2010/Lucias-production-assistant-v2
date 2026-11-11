import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Check, CircleAlert, ClipboardList, Factory, LoaderCircle,
  LockKeyhole, Plus, RefreshCw, Save, Snowflake, Warehouse, Wheat, X,
} from 'lucide-react';
import {
  getGetFacilityContextQueryKey,
  getGetFacilityStationsQueryKey,
  useGetFacilityContext,
  useGetFacilityStations,
  useUpdateFacilityStations,
} from '@workspace/api-client-react';
import type { FacilityStation, FacilityStationArea, FacilityStationInput } from '@workspace/api-client-react';
import './station-lineup-page.css';

const AREAS: { id: FacilityStationArea; label: string; short: string; icon: typeof Wheat; note: string }[] = [
  { id: 'dough_sauce_prep', label: 'Dough & sauce prep', short: 'Prep', icon: Wheat, note: 'Mixing, portioning and sauce work' },
  { id: 'production_line', label: 'Production line', short: 'Line', icon: Factory, note: 'Make, assemble and move product' },
  { id: 'freezing_packaging', label: 'Freezing & packaging', short: 'Pack', icon: Snowflake, note: 'Freeze, finish and case product' },
  { id: 'warehouse', label: 'Warehouse', short: 'Store', icon: Warehouse, note: 'Receiving, storage and dispatch' },
];

type DraftStation = { id?: string; name: string; area: FacilityStationArea; isActive: boolean; draftKey: string };
const asDraft = (stations: FacilityStation[]): DraftStation[] => stations.map((station) => ({ ...station, draftKey: `saved-${station.id}` }));
function statusOf(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) return (error as { status?: number }).status;
  return undefined;
}
function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') return (error as { message: string }).message;
  return 'The station lineup could not be saved. Check your connection and try again.';
}

export default function StationLineupPage() {
  const client = useQueryClient();
  const context = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const lineupQuery = useGetFacilityStations({
    query: { queryKey: getGetFacilityStationsQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const updateLineup = useUpdateFacilityStations({ request: { credentials: 'include' } });
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [draft, setDraft] = useState<DraftStation[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [validation, setValidation] = useState('');
  const [success, setSuccess] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newArea, setNewArea] = useState<FacilityStationArea>('production_line');

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  useEffect(() => {
    if (lineupQuery.data && !initialized) {
      setDraft(asDraft(lineupQuery.data.stations));
      setRevision(lineupQuery.data.revision);
      setInitialized(true);
    }
  }, [initialized, lineupQuery.data]);

  const role = context.data?.role;
  const canEdit = online && (role === 'owner' || role === 'manager');
  const isDirty = useMemo(() => {
    if (!lineupQuery.data || revision === null) return false;
    if (revision !== lineupQuery.data.revision) return true;
    const current = lineupQuery.data.stations;
    return draft.length !== current.length || draft.some((item, index) => {
      const saved = current[index];
      return !saved || item.id !== saved.id || item.name !== saved.name || item.area !== saved.area || item.isActive !== saved.isActive;
    });
  }, [draft, lineupQuery.data, revision]);

  const moveStation = (station: DraftStation, direction: -1 | 1) => {
    setDraft((current) => {
      const areaItems = current.filter((item) => item.area === station.area);
      const areaIndex = areaItems.findIndex((item) => item.draftKey === station.draftKey);
      const targetItem = areaItems[areaIndex + direction];
      if (!targetItem) return current;
      const index = current.findIndex((item) => item.draftKey === station.draftKey);
      const target = current.findIndex((item) => item.draftKey === targetItem.draftKey);
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSuccess('');
  };

  const rename = (draftKey: string, name: string) => {
    setDraft((current) => current.map((station) => station.draftKey === draftKey ? { ...station, name } : station));
    setSuccess('');
  };

  const archive = (station: DraftStation) => {
    setDraft((current) => current.map((item) => item.draftKey === station.draftKey ? { ...item, isActive: false } : item));
    setSuccess('');
  };

  const restore = (station: DraftStation) => {
    setDraft((current) => current.map((item) => item.draftKey === station.draftKey ? { ...item, isActive: true } : item));
    setSuccess('');
  };

  const addStation = () => {
    const name = newName.trim();
    if (!name || name.length > 80) { setValidation('Enter a station name between 1 and 80 characters.'); return; }
    if (draft.length >= 50) { setValidation('A lineup can contain no more than 50 stations.'); return; }
    if (draft.some((station) => station.area === newArea && station.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setValidation('Station names must be unique within their area.'); return;
    }
    setDraft((current) => [...current, { name, area: newArea, isActive: true, draftKey: `new-${crypto.randomUUID()}` }]);
    setNewName(''); setAdding(false); setValidation(''); setSuccess('');
  };

  const save = () => {
    if (!canEdit || revision === null || updateLineup.isPending) return;
    const duplicate = draft.some((station, index) => draft.slice(0, index).some((other) => other.area === station.area && other.name.trim().toLocaleLowerCase() === station.name.trim().toLocaleLowerCase()));
    if (draft.some((station) => !station.name.trim() || station.name.trim().length > 80)) { setValidation('Each station needs a name between 1 and 80 characters.'); return; }
    if (duplicate) { setValidation('Station names must be unique within each area.'); return; }
    if (draft.length > 50) { setValidation('A lineup can contain no more than 50 stations.'); return; }
    setValidation(''); setSuccess(''); setConflict(false);
    const stations: FacilityStationInput[] = draft.map(({ id, name, area, isActive }) => ({ ...(id ? { id } : {}), name: name.trim(), area, isActive }));
    updateLineup.mutate({ data: { expectedRevision: revision, stations } }, {
      onSuccess: (layout) => {
        setDraft(asDraft(layout.stations)); setRevision(layout.revision); setConflict(false); setSuccess('Lineup saved and shared with the facility.');
        client.setQueryData(getGetFacilityStationsQueryKey(), layout);
        void client.invalidateQueries({ queryKey: getGetFacilityStationsQueryKey() });
      },
      onError: (error) => {
        if (statusOf(error) === 409) setConflict(true);
      },
    });
  };

  const reloadLatest = async () => {
    const latest = await lineupQuery.refetch();
    if (latest.data) {
      setDraft(asDraft(latest.data.stations)); setRevision(latest.data.revision); setConflict(false); setValidation(''); setSuccess('Latest shared lineup loaded.');
    }
  };

  const stationCount = draft.length;
  const activeCount = draft.filter((station) => station.isActive).length;
  const isInitialLoading = lineupQuery.isLoading && !lineupQuery.data;

  return (
    <main className="workspace station-page" data-testid="page-station-lineup">
      <header className="station-heading">
        <div className="station-heading-copy">
          <div className="eyebrow">Facility map <span className="station-eyebrow-divider">/</span> Shift setup</div>
          <h1>Station lineup</h1>
          <p className="page-subtitle">The places work happens, in the order your floor moves.</p>
        </div>
        <div className="station-map-stamp" aria-hidden="true"><Factory size={21} /><span>FLOOR<br />V1 MAP</span></div>
      </header>

      {!online && <div className="station-banner station-banner-offline" role="status" data-testid="status-stations-offline"><CircleAlert size={17} /><span><strong>Offline view</strong>{lineupQuery.data ? 'Showing the last loaded lineup. Changes require reconnecting.' : 'Reconnect to load the facility lineup.'}</span></div>}
      {conflict && <div className="station-banner station-banner-conflict" role="alert" data-testid="status-stations-conflict"><CircleAlert size={17} /><span><strong>Another device changed the lineup.</strong> Your edits are still here. Reload the latest version to reconcile before saving again.</span><button className="station-banner-action" type="button" onClick={() => void reloadLatest()} disabled={!online || lineupQuery.isFetching} data-testid="button-reload-stations">{lineupQuery.isFetching ? <LoaderCircle size={15} /> : <RefreshCw size={15} />} Reload latest</button></div>}
      {lineupQuery.isError && !lineupQuery.data && <div className="station-load-error" role="alert" data-testid="error-stations-load"><CircleAlert size={22} /><h2>Lineup unavailable</h2><p>{errorMessage(lineupQuery.error)}</p><button className="button button-secondary" type="button" onClick={() => void lineupQuery.refetch()} data-testid="button-retry-stations"><RefreshCw size={15} /> Try again</button></div>}
      {lineupQuery.isError && lineupQuery.data && <div className="station-banner station-banner-refresh" role="status" data-testid="status-stations-refresh">Could not refresh. Showing the last loaded lineup.</div>}
      {isInitialLoading && <div className="station-loading" aria-label="Loading station lineup" aria-busy="true" data-testid="loading-stations"><div className="station-skeleton-head" /><div className="station-skeleton-row" /><div className="station-skeleton-row" /><div className="station-skeleton-row" /></div>}

      {lineupQuery.data && <>
        <section className="station-summary" aria-label="Lineup summary">
          <div className="station-summary-primary"><span className="station-summary-icon"><ClipboardList size={18} /></span><span><strong data-testid="text-station-active-count">{activeCount}</strong><small>active stations</small></span></div>
          <span className="station-summary-divider" aria-hidden="true" />
          <span className="station-summary-meta"><strong data-testid="text-station-total-count">{stationCount}</strong> on map</span>
          <span className="station-summary-meta station-revision">REV <strong data-testid="text-station-revision">{String(lineupQuery.data.revision).padStart(2, '0')}</strong></span>
          <span className={`station-save-state ${isDirty ? 'is-dirty' : ''}`} data-testid="status-stations-dirty">{updateLineup.isPending ? <><LoaderCircle size={14} className="station-spin" /> Saving changes</> : isDirty ? 'Unsaved changes' : <><Check size={14} /> Up to date</>}</span>
        </section>

        {success && <div className="station-success" role="status" data-testid="status-stations-success"><Check size={16} />{success}</div>}
        {validation && <div id="station-validation-message" className="station-validation" role="alert" data-testid="error-stations-validation"><CircleAlert size={16} />{validation}</div>}
        {updateLineup.isError && !conflict && <div className="station-validation" role="alert" data-testid="error-stations-save">{errorMessage(updateLineup.error)}</div>}

        <div className="station-toolbar">
          <div><span className="station-section-label">WORK AREAS</span><span className="station-toolbar-note">{canEdit ? 'Edit names and sequence; archived stations remain on the map.' : role === 'operator' ? 'Read-only view for facility operators.' : 'Changes are available to owners and managers.'}</span></div>
          {canEdit && <div className="station-toolbar-actions">
            <button className="button button-secondary station-add-trigger" type="button" onClick={() => { setAdding((open) => !open); setValidation(''); }} disabled={stationCount >= 50 || updateLineup.isPending} data-testid="button-toggle-add-station">{adding ? <X size={16} /> : <Plus size={16} />}{adding ? 'Close' : 'Add station'}</button>
            <button className="button button-primary station-save-button" type="button" onClick={save} disabled={!isDirty || !canEdit || updateLineup.isPending || conflict} data-testid="button-save-stations">{updateLineup.isPending ? <LoaderCircle size={16} className="station-spin" /> : <Save size={16} />}{updateLineup.isPending ? 'Saving…' : 'Save lineup'}</button>
          </div>}
        </div>

        {adding && canEdit && <section className="station-add-panel" aria-labelledby="add-station-title" data-testid="form-add-station">
          <div className="station-add-title"><span className="station-add-icon"><Plus size={17} /></span><div><h2 id="add-station-title">Add a station</h2><p>Give this work area a name your crew recognizes.</p></div></div>
          <div className="station-add-fields"><div className="station-field"><label htmlFor="station-new-area">Work area</label><select id="station-new-area" value={newArea} onChange={(event) => setNewArea(event.target.value as FacilityStationArea)} data-testid="select-new-station-area">{AREAS.map((area) => <option value={area.id} key={area.id}>{area.label}</option>)}</select></div><div className="station-field station-name-field"><label htmlFor="station-new-name">Station name</label><input id="station-new-name" value={newName} maxLength={80} aria-invalid={validation ? true : undefined} aria-describedby={validation ? 'station-validation-message' : undefined} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addStation(); } }} placeholder="For example, Sauce finishing" data-testid="input-new-station-name" /></div><button className="button button-primary station-add-submit" type="button" onClick={addStation} data-testid="button-add-station"><Plus size={15} /> Add station</button></div>
        </section>}

        {stationCount === 0 ? <section className="station-empty" data-testid="empty-stations"><div className="station-empty-mark"><Factory size={22} /></div><h2>No stations on the map yet</h2><p>Add the first work point so every shift starts from the same floor plan.</p>{canEdit && <button className="button button-primary" type="button" onClick={() => setAdding(true)} data-testid="button-add-first-station"><Plus size={16} /> Add first station</button>}</section> : <div className="station-areas">
          {AREAS.map((area, areaIndex) => {
            const stations = draft.filter((station) => station.area === area.id);
            const AreaIcon = area.icon;
            return <section className={`station-area station-area-${areaIndex + 1}`} key={area.id} aria-labelledby={`station-area-${area.id}`} data-testid={`section-station-area-${area.id}`}>
              <header className="station-area-head"><div className="station-area-mark"><AreaIcon size={17} /></div><div className="station-area-title"><h2 id={`station-area-${area.id}`}>{area.label}</h2><p>{area.note}</p></div><span className="station-area-count" data-testid={`text-station-area-count-${area.id}`}>{stations.length.toString().padStart(2, '0')} <small>STATIONS</small></span></header>
              {stations.length ? <ol className="station-list" aria-label={`${area.label} stations`}>
                {stations.map((station) => {
                  const withinArea = stations.findIndex((item) => item.draftKey === station.draftKey);
                  return <li className={`station-row ${station.isActive ? '' : 'station-row-archived'}`} key={station.draftKey} data-testid={`row-station-${station.id || station.draftKey}`}>
                    <span className="station-order" aria-label={`Station ${withinArea + 1}`}>{String(withinArea + 1).padStart(2, '0')}</span>
                    <div className="station-row-main"><label className="sr-only" htmlFor={`station-name-${station.draftKey}`}>{`Station name in ${area.label}`}</label><input id={`station-name-${station.draftKey}`} className="station-name-input" value={station.name} maxLength={80} disabled={!canEdit} onChange={(event) => rename(station.draftKey, event.target.value)} aria-label={`${station.name || 'Unnamed station'} name`} aria-invalid={validation ? true : undefined} aria-describedby={validation ? 'station-validation-message' : undefined} data-testid={`input-station-name-${station.id || station.draftKey}`} /><span className={`station-status ${station.isActive ? 'station-status-active' : 'station-status-archived'}`} data-testid={`status-station-${station.id || station.draftKey}`}>{station.isActive ? 'Active' : 'Archived'}</span></div>
                    {canEdit && <div className="station-row-controls" aria-label={`Controls for ${station.name}`}>
                      <button className="station-icon-button" type="button" onClick={() => moveStation(station, -1)} disabled={updateLineup.isPending || withinArea === 0} aria-label={`Move ${station.name} up`} title="Move up" data-testid={`button-move-station-up-${station.id || station.draftKey}`}><ArrowUp size={16} /></button>
                      <button className="station-icon-button" type="button" onClick={() => moveStation(station, 1)} disabled={updateLineup.isPending || withinArea === stations.length - 1} aria-label={`Move ${station.name} down`} title="Move down" data-testid={`button-move-station-down-${station.id || station.draftKey}`}><ArrowDown size={16} /></button>
                      {station.isActive
                        ? <button className="station-archive-button" type="button" onClick={() => archive(station)} disabled={updateLineup.isPending} data-testid={`button-archive-station-${station.id || station.draftKey}`}>Archive</button>
                        : <button className="station-archive-button station-restore-button" type="button" onClick={() => restore(station)} disabled={updateLineup.isPending} data-testid={`button-restore-station-${station.id || station.draftKey}`}>Restore</button>}
                    </div>}
                    {!canEdit && <span className="station-readonly" aria-label="Read only"><LockKeyhole size={14} /></span>}
                  </li>;
                })}
              </ol> : <div className="station-area-empty">No stations assigned to this work area.</div>}
            </section>;
          })}
        </div>}

        <footer className="station-page-foot"><span>Station identities stay on the map when archived.</span><span>Shared lineup <i aria-hidden="true" /> Revision {lineupQuery.data.revision}</span></footer>
      </>}
    </main>
  );
}
