type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const asText = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : 'Not supplied';
const entries = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];

export function DoughDetailsSummary({ data }: { data: unknown }) {
  if (!record(data) || data.format !== 'lucia.dough-details.v1') return null;
  const portions = entries(data.portions);
  const batches = entries(data.batches);
  const issues = entries(data.issues);
  return <div className="dough-details">
    {issues.length > 0 && <div className="notice" role="status">
      <strong>Source review required — values have not been corrected</strong>
      <ul className="operational-items">{issues.map((issue, index) => <li key={index}>
        {asText(issue.message)}
        {Array.isArray(issue.sourceRows) && issue.sourceRows.length > 0 && <span> (source rows {issue.sourceRows.map(asText).join(', ')})</span>}
      </li>)}</ul>
    </div>}
    <div><strong>Batch columns</strong>
      <ul className="operational-items">{batches.map((batch, index) => <li key={index}>
        {asText(batch.label)} · source column {asText(batch.column)}
        {batch.unit ? ` · ${asText(batch.unit)}` : ' · unit not supplied'}
        <div>Listed total: {asText(batch.total)} · ingredient sum: {asText(batch.ingredientSum)}</div>
      </li>)}</ul>
    </div>
    {portions.length > 0 && <div><strong>Dough-ball variants and yields</strong>
      <ul className="operational-items">{portions.map((portion, index) => <li key={index}>
        <strong>{asText(portion.product)}</strong> · source row {asText(portion.sourceRow)}
        <div>{asText(portion.ounces)} oz · {asText(portion.pounds)} lb</div>
        <div>Source yield: {asText(portion.yield)} · per tray: {asText(portion.perTray)}</div>
      </li>)}</ul>
      <p className="field-help">Yield values are retained as written, not rounded into production targets.</p>
    </div>}
    {record(data.selection) && <p className="field-help">
      Selected source column {asText(data.selection.batchColumn)} and dough-ball row {asText(data.selection.portionSourceRow)}.
      {data.selection.reviewedAsReference === true ? ' Source discrepancies were acknowledged; this is not a corrected recipe.' : ''}
    </p>}
  </div>;
}
