import type { NameReference, NameRule } from '@workspace/api-client-react';
import { resolveReferenceName } from '../importing/reference-names';

export function ResolvedName({ name, kind, brand = '', rules = [] }: {
  name: string; kind: NameReference['kind'] | 'spec'; brand?: string; rules?: NameRule[];
}) {
  let reference = resolveReferenceName({ kind: kind === 'spec' ? 'recipe' : kind, brand, name }, rules);
  if (kind === 'spec' && reference.name === name && reference.brand === brand) {
    reference = resolveReferenceName({ kind: 'ingredient', brand, name }, rules);
  }
  const changed = reference.name !== name || reference.brand !== brand;
  return <span>{reference.brand && reference.brand !== brand ? `${reference.brand} / ` : ''}{reference.name}
    {changed && <small className="field-help" style={{ display: 'block' }}>Source label: {name}{brand && reference.brand !== brand ? ` (${brand})` : ''}</small>}
  </span>;
}
