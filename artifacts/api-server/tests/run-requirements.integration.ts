import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, facilitiesTable, facilityProductProfilesTable, facilityNameLibrariesTable, productionRunsTable } from "@workspace/db";
import { CreateRunResponse, PreviewRunRequirementsResponse } from "@workspace/api-zod";
import { buildRunRequirements } from "../src/lib/run-requirements";
import { createPlannedRun } from "../src/lib/run-create-service";

after(() => pool.end());
function fixture(amount = "2", brand = "Lucia") {
  return { brand, flavor: "Cheese", revision: 0, productData: { sources: [
    { brand, sourceName: "spec.xlsx", content: { format: "lucia.product-spec.v1", sections: [
      { sheet: "Cheese", headerRow: 1, unit: "oz", notes: [], warnings: [], ingredients: [
        { name: "Sauce", sourceRow: 2, ingredientRole: "sauce",
          sourceCoordinates: { sheet: "Cheese", row: 2, nameColumn: "A" },
          amounts: [{ column: "B", value: amount }] },
      ] },
    ] } },
    { brand, sourceName: "sauce.xlsx", content: {
      format: "lucia.operational-workbook.v1", importKind: "sauce_guide", sheets: [
        { name: "Sauce", recipes: [{
          name: "Sauce", source: { sheet: "Sauce", startRow: 1 }, notes: [],
          ingredients: [
            { name: "Tomatoes", amounts: [{ column: 2, label: "Batch lbs", value: 40 }] },
            { name: "Water", amounts: [{ column: 2, label: "Batch lbs", value: 10 }] },
          ], total: { amounts: [{ column: 2, label: "Batch lbs", value: 50 }] },
          steps: [{ text: "Mix according to the confirmed source procedure." }],
        }] },
      ],
    } },
  ] } };
}
const options = { unitsPerCase: 12 };
const status = (n: number) => (e: unknown) => Boolean(e && typeof e === "object" && "statusCode" in e && e.statusCode === n);

test("case counts, per-pizza usage, exact batches, whole batches and overage remain distinct", () => {
  const profile = fixture();
  const before = JSON.stringify(profile);
  const plan = buildRunRequirements(profile, 10, options);
  PreviewRunRequirementsResponse.parse(plan);
  assert.equal(plan.status, "ready");
  assert.equal(plan.totalPizzas, 120);
  const row = plan.items[0];
  assert.equal(row.ingredientRole, "sauce");
  assert.deepEqual(row.sourceCoordinates, { sheet: "Cheese", row: 2, nameColumn: "A" });
  PreviewRunRequirementsResponse.parse(plan);
  assert.equal(row.perPizza, 2);
  assert.equal(row.totalRequired, 240);
  assert.equal(row.batchYield, 50);
  assert.equal(row.batchesExact, 0.3);
  assert.equal(row.wholeBatches, 1);
  assert.equal(row.remainder, 35);
  assert.equal(row.ingredients[0].exactRequired, 12);
  assert.equal(row.ingredients[0].wholeBatchRequired, 40);
  assert.equal(JSON.stringify(profile), before);
  assert.equal(buildRunRequirements(fixture("3"), 10, options).items[0].batchesExact, 0.45);
});

test("missing and conflicting case packs never receive an invented default", () => {
  const p = buildRunRequirements(fixture(), 10);
  assert.equal(p.unitsPerCase, null);
  assert.equal(p.totalPizzas, null);
  assert.equal(p.items[0].wholeBatches, null);
  assert.equal(p.status, "needs_review");
  assert.throws(() => buildRunRequirements(fixture(), 1, { unitsPerCase: 0 }), status(400));
  assert.throws(() => buildRunRequirements(fixture(), 1000001), status(400));
});

test("source discrepancy acknowledgement never approves a batch or invents a missing yield", () => {
  const p = fixture();
  const recipe = p.productData.sources[1].content.sheets![0].recipes[0];
  Object.assign(recipe, { sauce: { issues: [{ message: "Conflicting formula" }], reviewedAsReference: true } });
  assert.equal(buildRunRequirements(p, 10, options).items[0].batchesExact, null);
  delete (recipe as Partial<typeof recipe>).total;
  const missing = buildRunRequirements(p, 10, options).items[0];
  assert.equal(missing.batchYield, null);
  assert.equal(missing.ingredients.length, 0);
});

test("choosing a dough batch resolves only the alternatives warning and uses its explicitly stated header unit", () => {
  const p = fixture();
  const recipe = p.productData.sources[1].content.sheets![0].recipes[0];
  recipe.ingredients.forEach(i => { i.amounts[0].label = "2 Bag"; });
  Object.assign(recipe, { dough: {
    batches: [{ column: 2, label: "2 Bag", unit: "LBS.", total: 50 }],
    issues: [{ code: "multiple_batches", message: "Choose a source batch." }],
  } });
  const plan = buildRunRequirements(p, 10, options);
  assert.equal(plan.items[0].batchesExact, 0.3);
  assert.equal(plan.batchPreparation[0].wholeBatches, 1);
  Object.assign(recipe, { dough: { batches: [{ column: 2, label: "2 Bag", unit: "LBS.", total: 50 }],
    issues: [{ code: "total_mismatch", message: "The source quantities conflict." }] } });
  assert.equal(buildRunRequirements(p, 10, options).items[0].batchesExact, null);
});

test("a formula sum mismatch or incompatible ingredient unit blocks scaling", () => {
  const p = fixture();
  const recipe = p.productData.sources[1].content.sheets![0].recipes[0];
  recipe.total.amounts[0].value = 60;
  assert.equal(buildRunRequirements(p, 10, options).items[0].wholeBatches, null);
  recipe.total.amounts[0].value = 50;
  recipe.ingredients[1].amounts[0].label = "quarts";
  assert.equal(buildRunRequirements(p, 10, options).items[0].ingredients.length, 0);
});

test("merged flavor specs and parallel amount columns require explicit source choices", () => {
  const p = fixture();
  const section = p.productData.sources[0].content.sections![0];
  const alternate = structuredClone(section);
  alternate.headerRow = 10;
  alternate.ingredients[0].amounts[0].value = "3";
  p.productData.sources[0].content.sections!.push(alternate);
  const initial = buildRunRequirements(p, 10, options);
  assert.equal(initial.sectionId, null);
  assert.equal(initial.items.length, 0);
  const chosen = buildRunRequirements(p, 10, { ...options, sectionId: initial.sections[1].id });
  assert.equal(chosen.items[0].perPizza, 3);
  section.ingredients[0].amounts.push({ column: "C", value: "4" });
  const updated = buildRunRequirements(p, 10, options);
  const unresolved = buildRunRequirements(p, 10, { ...options, sectionId: updated.sections[0].id });
  assert.equal(unresolved.items[0].perPizza, null);
  assert.equal(buildRunRequirements(p, 10, { ...options, sectionId: updated.sections[0].id,
    links: [{ itemId: unresolved.items[0].id, amountColumn: "C" }] }).items[0].perPizza, 4);
});

test("the exact same selected formula is prepared once for combined usage, without changing per-pizza rows", () => {
  const p = fixture();
  const row = structuredClone(p.productData.sources[0].content.sections![0].ingredients[0]);
  row.amounts[0].value = "3";
  row.sourceRow = 3;
  p.productData.sources[0].content.sections![0].ingredients.push(row);
  const plan = buildRunRequirements(p, 10, options);
  assert.deepEqual(plan.items.map(i => i.perPizza), [2, 3]);
  assert.equal(plan.batchPreparation.length, 1);
  assert.equal(plan.batchPreparation[0].totalRequired, 37.5);
  assert.equal(plan.batchPreparation[0].wholeBatches, 1);
  assert.equal(plan.batchPreparation[0].ingredients[0].wholeBatchRequired, 40);
});

test("same-named recipes stay brand scoped; ambiguous formulas are not silently selected", () => {
  const p = fixture();
  p.productData.sources[1].brand = "Other";
  const missing = buildRunRequirements(p, 10, options);
  assert.equal(missing.items[0].recipeId, null);
  const explicit = buildRunRequirements(p, 10, { ...options, links: [{ itemId: missing.items[0].id, recipeId: missing.recipes[0].id }] });
  assert.equal(explicit.items[0].batchesExact, 0.3);
  p.productData.sources[1].brand = "Lucia";
  const alternate = structuredClone(p.productData.sources[1]);
  alternate.content.sheets![0].recipes[0].total.amounts[0].value = 100;
  p.productData.sources.push(alternate);
  assert.equal(buildRunRequirements(p, 10, options).items[0].recipeId, null);
});

test("explicit aliases link spec recipe names and ingredients without changing quantities", () => {
  const p = fixture();
  p.productData.sources[0].content.sections![0].ingredients[0].name = "Style";
  const result = buildRunRequirements({ ...p, nameResolution: { revision: 2, rules: [
    { source: { kind: "recipe", brand: "Lucia", name: "Style" }, target: { kind: "recipe", brand: "Lucia", name: "Sauce" } },
    { source: { kind: "ingredient", brand: "Lucia", name: "Tomatoes" }, target: { kind: "ingredient", brand: "Lucia", name: "Tomato" } },
  ] } }, 10, options);
  assert.equal(result.nameRevision, 2);
  assert.equal(result.items[0].name, "Sauce");
  assert.equal(result.items[0].originalName, "Style");
  assert.equal(result.items[0].ingredients[0].name, "Tomato");
  assert.equal(result.items[0].batchYield, 50);
});

test("direct ingredients need explicit confirmation; source annotations and missing units are not parsed as numbers", () => {
  const p = fixture("2 (check)");
  p.productData.sources[1].content.sheets![0].recipes[0].name = "Other sauce";
  const first = buildRunRequirements(p, 10, options);
  assert.equal(first.items[0].perPizza, null);
  const direct = { ...options, links: [{ itemId: first.items[0].id, recipeId: null, directIngredient: true }] };
  p.productData.sources[0].content.sections![0].ingredients[0].amounts[0].value = "2";
  const next = buildRunRequirements(p, 10, options);
  const resolved = buildRunRequirements(p, 10, { ...direct, links: [{ ...direct.links[0], itemId: next.items[0].id }] });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.items[0].totalRequired, 240);
  assert.equal(resolved.items[0].wholeBatches, null);
});

test("invalid or duplicate source selections fail explicitly", () => {
  const p = fixture();
  const plan = buildRunRequirements(p, 1, options);
  assert.throws(() => buildRunRequirements(p, 1, { ...options, links: [{ itemId: "absent" }] }), status(409));
  const link = { itemId: plan.items[0].id, recipeId: "absent" };
  assert.throws(() => buildRunRequirements(p, 1, { ...options, links: [link] }), status(409));
  assert.throws(() => buildRunRequirements(p, 1, { ...options, links: [link, link] }), status(400));
});

test("reviewed shipping supplies the case pack; early-pull and saved premix totals stay separate references", () => {
  const p = fixture();
  const doc = p.productData.sources[1].content;
  Object.assign(doc, { shippingSelection: { reviewed: true, key: "ship" } });
  Object.assign(doc.sheets![0], { shippingRecords: [{ sourceRow: 4, brand: "Lucia", shipping: { key: "ship", pizzasPerCase: 12, casesPerPallet: 30 } }] });
  Object.assign(doc.sheets![0].recipes[0], { premix: { section: "mix", pullInstructions: [{ text: "Pull to drain two days early", daysEarly: 2, sourceRow: 12 }], issues: [] },
    metrics: [{ name: "Saved batches", amounts: [{ value: 9999 }] }] });
  const plan = buildRunRequirements(p, 100);
  assert.equal(plan.unitsPerCase, 12);
  assert.equal(plan.totalPizzas, 1200);
  assert.equal(plan.items[0].batchesExact, 3);
  assert.match(plan.preparation[0], /2 days early/);
  assert.match(plan.packaging[1], /3 full pallets and 10 remaining/);
});

test("run creation recomputes and freezes requirements; stale reviews and changed retries cannot overwrite them", async () => {
  const [facility] = await db.insert(facilitiesTable).values({ name: "Synthetic requirements" }).returning();
  const p = fixture();
  const [profile] = await db.insert(facilityProductProfilesTable).values({
    facilityId: facility.id, brand: p.brand, flavor: p.flavor, normalizedKey: "lucia::cheese",
    createdBy: "synthetic-requirements", productData: p.productData,
  }).returning();
  const request = { facilityId: facility.id, actorUserId: "synthetic-requirements", requestId: randomUUID(),
    setupSnapshot: { label: "Requirements test", targetCases: 10, productProfileId: profile.id,
      planning: { expectedProfileRevision: 0, expectedNameRevision: 0, options } } };
  const result = await createPlannedRun(request);
  const contract = CreateRunResponse.parse(result);
  assert.equal(contract.run.productSnapshot!.runRequirements!.items[0].batchesExact, 0.3);
  const frozen = JSON.stringify(contract.run.productSnapshot);
  await db.update(facilityProductProfilesTable).set({ revision: 1, productData: fixture("3").productData }).where(eq(facilityProductProfilesTable.id, profile.id));
  assert.equal((await createPlannedRun(request)).replayed, true);
  await assert.rejects(createPlannedRun({ ...request, requestId: randomUUID() }), status(409));
  await assert.rejects(createPlannedRun({ ...request, setupSnapshot: { ...request.setupSnapshot,
    planning: { ...request.setupSnapshot.planning, options: { unitsPerCase: 6 } } } }), status(409));
  const [stored] = await db.select().from(productionRunsTable).where(eq(productionRunsTable.id, result.run.id));
  assert.equal(JSON.stringify(stored.productSnapshot), JSON.stringify(result.run.productSnapshot));
  assert.equal(JSON.stringify(CreateRunResponse.parse(result).run.productSnapshot), frozen);
  await db.insert(facilityNameLibrariesTable).values({ facilityId: facility.id, revision: 1, rules: [] });
  await assert.rejects(createPlannedRun({ ...request, requestId: randomUUID(), setupSnapshot: { ...request.setupSnapshot,
    planning: { ...request.setupSnapshot.planning, expectedProfileRevision: 1 } } }), status(409));
  const [other] = await db.insert(facilitiesTable).values({ name: "Other synthetic requirements" }).returning();
  await assert.rejects(createPlannedRun({ ...request, facilityId: other.id, requestId: randomUUID() }), status(404));
});

