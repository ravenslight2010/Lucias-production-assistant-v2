import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetFacilityContextQueryKey,
  getListProductProfilesQueryKey,
  useGetFacilityContext,
  useListProductProfiles,
  useUpdateProductProfileManagerData,
} from '@workspace/api-client-react';
import type {
  ManagerManualRecipe,
  ManagerRecipeDefinition,
  ProductProfileManagerData,
  RunPlanningReview,
} from '@workspace/api-client-react';
import {
  BookOpen, Check, CircleAlert, ClipboardCheck, FileSpreadsheet, Plus, RefreshCw,
  Save, ShieldCheck, Trash2,
} from 'lucide-react';
import { Link } from 'wouter';
import { RunRequirementsEditor } from '@/components/run-requirements';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { extractImportedRecipes, getManagerData } from '@/manager-data';
import './manager.css';

const categories = ['all', 'cheese', 'mix', 'dough', 'sauce'] as const;
type Category = typeof categories[number];
const categoryTitle: Record<Exclude<Category, 'all'>, string> = {
  cheese: 'Cheese', mix: 'Mix', dough: 'Dough', sauce: 'Sauce',
};
const freshDefinition = (): ManagerRecipeDefinition => ({
  batchVariants: [{ column: 1, label: 'Batch 1', unit: null, yield: null }],
  ingredients: [], steps: [], notes: [],
});
function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
function statusFor(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined;
}
function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

export default function ManagerPage() {
  const context = useGetFacilityContext({
    query: { queryKey: getGetFacilityContextQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const profileQuery = useListProductProfiles({
    query: {
      queryKey: getListProductProfilesQueryKey(),
      enabled: context.data?.role === 'owner' || context.data?.role === 'manager',
    },
    request: { credentials: 'include' },
  });
  const profiles = profileQuery.data?.profiles.filter((profile) => !profile.mergedIntoId) ?? [];
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const profile = profiles.find((item) => item.id === selectedProfileId) ?? profiles[0];
  const [category, setCategory] = useState<Category>('all');
  const [search, setSearch] = useState('');
  const [editingKey, setEditingKey] = useState('');
  const [draft, setDraft] = useState<ManagerRecipeDefinition | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManagerManualRecipe | null>(null);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [feedback, setFeedback] = useState('');
  const [review, setReview] = useState<RunPlanningReview | null>(null);
  const [targetCases, setTargetCases] = useState(1);
  const client = useQueryClient();
  const saveMutation = useUpdateProductProfileManagerData({ request: { credentials: 'include' } });
  const canManage = context.data?.role === 'owner' || context.data?.role === 'manager';

  const recipes = useMemo(() => {
    if (!profile) return [];
    const managerData = getManagerData(profile);
    const imported = extractImportedRecipes(profile).map((item) => ({
      key: item.sourceKey,
      name: item.name,
      category: item.category,
      source: `${item.sourceName} · ${item.sheet}, row ${item.row}`,
      imported: true,
      definition: managerData.recipeOverrides[item.sourceKey] ?? item.definition,
      overridden: Boolean(managerData.recipeOverrides[item.sourceKey]),
    }));
    const manual = managerData.manualRecipes.map((item) => ({
      key: `manual:${item.id}`,
      name: item.name,
      category: item.category,
      source: 'Manager-managed recipe',
      imported: false,
      definition: item.recipeData,
      overridden: false,
    }));
    const normalized = [...imported, ...manual];
    return normalized.filter((item) => (category === 'all' || item.category === category) &&
      `${item.name} ${item.category} ${item.source}`.toLowerCase().includes(search.toLowerCase().trim()));
  }, [profile, category, search]);

  const commit = (managerData: ProductProfileManagerData, done: string) => {
    if (!profile) return;
    setFeedback('');
    saveMutation.mutate({
      profileId: profile.id,
      data: { expectedRevision: profile.revision, managerData },
    }, {
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: getListProductProfilesQueryKey() });
        setFeedback(done);
        setReview(null);
        setEditingKey('');
        setDraft(null);
        setManualOpen(false);
        setManualDraft(null);
        setConfirmDelete('');
      },
      onError: (error) => setFeedback(statusFor(error) === 409
        ? `Conflict: ${messageFor(error, 'This profile changed elsewhere. Reload the latest revision before saving again.')}`
        : messageFor(error, 'No changes were saved. Check the connection and try again.')),
    });
  };

  const saveRecipe = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile || !draft || !editingKey) return;
    const current = getManagerData(profile);
    if (editingKey.startsWith('manual:')) {
      const id = editingKey.slice('manual:'.length);
      commit({ ...current, manualRecipes: current.manualRecipes.map((item) => item.id === id ? { ...item, recipeData: draft } : item) }, 'Manual recipe saved.');
    } else {
      commit({ ...current, recipeOverrides: { ...current.recipeOverrides, [editingKey]: draft } }, 'Manager override saved. Workbook source data remains preserved.');
    }
  };

  const addManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile || !manualDraft) return;
    const cleaned = { ...manualDraft, brand: manualDraft.brand.trim(), flavor: manualDraft.flavor.trim(), name: manualDraft.name.trim() };
    if (!cleaned.brand || !cleaned.flavor || !cleaned.name) return;
    const managerData = getManagerData(profile);
    commit({ ...managerData, manualRecipes: [...managerData.manualRecipes, cleaned] }, 'Manual recipe added to this profile.');
  };

  const removeManual = (recipeId: string) => {
    if (!profile) return;
    const managerData = getManagerData(profile);
    commit({ ...managerData, manualRecipes: managerData.manualRecipes.filter((item) => item.id !== recipeId) }, 'Manual recipe removed.');
  };
  const removeOverride = (sourceKey: string) => {
    if (!profile) return;
    const managerData = getManagerData(profile);
    const next = { ...managerData.recipeOverrides };
    delete next[sourceKey];
    commit({ ...managerData, recipeOverrides: next }, 'Override removed. Imported workbook formula is shown again.');
  };

  if (context.isLoading) return <main className="workspace"><div className="eyebrow">Manager workspace</div><h1>Checking facility access</h1><div className="skeleton" /></main>;
  if (context.isError && !context.data) return <main className="workspace"><div className="error-banner" role="alert">{messageFor(context.error, 'Facility access could not be checked.')}</div></main>;
  if (!canManage) return <main className="workspace">
    <section className="panel empty-state manager-no-access" role="status" data-testid="status-manager-no-access">
      <div className="empty-mark"><ShieldCheck size={21} /></div><div className="eyebrow">Facility permissions</div>
      <h1>Manager access required</h1>
      <p>This workspace is available to facility owners and managers. Your operator access remains unchanged.</p>
      <Link href="/" className="button button-secondary" data-testid="link-manager-access-home">Return to overview</Link>
    </section>
  </main>;

  return <main className="workspace manager-workspace">
    <header className="manager-heading">
      <div>
        <div className="eyebrow">Production setup · Manager workspace</div>
        <h1>Recipes that are ready for the floor.</h1>
        <p className="page-subtitle">Review source formulas, record manager-owned corrections, and set defaults for future run planning.</p>
      </div>
      <Link href="/imports#nl-title" className="button button-secondary" data-testid="link-manager-name-tools"><FileSpreadsheet size={16} /> Manage names</Link>
    </header>
    <div className="manager-integrity-note" role="note">
      <ShieldCheck size={18} aria-hidden="true" />
      <span><strong>Run records stay as captured.</strong> Recipe changes and saved defaults apply to future runs only. Imported workbook source data is never rewritten.</span>
    </div>

    {feedback && <div className={feedback.startsWith('Conflict') || saveMutation.isError ? 'error-banner manager-feedback' : 'notice manager-feedback'} role="status" data-testid="status-manager-feedback">
      {feedback.startsWith('Conflict') && <CircleAlert size={16} aria-hidden="true" />}{feedback}
      {feedback.startsWith('Conflict') && <button className="button button-secondary" type="button" onClick={() => void profileQuery.refetch()} data-testid="button-manager-reload">Reload profiles</button>}
    </div>}

    <section className="manager-profile-bar panel" aria-label="Profile selection">
      <div className="manager-profile-intro"><span className="manager-icon"><BookOpen size={18} /></span><div><span className="eyebrow">Facility library</span><strong>Choose a product profile</strong></div></div>
      {profileQuery.data && profiles.length > 0 && <label className="manager-profile-select">Product profile
        <select value={profile?.id ?? ''} onChange={(event) => { setSelectedProfileId(event.target.value); setReview(null); setEditingKey(''); setDraft(null); }} data-testid="select-manager-profile">
          {profiles.map((item) => <option value={item.id} key={item.id}>{item.brand} / {item.flavor} · rev {item.revision}</option>)}
        </select>
      </label>}
    </section>
    {profileQuery.isLoading && !profileQuery.data && <div aria-label="Loading product profiles" aria-busy="true"><div className="skeleton" /><div className="skeleton" /></div>}
    {profileQuery.isError && !profileQuery.data && <section className="panel empty-state"><div className="empty-mark"><CircleAlert size={20} /></div><h2>Profiles are unavailable</h2><p>{messageFor(profileQuery.error, 'Could not load the facility product library.')}</p><button className="button button-secondary" type="button" onClick={() => void profileQuery.refetch()} data-testid="button-manager-profiles-retry"><RefreshCw size={15} /> Try again</button></section>}
    {profileQuery.data && !profiles.length && <section className="panel empty-state manager-empty"><div className="empty-mark"><FileSpreadsheet size={20} /></div><h2>No product profiles yet</h2><p>Import and approve product setup before managing recipes or reviewing run requirements.</p><Link href="/imports" className="button button-primary" data-testid="link-manager-imports">Open product profiles</Link></section>}

    {profile && <>
      <section className="manager-library" aria-labelledby="manager-recipes-heading">
        <div className="section-heading manager-section-head"><div><div className="eyebrow">Formula library</div><h2 id="manager-recipes-heading">Recipes for {profile.brand} / {profile.flavor}</h2><p className="field-help">Imported formulas remain source references. Changes below save as manager-only overrides.</p></div>
          <button className="button button-primary" type="button" onClick={() => { setManualDraft({ id: makeId(), category: 'cheese', brand: profile.brand, flavor: profile.flavor, name: '', recipeData: freshDefinition() }); setManualOpen(true); }} data-testid="button-manager-add-recipe"><Plus size={16} /> Add manual recipe</button>
        </div>
        <div className="manager-toolbar">
          <div className="manager-category-tabs" role="group" aria-label="Filter recipes by category">
            {categories.map((item) => <button key={item} type="button" aria-pressed={category === item} onClick={() => setCategory(item)} data-testid={`button-manager-category-${item}`}>{item === 'all' ? 'All recipes' : categoryTitle[item]}</button>)}
          </div>
          <label className="manager-search">Search recipes<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Recipe, category, source" data-testid="input-manager-search" /></label>
        </div>
        {!recipes.length ? <div className="panel manager-empty-list"><BookOpen size={22} /><strong>No matching recipes</strong><p>There are no imported or manual recipes in this view yet.</p></div> :
          <div className="manager-recipe-list">
            {recipes.map((recipe) => {
              const active = editingKey === recipe.key;
              const manualId = recipe.key.startsWith('manual:') ? recipe.key.slice(7) : '';
              return <article className="panel manager-recipe" key={recipe.key} data-testid={`card-manager-recipe-${recipe.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}>
                <div className="manager-recipe-top">
                  <div className="manager-recipe-category">{recipe.category}<span>{recipe.imported ? 'Imported source' : 'Manager-owned'}</span></div>
                  <div className="manager-recipe-title"><h3>{recipe.name}</h3><p>{recipe.source}</p></div>
                  {recipe.overridden && <span className="manager-override-badge"><Check size={13} /> Manager override</span>}
                </div>
                {active && draft ? <RecipeEditor definition={draft} onChange={setDraft} onSubmit={saveRecipe} onCancel={() => { setEditingKey(''); setDraft(null); }} pending={saveMutation.isPending} testId={recipe.key.replace(/[^a-zA-Z0-9_-]/g, '-')} /> :
                  <RecipeReadout definition={recipe.definition} />}
                {!active && <div className="manager-recipe-actions">
                  <button className="button button-secondary" type="button" onClick={() => { setEditingKey(recipe.key); setDraft(structuredClone(recipe.definition)); setFeedback(''); }} data-testid={`button-manager-edit-${recipe.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}>Edit formula</button>
                  {recipe.imported && recipe.overridden && <button className="button button-quiet" type="button" onClick={() => setConfirmDelete(recipe.key)} data-testid={`button-manager-remove-override-${recipe.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}>Restore source formula</button>}
                  {!recipe.imported && <button className="button button-quiet manager-delete-button" type="button" onClick={() => setConfirmDelete(manualId)} data-testid={`button-manager-delete-${manualId}`}><Trash2 size={14} /> Remove recipe</button>}
                </div>}
                {confirmDelete && (confirmDelete === recipe.key || confirmDelete === manualId) && <div className="manager-confirm" role="group" aria-label="Confirm recipe change">
                  <strong>{recipe.imported ? 'Remove this manager override?' : 'Remove this manual recipe?'}</strong>
                  <p>{recipe.imported ? 'The preserved imported formula will be shown again. The source data is not changed.' : 'This recipe will be removed from manager data for future run planning. Existing runs are unchanged.'}</p>
                  <button className="button button-warn" type="button" disabled={saveMutation.isPending} onClick={() => recipe.imported ? removeOverride(recipe.key) : removeManual(manualId)} data-testid="button-manager-confirm-remove">Confirm change</button>
                  <button className="button button-secondary" type="button" onClick={() => setConfirmDelete('')} data-testid="button-manager-cancel-remove">Cancel</button>
                </div>}
              </article>;
            })}
          </div>}
      </section>

      {manualOpen && manualDraft && <Dialog open={manualOpen} onOpenChange={(open) => {
        setManualOpen(open);
        if (!open) setManualDraft(null);
      }}>
        <DialogContent className="manager-modal-dialog">
          <section className="manager-modal panel">
          <header><div><div className="eyebrow">Manager-owned formula</div><DialogTitle id="manager-manual-title">Add a manual recipe</DialogTitle><DialogDescription className="sr-only">This recipe is saved to the selected product profile for future run planning.</DialogDescription></div><button type="button" className="button button-quiet" onClick={() => { setManualOpen(false); setManualDraft(null); }} data-testid="button-manager-close-manual">Cancel</button></header>
          <div>
            <div className="manager-manual-fields">
              <label>Category<select value={manualDraft.category} onChange={(event) => setManualDraft({ ...manualDraft, category: event.target.value as ManagerManualRecipe['category'] })} data-testid="select-manager-manual-category">{(['cheese', 'mix', 'dough', 'sauce'] as const).map((item) => <option key={item} value={item}>{categoryTitle[item]}</option>)}</select></label>
              <label>Recipe name<input required maxLength={200} value={manualDraft.name} onChange={(event) => setManualDraft({ ...manualDraft, name: event.target.value })} data-testid="input-manager-manual-name" /></label>
              <label>Brand<input required maxLength={120} value={manualDraft.brand} onChange={(event) => setManualDraft({ ...manualDraft, brand: event.target.value })} data-testid="input-manager-manual-brand" /></label>
              <label>Flavor<input required maxLength={120} value={manualDraft.flavor} onChange={(event) => setManualDraft({ ...manualDraft, flavor: event.target.value })} data-testid="input-manager-manual-flavor" /></label>
            </div>
            <RecipeEditor definition={manualDraft.recipeData} onChange={(recipeData) => setManualDraft({ ...manualDraft, recipeData })} onSubmit={addManual} onCancel={() => { setManualOpen(false); setManualDraft(null); }} pending={saveMutation.isPending} testId="manual" compact />
          </div>
          </section>
        </DialogContent>
      </Dialog>}

      <section className="manager-defaults" aria-labelledby="manager-defaults-heading">
        <div className="manager-defaults-intro"><span className="eyebrow">Future run setup</span><h2 id="manager-defaults-heading">Review before setting defaults.</h2>
          <p>Lucia will preview the real requirements for this profile. Adjust the options, inspect the calculated plan, then save only after the review is current.</p>
          <label className="manager-case-input">Preview target cases<input type="number" min={1} max={1000000} step={1} value={targetCases} onChange={(event) => { setTargetCases(Math.max(1, Number(event.target.value) || 1)); setReview(null); }} data-testid="input-manager-target-cases" /></label>
          {getManagerData(profile).setupDefaults && <p className="manager-saved-default"><Check size={15} /> Defaults saved for future runs. Existing run snapshots are unchanged.</p>}
        </div>
        <div className="panel manager-review-panel">
          <RunRequirementsEditor key={`${profile.id}:${profile.revision}:${targetCases}`} profileId={profile.id} targetCases={targetCases} online={typeof navigator === 'undefined' || navigator.onLine} heading="Review actual run requirements" description="This is the live requirements preview from the run-planning API, not a sample. Review every unresolved line before saving defaults." onReviewChange={(nextReview) => setReview(nextReview)} previewLabel="Manager defaults review · future runs only" />
          <div className="manager-save-defaults">
            <div><strong>{review ? 'Review is current' : 'Review required before saving'}</strong><span>{review ? 'The reviewed options will be used as defaults for future runs only.' : 'Make a selection above and wait for the actual preview to become current.'}</span></div>
            <button type="button" className="button button-primary" disabled={!review || saveMutation.isPending} onClick={() => {
              if (!review) return;
              const data = getManagerData(profile);
              commit({ ...data, setupDefaults: review.options }, 'Reviewed options saved as defaults for future runs.');
            }} data-testid="button-manager-save-defaults">{saveMutation.isPending ? 'Saving…' : <><ClipboardCheck size={16} /> Save reviewed defaults</>}</button>
          </div>
        </div>
      </section>
    </>}
  </main>;
}

function RecipeReadout({ definition }: { definition: ManagerRecipeDefinition }) {
  return <div className="manager-recipe-readout">
    <div className="manager-variant-strip">{definition.batchVariants.map((variant) => <span key={variant.column}>{variant.label}: {variant.yield ?? 'Yield not supplied'} {variant.unit ?? ''}</span>)}</div>
    {definition.ingredients.length > 0 && <ul>{definition.ingredients.map((ingredient) => <li key={ingredient.id}><strong>{ingredient.name}</strong><span>{ingredient.amounts.map((amount) => `Column ${amount.column}: ${amount.amount ?? 'not supplied'} ${amount.unit ?? ''}`).join(' · ') || 'No amount recorded'}</span></li>)}</ul>}
    {definition.steps.length > 0 && <ol>{definition.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>}
    {definition.notes.length > 0 && <p className="field-help">Notes: {definition.notes.join(' · ')}</p>}
  </div>;
}

function RecipeEditor({ definition, onChange, onSubmit, onCancel, pending, testId, compact = false }: {
  definition: ManagerRecipeDefinition;
  onChange: (definition: ManagerRecipeDefinition) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  pending: boolean;
  testId: string;
  compact?: boolean;
}) {
  const [validation, setValidation] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (definition.batchVariants.some((variant) => !variant.label.trim()) ||
      definition.ingredients.some((ingredient) => !ingredient.name.trim())) {
      event.preventDefault();
      setValidation('Give every batch variant a label and every ingredient a name before saving.');
      return;
    }
    if (definition.batchVariants.length > 20 || definition.ingredients.length > 300 ||
      definition.steps.length > 200 || definition.notes.length > 200 ||
      definition.batchVariants.some((variant) => variant.label.length > 120 || (variant.unit?.length ?? 0) > 20 || (variant.yield ?? 0) > 1_000_000_000) ||
      definition.ingredients.some((ingredient) => ingredient.name.length > 200 ||
        ingredient.amounts.some((amount) => (amount.unit?.length ?? 0) > 20 || (amount.amount ?? 0) > 1_000_000_000)) ||
      [...definition.steps, ...definition.notes].some((line) => line.length > 1000)) {
      event.preventDefault();
      setValidation('This formula is larger than the supported recipe limits. Shorten its fields or split it into separate recipes.');
      return;
    }
    setValidation('');
    onSubmit(event);
  };
  const updateVariant = (index: number, key: 'label' | 'unit' | 'yield', value: string) => onChange({
    ...definition,
    batchVariants: definition.batchVariants.map((variant, i) => i !== index ? variant : {
      ...variant,
      [key]: key === 'yield' ? (value === '' ? null : Number(value)) : value === '' ? null : value,
    }),
  });
  return <form className={`manager-recipe-editor${compact ? ' is-compact' : ''}`} onSubmit={submit} data-testid={`form-manager-recipe-${testId}`}>
    <fieldset><legend>Batch variants</legend>
      {definition.batchVariants.map((variant, index) => <div className="manager-edit-row manager-variant-row" key={variant.column}>
        <label>Variant label<input maxLength={120} value={variant.label} onChange={(event) => updateVariant(index, 'label', event.target.value)} data-testid={`input-manager-variant-label-${testId}-${index}`} /></label>
        <label>Yield<input type="number" min={0} max={1000000000} step="any" value={variant.yield ?? ''} onChange={(event) => updateVariant(index, 'yield', event.target.value)} data-testid={`input-manager-variant-yield-${testId}-${index}`} /></label>
        <label>Unit<input maxLength={20} value={variant.unit ?? ''} onChange={(event) => updateVariant(index, 'unit', event.target.value)} data-testid={`input-manager-variant-unit-${testId}-${index}`} /></label>
      </div>)}
      <button className="button button-quiet" type="button" disabled={definition.batchVariants.length >= 20} onClick={() => onChange({ ...definition, batchVariants: [...definition.batchVariants, { column: Math.max(0, ...definition.batchVariants.map((variant) => variant.column)) + 1, label: `Batch ${definition.batchVariants.length + 1}`, unit: null, yield: null }] })} data-testid={`button-manager-add-variant-${testId}`}><Plus size={14} /> Add variant</button>
    </fieldset>
    <fieldset><legend>Ingredients</legend>
      {definition.ingredients.map((ingredient, index) => <div className="manager-edit-ingredient" key={ingredient.id}>
        <label>Ingredient name<input maxLength={200} value={ingredient.name} onChange={(event) => onChange({ ...definition, ingredients: definition.ingredients.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} data-testid={`input-manager-ingredient-name-${testId}-${index}`} /></label>
        <button className="button button-quiet" type="button" aria-label={`Remove ${ingredient.name || 'ingredient'}`} onClick={() => onChange({ ...definition, ingredients: definition.ingredients.filter((_, i) => i !== index) })} data-testid={`button-manager-remove-ingredient-${testId}-${index}`}><Trash2 size={14} /></button>
        <div className="manager-amount-grid">{definition.batchVariants.map((variant) => {
          const current = ingredient.amounts.find((amount) => amount.column === variant.column);
          return <div key={variant.column} className="manager-amount-cell">
            <label>{variant.label} amount<input type="number" min={0} max={1000000000} step="any" value={current?.amount ?? ''} onChange={(event) => onChange({
              ...definition,
              ingredients: definition.ingredients.map((item, i) => i !== index ? item : {
                ...item,
                amounts: [...item.amounts.filter((amount) => amount.column !== variant.column), {
                  column: variant.column, amount: event.target.value === '' ? null : Number(event.target.value), unit: current?.unit ?? null,
                }],
              }),
            })} data-testid={`input-manager-amount-${testId}-${index}-${variant.column}`} /></label>
            <label>{variant.label} unit<input value={current?.unit ?? ''} maxLength={20} onChange={(event) => onChange({
              ...definition,
              ingredients: definition.ingredients.map((item, i) => i !== index ? item : {
                ...item,
                amounts: [...item.amounts.filter((amount) => amount.column !== variant.column), {
                  column: variant.column, amount: current?.amount ?? null, unit: event.target.value || null,
                }],
              }),
            })} data-testid={`input-manager-unit-${testId}-${index}-${variant.column}`} /></label>
          </div>;
        })}</div>
      </div>)}
      <button className="button button-quiet" type="button" disabled={definition.ingredients.length >= 300} onClick={() => onChange({ ...definition, ingredients: [...definition.ingredients, { id: makeId(), name: '', amounts: [] }] })} data-testid={`button-manager-add-ingredient-${testId}`}><Plus size={14} /> Add ingredient</button>
    </fieldset>
    <label className="manager-long-field">Process steps <textarea rows={4} value={definition.steps.join('\n')} onChange={(event) => onChange({ ...definition, steps: event.target.value.split('\n') })} placeholder="One process step per line" data-testid={`textarea-manager-steps-${testId}`} /></label>
    <label className="manager-long-field">Notes <textarea rows={3} value={definition.notes.join('\n')} onChange={(event) => onChange({ ...definition, notes: event.target.value.split('\n') })} placeholder="One note per line" data-testid={`textarea-manager-notes-${testId}`} /></label>
    {validation && <p className="error-banner" role="alert" data-testid={`status-manager-validation-${testId}`}>{validation}</p>}
    <div className="manager-editor-actions"><button className="button button-primary" type="submit" disabled={pending} data-testid={`button-manager-save-recipe-${testId}`}><Save size={15} />{pending ? 'Saving…' : 'Save formula'}</button><button className="button button-secondary" type="button" disabled={pending} onClick={onCancel} data-testid={`button-manager-cancel-recipe-${testId}`}>Cancel</button></div>
  </form>;
}
