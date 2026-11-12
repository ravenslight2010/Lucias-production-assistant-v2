import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, ClipboardList, LoaderCircle, Printer, RefreshCw, RotateCcw, WifiOff } from 'lucide-react';
import { previewRunRequirements, RunRecipeLinkUsageUnit } from '@workspace/api-client-react';
import type {
  RunPlanningOptions,
  RunPlanningReview,
  RunRecipeLink,
  RunRequirementItem,
  RunRequirementsPlan,
} from '@workspace/api-client-react';
import './run-requirements.css';

type ReviewCallback = (review: RunPlanningReview | null) => void;
type Base = { profileRevision: number; nameRevision: number };
type Phase = 'loading' | 'calculating' | 'current' | 'error' | 'conflict' | 'invalid';

const USAGE_UNITS = Object.values(RunRecipeLinkUsageUnit);
const DIRECT = '__direct__';

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
    || (error instanceof Error && error.name === 'AbortError');
}
function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
function fmt(value: number | null | undefined, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
function asUsageUnit(value: string | null): RunRecipeLink['usageUnit'] {
  return value && (USAGE_UNITS as string[]).includes(value) ? (value as RunRecipeLink['usageUnit']) : undefined;
}
function itemUnresolved(item: RunRequirementItem) {
  return item.issues.length > 0 || (item.recipeId === null && !item.directIngredient)
    || (item.perPizza === null && !item.id.startsWith('batch:')) || item.totalRequired === null;
}
function linkFromItem(item: RunRequirementItem): RunRecipeLink {
  const link: RunRecipeLink = { itemId: item.id, recipeId: item.recipeId, directIngredient: item.directIngredient };
  if (item.amountColumn !== null) link.amountColumn = item.amountColumn;
  const unit = asUsageUnit(item.usageUnit);
  if (unit) link.usageUnit = unit;
  if (item.batchColumn !== null) link.batchColumn = item.batchColumn;
  return link;
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export function RunRequirementsEditor({ profileId, targetCases, online, onReviewChange }: {
  profileId: string;
  targetCases: number;
  online: boolean;
  onReviewChange: ReviewCallback;
}) {
  const callbackRef = useRef(onReviewChange);
  callbackRef.current = onReviewChange;

  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState<RunPlanningOptions | null>(null);
  const [plan, setPlan] = useState<RunRequirementsPlan | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('');
  const [casesInput, setCasesInput] = useState('');
  const [casesError, setCasesError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [baseNonce, setBaseNonce] = useState(0);
  const keepDraftOnReload = useRef(false);
  const validCases = Number.isSafeInteger(targetCases) && targetCases >= 1 && targetCases <= 1_000_000;

  // Initial / user-requested base load (no review): captures revisions as reviewed base.
  useEffect(() => {
    callbackRef.current(null);
    if (!validCases || !online) { setPhase(validCases ? 'error' : 'invalid'); setMessage(validCases ? 'Offline. Requirements load when the connection returns.' : 'Enter a whole target case count to calculate requirements.'); return; }
    const controller = new AbortController();
    const keep = keepDraftOnReload.current;
    keepDraftOnReload.current = false;
    setPhase('loading');
    setMessage('');
    previewRunRequirements({ productProfileId: profileId, targetCases }, { credentials: 'include', signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setBase({ profileRevision: result.profileRevision, nameRevision: result.nameRevision });
        setPlan(result);
        setDraft((previous) => {
          if (!keep || !previous) {
            setCasesInput(result.options.unitsPerCase ? String(result.options.unitsPerCase) : '');
            return result.options;
          }
          const ids = new Set(result.items.map((item) => item.id));
          const sectionIds = new Set(result.sections.map((section) => section.id));
          return {
            ...previous,
            sectionId: previous.sectionId && sectionIds.has(previous.sectionId) ? previous.sectionId : result.options.sectionId,
            links: (previous.links ?? []).filter((link) => ids.has(link.itemId)),
          };
        });
        setNonce((n) => n + 1);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setPhase('error');
        setMessage(errorText(error, 'Run requirements could not be loaded.'));
      });
    return () => controller.abort();
  }, [profileId, targetCases, validCases, online, baseNonce]);

  // Explicit review recalculation, debounced and abortable.
  useEffect(() => {
    if (!base || !draft || nonce === 0 || !online || !validCases) return;
    const controller = new AbortController();
    const review: RunPlanningReview = { expectedProfileRevision: base.profileRevision, expectedNameRevision: base.nameRevision, options: draft };
    setPhase('calculating');
    const timer = window.setTimeout(() => {
      previewRunRequirements({ productProfileId: profileId, targetCases, review }, { credentials: 'include', signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setPlan(result);
          setPhase('current');
          setMessage('');
          callbackRef.current(review);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbort(error)) return;
          callbackRef.current(null);
          if (errorStatus(error) === 409) {
            setPhase('conflict');
            setMessage('The product profile or name library changed after you began reviewing. Your choices are kept, but they were reviewed against an older version.');
          } else {
            setPhase('error');
            setMessage(errorText(error, 'Requirements could not be recalculated.'));
          }
        });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [nonce, base, draft, online, validCases, profileId, targetCases]);

  const change = (next: (current: RunPlanningOptions) => RunPlanningOptions) => {
    callbackRef.current(null);
    setDraft((current) => (current ? next(current) : current));
    setNonce((n) => n + 1);
  };

  const linkFor = (item: RunRequirementItem): RunRecipeLink =>
    draft?.links?.find((link) => link.itemId === item.id) ?? linkFromItem(item);

  const patchLink = (item: RunRequirementItem, patch: Partial<RunRecipeLink>) => change((current) => {
    const links = current.links ?? [];
    const existing = links.find((link) => link.itemId === item.id) ?? linkFromItem(item);
    const merged: RunRecipeLink = { ...existing, ...patch, itemId: item.id };
    (Object.keys(merged) as (keyof RunRecipeLink)[]).forEach((key) => { if (merged[key] === undefined) delete merged[key]; });
    return { ...current, links: [...links.filter((link) => link.itemId !== item.id), merged] };
  });

  const onCases = (value: string) => {
    setCasesInput(value);
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      callbackRef.current(null);
      setCasesError('Enter a whole number of pizzas per case from 1 to 1000.');
      setPhase('invalid');
      return;
    }
    setCasesError('');
    change((current) => ({ ...current, unitsPerCase: parsed }));
  };

  const reloadBase = (keepChoices: boolean) => {
    callbackRef.current(null);
    keepDraftOnReload.current = keepChoices;
    setBase(null);
    setBaseNonce((n) => n + 1);
  };

  const disabled = !online || !draft || phase === 'loading';
  const recipes = plan?.recipes ?? [];
  const needsCaseInput = plan ? plan.unitsPerCase === null || draft?.unitsPerCase !== undefined || plan.issues.some((issue) => /case|shipping/i.test(issue)) : false;
  const statusId = `rr-status-${profileId}`;

  return (
    <section className="rr-editor" aria-labelledby={`rr-editor-title-${profileId}`} data-testid="run-requirements-editor">
      <div className="rr-editor-head">
        <div>
          <div className="eyebrow">Run requirements review</div>
          <h3 id={`rr-editor-title-${profileId}`}>Confirm how this run will be prepared</h3>
          <p className="field-help">Per-pizza usage is multiplied by total pizzas. Shared batch recipes are then rounded up to whole batches. Nothing here is approved for production until each line is resolved.</p>
        </div>
        <EditorStatus phase={phase} base={base} />
      </div>

      {!online && <div className="connection-banner" role="status"><WifiOff size={16} aria-hidden="true" /><span>Offline. Requirement review is paused; no choices are being saved.</span></div>}

      <div id={statusId} aria-live="polite" className="sr-only">
        {phase === 'calculating' ? 'Recalculating requirements.' : phase === 'current' ? 'Requirements preview is current.' : ''}
      </div>

      {phase === 'conflict' && (
        <div className="error-banner rr-conflict" role="alert" data-testid="status-rr-conflict">
          <strong>Review out of date.</strong> {message}
          <div className="control-row">
            <button type="button" className="button button-secondary" onClick={() => reloadBase(true)} disabled={!online} data-testid="button-rr-reload-keep">
              <RefreshCw size={15} aria-hidden="true" /> Load latest profile, keep my choices
            </button>
            <button type="button" className="button button-quiet" onClick={() => reloadBase(false)} disabled={!online} data-testid="button-rr-reload-reset">
              <RotateCcw size={15} aria-hidden="true" /> Start review over
            </button>
          </div>
        </div>
      )}
      {phase === 'error' && message && (
        <div className="error-banner" role="alert" data-testid="status-rr-error">
          {message}
          <div className="control-row">
            <button type="button" className="button button-secondary" disabled={!online} onClick={() => (base && draft ? (callbackRef.current(null), setNonce((n) => n + 1)) : reloadBase(false))} data-testid="button-rr-retry">
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </button>
          </div>
        </div>
      )}

      {phase === 'loading' && !plan && <div aria-label="Loading run requirements"><div className="skeleton" /><div className="skeleton" /></div>}
      {base && phase === 'current' && <button type="button" className="button button-quiet" disabled={!online}
        onClick={() => reloadBase(true)} data-testid="button-rr-review-latest">
        <RefreshCw size={15} aria-hidden="true" /> Refresh and review latest sources
      </button>}

      {plan && draft && (
        <div className="rr-controls" aria-busy={phase === 'calculating' || phase === 'loading'}>
          <div className="rr-control-grid">
            {plan.sections.length > 1 && (
              <div className="rr-field">
                <label htmlFor={`rr-section-${profileId}`}>Spec section for this run</label>
                <select id={`rr-section-${profileId}`} value={draft.sectionId ?? ''} disabled={disabled} onChange={(e) => change((c) => { const n = { ...c }; if (e.target.value) n.sectionId = e.target.value; else delete n.sectionId; return n; })} data-testid="select-rr-section">
                  <option value="">Choose a section</option>
                  {plan.sections.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.source}</option>)}
                </select>
                <span className="field-help">The profile has {plan.sections.length} spec sections. Pick the one this run follows.</span>
              </div>
            )}
            {needsCaseInput && (
              <div className="rr-field">
                <label htmlFor={`rr-cases-${profileId}`}>Pizzas per case</label>
                <input id={`rr-cases-${profileId}`} type="number" inputMode="numeric" min={1} max={1000} step={1} value={casesInput} disabled={disabled} onChange={(e) => onCases(e.target.value)} aria-invalid={Boolean(casesError)} aria-describedby={`rr-cases-help-${profileId}${casesError ? ` rr-cases-err-${profileId}` : ''}`} data-testid="input-rr-units-per-case" />
                <span className="field-help" id={`rr-cases-help-${profileId}`}>Shipping source: {plan.casePackSource || 'none found'}. {plan.unitsPerCase === null ? 'The shipping count is missing or conflicting, so enter it explicitly.' : 'Explicit entry overrides the source value.'}</span>
                {casesError && <span className="rr-field-error" id={`rr-cases-err-${profileId}`} role="alert">{casesError}</span>}
              </div>
            )}
          </div>

          {plan.items.length === 0 ? (
            <div className="empty-state"><div className="empty-mark"><ClipboardList size={20} aria-hidden="true" /></div><h3>No requirement lines</h3><p>This profile's selected section lists no per-pizza components to plan.</p></div>
          ) : (
            <ol className="rr-item-editors">
              {plan.items.map((item) => {
                const link = linkFor(item);
                const recipe = recipes.find((r) => r.id === link.recipeId);
                const recipeValue = link.recipeId ? link.recipeId : link.directIngredient ? DIRECT : '';
                const unresolved = itemUnresolved(item);
                const fid = `rr-${profileId}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
                return (
                  <li key={item.id} className={`rr-item-editor${unresolved ? ' is-unresolved' : ''}`} data-testid={`row-rr-item-${item.id}`}>
                    <div className="rr-item-editor-head">
                      <div>
                        <strong>{item.name}</strong>
                        <span className="rr-meta">{item.station} · {item.source}{item.originalName !== item.name ? ` · originally "${item.originalName}"` : ''}</span>
                      </div>
                      <span className={`rr-chip ${unresolved ? 'rr-chip-review' : 'rr-chip-ok'}`}>{unresolved ? 'Needs review' : 'Resolved'}</span>
                    </div>
                    <div className="rr-item-fields">
                      <div className="rr-field">
                        <label htmlFor={`${fid}-amount`}>Per-pizza amount</label>
                        <select id={`${fid}-amount`} value={link.amountColumn ?? ''} disabled={disabled || item.amountChoices.length === 0} onChange={(e) => patchLink(item, { amountColumn: e.target.value || undefined })} data-testid={`select-rr-amount-${item.id}`}>
                          <option value="">{item.amountChoices.length ? 'Choose a source column' : 'No amounts in source'}</option>
                          {item.amountChoices.map((c) => <option key={c.column} value={c.column}>{c.column}: {c.value}</option>)}
                        </select>
                      </div>
                      <div className="rr-field">
                        <label htmlFor={`${fid}-unit`}>Usage unit</label>
                        <select id={`${fid}-unit`} value={link.usageUnit ?? ''} disabled={disabled} onChange={(e) => patchLink(item, { usageUnit: asUsageUnit(e.target.value) })} data-testid={`select-rr-unit-${item.id}`}>
                          <option value="">From source{item.usageUnit ? ` (${item.usageUnit})` : ' (unknown)'}</option>
                          {USAGE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      <div className="rr-field">
                        <label htmlFor={`${fid}-recipe`}>Batch recipe</label>
                        <select id={`${fid}-recipe`} value={recipeValue} disabled={disabled} onChange={(e) => {
                          const v = e.target.value;
                          if (v === DIRECT) patchLink(item, { recipeId: null, directIngredient: true, batchColumn: undefined });
                          else if (!v) patchLink(item, { recipeId: null, directIngredient: false, batchColumn: undefined });
                          else patchLink(item, { recipeId: v, directIngredient: false, batchColumn: v === link.recipeId ? link.batchColumn : undefined });
                        }} data-testid={`select-rr-recipe-${item.id}`}>
                          <option value="">Unresolved — choose a formula</option>
                          <option value={DIRECT}>No recipe: used directly as an ingredient</option>
                          {recipes.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.brand} · {r.kind}{r.issues.length ? ' (has issues)' : ''}</option>)}
                        </select>
                      </div>
                      {recipe && (
                        <div className="rr-field">
                          <label htmlFor={`${fid}-batch`}>Batch size column</label>
                          <select id={`${fid}-batch`} value={link.batchColumn ?? ''} disabled={disabled} onChange={(e) => patchLink(item, { batchColumn: e.target.value ? Number(e.target.value) : undefined })} data-testid={`select-rr-batch-${item.id}`}>
                            <option value="">Choose a batch column</option>
                            {recipe.columns.map((c) => <option key={c.column} value={c.column}>{c.label} · yield {c.yield === null ? 'unknown' : fmt(c.yield)} {c.unit ?? ''}</option>)}
                          </select>
                          <span className="field-help">Source: {recipe.source}</span>
                        </div>
                      )}
                    </div>
                    {recipe && recipe.issues.length > 0 && <IssueList issues={recipe.issues} label="Formula issues" />}
                    {item.issues.length > 0 && <IssueList issues={item.issues} label="Why this line needs review" />}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {plan && (
        <div className={phase === 'current' ? undefined : 'rr-stale'} aria-hidden={phase === 'loading' ? true : undefined}>
          {phase !== 'current' && phase !== 'loading' && <p className="rr-stale-note" role="status">{phase === 'calculating' ? 'Recalculating…' : 'Preview below reflects the last successful calculation, not your current choices.'}</p>}
          <RunRequirementsSummary plan={plan} />
        </div>
      )}
    </section>
  );
}

function EditorStatus({ phase, base }: { phase: Phase; base: Base | null }) {
  const label = { loading: 'Loading', calculating: 'Recalculating', current: 'Preview saved for run', error: 'Not current', conflict: 'Out of date', invalid: 'Input needed' }[phase];
  return (
    <div className="rr-editor-status" data-testid="status-rr-phase">
      <span className={`rr-chip ${phase === 'current' ? 'rr-chip-ok' : phase === 'calculating' || phase === 'loading' ? '' : 'rr-chip-review'}`}>
        {(phase === 'calculating' || phase === 'loading') && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{label}
      </span>
      {base && <span className="rr-meta">Profile rev {base.profileRevision} · names rev {base.nameRevision}</span>}
    </div>
  );
}

function IssueList({ issues, label }: { issues: string[]; label: string }) {
  return (
    <div className="rr-issues">
      <span className="rr-issues-label"><CircleAlert size={13} aria-hidden="true" /> {label}</span>
      <ul>{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Summary (no network)                                                */
/* ------------------------------------------------------------------ */

export function RunRequirementsSummary({ plan, runId }: { plan: RunRequirementsPlan; runId?: string }) {
  const section = plan.sections.find((s) => s.id === plan.sectionId) ?? null;
  const recipesById = useMemo(() => new Map(plan.recipes.map((r) => [r.id, r])), [plan.recipes]);
  const byStation = useMemo(() => {
    const groups = new Map<string, RunRequirementItem[]>();
    [...plan.items.filter(item => !item.recipeId || item.issues.length > 0), ...plan.batchPreparation].forEach((item) => {
      const key = item.station || 'Unassigned station';
      groups.set(key, [...(groups.get(key) ?? []), item]);
    });
    return [...groups.entries()];
  }, [plan.items, plan.batchPreparation]);
  const ready = plan.status === 'ready';

  return (
    <article className="run-requirements-summary" data-testid="run-requirements-summary">
      <header className="rr-sheet-head">
        <div>
          <div className="eyebrow">Station preparation sheet</div>
          <h3>{plan.productLabel} requirements</h3>
          <span className="rr-meta">{runId ? `Captured run ${runId}` : 'Planning preview · not yet saved to a run'}</span>
          <span className="rr-meta">Profile rev {plan.profileRevision} · names rev {plan.nameRevision}{section ? ` · section ${section.label} (${section.source})` : ''}</span>
        </div>
        <div className="rr-sheet-actions">
          <span className={`rr-chip ${ready ? 'rr-chip-ok' : 'rr-chip-review'}`} data-testid="status-rr-plan">{ready ? 'Ready' : 'Needs review'}</span>
          <button type="button" className="button button-secondary rr-print" onClick={() => window.print()} data-testid="button-rr-print">
            <Printer size={15} aria-hidden="true" /> Print sheet
          </button>
        </div>
      </header>

      {!ready && <div className="rr-review-banner" role="note"><CircleAlert size={16} aria-hidden="true" /><span><strong>This plan needs review.</strong> A planned run can be created, but lines marked "needs review" are not usable preparation instructions until resolved.</span></div>}

      <dl className="rr-totals">
        <div><dt>Target cases</dt><dd data-testid="text-rr-cases">{fmt(plan.targetCases, 0)}</dd></div>
        <div><dt>Pizzas per case</dt><dd>{plan.unitsPerCase === null ? 'Unresolved' : fmt(plan.unitsPerCase, 0)}</dd><small>{plan.casePackSource || 'No shipping source'}</small></div>
        <div><dt>Total pizzas</dt><dd data-testid="text-rr-pizzas">{plan.totalPizzas === null ? 'Unresolved' : fmt(plan.totalPizzas, 0)}</dd></div>
      </dl>

      {plan.issues.length > 0 && <IssueList issues={plan.issues} label="Plan issues" />}
      <section className="rr-station" aria-label="Per-pizza source requirements">
        <h4>Per-pizza requirements</h4>
        <p className="field-help">Each source amount is preserved. Uses of the exact same selected formula and batch column are combined once in the preparation totals below.</p>
        {plan.items.map(item => <div key={item.id} className="property-row">
          <span>{item.name}<small className="field-help" style={{ display: 'block' }}>{item.source}</small></span>
          <strong>{fmt(item.perPizza, 6)} {item.usageUnit ?? ''} / pizza · {fmt(item.totalRequired, 6)} {item.usageUnit ?? ''} total</strong>
        </div>)}
      </section>

      {byStation.map(([station, items]) => (
        <section key={station} className="rr-station">
          <h4>{station}</h4>
          <div className="rr-lines">
            {items.map((item) => {
              const unresolved = itemUnresolved(item);
              const recipe = item.recipeId ? recipesById.get(item.recipeId) : undefined;
              return (
                <div key={item.id} className={`rr-line${unresolved ? ' is-unresolved' : ''}`} data-testid={`card-rr-line-${item.id}`}>
                  <div className="rr-line-head">
                    <div>
                      <strong>{item.name}</strong>
                      <span className="rr-meta">Source: {item.source}{item.originalName !== item.name ? ` · source name "${item.originalName}"` : ''}</span>
                    </div>
                    <span className={`rr-chip ${unresolved ? 'rr-chip-review' : 'rr-chip-ok'}`}>{unresolved ? 'Needs review' : item.directIngredient ? 'Direct ingredient' : 'Batch recipe'}</span>
                  </div>
                  <dl className="rr-figures">
                    {!item.id.startsWith('batch:') && <div><dt>Per pizza</dt><dd>{fmt(item.perPizza)} {item.usageUnit ?? ''}</dd>{item.amountColumn && <small>column {item.amountColumn}</small>}</div>}
                    <div><dt>Exact demand</dt><dd>{fmt(item.totalRequired)} {item.usageUnit ?? ''}</dd></div>
                    {!item.directIngredient && <>
                      <div><dt>Batch yield</dt><dd>{fmt(item.batchYield)} {item.batchUnit ?? ''}</dd>{recipe && <small>{recipe.name}</small>}</div>
                      <div><dt>Batches (exact)</dt><dd>{fmt(item.batchesExact)}</dd></div>
                      <div className="rr-emph"><dt>Whole batches to prepare</dt><dd>{fmt(item.wholeBatches, 0)}</dd></div>
                      <div><dt>Overage after rounding</dt><dd>{fmt(item.remainder)} {item.batchUnit ?? ''}</dd></div>
                    </>}
                  </dl>
                  {unresolved ? (
                    <>
                      {item.issues.length > 0 && <IssueList issues={item.issues} label="Unresolved" />}
                      {item.recipeId === null && !item.directIngredient && <p className="rr-withheld">No formula or direct-ingredient choice has been confirmed. Formula quantities and instructions are withheld.</p>}
                      {(item.ingredients.length > 0 || item.instructions.length > 0) && <p className="rr-withheld">Formula details are withheld until this line is resolved.</p>}
                    </>
                  ) : (
                    <>
                      {item.ingredients.length > 0 && (
                        <div className="rr-table-wrap">
                          <table className="rr-table">
                            <caption className="sr-only">Ingredients for {item.name}</caption>
                            <thead><tr><th scope="col">Ingredient</th><th scope="col">Per batch</th><th scope="col">Exact demand</th><th scope="col">Whole-batch prep</th></tr></thead>
                            <tbody>
                              {item.ingredients.map((ing, i) => (
                                <tr key={`${ing.name}-${i}`}>
                                  <th scope="row">{ing.name}</th>
                                  <td>{fmt(ing.perBatch)} {ing.unit}</td>
                                  <td>{fmt(ing.exactRequired)} {ing.unit}</td>
                                  <td><strong>{fmt(ing.wholeBatchRequired)} {ing.unit}</strong></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {item.instructions.length > 0 && <ol className="rr-instructions">{item.instructions.map((step, i) => <li key={i}>{step}</li>)}</ol>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {(plan.preparation.length > 0 || (section && section.notes.length > 0)) && (
        <section className="rr-notes">
          <h4>Preparation references</h4>
          <p className="field-help">Reference notes from the source documents. They are not amounts and are never added to any formula.</p>
          <ul>{[...(section?.notes ?? []), ...plan.preparation].map((note, i) => <li key={i}>{note}</li>)}</ul>
        </section>
      )}
      {plan.packaging.length > 0 && (
        <section className="rr-notes">
          <h4>Packaging references</h4>
          <ul>{plan.packaging.map((note, i) => <li key={i}>{note}</li>)}</ul>
        </section>
      )}

      <footer className="rr-footnote">
        Quantities are calculated from imported customer specs and attached formulas. Uses of the exact same selected formula and batch column are prepared once together; different formulas, alternative batch sizes, and sub-mixes are never substituted or combined. Acknowledging a reference or name change does not approve a formula, and this sheet is not a verified production approval.
      </footer>
    </article>
  );
}
