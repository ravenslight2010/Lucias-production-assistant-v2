import type { NameReference, NameRule } from '@workspace/api-client-react';

const clean = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ');
export const referenceNameKey = (r: NameReference) => JSON.stringify([
  r.kind, r.kind === 'brand' ? '' : clean(r.brand).toLowerCase(), clean(r.name).toLowerCase(),
]);

export function resolveReferenceName(reference: NameReference, rules: NameRule[]): NameReference {
  const index = new Map(rules.map(rule => [referenceNameKey(rule.source), rule.target]));
  const seen = new Set<string>();
  let current = { ...reference, brand: reference.kind === 'brand' ? '' : clean(reference.brand), name: clean(reference.name) };
  for (let step = 0; step <= rules.length + 2; step++) {
    const key = referenceNameKey(current);
    if (seen.has(key)) throw new Error('A remembered name has a circular reference. Review the name library.');
    seen.add(key);
    const target = index.get(key);
    if (target) {
      if (referenceNameKey(target) === key) return target.kind === 'brand' ? target : {
        ...target, brand: resolveReferenceName({ kind: 'brand', brand: '', name: target.brand }, rules).name,
      };
      current = target;
      continue;
    }
    if (current.kind !== 'brand') {
      const brand = resolveReferenceName({ kind: 'brand', brand: '', name: current.brand }, rules).name;
      const next = { ...current, brand };
      if (referenceNameKey(next) !== key) { current = next; continue; }
      return next;
    }
    return current;
  }
  throw new Error('This name has too many redirects. Review the name library.');
}
