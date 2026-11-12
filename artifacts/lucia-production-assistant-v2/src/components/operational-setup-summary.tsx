import type { OperationalWorkbookData } from '../importing/operational';
import { DoughDetailsSummary } from './dough-details-summary';
import { CheeseDetailsSummary } from './cheese-details-summary';

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
  const sauce = isRecord(recipe.sauce) ? recipe.sauce : null;
  const sauceIssues = sauce && Array.isArray(sauce.issues) ? sauce.issues.filter(isRecord) : [];
  const premix = isRecord(recipe.premix) ? recipe.premix : null;
  const premixIssues = premix && Array.isArray(premix.issues) ? premix.issues.filter(isRecord) : [];
  const pullInstructions = premix && Array.isArray(premix.pullInstructions) ? premix.pullInstructions.filter(isRecord) : [];
  return <details className="operational-recipe" open={isRecord(recipe.dough) || isRecord(recipe.cheese) || Boolean(sauce) || Boolean(premix)}>
    <summary>{name} <span>{ingredients.length} ingredients · {steps.length} steps</span></summary>
    <DoughDetailsSummary data={recipe.dough} />
    <CheeseDetailsSummary data={recipe.cheese} />
    {premix && <div className="field-help">
      <p>Customer: {asText(premix.sourceBrand)} · Original heading: {asText(premix.originalName)} · {asText(premix.section)} reference</p>
      <p>Saved workbook planning values are not current-run calculations. No aliases, cross-brand merges, or quantity corrections were applied.</p>
      {pullInstructions.length > 0 && <div><strong>Pull-ahead instructions</strong><ul className="operational-items">
        {pullInstructions.map((pull, index) => <li key={index}>{asText(pull.text)} · source row {asText(pull.sourceRow)}
          {typeof pull.daysEarly === 'number' && ` · ${pull.daysEarly} days early`}
        </li>)}
      </ul></div>}
      {premixIssues.length > 0 && <div className="notice" role="status"><strong>Review premix source details</strong>
        <ul className="operational-items">{premixIssues.map((issue, index) => <li key={index}>{asText(issue.message)}</li>)}</ul>
      </div>}
    </div>}
    {sauce && <div className="field-help">
      Source formula reference only. Alternative formulas, conditional additions, and native units have not been approved, converted, or applied automatically.
      {sauceIssues.length > 0 && <div className="notice" role="status"><strong>Review sauce source discrepancies</strong>
        <ul className="operational-items">{sauceIssues.map((issue, index) => <li key={index}>
          {asText(issue.message)}{Array.isArray(issue.sourceRows) && issue.sourceRows.length > 0 && ` (source rows ${issue.sourceRows.filter(v => typeof v === 'number').join(', ')})`}
        </li>)}</ul>
      </div>}
    </div>}
    {ingredients.length > 0 && <div>
      <strong>Ingredients</strong>
      <ul className="operational-items">{ingredients.map((ingredient, index) => <li key={`${asText(ingredient.sourceRow)}:${index}`}>
        <span>{asText(ingredient.name)} · source row {asText(ingredient.sourceRow)}</span><AmountList amounts={ingredient.amounts} />
        {Array.isArray(ingredient.amounts) && ingredient.amounts.length === 0 && <span>Weight not supplied — review source</span>}
      </li>)}</ul>
    </div>}
    {isRecord(recipe.total) && <div><strong>{asText(recipe.total.name) || 'Total'}</strong><AmountList amounts={recipe.total.amounts} /></div>}
    {steps.length > 0 && <div>
      <strong>Process</strong>
      <ol className="operational-items">{steps.map((step, index) => <li value={typeof step.order === 'number' ? step.order : index + 1} key={`${asText(step.sourceRow)}:${index}`}>{asText(step.text)}</li>)}</ol>
    </div>}
    {equipment.length > 0 && <div><strong>Materials / equipment</strong><ul className="operational-items">{equipment.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></div>}
    {metrics.length > 0 && <div>
      <strong>{recipe.cheese ? 'Source cellulose metrics' : 'Batch and pull metrics'}</strong>
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
        {isRecord(workbook.cheeseSelection) && Array.isArray(workbook.cheeseSelection.keys) && <p className="field-help">
          {workbook.cheeseSelection.keys.length} explicitly selected cheese formulas.
          {workbook.cheeseSelection.reviewedAsReference === true && ' Source discrepancies were acknowledged as reference data, not corrected recipes.'}
        </p>}
        {isRecord(workbook.sauceReview) && workbook.sauceReview.reviewedAsReference === true && <p className="field-help">
          Sauce source discrepancies were acknowledged as reference data, not corrected or approved formulas.
        </p>}
        {isRecord(workbook.premixReview) && workbook.premixReview.reviewedAsReference === true && <p className="field-help">
          Premix source details were acknowledged as reference data. Stored planning totals are not current-run requirements.
        </p>}
        {isRecord(workbook.shippingSelection) && <p className="field-help">
          Explicit packaging choice for {asText(workbook.shippingSelection.targetBrand)} / {asText(workbook.shippingSelection.targetFlavor)}.
          Original guide labels and source values are preserved; other variants were not applied.
        </p>}
        {workbook.warnings.length > 0 && <div className="notice" role="status">
          Review parser notes:
          <ul className="operational-items">{workbook.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </div>}
        {workbook.sheets.map((sheet, sheetIndex) => <div className="operational-sheet" key={`${sheet.name}:${sheetIndex}`}>
          <strong>{sheet.name}</strong>
          {sheet.notes.length > 0 && <ul className="operational-items">{sheet.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          {sheet.recipes.map((recipe, index) => <RecipeSummary recipe={recipe} key={`${sheet.name}:${index}`} />)}
          {sheet.productMappings.length > 0 && <p className="field-help">
            {workbook.importKind === 'cheese' ? 'Source product/recipe references (not automatically applied): ' : 'Applies to: '}
            {sheet.productMappings.map((mapping) => `${mapping.product}: ${mapping.recipe}`).join(' · ')}
          </p>}
          {sheet.shippingRecords.length > 0 && <div className="operational-shipping-list">
            {sheet.shippingRecords.filter(isRecord).map((record, index) => <div key={`${asText(record.sourceRow)}:${index}`}>
              <strong>{asText(record.brand)} · row {asText(record.sourceRow)}</strong>
              <span>{Object.entries(isRecord(record.values) ? record.values : {}).filter(([key]) => key.toLowerCase() !== 'pizza').map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</span>
              {isRecord(record.shipping) && <>
                <span>Counts from guide: {asText(record.shipping.pizzasPerCase) || 'unconfirmed'} pizzas/case · {asText(record.shipping.casesPerPallet) || 'unconfirmed'} cases/pallet
                  {record.shipping.packsPerCase !== undefined && ` · ${asText(record.shipping.packsPerCase)} packs × ${asText(record.shipping.pizzasPerPack)} pizzas`}
                </span>
                {(Array.isArray(record.shipping.issues) ? record.shipping.issues.filter((v): v is string => typeof v === 'string') : []).map((issue, i) => <p className="field-help" key={i}>{issue}</p>)}
              </>}
            </div>)}
          </div>}
        </div>)}
      </section>)}
    </div>
  </details>;
}
