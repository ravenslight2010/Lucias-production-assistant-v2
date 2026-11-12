export function productNameKey(brand: string, flavor: string) {
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return JSON.stringify([normalize(brand), normalize(flavor)]);
}

export function indexProductNames<T extends { id: string; brand: string; flavor: string }>(
  profiles: T[],
  mappings: { brand: string; flavor: string; profileId: string }[],
) {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const index = new Map(profiles.map(profile => [productNameKey(profile.brand, profile.flavor), profile]));
  for (const mapping of mappings) {
    const profile = byId.get(mapping.profileId);
    if (profile && !index.has(productNameKey(mapping.brand, mapping.flavor))) {
      index.set(productNameKey(mapping.brand, mapping.flavor), profile);
    }
  }
  return index;
}
