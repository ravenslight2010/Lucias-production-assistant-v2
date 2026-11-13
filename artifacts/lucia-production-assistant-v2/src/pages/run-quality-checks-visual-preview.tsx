import { useState } from "react";
import type { RunQualityChecks } from "@workspace/api-client-react";
import { RunQualityChecksView } from "@/components/run-quality-checks";

const previewData: RunQualityChecks = {
  runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  unavailableReason: null,
  checks: [
    {
      id: "ingredient:sauce",
      checkType: "ingredient_weight",
      label: "Aldo’s Sauce (made in house)",
      source: "Aldo’s Pizza Specs.xlsx · OZ row 4",
      status: "ready",
      targetOz: 4,
      minimumOz: 3.95,
      maximumOz: 4.05,
      toleranceOz: 0.05,
      unavailableReason: null,
    },
    {
      id: "ingredient:pepperoni",
      checkType: "ingredient_weight",
      label: "Pepperoni Stick",
      source: "Aldo’s Pizza Specs.xlsx · OZ row 16",
      status: "ready",
      targetOz: 1.1,
      minimumOz: 1.05,
      maximumOz: 1.15,
      toleranceOz: 0.05,
      unavailableReason: null,
    },
    {
      id: "ingredient:cheese",
      checkType: "ingredient_weight",
      label: "Applicator — Aldo’s Cheese Mix",
      source: "Aldo’s Pizza Specs.xlsx · OZ row 5",
      status: "ready",
      targetOz: 3.5,
      minimumOz: 3.4,
      maximumOz: 3.6,
      toleranceOz: 0.1,
      unavailableReason: null,
    },
    {
      id: "finished-pizza-weight",
      checkType: "finished_weight",
      label: "Finished pizza weight",
      source: "Aldo’s Pizza Specs.xlsx · OZ row 2",
      status: "ready",
      targetOz: null,
      minimumOz: 17.55,
      maximumOz: 18.05,
      toleranceOz: null,
      unavailableReason: null,
    },
    {
      id: "ingredient:annotated",
      checkType: "ingredient_weight",
      label: "Annotated applicator amount",
      source: "Imported source · OZ row 18",
      status: "unresolved",
      targetOz: null,
      minimumOz: null,
      maximumOz: null,
      toleranceOz: null,
      unavailableReason: "Confirm one per-pizza target from the captured source row.",
    },
  ],
  measurements: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      checkId: "ingredient:sauce",
      observedOz: 3.98,
      minimumOz: 3.95,
      maximumOz: 4.05,
      passed: true,
      recordedAt: "2026-11-12T15:05:00.000Z",
    },
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      checkId: "finished-pizza-weight",
      observedOz: 18.12,
      minimumOz: 17.55,
      maximumOz: 18.05,
      passed: false,
      recordedAt: "2026-11-12T15:06:00.000Z",
    },
  ],
};

export default function RunQualityChecksVisualPreviewPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);

  return (
    <main className="workspace">
      <div className="page-head">
        <div>
          <div className="eyebrow">Development-only preview</div>
          <h1>Run quality checks</h1>
          <p className="page-subtitle">Synthetic data only. Saving here does not call the API or alter a run.</p>
        </div>
      </div>
      <RunQualityChecksView
        data={previewData}
        online
        successMessage={message}
        resetToken={resetToken}
        onSave={(items) => {
          setMessage(`Preview only — ${items.length} measurement${items.length === 1 ? "" : "s"} would be saved.`);
          setResetToken((value) => value + 1);
        }}
      />
    </main>
  );
}
