import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, CircleAlert, LoaderCircle, Package, Plus, RefreshCw, Undo2 } from 'lucide-react';
import {
  getGetFacilityContextQueryKey,
  getGetFacilityInventoryQueryKey,
  useAdjustFacilityInventory,
  useGetFacilityContext,
  useGetFacilityInventory,
} from '@workspace/api-client-react';
import type { InventoryAdjustmentInputUnit, InventoryTransaction } from '@workspace/api-client-react';
import { Link } from 'wouter';
import './inventory-page.css';

const units: InventoryAdjustmentInputUnit[] = ['oz', 'lb', 'g', 'kg', 'each'];

function amount(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'The inventory change could not be saved.';
}

function entryLabel(kind: InventoryTransaction['kind']) {
  if (kind === 'run_usage') return 'Confirmed run use';
  if (kind === 'correction') return 'Correction';
  return 'Stock adjustment';
}

export default function InventoryPage() {
  const client = useQueryClient();
  const contextQuery = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey() },
    request: { credentials: 'include' },
  });
  const inventoryQuery = useGetFacilityInventory({
    query: { queryKey: getGetFacilityInventoryQueryKey(), refetchInterval: 10_000 },
    request: { credentials: 'include' },
  });
  const adjustment = useAdjustFacilityInventory({ request: { credentials: 'include' } });
  const [ingredientName, setIngredientName] = useState('');
  const [unit, setUnit] = useState<InventoryAdjustmentInputUnit>('lb');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [corrects, setCorrects] = useState<InventoryTransaction | null>(null);
  const [error, setError] = useState('');
  const data = inventoryQuery.data;
  const canAdjust = contextQuery.data?.role === 'owner' || contextQuery.data?.role === 'manager';

  const startCorrection = (entry: InventoryTransaction) => {
    setCorrects(entry);
    setIngredientName(entry.ingredientName);
    setUnit(entry.unit as InventoryAdjustmentInputUnit);
    setDelta('');
    setNote('');
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelCorrection = () => {
    setCorrects(null);
    setDelta('');
    setNote('');
    setError('');
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanedName = ingredientName.trim();
    const quantity = Number(delta);
    const cleanedNote = note.trim();
    if (!cleanedName || !delta.trim() || !Number.isFinite(quantity) || quantity === 0 || cleanedNote.length < 3) {
      setError('Enter an ingredient, a nonzero signed quantity, and a note of at least three characters.');
      return;
    }
    setError('');
    adjustment.mutate({
      data: {
        commandId: crypto.randomUUID(),
        ingredientName: cleanedName,
        unit,
        delta: quantity,
        note: cleanedNote,
        correctsEntryId: corrects?.id ?? null,
      },
    }, {
      onSuccess: (result) => {
        client.setQueryData(getGetFacilityInventoryQueryKey(), result);
        void client.invalidateQueries({ queryKey: getGetFacilityInventoryQueryKey() });
        setIngredientName('');
        setDelta('');
        setNote('');
        setCorrects(null);
      },
    });
  };

  return (
    <main className="workspace inventory-page">
      <div className="page-head">
        <div><div className="eyebrow">Facility stock</div><h1>Ingredient inventory</h1><p className="page-subtitle">On-hand quantities are grouped by the exact source unit. Every change stays in the review history.</p></div>
        <div className="inventory-page-mark"><Package size={21} aria-hidden="true" /></div>
      </div>

      {inventoryQuery.isLoading && !data && <div aria-label="Loading inventory"><div className="skeleton" /><div className="skeleton" /></div>}
      {inventoryQuery.isError && !data && (
        <section className="panel empty-state">
          <div className="empty-mark"><CircleAlert size={21} /></div><h2>Inventory could not be loaded</h2>
          <p>{errorText(inventoryQuery.error)}</p>
          <button type="button" className="button button-secondary" onClick={() => void inventoryQuery.refetch()}><RefreshCw size={15} /> Try again</button>
        </section>
      )}
      {inventoryQuery.isError && data && <div className="error-banner" role="status">Could not refresh inventory. Showing the last saved balances and history.</div>}

      {canAdjust ? (
        <section className="panel inventory-adjust-panel" aria-labelledby="inventory-adjust-title">
          <div className="inventory-panel-head">
            <div><div className="eyebrow">{corrects ? 'Correct a recorded entry' : 'Record stock'}</div><h2 id="inventory-adjust-title">{corrects ? `Correct ${corrects.ingredientName}` : 'Add opening stock or a stock adjustment'}</h2></div>
            {corrects && <button className="button button-quiet" type="button" onClick={cancelCorrection}><Undo2 size={14} /> Cancel correction</button>}
          </div>
          <p className="field-help">{corrects
            ? `This adds a signed change to the balance and links it to history entry ${corrects.id.slice(0, 8)}. It does not overwrite the original amount.`
            : 'Use a positive number to add stock or a negative number to remove stock. Keep each unit separate; no conversions are assumed.'}</p>
          <form className="inventory-adjust-form" onSubmit={submit} noValidate>
            <div className="form-field">
              <label htmlFor="inventory-ingredient">Ingredient</label>
              <input id="inventory-ingredient" value={ingredientName} maxLength={200} onChange={(event) => setIngredientName(event.target.value)} required disabled={Boolean(corrects)} />
            </div>
            <div className="form-field">
              <label htmlFor="inventory-unit">Source unit</label>
              <select id="inventory-unit" value={unit} onChange={(event) => setUnit(event.target.value as InventoryAdjustmentInputUnit)} disabled={Boolean(corrects)}>
                {units.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="inventory-delta">Quantity change ({unit})</label>
              <input id="inventory-delta" type="number" step="any" inputMode="decimal" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="+ or − quantity" required />
            </div>
            <div className="form-field inventory-note-field">
              <label htmlFor="inventory-note">Review note</label>
              <input id="inventory-note" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder={corrects ? 'Why is this entry being corrected?' : 'For example: opening count on today’s shift'} required />
            </div>
            {error && <p className="inventory-form-error" role="alert">{error}</p>}
            {adjustment.isError && <p className="inventory-form-error" role="alert">{errorText(adjustment.error)}</p>}
            <div className="inventory-form-actions">
              <button className="button button-primary" type="submit" disabled={adjustment.isPending}>
                {adjustment.isPending ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
                {adjustment.isPending ? 'Saving change…' : corrects ? 'Save correction' : 'Record stock change'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="panel inventory-readonly-note"><p>Stock and history are available to review. Only facility owners and managers can enter stock adjustments or corrections.</p></section>
      )}

      <section className="panel inventory-section" aria-labelledby="inventory-balance-title">
        <div className="inventory-panel-head"><div><div className="eyebrow">Current quantities</div><h2 id="inventory-balance-title">On hand</h2></div><span className="inventory-count">{data?.items.length ?? 0} ingredients</span></div>
        {!data?.items.length
          ? <div className="inventory-empty"><div className="empty-mark"><Package size={20} /></div><h3>No stock balances yet</h3><p>Add opening stock above, or confirm actual use from a completed run. Each ingredient and unit keeps its own balance.</p></div>
          : <div className="inventory-balance-grid">{data.items.map((item) => (
            <article key={item.id} className={`inventory-balance-card${item.onHand < 0 ? ' is-negative' : ''}`}>
              <div><strong>{item.ingredientName}</strong><span>{item.unit}</span></div>
              <b>{amount(item.onHand)} <small>{item.unit}</small></b>
              {item.onHand < 0 && <small className="inventory-shortage">Below zero · review stock and usage history</small>}
              <small>Updated {new Date(item.updatedAt).toLocaleString()}</small>
            </article>
          ))}</div>}
      </section>

      <section className="panel inventory-section" aria-labelledby="inventory-history-title">
        <div className="inventory-panel-head"><div><div className="eyebrow">Auditable changes</div><h2 id="inventory-history-title">Recent history</h2></div><span className="inventory-count">Latest {data?.entries.length ?? 0}</span></div>
        {!data?.entries.length
          ? <p className="field-help">No inventory movements have been recorded.</p>
          : <div className="inventory-history-list">{data.entries.map((entry) => (
            <article key={entry.id} className="inventory-history-entry" data-testid={`inventory-entry-${entry.id}`}>
              <div className={`inventory-change-icon${entry.delta < 0 ? ' is-minus' : ''}`}>
                {entry.delta < 0 ? <ArrowDownRight size={17} /> : <ArrowUpRight size={17} />}
              </div>
              <div className="inventory-history-main">
                <div className="inventory-history-title"><strong>{entry.ingredientName}</strong><span>{entryLabel(entry.kind)}</span></div>
                <div className="inventory-history-meta">
                  {entry.runId ? <Link href={`/runs/${entry.runId}`}>Run usage · {entry.runId.slice(0, 8)}</Link> : <span>{entry.note}</span>}
                  {entry.requirementName && <span>{entry.requirementName} · source: {entry.source}</span>}
                  {entry.correctsEntryId && <span>Corrects entry {entry.correctsEntryId.slice(0, 8)}</span>}
                  <small>{new Date(entry.createdAt).toLocaleString()} · {entry.unit}</small>
                </div>
              </div>
              <strong className={entry.delta < 0 ? 'is-minus' : 'is-plus'}>{entry.delta > 0 ? '+' : ''}{amount(entry.delta)} {entry.unit}</strong>
              {canAdjust && <button className="button button-quiet inventory-correct-button" type="button" onClick={() => startCorrection(entry)}>Correct</button>}
            </article>
          ))}</div>}
        {data && data.entries.length === 500 && <p className="field-help">Showing the latest 500 entries. Older history remains saved.</p>}
      </section>
    </main>
  );
}
