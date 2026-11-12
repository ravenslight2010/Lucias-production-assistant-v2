import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, facilitiesTable, facilityProductProfilesTable, pool, productionRunsTable, type NameReference } from "@workspace/db";
import { changeLibraryName, getNameLibrary } from "../src/lib/name-library";
import { loadNameResolution, nameKey, resolveName, resolutionForProfile } from "../src/lib/name-resolution";
import { listProfileNames, normalizedProfileKey, profileForImportedName } from "../src/lib/profile-names";
import { createPlannedRun } from "../src/lib/run-create-service";
import { importSchedule } from "../src/lib/schedule-import-service";
import type { ProductProfile } from "@workspace/api-zod";

after(() => pool.end());
const ref = (kind: NameReference["kind"], name: string, brand = "Lucia") => ({ kind, name, brand: kind === "brand" ? "" : brand });
const spec = (brand: string, amount: string) => ({
  format: "lucia.product-spec.v1", brand, flavor: "Cheese", warnings: [],
  sections: [{ sheet: "Cheese", headerRow: 1, endRow: 4, unit: "oz", notes: [], warnings: [],
    targetWeight: null, weightSpecRange: null, ingredients: [{ name: "Lucia Style", sourceRow: 2, amounts: [{ column: "B", value: amount }] }] }],
});
const batch = (brand: string) => ({
  format: "lucia.operational-workbook.v1", importKind: "sauce_guide", title: `${brand} sauce`, revision: null,
  availableSheetNames: ["Sauce"], selectedSheetNames: ["Sauce"], warnings: [],
  sheets: [{ name: "Sauce", productMappings: [], shippingRecords: [], notes: [], recipes: [{
    name: "Lucia Sauce", source: { sheet: "Sauce", startRow: 1, endRow: 4 },
    ingredients: [{ name: "Tomatos", sourceRow: 2, amounts: [{ column: 2, label: "Batch lbs", value: 50 }] }],
    steps: [], equipment: [], notes: [], metrics: [],
  }] }],
});
async function scenario() {
  const [facility] = await db.insert(facilitiesTable).values({ name: `Name library ${randomUUID()}` }).returning();
  const profiles = await db.insert(facilityProductProfilesTable).values([
    { brand: "Lucia", flavor: "Cheese", productData: { sources: [{ brand: "Lucia", content: spec("Lucia", "2") }, { brand: "Lucia", content: batch("Lucia") }] } },
    { brand: "Lucia", flavor: "Pepperoni", productData: { sources: [{ brand: "Lucia", content: spec("Lucia", "3") }, { brand: "Lucia", content: batch("Lucia") }] } },
    { brand: "Other", flavor: "Cheese", productData: { sources: [{ brand: "Other", content: spec("Other", "4") }, { brand: "Other", content: batch("Other") }] } },
  ].map(p => ({ ...p, facilityId: facility.id, normalizedKey: normalizedProfileKey(p.brand, p.flavor), createdBy: "synthetic-name-test" }))).returning();
  return { facilityId: facility.id, profiles };
}
async function change(facilityId: string, source: NameReference, target: NameReference, operation: "rename" | "merge" = "rename") {
  return changeLibraryName({ facilityId, source, target, operation, expectedVersion: (await getNameLibrary(facilityId)).version });
}

test("recipe aliases link spec references to batch identities without changing per-pizza amounts or other brands", async () => {
  const { facilityId, profiles } = await scenario();
  const before = profiles.map(p => p.productData);
  const library = await change(facilityId, ref("recipe", "Lucia Style"), ref("recipe", "Lucia Sauce"), "merge");
  const entry = library.entries.find(e => nameKey(e.reference) === nameKey(ref("recipe", "Lucia Sauce")))!;
  assert.equal(entry.formulaCount, 2);
  assert.equal(entry.specReferenceCount, 2);
  assert.equal(entry.profileIds.length, 2);
  assert.deepEqual(entry.aliases, [ref("recipe", "Lucia Style")]);
  assert.equal(resolveName(ref("recipe", "Lucia Style", "Other"), library.resolution.rules).name, "Lucia Style");
  for (const p of profiles) {
    const [row] = await db.select().from(facilityProductProfilesTable).where(eq(facilityProductProfilesTable.id, p.id));
    assert.deepEqual(row.productData, before[profiles.indexOf(p)]);
    assert.equal(row.revision, 0);
  }
  assert.equal(library.entries.find(e => nameKey(e.reference) === nameKey(ref("recipe", "Lucia Style", "Other")))?.specReferenceCount, 1);
});

test("ingredient aliases and repeated recipe renames survive reload, stay type scoped, and can reuse an old name", async () => {
  const { facilityId } = await scenario();
  await change(facilityId, ref("ingredient", "Tomatos"), ref("ingredient", "Tomatoes"));
  await change(facilityId, ref("recipe", "Lucia Sauce"), ref("recipe", "House Sauce"));
  await change(facilityId, ref("recipe", "House Sauce"), ref("recipe", "Lucia Sauce"));
  const { resolution } = await getNameLibrary(facilityId);
  assert.equal(resolveName(ref("ingredient", "Tomatos"), resolution.rules).name, "Tomatoes");
  assert.equal(resolveName(ref("recipe", "House Sauce"), resolution.rules).name, "Lucia Sauce");
  assert.equal(resolveName(ref("recipe", "Tomatos"), resolution.rules).name, "Tomatos");
  await assert.rejects(change(facilityId, ref("ingredient", "Tomatoes"), ref("recipe", "Lucia Sauce"), "merge"),
    (e: any) => e.statusCode === 400);
});

test("brand renaming updates all current products, preserves old names, and recognizes old brand/new flavor combinations", async () => {
  const { facilityId, profiles } = await scenario();
  await change(facilityId, ref("recipe", "Lucia Style"), ref("recipe", "Lucia Sauce"), "merge");
  const library = await change(facilityId, ref("brand", "Lucia"), ref("brand", "Lucia Foods", ""));
  const listed = await listProfileNames(facilityId);
  assert.equal(listed.profiles.filter(p => p.brand === "Lucia Foods").length, 2);
  assert.equal(listed.profiles.find(p => p.id === profiles[2].id)?.brand, "Other");
  assert.equal(resolveName(ref("recipe", "Lucia Style", "Lucia Foods"), library.resolution.rules).name, "Lucia Sauce");
  await db.transaction(async tx => {
    assert.equal((await profileForImportedName(tx, facilityId, "Lucia", "Cheese"))?.id, profiles[0].id);
    assert.equal((await profileForImportedName(tx, facilityId, "Lucia", "Pepperoni"))?.id, profiles[1].id);
    const resolution = await loadNameResolution(tx, facilityId);
    assert.equal(resolveName(ref("flavor", "New flavor"), resolution.rules).brand, "Lucia Foods");
  });
});

test("flavor renaming is brand scoped; explicit flavor merges preserve all source bundles", async () => {
  const { facilityId, profiles } = await scenario();
  await change(facilityId, ref("flavor", "Cheese"), ref("flavor", "Four Cheese"));
  const listed = await listProfileNames(facilityId);
  assert.equal(listed.profiles.find(p => p.id === profiles[0].id)?.flavor, "Four Cheese");
  assert.equal(listed.profiles.find(p => p.id === profiles[2].id)?.flavor, "Cheese");
  await change(facilityId, ref("flavor", "Pepperoni"), ref("flavor", "Four Cheese"), "merge");
  const merged = await listProfileNames(facilityId);
  assert.equal(merged.profiles.length, 2);
  assert.equal((merged.profiles.find(p => p.id === profiles[0].id)!.productData as any).sources.length, 4);
  await db.transaction(async tx => assert.equal((await profileForImportedName(tx, facilityId, "Lucia", "Pepperoni"))?.id, profiles[0].id));
  const other = await scenario();
  const old = await getNameLibrary(other.facilityId);
  await assert.rejects(change(other.facilityId, ref("brand", "Lucia"), ref("brand", "Other"), "merge"), (e: any) => e.statusCode === 409);
  assert.deepEqual(await getNameLibrary(other.facilityId), old);
});

test("stale source profiles, concurrent edits, unknown names, and foreign facility names fail without mutation", async () => {
  const { facilityId, profiles } = await scenario();
  const view = await getNameLibrary(facilityId);
  await db.update(facilityProductProfilesTable).set({ revision: 1 }).where(eq(facilityProductProfilesTable.id, profiles[0].id));
  await assert.rejects(changeLibraryName({ facilityId, source: ref("ingredient", "Tomatos"), target: ref("ingredient", "Tomatoes"),
    operation: "rename", expectedVersion: view.version }), (e: any) => e.statusCode === 409);
  const fresh = await getNameLibrary(facilityId);
  const results = await Promise.allSettled(["A", "B"].map(name => changeLibraryName({
    facilityId, source: ref("ingredient", "Tomatos"), target: ref("ingredient", name), operation: "rename", expectedVersion: fresh.version,
  })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(change(facilityId, ref("ingredient", "Unknown"), ref("ingredient", "Other name")), (e: any) => e.statusCode === 409);
  const foreign = await scenario();
  assert.deepEqual((await getNameLibrary(foreign.facilityId)).resolution.rules, []);
});

test("new manual and scheduled runs freeze name decisions; later renames never rewrite snapshots or source formulas", async () => {
  const { facilityId, profiles: [profile] } = await scenario();
  const make = () => createPlannedRun({ facilityId, actorUserId: "synthetic-name-test", requestId: randomUUID(),
    setupSnapshot: { label: "Name snapshot", targetCases: 12, productProfileId: profile.id } });
  const historical = await make();
  await change(facilityId, ref("recipe", "Lucia Style"), ref("recipe", "Lucia Sauce"), "merge");
  const created = await make();
  const snapshot = created.run.productSnapshot as ProductProfile;
  assert.equal(resolveName(ref("recipe", "Lucia Style"), snapshot.nameResolution!.rules).name, "Lucia Sauce");
  assert.deepEqual(snapshot.productData, profile.productData);
  await importSchedule({
    facilityId, actorUserId: "synthetic-name-test", sourceName: "synthetic.xlsx", sourceHash: "d".repeat(64),
    importDate: "2099-01-01", ignoredPastCount: 0,
    runs: [{ date: "2099-01-01", brand: "Lucia", flavor: "Cheese", productProfileId: profile.id,
      casesPlanned: 12, notes: "", source: { sheet: "Plan", row: 2 } }],
  });
  const scheduled = (await db.select().from(productionRunsTable).where(eq(productionRunsTable.facilityId, facilityId)))
    .find(r => r.scheduledFor === "2099-01-01")!;
  assert.deepEqual((scheduled.productSnapshot as any).nameResolution, snapshot.nameResolution);
  await change(facilityId, ref("recipe", "Lucia Sauce"), ref("recipe", "Newest Sauce"));
  const [old] = await db.select().from(productionRunsTable).where(eq(productionRunsTable.id, historical.run.id));
  const [unchanged] = await db.select().from(productionRunsTable).where(eq(productionRunsTable.id, created.run.id));
  assert.equal((old.productSnapshot as any).nameResolution, undefined);
  assert.deepEqual(unchanged.productSnapshot, snapshot);
  const resolution = (await getNameLibrary(facilityId)).resolution;
  assert.equal(resolveName(ref("recipe", "Lucia Style"), resolutionForProfile(profile, resolution)!.rules).name, "Newest Sauce");
});

test("explicit cross-brand recipe and non-conflicting brand merges retain all source formulas and name history", async () => {
  const { facilityId, profiles } = await scenario();
  await change(facilityId, ref("recipe", "Lucia Style"), ref("recipe", "Lucia Sauce", "Other"), "merge");
  let library = await getNameLibrary(facilityId);
  assert.equal(resolveName(ref("recipe", "Lucia Style"), library.resolution.rules).brand, "Other");
  await change(facilityId, ref("flavor", "Cheese", "Other"), ref("flavor", "Other Flavor", "Other"));
  library = await change(facilityId, ref("brand", "Other"), ref("brand", "Lucia"), "merge");
  const listed = await listProfileNames(facilityId);
  assert.equal(listed.profiles.length, 3);
  assert(listed.profiles.every(p => p.brand === "Lucia"));
  for (const profile of profiles) assert.deepEqual(listed.profiles.find(p => p.id === profile.id)?.productData, profile.productData);
  assert.equal(resolveName(ref("recipe", "Lucia Style"), library.resolution.rules).brand, "Lucia");
  await db.transaction(async tx => assert.equal((await profileForImportedName(tx, facilityId, "Other", "Cheese"))?.id, profiles[2].id));
  library = await change(facilityId, ref("brand", "Lucia"), ref("brand", "Unified"));
  assert((await listProfileNames(facilityId)).profiles.every(p => p.brand === "Unified"));
  assert.deepEqual(resolveName(ref("flavor", "Cheese"), library.resolution.rules), ref("flavor", "Cheese", "Unified"));
  assert.deepEqual(resolveName(ref("flavor", "Cheese", "Other"), library.resolution.rules), ref("flavor", "Other Flavor", "Unified"));
});

test("an oversized flavor merge rolls back name history and both product profiles", async () => {
  const { facilityId, profiles: [a, b] } = await scenario();
  for (const p of [a, b]) await db.update(facilityProductProfilesTable).set({ productData: { padding: "x".repeat(400_000) } })
    .where(eq(facilityProductProfilesTable.id, p.id));
  const before = await listProfileNames(facilityId);
  await assert.rejects(change(facilityId, ref("flavor", b.flavor), ref("flavor", a.flavor), "merge"), (e: any) => e.statusCode === 413);
  assert.deepEqual(await listProfileNames(facilityId), before);
});
