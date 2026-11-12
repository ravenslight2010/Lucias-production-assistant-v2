import { db, facilityNameLibrariesTable, type NameReference, type NameRule } from "@workspace/db";
import { eq } from "drizzle-orm";
import { HttpError } from "./http-error";
import { collectNameOccurrences } from "./name-occurrences";

export const cleanName = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ");
export const nameKey = (ref: NameReference) => JSON.stringify([
  ref.kind, ref.kind === "brand" ? "" : cleanName(ref.brand).toLowerCase(), cleanName(ref.name).toLowerCase(),
]);

export function resolveName(ref: NameReference, rules: NameRule[]): NameReference {
  const index = new Map(rules.map(rule => [nameKey(rule.source), rule.target]));
  const seen = new Set<string>();
  let current = { ...ref, brand: ref.kind === "brand" ? "" : cleanName(ref.brand), name: cleanName(ref.name) };
  for (let step = 0; step <= rules.length + 2; step++) {
    const key = nameKey(current);
    if (seen.has(key)) throw new HttpError(409, "A remembered name has a circular reference. Review the name library.");
    seen.add(key);
    // Resolve only this namespace, then follow its explicit brand redirect.
    // Never search every historical brand for a similarly scoped alias.
    const target = index.get(key);
    if (target) {
      if (nameKey(target) === key) return target.kind === "brand" ? target : {
        ...target, brand: resolveName({ kind: "brand", brand: "", name: target.brand }, rules).name,
      };
      current = target;
      continue;
    }
    if (current.kind !== "brand") {
      const brand = resolveName({ kind: "brand", brand: "", name: current.brand }, rules).name;
      const next = { ...current, brand };
      if (nameKey(next) !== key) { current = next; continue; }
      return next;
    }
    return current;
  }
  throw new HttpError(409, "This name has too many redirects. Review the name library.");
}

export function resolvedProduct(brand: string, flavor: string, rules: NameRule[]) {
  const canonical = resolveName({ kind: "flavor", brand, name: flavor }, rules);
  return { brand: canonical.brand, flavor: canonical.name };
}

export async function loadNameResolution(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], facilityId: string) {
  const [library] = await tx.select().from(facilityNameLibrariesTable)
    .where(eq(facilityNameLibrariesTable.facilityId, facilityId)).limit(1);
  return { revision: library?.revision ?? 0, rules: library?.rules ?? [] };
}

export function resolutionForProfile(
  profile: { id: string; brand: string; flavor: string; productData: unknown },
  resolution: { revision: number; rules: NameRule[] },
) {
  if (!resolution.rules.length) return undefined;
  const rules = new Map<string, NameRule>();
  for (const { reference } of collectNameOccurrences([profile])) {
    for (const source of [reference, ...(reference.brand ? [{ kind: "brand" as const, brand: "", name: reference.brand }] : [])]) {
      const target = resolveName(source, resolution.rules);
      if (source.brand !== target.brand || source.name !== target.name) rules.set(nameKey(source), { source, target });
    }
  }
  return rules.size ? { revision: resolution.revision, rules: [...rules.values()] } : undefined;
}
