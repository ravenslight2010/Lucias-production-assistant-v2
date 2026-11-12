import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pool } from '../../lib/db/src/index.ts';
import { buildRunRequirements } from '../../artifacts/api-server/src/lib/run-requirements.ts';
import { parseWorkbookFile, parseProductSpecProfiles } from '../../artifacts/lucia-production-assistant-v2/src/importing/workbook.ts';
import { parseProductSpecData } from '../../artifacts/lucia-production-assistant-v2/src/importing/product-spec.ts';
import { parseOperationalWorkbook } from '../../artifacts/lucia-production-assistant-v2/src/importing/operational.ts';

after(() => pool.end());
test('uploaded Lucia specs and Malted Barley dough reach planning with original alternatives and quantities intact', async () => {
  const load = async path => {
    const bytes = await readFile(path);
    return parseWorkbookFile(new File([bytes], path.split('/').at(-1)));
  };
  const workbook = await load('attached_assets/Lucia_Pizza_Recipe_Specs_-_35_1794437759636.xlsx');
  const candidate = parseProductSpecProfiles(workbook)[0];
  assert.ok(candidate);
  const spec = parseProductSpecData(workbook, candidate);
  const dough = parseOperationalWorkbook(await load('attached_assets/Malted_Barley_Dough_Mixing_Procedure_-_29_1794437360342.xlsx'), 'dough_guide');
  const original = JSON.stringify({ spec, dough });
  const profile = { brand: candidate.brand, flavor: candidate.flavor, revision: 0,
    productData: { sources: [{ brand: candidate.brand, content: spec }, { brand: candidate.brand, content: dough }] } };
  const options = { unitsPerCase: 12 };
  const initial = buildRunRequirements(profile, 10, options);
  assert.ok(initial.sections.length > 0);
  const plan = buildRunRequirements(profile, 10, { ...options, sectionId: initial.sections[0].id });
  assert.ok(plan.items.length > 0);
  assert.ok(plan.recipes.length > 0);
  assert.equal(plan.totalPizzas, 120);
  const recipe = plan.recipes[0];
  const linked = buildRunRequirements(profile, 10, { ...options, sectionId: initial.sections[0].id,
    links: [{ itemId: plan.items[0].id, recipeId: recipe.id, batchColumn: recipe.columns[0]?.column }] });
  if (recipe.issues.length) assert.equal(linked.items[0].wholeBatches, null);
  assert.equal(JSON.stringify({ spec, dough }), original);
});
