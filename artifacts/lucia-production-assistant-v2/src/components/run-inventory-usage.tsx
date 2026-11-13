import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  getGetFacilityInventoryQueryKey,
  getGetRunInventoryUsageQueryKey,
  useConfirmRunInventoryUsage,
  useGetRunInventoryUsage,
} from '@workspace/api-client-react';
import type { RunInventoryUsageEntry, RunStatus } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { findInventoryShortages } from '@/run-inventory-shortage';
import './run-inventory-usage.css';

function fmt(value: number | null) {
  return value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function errText(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'Ingredient use could not be confirmed.';
}

function isApplicable(entry: RunInventoryUsageEntry) {
  return entry.blockedReason === null && entry.proposedQuantity !== null;
}

export function RunInventoryUsagePanel({
  runId,
  runStatus,
  online,
}: {
  runId: string;
  runStatus: RunStatus;
  online: boolean;
}) {
  const client = useQueryClient();
  const usageQuery = useGetRunInventoryUsage(runId, {
    query: {
      queryKey: getGetRunInventoryUsageQueryKey(runId),
      enabled: runStatus === 'completed',
      refetchInterval: online && runStatus === 'completed' ? 10_000 : false,
    },
    request: { credentials: 'include' },
  });
  const confirm = useConfirmRunInventoryUsage({ request: { credentials: 'include' } });
  const [actuals, setActuals] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const usage = usageQuery.data;
  const eligible = useMemo(() => usage?.items.filter(isApplicable) ?? [], [usage]);
  const shortages = useMemo(() => findInventoryShortages(eligible, actuals), [eligible, actuals]);

  useEffect(() => {
    setActuals({});
    setFormError('');
  }, [usage?.reconciliation?.id, usage?.items.length]);

  if (runStatus !== 'completed') return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!usage?.canConfirm || !online) return;
    const rows: { id: string; actualUsed: number }[] = [];
    for (const item of eligible) {
      const raw = actuals[item.id]?.trim() ?? '';
      const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < 0 || value >= 1e12) {
        setFormError(`Enter actual use for ${item.ingredientName} in ${item.unit}. Use 0 if none was used.`);
        return;
      }
      rows.push({ id: item.id, actualUsed: value });
    }
    if (rows.length === 0) {
      setFormError('No resolved ingredient amounts are available to confirm.');
      return;
    }
    setFormError('');
    confirm.mutate(
      {
        runId,
        data: {
          commandId: crypto.randomUUID(),
          items: rows.map((row) => {
            const item = eligible.find((entry) => entry.id === row.id)!;
            return {
              ...row,
              expectedInventoryRevision: item.inventoryRevision,
            };
          }),
        },
      },
      {
        onSuccess: (result) => {
          client.setQueryData(getGetRunInventoryUsageQueryKey(runId), result);
          void client.invalidateQueries({ queryKey: getGetFacilityInventoryQueryKey() });
        },
        onError: () => {
          void usageQuery.refetch();
        },
      },
    );
  };

  return (
    <section className="run-inventory-usage panel" aria-labelledby="run-inventory-usage-title" data-testid="section-run-inventory-usage">
      <div className="run-inventory-usage-head">
        <div>
          <div className="eyebrow">Inventory reconciliation</div>
          <h3 id="run-inventory-usage-title">Confirm actual ingredient use</h3>
          <p className="field-help">The proposal uses this run’s saved plan and station counts. Nothing changes in stock until actual quantities are confirmed.</p>
        </div>
        <Link href="/inventory" className="text-link">Review inventory <ArrowRight size={14} /></Link>
      </div>

      {usageQuery.isLoading && !usage && <p className="field-help" role="status"><LoaderCircle size={14} className="spin" /> Loading saved usage proposal…</p>}
      {usageQuery.isError && !usage && (
        <div className="error-banner" role="alert">
          Ingredient use could not be loaded.
          <button className="button button-quiet" type="button" onClick={() => void usageQuery.refetch()}><RefreshCw size={14} /> Try again</button>
        </div>
      )}
      {usage && (
        <>
          {usage.reconciliation ? (
            <div className="run-inventory-confirmed" role="status" data-testid="status-run-inventory-confirmed">
              <ShieldCheck size={18} aria-hidden="true" />
              <div><strong>Actual use recorded</strong><span>Confirmed {new Date(usage.reconciliation.createdAt).toLocaleString()}. Corrections are added as new inventory history entries.</span></div>
              <span>{usage.reconciliation.entries.length} lines</span>
            </div>
          ) : (
            <p className="field-help">
              {usage.canConfirm
                ? 'Check the source-based proposal, then enter what was actually used for every available line.'
                : 'No inventory deduction is available. A saved station count and resolved source quantity and unit are required.'}
            </p>
          )}
          {usage.blockedCount > 0 && (
            <div className="run-inventory-blocked" role="note">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{usage.blockedCount} unresolved line{usage.blockedCount === 1 ? '' : 's'} cannot be applied. Their source issue or unit must be resolved before inventory can be adjusted.</span>
            </div>
          )}
          {usage.items.length === 0 ? (
            <p className="field-help">This saved run has no ingredient rows to reconcile.</p>
          ) : (
            <form onSubmit={submit} noValidate>
              <div className="run-usage-table-wrap">
                <table className="run-usage-table">
                  <thead><tr><th scope="col">Ingredient and source</th><th scope="col">Proposed use</th><th scope="col">Actual use</th><th scope="col">On hand</th></tr></thead>
                  <tbody>{usage.items.map((item) => {
                    const usable = isApplicable(item);
                    const recorded = item.actualUsed !== null;
                    return (
                      <tr key={item.id} className={usable ? undefined : 'is-blocked'}>
                        <th scope="row">
                          <strong>{item.ingredientName || item.requirementName}</strong>
                          <small>{item.requirementName} · {item.unit || 'unit unresolved'}</small>
                          <small>{item.source}{item.sourceAmount !== null ? ` · ${fmt(item.sourceAmount)} ${item.unit} per ${item.quantityBasis.replace('_', ' ')}` : ''}{item.amountColumn ? ` · amount column ${item.amountColumn}` : ''}{item.batchColumn !== null ? ` · batch column ${item.batchColumn}` : ''}</small>
                          {item.blockedReason && <small className="run-usage-block-reason">{item.blockedReason}</small>}
                        </th>
                        <td>{fmt(item.proposedQuantity)} {item.unit}</td>
                        <td>{recorded
                          ? <strong>{fmt(item.actualUsed)} {item.unit}</strong>
                          : usable && usage.canConfirm
                            ? <label className="run-usage-input"><span className="sr-only">Actual {item.ingredientName} used in {item.unit}</span>
                                <input type="number" min={0} max={999999999999} step="any" inputMode="decimal" value={actuals[item.id] ?? ''} onChange={(event) => setActuals((current) => ({ ...current, [item.id]: event.target.value }))} placeholder={`Enter ${item.unit}`} disabled={!online || confirm.isPending} data-testid={`input-actual-usage-${item.id}`} />
                                <span>{item.unit}</span>
                              </label>
                            : <span>Not applied</span>}
                        </td>
                        <td>{fmt(item.inventoryOnHand)} {item.unit}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
              {shortages.length > 0 && (
                <div className="run-inventory-shortage" role="status" aria-live="polite" data-testid="warning-inventory-shortage">
                  <CircleAlert size={17} aria-hidden="true" />
                  <div>
                    <strong>Entered use is higher than current stock.</strong>
                    <ul>{shortages.map((item) => (
                      <li key={`${item.ingredientName}-${item.unit}`}>
                        {item.ingredientName}: {fmt(item.enteredUse)} {item.unit} entered, {fmt(item.onHand)} {item.unit} on hand ({fmt(item.shortage)} {item.unit} short).
                      </li>
                    ))}</ul>
                    <p>Confirming will record stock below zero. Stock may change before you save.</p>
                  </div>
                </div>
              )}
              {formError && <p className="field-help run-usage-error" role="alert">{formError}</p>}
              {confirm.isError && <p className="field-help run-usage-error" role="alert">{errText(confirm.error)}</p>}
              {!usage.reconciliation && usage.canConfirm && (
                <div className="run-usage-actions">
                  <button className="button button-primary" type="submit" disabled={!online || confirm.isPending}>
                    {confirm.isPending ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}
                    {confirm.isPending ? 'Saving confirmed use…' : 'Confirm actual use and adjust stock'}
                  </button>
                  <span>All available lines need an explicit amount. Use 0 when none was used.</span>
                </div>
              )}
              {!online && <p className="field-help">Reconnect to confirm usage. No inventory changes are queued offline.</p>}
            </form>
          )}
        </>
      )}
    </section>
  );
}
