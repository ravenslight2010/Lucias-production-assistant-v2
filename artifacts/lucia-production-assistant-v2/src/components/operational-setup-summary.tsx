import type { OperationalWorkbookData } from '../importing/operational';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOperationalWorkbookData(value: unknown): value is OperationalWorkbookData {
  if (!isRecord(value) || value.format !== 'lucia.operational-workbook.v1' || !Array.isArray(value.sheets)) return false;
  if (typeof value.title !== 'string' || !Array.isArray(value.warnings) ||
      !['premix', 'cheese', 'shipping', 'sauce_guide', 'dough_guide'].includes(String(value.importKind))) return false;
  return value.sheets.every((sheet) =>
    isRecord(sheet) && typeof sheet.name === 'string' &&
    Array.isArray(sheet.recipes) && Array.isArray(sheet.productMappings) &&
    Array.isArray(sheet.shippingRecords) && Array.isArray(sheet.notes),
  );
}

function findOperationalData(value: unknown): OperationalWorkbookData[] {
  const found: OperationalWorkbookData[] = [];
  const seen = new Set<object>();
  let inspected = 0;
  const visit = (current: unknown, depth: number) => {
    if (depth > 12 || inspected >= 500 || !current || typeof current !== 'object' || seen.has(current)) return;
    inspected++;
    seen.add(current);
    if (isOperationalWorkbookData(current)) {
      found.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.slice(0, 100).forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (isRecord(current)) {
      for (const key of ['structured', 'content', 'sources', 'data']) {
        if (key in current) visit(current[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  return found;
}

function asText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function recipeCounts(data: OperationalWorkbookData) {
  const recipes = data.sheets.flatMap((sheet) => sheet.recipes);
  const shipments = data.sheets.flatMap((sheet) => sheet.shippingRecords);
  return { recipes: recipes.length, shipments: shipments.length };
}

function AmountList({ amounts }: { amounts: unknown }) {
  if (!Array.isArray(amounts)) return null;
  const safeAmounts = amounts.filter(isRecord);
  if (!safeAmounts.length) return null;
  return <ul className="operational-amounts">
    {safeAmounts.map((amount, index) => <li key={`${asText(amount.column)}:${index}`}>
      {asText(amount.label) || 'Amount'}: {asText(amount.value)}
    </li>)}
  </ul>;
}

function RecipeSummary({ recipe }: { recipe: unknown }) {
  if (!isRecord(recipe)) return null;
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients.filter(isRecord) : [];
  const steps = Array.isArray(recipe.steps) ? recipe.steps.filter(isRecord) : [];
  const equipment = Array.isArray(recipe.equipment) ? recipe.equipment.filter((item): item is string => typeof item === 'string') : [];
  const metrics = Array.isArray(recipe.metrics) ? recipe.metrics.filter(isRecord) : [];
  const notes = Array.isArray(recipe.notes) ? recipe.notes.filter((item): item is string => typeof item === 'string') : [];
  const name = asText(recipe.name) || 'Recipe';
  return <details className="operational-recipe">
    <summary>{name} <span>{ingredients.length} ingredients · {steps.length} steps</span></summary>
    {ingredients.length > 0 && <div>
      <strong>Ingredients</strong>
      <ul className="operational-items">{ingredients.map((ingredient, index) => <li key={`${asText(ingredient.sourceRow)}:${index}`}>
        <span>{asText(ingredient.name)}</span><AmountList amounts={ingredient.amounts} />
      </li>)}</ul>
    </div>}
    {isRecord(recipe.total) && <div><strong>{asText(recipe.total.name) || 'Total'}</strong><AmountList amounts={recipe.total.amounts} /></div>}
    {steps.length > 0 && <div>
      <strong>Process</strong>
      <ol className="operational-items">{steps.map((step, index) => <li key={`${asText(step.sourceRow)}:${index}`}>{asText(step.text)}</li>)}</ol>
    </div>}
    {equipment.length > 0 && <div><strong>Materials / equipment</strong><ul className="operational-items">{equipment.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></div>}
    {metrics.length > 0 && <div>
      <strong>Batch and pull metrics</strong>
      <ul className="operational-items">{metrics.map((metric, index) => <li key={`${asText(metric.sourceRow)}:${index}`}>
        {asText(metric.name)} <AmountList amounts={metric.amounts} />
      </li>)}</ul>
    </div>}
    {notes.length > 0 && <div><strong>Workbook notes</strong><ul className="operational-items">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>}
  </details>;
}

export function OperationalSetupSummary({
  data,
  title = 'Operational recipe and process data',
  defaultOpen = false,
}: {
  data: unknown;
  title?: string;
  defaultOpen?: boolean;
}) {
  const workbooks = findOperationalData(data);
  if (!workbooks.length) return null;
  const recipeCount = workbooks.reduce((sum, workbook) => sum + recipeCounts(workbook).recipes, 0);
  const shipmentCount = workbooks.reduce((sum, workbook) => sum + recipeCounts(workbook).shipments, 0);

  return <details className="operational-summary" open={defaultOpen || undefined}>
    <summary>{title} <span>{recipeCount} recipes · {shipmentCount} shipping rows</span></summary>
    <div className="operational-summary-content">
      {workbooks.map((workbook, workbookIndex) => <section className="operational-workbook" key={`${workbook.title}:${workbookIndex}`}>
        <h4>{workbook.title} <span>{workbook.importKind.replaceAll('_', ' ')}</span></h4>
        {workbook.revision && <p className="field-help">Revision {workbook.revision}</p>}
        {workbook.warnings.length > 0 && <div className="notice" role="status">
          Review parser notes:
          <ul className="operational-items">{workbook.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </div>}
        {workbook.sheets.map((sheet, sheetIndex) => <div className="operational-sheet" key={`${sheet.name}:${sheetIndex}`}>
          <strong>{sheet.name}</strong>
          {sheet.notes.length > 0 && <ul className="operational-items">{sheet.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          {sheet.recipes.map((recipe, index) => <RecipeSummary recipe={recipe} key={`${sheet.name}:${index}`} />)}
          {sheet.productMappings.length > 0 && <p className="field-help">
            Applies to: {sheet.productMappings.map((mapping) => `${mapping.product}: ${mapping.recipe}`).join(' · ')}
          </p>}
          {sheet.shippingRecords.length > 0 && <div className="operational-shipping-list">
            {sheet.shippingRecords.filter(isRecord).slice(0, 12).map((record, index) => <div key={`${asText(record.sourceRow)}:${index}`}>
              <strong>{asText(record.brand)}</strong>
              <span>{Object.entries(isRecord(record.values) ? record.values : {}).filter(([key]) => key.toLowerCase() !== 'pizza').map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</span>
            </div>)}
            {sheet.shippingRecords.length > 12 && <p className="field-help">Showing 12 of {sheet.shippingRecords.length} shipping rows.</p>}
          </div>}
        </div>)}
      </section>)}
    </div>
  </details>;
}
