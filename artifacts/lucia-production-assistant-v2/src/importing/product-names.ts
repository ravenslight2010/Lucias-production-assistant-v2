import type { NameRule } from '@workspace/api-client-react';
import { resolveReferenceName } from './reference-names.ts';

export function productNameKey(brand: string, flavor: string) {
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return JSON.stringify([normalize(brand), normalize(flavor)]);
}

export function indexProductNames<T extends { id: string; brand: string; flavor: string }>(
  profiles: T[],
  mappings: { brand: string; flavor: string; profileId: string }[],
  rules: NameRule[] = [],
) {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  class RememberedProductIndex extends Map<string, T> {
    override get(key: string): T | undefined {
      const exact = super.get(key);
      if (exact || !rules.length) return exact;
      let parts: unknown;
      try { parts = JSON.parse(key); } catch { return undefined; }
      if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => typeof p !== 'string')) return undefined;
      const canonical = resolveReferenceName({ kind: 'flavor', brand: parts[0], name: parts[1] }, rules);
      return super.get(productNameKey(canonical.brand, canonical.name));
    }
    override has(key: string) { return this.get(key) !== undefined; }
  }
  const index = new RememberedProductIndex(profiles.map(profile => [productNameKey(profile.brand, profile.flavor), profile]));
  for (const mapping of mappings) {
    const profile = byId.get(mapping.profileId);
    if (profile && !index.has(productNameKey(mapping.brand, mapping.flavor))) {
      index.set(productNameKey(mapping.brand, mapping.flavor), profile);
    }
  }
  return index;
}
