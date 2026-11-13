import './visual-sandbox.css';

const previews = [
  {
    path: '/__visual-preview/stations',
    title: 'Station lineup',
    detail: 'Test station sections, role-specific controls, and local-only edits.',
  },
  {
    path: '/__visual-preview/imports',
    title: 'Workbook review',
    detail: 'Inspect synthetic workbook import and review states.',
  },
  {
    path: '/__visual-preview/station-calculator',
    title: 'Station calculations',
    detail: 'Review area totals, captured counts, and unresolved formulas.',
  },
  {
    path: '/__visual-preview/quality-checks',
    title: 'Quality checks',
    detail: 'Inspect operator measurement fields and target ranges.',
  },
  {
    path: '/__visual-preview/preparation',
    title: 'Early-pull checklist',
    detail: 'Review source-listed preparation tasks without saving.',
  },
  {
    path: '/__visual-preview/dashboard',
    title: 'Live dashboard',
    detail: 'See the synthetic active-run overview and station status.',
  },
];

export default function VisualSandboxPage({ basePath = '' }: { basePath?: string }) {
  return (
    <main className="workspace visual-sandbox" data-testid="page-visual-sandbox">
      <header className="visual-sandbox-heading">
        <div>
          <div className="eyebrow">Development tools / Visual sandbox</div>
          <h1>Test without signing in</h1>
          <p className="page-subtitle">These previews use synthetic data and do not call the API, Clerk, or your facility database.</p>
        </div>
        <span className="visual-sandbox-badge">DEVELOPMENT ONLY</span>
      </header>

      <section className="visual-sandbox-grid" aria-label="Available visual previews">
        {previews.map((preview) => (
          <a className="visual-sandbox-card" href={`${basePath}${preview.path}`} key={preview.path}>
            <span className="visual-sandbox-card-mark" aria-hidden="true">↗</span>
            <h2>{preview.title}</h2>
            <p>{preview.detail}</p>
            <span className="visual-sandbox-card-action">Open preview</span>
          </a>
        ))}
      </section>

      <aside className="visual-sandbox-note">
        <strong>What this sandbox does not test</strong>
        <p>It does not verify Clerk sign-in, permissions enforced by the API, or data persistence. Those checks must use the real development API and a real development test session; production authentication remains unchanged.</p>
      </aside>
    </main>
  );
}
