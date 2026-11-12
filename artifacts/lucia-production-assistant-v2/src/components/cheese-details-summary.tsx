export function CheeseDetailsSummary({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const cheese = data as Record<string, unknown>;
  if (cheese.format !== 'lucia.cheese-details.v1') return null;
  const issues = Array.isArray(cheese.issues) ? cheese.issues.filter(
    (issue): issue is Record<string, unknown> => Boolean(issue && typeof issue === 'object' && !Array.isArray(issue)),
  ) : [];
  const safeText = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return <div>
    <p className="field-help">
      Source label: {safeText(cheese.sourceName)} · customer tab: {safeText(cheese.brand)}
      {' · '}row {safeText(cheese.headerRow)}, weight column {safeText(cheese.sourceColumn)}
      {typeof cheese.applicator === 'string' && <> · {cheese.applicator}</>}
    </p>
    {issues.length > 0 && <div className="notice" role="status">
      <strong>Source review required — values have not been corrected</strong>
      <ul className="operational-items">{issues.map((issue, i) => <li key={i}>
        {safeText(issue.message)}
        {Array.isArray(issue.sourceRows) && <> (source rows {issue.sourceRows.filter(Number.isInteger).join(', ')})</>}
      </li>)}</ul>
    </div>}
    {typeof cheese.ingredientSum === 'number' && <p className="field-help">
      Ingredient sum: {Number(cheese.ingredientSum.toFixed(6))} lb. Annotated source weights remain unchanged.
    </p>}
  </div>;
}
