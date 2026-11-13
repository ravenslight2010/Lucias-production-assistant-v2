import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetRunQualityChecksQueryKey,
  useGetRunQualityChecks,
  useRecordRunQualityMeasurements,
} from "@workspace/api-client-react";
import type { RunQualityChecks } from "@workspace/api-client-react";
import { AlertTriangle, Check, LoaderCircle, Scale } from "lucide-react";
import "./run-quality-checks.css";

type MeasurementDraft = { checkId: string; observedOz: number };

function ounces(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function measuredAt(value: string | Date) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function RunQualityChecksView({
  data,
  online,
  isSaving = false,
  errorMessage = null,
  successMessage = null,
  resetToken = 0,
  onSave,
}: {
  data: RunQualityChecks;
  online: boolean;
  isSaving?: boolean;
  errorMessage?: string | null;
  successMessage?: string | null;
  resetToken?: number;
  onSave: (items: MeasurementDraft[]) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts({});
  }, [resetToken]);

  const historyByCheck = new Map<string, RunQualityChecks["measurements"]>();
  for (const measurement of data.measurements) {
    const existing = historyByCheck.get(measurement.checkId) ?? [];
    historyByCheck.set(measurement.checkId, [...existing, measurement]);
  }
  const readyChecks = data.checks.filter((check) => check.status === "ready");
  const pendingItems = readyChecks.flatMap((check) => {
    const raw = drafts[check.id]?.trim();
    if (!raw) return [];
    const observedOz = Number(raw);
    return Number.isFinite(observedOz) && observedOz >= 0 && observedOz <= 10000
      ? [{ checkId: check.id, observedOz }]
      : [];
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingItems.length || !online || isSaving) return;
    onSave(pendingItems);
  }

  return (
    <section className="panel run-quality-checks" aria-labelledby="run-quality-checks-title">
      <div className="run-quality-heading">
        <div className="run-quality-heading-mark"><Scale size={18} aria-hidden="true" /></div>
        <div>
          <div className="eyebrow">Run quality</div>
          <h2 id="run-quality-checks-title">Weight checks</h2>
          <p className="page-subtitle">Record ingredient and finished-pizza weights in ounces. Saved measurements stay in this run’s history.</p>
        </div>
      </div>

      {data.unavailableReason && (
        <div className="notice run-quality-unavailable" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{data.unavailableReason}</span>
        </div>
      )}

      {data.checks.length === 0 && !data.unavailableReason && (
        <div className="notice" role="status">No source-based quality checks are available for this run.</div>
      )}

      <form onSubmit={submit}>
        <div className="run-quality-grid">
          {data.checks.map((check, index) => {
            const history = historyByCheck.get(check.id) ?? [];
            const latest = history[0];
            const inputId = `run-quality-measurement-${index}`;
            const helpId = `run-quality-help-${index}`;
            const rangeText = check.minimumOz !== null && check.maximumOz !== null
              ? `${ounces(check.minimumOz)}–${ounces(check.maximumOz)} oz`
              : null;

            return (
              <article className="run-quality-card" key={check.id}>
                <div className="run-quality-card-heading">
                  <h3>{check.label}</h3>
                  {check.status === "ready"
                    ? <span className="run-quality-state"><Scale size={14} aria-hidden="true" /> Ready</span>
                    : <span className="run-quality-state unresolved"><AlertTriangle size={14} aria-hidden="true" /> Needs review</span>}
                </div>

                {check.status === "ready" ? (
                  <p className="run-quality-target">
                    {check.checkType === "finished_weight"
                      ? <>Spec range: <strong>{rangeText}</strong></>
                      : <>Target: <strong>{ounces(check.targetOz ?? 0)} oz</strong>{check.toleranceOz !== null && <> · ±{ounces(check.toleranceOz)} oz · {rangeText}</>}</>}
                  </p>
                ) : (
                  <p className="run-quality-unresolved-reason">{check.unavailableReason}</p>
                )}

                <p className="run-quality-source">Source: {check.source}</p>

                {check.status === "ready" && (
                  <div className="run-quality-input">
                    <label htmlFor={inputId}>Measured weight (oz)</label>
                    <input
                      id={inputId}
                      name={check.id}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="10000"
                      step="0.01"
                      value={drafts[check.id] ?? ""}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [check.id]: event.target.value,
                      }))}
                      aria-describedby={helpId}
                    />
                    <small id={helpId}>Enter the scale reading. The app compares it with the captured target.</small>
                  </div>
                )}

                {latest && (
                  <div className={`run-quality-latest ${latest.passed ? "passed" : "failed"}`} role="status">
                    {latest.passed
                      ? <Check size={15} aria-hidden="true" />
                      : <AlertTriangle size={15} aria-hidden="true" />}
                    <span>
                      Latest: {ounces(latest.observedOz)} oz · {latest.passed ? "Within range" : "Outside range"}
                      <small>{measuredAt(latest.recordedAt)}</small>
                    </span>
                  </div>
                )}

                {history.length > 1 && (
                  <details className="run-quality-history">
                    <summary>View {history.length} recorded measurements</summary>
                    <ol>
                      {history.map((measurement) => (
                        <li key={measurement.id}>
                          <span>{ounces(measurement.observedOz)} oz · {measurement.passed ? "Within range" : "Outside range"}</span>
                          <time dateTime={new Date(measurement.recordedAt).toISOString()}>{measuredAt(measurement.recordedAt)}</time>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </article>
            );
          })}
        </div>

        {errorMessage && <p className="run-quality-feedback error" role="alert">{errorMessage}</p>}
        {successMessage && <p className="run-quality-feedback success" role="status">{successMessage}</p>}
        {!online && <p className="run-quality-feedback" role="status">Reconnect before recording measurements. Offline entries are not queued.</p>}
        {readyChecks.length > 0 && (
          <div className="run-quality-actions">
            <button type="submit" className="button" disabled={!online || isSaving || pendingItems.length === 0}>
              {isSaving ? <><LoaderCircle size={16} className="run-quality-spinner" /> Saving measurements…</> : "Save measurements"}
            </button>
            <span className="field-help">Only filled checks will be saved. Record another measurement to add a new history entry.</span>
          </div>
        )}
      </form>
    </section>
  );
}

export function RunQualityChecksSection({
  runId,
  online,
}: {
  runId: string;
  online: boolean;
}) {
  const queryClient = useQueryClient();
  const [resetToken, setResetToken] = useState(0);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const query = useGetRunQualityChecks(runId, {
    query: {
      queryKey: getGetRunQualityChecksQueryKey(runId),
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
    request: { credentials: "include" },
  });
  const mutation = useRecordRunQualityMeasurements({
    request: { credentials: "include" },
  });

  if (query.isLoading && !query.data) {
    return (
      <section className="panel run-quality-checks" aria-live="polite">
        <div className="run-quality-heading">
          <div className="run-quality-heading-mark"><Scale size={18} aria-hidden="true" /></div>
          <div><div className="eyebrow">Run quality</div><h2>Loading weight checks…</h2></div>
        </div>
      </section>
    );
  }
  if (query.isError && !query.data) {
    return (
      <section className="panel run-quality-checks">
        <h2>Weight checks</h2>
        <p className="run-quality-feedback error" role="alert">Quality checks could not be loaded.</p>
        <button type="button" className="button button-secondary" onClick={() => void query.refetch()}>Retry</button>
      </section>
    );
  }
  if (!query.data) return null;

  return (
    <RunQualityChecksView
      data={query.data}
      online={online}
      isSaving={mutation.isPending}
      errorMessage={errorMessage}
      successMessage={successMessage}
      resetToken={resetToken}
      onSave={(items) => {
        setErrorMessage(null);
        setSuccessMessage(null);
        mutation.mutate(
          { runId, data: { commandId: window.crypto.randomUUID(), items } },
          {
            onSuccess: (data) => {
              queryClient.setQueryData(getGetRunQualityChecksQueryKey(runId), data);
              void queryClient.invalidateQueries({ queryKey: getGetRunQualityChecksQueryKey(runId) });
              setResetToken((current) => current + 1);
              setSuccessMessage(`Saved ${items.length} ${items.length === 1 ? "measurement" : "measurements"} to this run.`);
            },
            onError: () => {
              setErrorMessage("The measurements could not be saved. Review the entered values and retry.");
            },
          },
        );
      }}
    />
  );
}
