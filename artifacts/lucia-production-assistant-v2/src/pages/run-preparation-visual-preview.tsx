import type { RunPreparationTask } from '@workspace/api-client-react';
import { RunPreparationChecklist } from '@/components/run-preparation-checklist';

const previewTasks: RunPreparationTask[] = [
  {
    id: 'pull-premix-sauce',
    name: 'Lucia Pizza Sauce premix',
    instruction: 'Move the sealed premix from the freezer to the cooler to thaw.',
    source: 'Updated Pre-Mix Sheets.xlsx · Premix Pulls',
    sourceRow: 14,
    sourceColumn: 'B',
    daysEarly: 2,
    status: 'not_started',
    revision: 0,
    updatedAt: null,
  },
  {
    id: 'pull-cheese-mix',
    name: 'Brand Cheese Mix',
    instruction: 'Pull the required cheese mix before the production day.',
    source: 'Cheese Mix Recipe Specs.xlsx · Brand tab',
    sourceRow: 22,
    sourceColumn: 'A',
    daysEarly: 1,
    status: 'in_progress',
    revision: 1,
    updatedAt: '2026-11-13T12:00:00.000Z',
  },
  {
    id: 'pull-special-sauce',
    name: 'Specialty sauce',
    instruction: 'Prepare according to the attached source instructions.',
    source: 'Imported sauce workbook · Preparation',
    sourceRow: 31,
    sourceColumn: 'C',
    daysEarly: null,
    status: 'completed',
    revision: 2,
    updatedAt: '2026-11-13T12:30:00.000Z',
  },
];

export default function RunPreparationVisualPreviewPage() {
  return (
    <main className="workspace">
      <div className="page-head">
        <div>
          <div className="eyebrow">Development-only preview</div>
          <h1>Early-pull checklist</h1>
          <p className="page-subtitle">Synthetic workbook rows only. Try the status buttons; changes remain temporary.</p>
        </div>
      </div>
      <RunPreparationChecklist
        runId=""
        runStatus="running"
        online
        previewTasks={previewTasks}
      />
    </main>
  );
}
