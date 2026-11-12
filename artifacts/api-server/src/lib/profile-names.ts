import { and, eq, sql } from "drizzle-orm";
import { db, facilityProductProfilesTable, profileNameAliasesTable } from "@workspace/db";
import { HttpError } from "./http-error";
import { loadNameResolution, resolutionForProfile, resolvedProduct } from "./name-resolution";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Profile = typeof facilityProductProfilesTable.$inferSelect;

export function normalizedProfileKey(brand: string, flavor: string) {
  return [brand, flavor].map(part => part.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()).join("::");
}

// Canonical names and aliases share one logical namespace. Serialize writes
// across both tables so two concurrent imports/renames cannot claim one name.
export async function lockProfileNames(tx: Transaction, facilityId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('profile-names'), hashtext(${facilityId}))`);
}

export async function activeProfile(tx: Transaction, facilityId: string, profileId: string): Promise<Profile> {
  const seen = new Set<string>();
  let id = profileId;
  while (!seen.has(id) && seen.size < 100) {
    seen.add(id);
    const [profile] = await tx.select().from(facilityProductProfilesTable).where(and(
      eq(facilityProductProfilesTable.facilityId, facilityId),
      eq(facilityProductProfilesTable.id, id),
    )).limit(1);
    if (!profile) throw new HttpError(409, "The remembered product is unavailable. Refresh profiles before importing.");
    if (!profile.mergedIntoId) return profile;
    id = profile.mergedIntoId;
  }
  throw new HttpError(409, "The remembered product cannot be resolved. Review the profile merge history.");
}

export async function profileForName(tx: Transaction, facilityId: string, key: string) {
  const [profile] = await tx.select().from(facilityProductProfilesTable).where(and(
    eq(facilityProductProfilesTable.facilityId, facilityId),
    eq(facilityProductProfilesTable.normalizedKey, key),
  )).limit(1);
  if (profile) return activeProfile(tx, facilityId, profile.id);
  const [alias] = await tx.select({ profileId: profileNameAliasesTable.profileId }).from(profileNameAliasesTable).where(and(
    eq(profileNameAliasesTable.facilityId, facilityId),
    eq(profileNameAliasesTable.normalizedKey, key),
  )).limit(1);
  return alias ? activeProfile(tx, facilityId, alias.profileId) : undefined;
}

export async function profileForImportedName(tx: Transaction, facilityId: string, brand: string, flavor: string) {
  const original = await profileForName(tx, facilityId, normalizedProfileKey(brand, flavor));
  if (original) return original;
  const resolution = await loadNameResolution(tx, facilityId);
  const names = resolvedProduct(brand, flavor, resolution.rules);
  return profileForName(tx, facilityId, normalizedProfileKey(names.brand, names.flavor));
}

export async function rememberProfileName(tx: Transaction, profile: Profile, targetId = profile.id) {
  const key = normalizedProfileKey(profile.brand, profile.flavor);
  const [alias] = await tx.select().from(profileNameAliasesTable).where(and(
    eq(profileNameAliasesTable.facilityId, profile.facilityId),
    eq(profileNameAliasesTable.normalizedKey, key),
  )).limit(1);
  if (alias) {
    const owner = await activeProfile(tx, profile.facilityId, alias.profileId);
    if (owner.id !== profile.id && owner.id !== targetId) {
      throw new HttpError(409, "This name is already remembered for another product.");
    }
    await tx.update(profileNameAliasesTable).set({ profileId: targetId }).where(eq(profileNameAliasesTable.id, alias.id));
  } else {
    await tx.insert(profileNameAliasesTable).values({
      facilityId: profile.facilityId, profileId: targetId, brand: profile.brand, flavor: profile.flavor, normalizedKey: key,
    });
  }
}

export function profileSourceEntries(profile: Pick<Profile, "id" | "brand" | "flavor" | "productData">): unknown[] {
  if (profile.productData && typeof profile.productData === "object" && !Array.isArray(profile.productData) &&
    Array.isArray((profile.productData as Record<string, unknown>).sources)) {
    return (profile.productData as { sources: unknown[] }).sources;
  }
  return [{ profileId: profile.id, brand: profile.brand, flavor: profile.flavor, data: profile.productData }];
}

export function safeProfilePayload(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 0 && serialized.length <= 700_000;
  } catch { return false; }
}

export async function listProfileNames(facilityId: string) {
  // Keep profiles and their mappings on one consistent read snapshot.
  return db.transaction(async tx => {
    await lockProfileNames(tx, facilityId);
    const all = await tx.select().from(facilityProductProfilesTable).where(eq(facilityProductProfilesTable.facilityId, facilityId));
    const aliases = await tx.select().from(profileNameAliasesTable).where(eq(profileNameAliasesTable.facilityId, facilityId));
    const referenceNames = await loadNameResolution(tx, facilityId);
    const byId = new Map(all.map(profile => [profile.id, profile]));
    const mappings = new Map<string, { brand: string; flavor: string; profileId: string }>();
    const candidates = [
      ...all.filter(p => p.mergedIntoId).map(p => ({ brand: p.brand, flavor: p.flavor, profileId: p.id })),
      ...aliases,
    ];
    for (const alias of candidates) {
      const seen = new Set<string>();
      let profile = byId.get(alias.profileId);
      while (profile?.mergedIntoId && !seen.has(profile.id)) {
        seen.add(profile.id);
        profile = byId.get(profile.mergedIntoId);
      }
      if (!profile || profile.mergedIntoId) throw new HttpError(409, "A remembered product is unavailable. Review the profile merge history.");
      mappings.set(normalizedProfileKey(alias.brand, alias.flavor), { brand: alias.brand, flavor: alias.flavor, profileId: profile.id });
    }
    return {
      profiles: all.filter(p => !p.mergedIntoId).sort((a, b) => a.brand.localeCompare(b.brand) || a.flavor.localeCompare(b.flavor))
        .map(p => ({ ...p, ...(referenceNames.rules.length ? { nameResolution: resolutionForProfile(p, referenceNames) } : {}) })),
      nameMappings: [...mappings.values()],
      referenceNames,
    };
  });
}

export async function renameProfile(input: {
  facilityId: string; profileId: string; brand: string; flavor: string; expectedRevision: number;
}) {
  const brand = input.brand.normalize("NFKC").trim().replace(/\s+/g, " ");
  const flavor = input.flavor.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!brand || !flavor || brand.length > 120 || flavor.length > 120) throw new HttpError(400, "Enter a valid brand and flavor.");
  return db.transaction(async tx => {
    await lockProfileNames(tx, input.facilityId);
    const names = resolvedProduct(brand, flavor, (await loadNameResolution(tx, input.facilityId)).rules);
    if (names.brand !== brand || names.flavor !== flavor) {
      throw new HttpError(409, "This brand or flavor is a remembered name. Use its canonical name from the name library.");
    }
    const source = await activeProfile(tx, input.facilityId, input.profileId);
    if (source.id !== input.profileId || source.revision !== input.expectedRevision) {
      throw new HttpError(409, "This profile changed on another device. Refresh and review the rename again.");
    }
    const key = normalizedProfileKey(brand, flavor);
    const owner = await profileForName(tx, input.facilityId, key);
    if (owner && owner.id !== source.id) throw new HttpError(409, "This name already belongs to another product, including its remembered names.");
    // A survivor may take the name of one of its own retired profiles. Preserve
    // that historical name before freeing the retired row's internal key.
    const [retired] = await tx.select().from(facilityProductProfilesTable).where(and(
      eq(facilityProductProfilesTable.facilityId, input.facilityId),
      eq(facilityProductProfilesTable.normalizedKey, key),
    )).limit(1);
    if (retired && retired.id !== source.id) {
      await rememberProfileName(tx, retired, source.id);
      await tx.update(facilityProductProfilesTable).set({ normalizedKey: `merged:${retired.id}` })
        .where(eq(facilityProductProfilesTable.id, retired.id));
    }
    await rememberProfileName(tx, source);
    const [profile] = await tx.update(facilityProductProfilesTable).set({
      brand, flavor, normalizedKey: key, revision: source.revision + 1, updatedAt: new Date(),
    }).where(and(
      eq(facilityProductProfilesTable.id, source.id),
      eq(facilityProductProfilesTable.revision, input.expectedRevision),
    )).returning();
    if (!profile) throw new HttpError(409, "This profile changed on another device. No rename was applied.");
    return profile;
  });
}

export async function mergeProfiles(input: {
  facilityId: string; sourceId: string; targetId: string; expectedSourceRevision: number; expectedTargetRevision: number;
}) {
  return db.transaction(async tx => {
    await lockProfileNames(tx, input.facilityId);
    return mergeProfilesInTransaction(tx, input);
  });
}

export async function mergeProfilesInTransaction(tx: Transaction, input: {
  facilityId: string; sourceId: string; targetId: string; expectedSourceRevision: number; expectedTargetRevision: number;
}) {
    if (input.sourceId === input.targetId) throw new HttpError(400, "Choose two different product profiles to merge.");
    const source = await activeProfile(tx, input.facilityId, input.sourceId);
    const target = await activeProfile(tx, input.facilityId, input.targetId);
    if (source.id !== input.sourceId || target.id !== input.targetId ||
      source.revision !== input.expectedSourceRevision || target.revision !== input.expectedTargetRevision) {
      throw new HttpError(409, "A profile changed on another device. Refresh and review the merge again.");
    }
    const productData = { sources: [...profileSourceEntries(target), ...profileSourceEntries(source)] };
    if (!safeProfilePayload(productData)) throw new HttpError(413, "The combined profile source data exceeds the facility profile limit. Neither profile was changed.");
    await rememberProfileName(tx, source, target.id);
    await tx.update(profileNameAliasesTable).set({ profileId: target.id }).where(and(
      eq(profileNameAliasesTable.facilityId, input.facilityId),
      eq(profileNameAliasesTable.profileId, source.id),
    ));
    const [profile] = await tx.update(facilityProductProfilesTable).set({
      productData, revision: target.revision + 1, updatedAt: new Date(),
    }).where(and(
      eq(facilityProductProfilesTable.id, target.id),
      eq(facilityProductProfilesTable.revision, input.expectedTargetRevision),
    )).returning();
    const [retired] = await tx.update(facilityProductProfilesTable).set({
      mergedIntoId: target.id, normalizedKey: `merged:${source.id}`,
      revision: source.revision + 1, updatedAt: new Date(),
    }).where(and(
      eq(facilityProductProfilesTable.id, source.id),
      eq(facilityProductProfilesTable.revision, input.expectedSourceRevision),
    )).returning();
    if (!profile || !retired) throw new HttpError(409, "A profile changed on another device. Neither profile was changed.");
    return { profile, mergedProfileId: retired.id };
}
