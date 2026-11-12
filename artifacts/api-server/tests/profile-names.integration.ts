import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, facilitiesTable, facilityProductProfilesTable, pool, productionRunsTable } from "@workspace/db";
import {
  activeProfile, listProfileNames, mergeProfiles, normalizedProfileKey, profileForName, renameProfile,
} from "../src/lib/profile-names";

after(() => pool.end());
async function scenario() {
  const [facility] = await db.insert(facilitiesTable).values({ name: `Alias test ${randomUUID()}` }).returning();
  const profiles = await db.insert(facilityProductProfilesTable).values(["Original", "Destination", "Final"].map(brand => ({
    facilityId: facility.id, brand, flavor: "Cheese", normalizedKey: normalizedProfileKey(brand, "Cheese"),
    productData: { source: brand }, createdBy: "synthetic-alias-test",
  }))).returning();
  return { facilityId: facility.id, profiles };
}
const rename = (facilityId: string, profile: Awaited<ReturnType<typeof scenario>>["profiles"][number], brand: string) =>
  renameProfile({ facilityId, profileId: profile.id, brand, flavor: profile.flavor, expectedRevision: profile.revision });
const merge = (facilityId: string, source: Awaited<ReturnType<typeof scenario>>["profiles"][number],
  target: Awaited<ReturnType<typeof scenario>>["profiles"][number]) =>
  mergeProfiles({ facilityId, sourceId: source.id, targetId: target.id, expectedSourceRevision: source.revision, expectedTargetRevision: target.revision });

test("repeated renames and chained merges remember every explicit old name, preserving sources and snapshots", async () => {
  const { facilityId, profiles: [original, destination, final] } = await scenario();
  const snapshot = { id: original.id, brand: original.brand, flavor: original.flavor, revision: original.revision, productData: original.productData };
  const [run] = await db.insert(productionRunsTable).values({
    facilityId, name: "Historical run", productProfileId: original.id, productSnapshot: snapshot,
    status: "planned", targetCases: 12, createdBy: "synthetic-alias-test",
  }).returning();
  const first = await rename(facilityId, original, "Renamed");
  const second = await rename(facilityId, first, "Renamed again");
  const merged = await merge(facilityId, second, destination);
  const last = await merge(facilityId, merged.profile, final);
  const listed = await listProfileNames(facilityId);
  assert.deepEqual(listed.profiles.map(p => p.id), [final.id]);
  assert.deepEqual(new Set(listed.nameMappings.map(m => m.brand)), new Set(["Original", "Renamed", "Renamed again", "Destination"]));
  assert.ok(listed.nameMappings.every(m => m.profileId === final.id));
  for (const brand of ["Original", "Renamed", "Renamed again", "Destination", "Final"]) {
    await db.transaction(async tx => assert.equal((await profileForName(tx, facilityId, normalizedProfileKey(brand, "Cheese")))?.id, final.id));
  }
  assert.equal((last.profile.productData as { sources: unknown[] }).sources.length, 3);
  const [unchanged] = await db.select().from(productionRunsTable).where(eq(productionRunsTable.id, run.id));
  assert.deepEqual(unchanged.productSnapshot, snapshot);
  assert.equal(unchanged.productProfileId, original.id);
});

test("remembered names cannot be claimed by another profile, and stale changes never add aliases", async () => {
  const { facilityId, profiles: [a, b] } = await scenario();
  const renamed = await rename(facilityId, a, "New");
  await assert.rejects(rename(facilityId, b, "Original"), /already belongs/);
  await assert.rejects(rename(facilityId, a, "Stale"), /changed on another device/);
  const result = await listProfileNames(facilityId);
  assert.equal(result.nameMappings.length, 1);
  assert.equal(result.nameMappings[0].profileId, renamed.id);
  assert.equal(result.profiles.find(p => p.id === b.id)?.brand, b.brand);
});

test("aliases stay facility-scoped and cannot redirect foreign profile operations", async () => {
  const first = await scenario();
  const second = await scenario();
  await rename(first.facilityId, first.profiles[0], "New");
  const own = await db.transaction(tx => profileForName(tx, second.facilityId, normalizedProfileKey("Original", "Cheese")));
  assert.equal(own?.id, second.profiles[0].id);
  await assert.rejects(renameProfile({
    facilityId: second.facilityId, profileId: first.profiles[0].id, brand: "Foreign", flavor: "Cheese", expectedRevision: 1,
  }), /unavailable/);
  assert.deepEqual((await listProfileNames(second.facilityId)).nameMappings, []);
});

test("an oversized merge is rejected atomically without retiring profiles or remembering a false merge", async () => {
  const { facilityId, profiles: [a, b] } = await scenario();
  for (const profile of [a, b]) await db.update(facilityProductProfilesTable).set({ productData: { data: "x".repeat(360_000) } })
    .where(eq(facilityProductProfilesTable.id, profile.id));
  await assert.rejects(merge(facilityId, a, b), error => (error as { statusCode?: number }).statusCode === 413);
  const listed = await listProfileNames(facilityId);
  assert.equal(listed.profiles.length, 3);
  assert.ok(listed.profiles.every(p => p.revision === 0 && !p.mergedIntoId));
  assert.deepEqual(listed.nameMappings, []);
});

test("concurrent renames cannot claim the same canonical or remembered name", async () => {
  const { facilityId, profiles: [a, b] } = await scenario();
  const results = await Promise.allSettled([rename(facilityId, a, "One winner"), rename(facilityId, b, "One winner")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal((await listProfileNames(facilityId)).nameMappings.length, 1);
});

test("the survivor can reuse an explicitly merged name, while retired IDs resolve to that survivor", async () => {
  const { facilityId, profiles: [a, b] } = await scenario();
  const merged = await merge(facilityId, a, b);
  const renamed = await rename(facilityId, merged.profile, a.brand);
  assert.equal(renamed.id, b.id);
  assert.equal(renamed.brand, a.brand);
  await db.transaction(async tx => assert.equal((await activeProfile(tx, facilityId, a.id)).id, b.id));
});

test("merges saved before remembered-name support still resolve and allow the survivor to reuse their old names", async () => {
  const { facilityId, profiles: [a, b] } = await scenario();
  // Prior versions kept the original normalized key on a retired row.
  await db.update(facilityProductProfilesTable).set({ mergedIntoId: b.id, revision: 1 })
    .where(eq(facilityProductProfilesTable.id, a.id));
  await db.transaction(async tx => assert.equal((await profileForName(tx, facilityId, normalizedProfileKey(a.brand, a.flavor)))?.id, b.id));
  assert.deepEqual((await listProfileNames(facilityId)).nameMappings, [{ brand: a.brand, flavor: a.flavor, profileId: b.id }]);
  const renamed = await rename(facilityId, b, a.brand);
  assert.equal(renamed.id, b.id);
  assert.equal(renamed.brand, a.brand);
  await db.transaction(async tx => assert.equal((await profileForName(tx, facilityId, normalizedProfileKey(b.brand, b.flavor)))?.id, b.id));
});
