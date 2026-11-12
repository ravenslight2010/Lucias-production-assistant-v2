import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  db, facilityNameLibrariesTable, facilityProductProfilesTable,
  type NameReference, type NameRule,
} from "@workspace/db";
import { HttpError } from "./http-error";
import { cleanName, loadNameResolution, nameKey, resolveName, resolvedProduct } from "./name-resolution";
import { activeProfile, lockProfileNames, mergeProfilesInTransaction, normalizedProfileKey, profileForName, rememberProfileName } from "./profile-names";
import { collectNameOccurrences } from "./name-occurrences";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Entry = {
  reference: NameReference; aliases: NameReference[]; profileIds: string[];
  formulaCount: number; specReferenceCount: number; ingredientReferenceCount: number;
};
const kinds = new Set(["brand", "flavor", "recipe", "ingredient"]);

function cleanReference(ref: NameReference): NameReference {
  if (!kinds.has(ref.kind)) throw new HttpError(400, "Choose a supported name type.");
  const result = { ...ref, name: cleanName(ref.name), brand: ref.kind === "brand" ? "" : cleanName(ref.brand) };
  if (!result.name || result.name.length > 300 || result.brand.length > 120 ||
    (ref.kind !== "brand" && !result.brand) || /[\u0000-\u001f]/.test(result.name + result.brand) ||
    ((ref.kind === "brand" || ref.kind === "flavor") && result.name.length > 120)) {
    throw new HttpError(400, "Enter a valid name and brand. Brand and flavor names can contain up to 120 characters.");
  }
  return result;
}

async function readState(tx: Transaction, facilityId: string) {
  const resolution = await loadNameResolution(tx, facilityId);
  const profiles = await tx.select().from(facilityProductProfilesTable).where(and(
    eq(facilityProductProfilesTable.facilityId, facilityId), isNull(facilityProductProfilesTable.mergedIntoId),
  ));
  const version = createHash("sha256").update(JSON.stringify([resolution,
    profiles.map(p => [p.id, p.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ])).digest("hex");
  return { profiles, resolution, version };
}

function libraryView(state: Awaited<ReturnType<typeof readState>>) {
  const entries = new Map<string, Entry>();
  for (const occurrence of collectNameOccurrences(state.profiles)) {
    const reference = resolveName(occurrence.reference, state.resolution.rules);
    const key = nameKey(reference);
    let entry = entries.get(key);
    if (!entry) {
      entry = { reference, aliases: [], profileIds: [], formulaCount: 0, specReferenceCount: 0, ingredientReferenceCount: 0 };
      entries.set(key, entry);
      if (entries.size > 10_000) throw new HttpError(413, "This facility's name library exceeds the review limit.");
    }
    if (!entry.profileIds.includes(occurrence.profileId)) entry.profileIds.push(occurrence.profileId);
    if (occurrence.usage === "formula") entry.formulaCount++;
    if (occurrence.usage === "spec") entry.specReferenceCount++;
    if (occurrence.usage === "ingredient") entry.ingredientReferenceCount++;
  }
  for (const rule of state.resolution.rules) {
    const reference = resolveName(rule.source, state.resolution.rules);
    if (rule.source.brand === reference.brand && rule.source.name === reference.name) continue;
    const key = nameKey(reference);
    const entry = entries.get(key) ?? { reference, aliases: [], profileIds: [], formulaCount: 0, specReferenceCount: 0, ingredientReferenceCount: 0 };
    entries.set(key, entry);
    if (!entry.aliases.some(alias => nameKey(alias) === nameKey(rule.source))) entry.aliases.push(rule.source);
  }
  return { version: state.version, resolution: state.resolution, entries: [...entries.values()].sort((a, b) =>
    a.reference.kind.localeCompare(b.reference.kind) || a.reference.brand.localeCompare(b.reference.brand) || a.reference.name.localeCompare(b.reference.name)) };
}

export async function getNameLibrary(facilityId: string) {
  return db.transaction(async tx => {
    await lockProfileNames(tx, facilityId);
    return libraryView(await readState(tx, facilityId));
  });
}

export async function changeLibraryName(input: {
  facilityId: string; operation: "rename" | "merge"; source: NameReference; target: NameReference; expectedVersion: string;
}) {
  const source = cleanReference(input.source);
  const target = cleanReference(input.target);
  if (source.kind !== target.kind) throw new HttpError(400, "Only names of the same type can be merged.");
  if (input.operation === "rename" && source.brand !== target.brand) throw new HttpError(400, "Rename keeps the brand namespace. Use an explicit merge to connect names across brands.");
  return db.transaction(async tx => {
    await lockProfileNames(tx, input.facilityId);
    const state = await readState(tx, input.facilityId);
    if (state.version !== input.expectedVersion) throw new HttpError(409, "The name library or its source profiles changed. Refresh and review your draft before confirming again.");
    const view = libraryView(state);
    const sourceEntry = view.entries.find(entry => nameKey(entry.reference) === nameKey(source));
    const targetEntry = view.entries.find(entry => nameKey(entry.reference) === nameKey(target));
    if (!sourceEntry) throw new HttpError(409, "This source name is no longer active. Refresh the name library.");
    const targetOwner = resolveName(target, state.resolution.rules);
    if (input.operation === "rename" && (targetEntry || nameKey(targetOwner) !== nameKey(target)) &&
      nameKey(targetOwner) !== nameKey(source)) {
      throw new HttpError(409, "This name already belongs to another entry or its remembered aliases. Use merge instead.");
    }
    if (input.operation === "merge" && (!targetEntry || nameKey(source) === nameKey(target))) {
      throw new HttpError(400, "Choose another existing name of the same type.");
    }
    // Flatten prior aliases so repeated renames and chained merges remain
    // stable. A name merge changes identity only, never formula payloads.
    const rules = state.resolution.rules.map(rule => ({
      source: rule.source,
      target: nameKey(resolveName(rule.source, state.resolution.rules)) === nameKey(source)
        ? target : resolveName(rule.source, state.resolution.rules),
    }));
    const next: NameRule = { source, target };
    const oldIndex = rules.findIndex(rule => nameKey(rule.source) === nameKey(source));
    if (oldIndex >= 0) rules[oldIndex] = next; else rules.push(next);
    if (source.kind === "brand" && input.operation === "rename") {
      // Rebase the canonical namespace and its aliases onto the new brand.
      // Retain all old-brand rules too; imported provenance still uses them.
      // This also preserves destination bindings from earlier brand merges.
      const references = [
        ...view.entries.map(entry => entry.reference),
        ...state.resolution.rules.map(rule => rule.source),
      ].filter(ref => ref.kind !== "brand" &&
        cleanName(resolveName({ kind: "brand", brand: "", name: ref.brand }, state.resolution.rules).name).toLowerCase() === cleanName(source.name).toLowerCase());
      for (const reference of references) {
        const previous = resolveName({ ...reference, brand: source.name }, state.resolution.rules);
        const rebound = { source: { ...reference, brand: target.name }, target: resolveName(previous, rules) };
        const index = rules.findIndex(rule => nameKey(rule.source) === nameKey(rebound.source));
        if (index >= 0) rules[index] = rebound; else rules.push(rebound);
      }
    }
    if (rules.length > 2000 || JSON.stringify(rules).length > 900_000) throw new HttpError(413, "The remembered-name limit was reached. No names were changed.");
    for (const entry of view.entries) resolveName(entry.reference, rules);
    for (const rule of rules) {
      resolveName(rule.source, rules);
      if (rule.source.kind !== "brand") resolveName({
        ...rule.source, brand: resolveName({ kind: "brand", brand: "", name: rule.source.brand }, rules).name,
      }, rules);
    }
    if (source.kind === "brand" || source.kind === "flavor") {
      if (source.kind === "flavor" && input.operation === "merge") {
        for (const profile of state.profiles) {
          const current = resolveName({ kind: "flavor", brand: profile.brand, name: profile.flavor }, state.resolution.rules);
          if (nameKey(current) !== nameKey(source)) continue;
          const names = resolvedProduct(profile.brand, profile.flavor, rules);
          const destination = state.profiles.find(other => other.id !== profile.id &&
            normalizedProfileKey(other.brand, other.flavor) === normalizedProfileKey(names.brand, names.flavor));
          if (destination) await mergeProfilesInTransaction(tx, {
            facilityId: input.facilityId, sourceId: profile.id, targetId: destination.id,
            expectedSourceRevision: profile.revision, expectedTargetRevision: destination.revision,
          });
        }
        state.profiles = (await readState(tx, input.facilityId)).profiles;
      }
      const proposed = state.profiles.map(profile => ({ profile, names: resolvedProduct(profile.brand, profile.flavor, rules) }));
      const owners = new Map<string, string>();
      for (const { profile, names } of proposed) {
        const key = normalizedProfileKey(names.brand, names.flavor);
        const owner = await profileForName(tx, input.facilityId, key);
        if (owner && owner.id !== profile.id) throw new HttpError(409, "A destination name is remembered for another product. Merge or rename those product profiles first.");
        if (owners.has(key)) throw new HttpError(409,
          `Both brands contain ${names.flavor}. Merge or rename those product profiles first; their formulas were not combined.`);
        owners.set(key, profile.id);
      }
      for (const { profile, names } of proposed) {
        if (profile.brand === names.brand && profile.flavor === names.flavor) continue;
        const key = normalizedProfileKey(names.brand, names.flavor);
        const [reserved] = await tx.select().from(facilityProductProfilesTable).where(and(
          eq(facilityProductProfilesTable.facilityId, input.facilityId), eq(facilityProductProfilesTable.normalizedKey, key),
        )).limit(1);
        if (reserved && reserved.id !== profile.id) {
          if ((await activeProfile(tx, input.facilityId, reserved.id)).id !== profile.id) {
            throw new HttpError(409, "A destination product name is reserved for another profile. Review the product profiles first.");
          }
          await rememberProfileName(tx, reserved, profile.id);
          await tx.update(facilityProductProfilesTable).set({ normalizedKey: `merged:${reserved.id}` }).where(eq(facilityProductProfilesTable.id, reserved.id));
        }
        await rememberProfileName(tx, profile);
        await tx.update(facilityProductProfilesTable).set({
          ...names, normalizedKey: key, revision: profile.revision + 1, updatedAt: new Date(),
        }).where(eq(facilityProductProfilesTable.id, profile.id));
      }
    }
    await tx.insert(facilityNameLibrariesTable).values({
      facilityId: input.facilityId, revision: state.resolution.revision + 1, rules,
    }).onConflictDoUpdate({
      target: facilityNameLibrariesTable.facilityId,
      set: { revision: state.resolution.revision + 1, rules, updatedAt: new Date() },
    });
    return libraryView(await readState(tx, input.facilityId));
  });
}
