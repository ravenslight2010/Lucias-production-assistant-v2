import { createHash } from "node:crypto";
import type {
  FacilityStationArea,
  RunRequirementsPlan,
  RunPlanningOptions,
  RunRequirementItem,
  RunRecipeChoice,
  RunBatchColumn,
} from "@workspace/api-zod";
import type { NameRule } from "@workspace/db/schema";
import { resolveName, nameKey } from "./name-resolution";
import { HttpError } from "./http-error";

type RecordValue = Record<string, unknown>;
type Profile = { brand: string; flavor: string; revision: number; productData: unknown; nameResolution?: { revision: number; rules: NameRule[] } };
type Document = { data: RecordValue; brand: string; file: string; id: string };
type Recipe = { choice: RunRecipeChoice; raw: RecordValue; brand: string };
const record = (v: unknown): v is RecordValue => Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown) => typeof v === "string" ? v : "";
const rows = (v: unknown): RecordValue[] => {
  if (!Array.isArray(v)) return [];
  if (v.length > 500) throw new HttpError(413, "This source has too many planning rows. Split or review its source tables first.");
  if (v.some(entry => !record(entry))) throw new HttpError(400, "An imported planning table contains malformed rows. Review the source import before using it.");
  return v.filter(record);
};
const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
const numeric = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || !/^\d+(?:\.\d+)?$/.test(v.trim()))) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
};
const id = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const round = (n: number) => {
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new HttpError(400, "The requested quantities exceed the supported planning range. Use a smaller run.");
  return Number(n.toFixed(6));
};
export { calculateRunRequirementsProgress } from "./run-requirements-progress";
export type { RunRequirementsProgress } from "./run-requirements-progress";
const unit = (v: unknown): string | null => {
  const s = text(v).toLowerCase().trim();
  if (/\b(?:fluid|fl\.?\s*oz|quart|qt|gallon)\b/.test(s)) return null;
  if (/\b(?:lb|lbs|pound|pounds)\b/.test(s)) return "lb";
  if (/\b(?:oz|ounce|ounces)\b/.test(s)) return "oz";
  if (/^(?:kg|kgs|kilograms?)$/.test(s)) return "kg";
  if (/^(?:g|grams?)$/.test(s)) return "g";
  if (/^(?:ea|each|count|pieces?)$/.test(s)) return "each";
  return null;
};
const grams: Record<string, number> = { oz: 28.349523125, lb: 453.59237, g: 1, kg: 1000 };
function convert(amount: number, from: string, to: string): number | null {
  if (from === to) return amount;
  return grams[from] && grams[to] ? amount * grams[from] / grams[to] : null;
}
function documents(profile: Profile): Document[] {
  const result: Document[] = [];
  const seen = new Set<object>();
  let visited = 0;
  const visit = (value: unknown, brand: string, file: string, path: string, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    if (++visited > 4000 || depth > 18) throw new HttpError(413, "The product has too many nested source records for one plan.");
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, brand, file, `${path}.${index}`, depth + 1)); return; }
    if (!record(value)) return;
    const scope = text(value.brand) || brand;
    const source = text(value.sourceName) || file;
    if (value.format === "lucia.product-spec.v1" || value.format === "lucia.operational-workbook.v1") {
      result.push({ data: value, brand, file: source || "Imported source", id: path });
      return;
    }
    for (const key of ["sources", "content", "structured", "data"]) if (key in value) visit(value[key], scope, source, `${path}.${key}`, depth + 1);
  };
  visit(profile.productData, profile.brand, "", "source", 0);
  return result;
}
function issueMessages(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.issues)) return [];
  return value.issues.flatMap(v => typeof v === "string" ? [v] : record(v) && text(v.message) ? [text(v.message)] : []);
}
function columns(recipe: RecordValue): RunBatchColumn[] {
  const totals = record(recipe.total) ? rows(recipe.total.amounts) : [];
  const dough = record(recipe.dough) ? recipe.dough : null;
  if (dough && rows(dough.batches).length) return rows(dough.batches).map(b => ({
    column: Number(b.column), label: text(b.label), unit: unit(b.unit), yield: numeric(b.total),
  })).filter(b => Number.isInteger(b.column) && b.column > 0);
  const amounts = totals.length ? totals : rows(recipe.ingredients).flatMap(i => rows(i.amounts));
  const unique = new Map<number, RunBatchColumn>();
  for (const a of amounts) {
    const column = Number(a.column);
    if (!Number.isInteger(column) || column < 1) continue;
    unique.set(column, { column, label: text(a.label), unit: unit(a.label), yield: totals.includes(a) ? numeric(a.value) : null });
  }
  return [...unique.values()];
}

/** Pure, source-based calculations: reference acknowledgements never authorize a conflicting formula. */
export function buildRunRequirements(profile: Profile, targetCases: number, options: RunPlanningOptions = {}): RunRequirementsPlan {
  if (!Number.isSafeInteger(targetCases) || targetCases < 1 || targetCases > 1e6) throw new HttpError(400, "Planning supports between 1 and 1,000,000 target cases.");
  const rules = profile.nameResolution?.rules ?? [];
  const resolvedNames = new Map<string, ReturnType<typeof resolveName>>();
  const canonical = (kind: "recipe" | "ingredient", brand: string, name: string) => {
    const key = JSON.stringify([kind, brand, name]);
    const existing = resolvedNames.get(key);
    if (existing) return existing;
    const value = resolveName({ kind, brand, name }, rules);
    resolvedNames.set(key, value);
    return value;
  };
  const docs = documents(profile);
  const sections: { id: string; label: string; source: string; notes: string[]; raw: RecordValue; brand: string }[] = [];
  const recipes = new Map<string, Recipe>();
  const shipping: { count: number | null; pallet: number | null; source: string }[] = [];
  const preparation: string[] = [];
  const globalIssues: string[] = [];
  for (const doc of docs) {
    if (doc.data.format === "lucia.product-spec.v1") {
      for (const section of rows(doc.data.sections)) {
        const key = `s_${id([doc.brand, section])}`;
        if (sections.some(s => s.id === key)) continue;
        sections.push({ id: key, label: `${text(section.sheet)} · row ${section.headerRow ?? "?"}`, source: doc.file,
          notes: [...strings(section.notes), ...strings(section.warnings)], raw: section, brand: doc.brand });
      }
      continue;
    }
    for (const sheet of rows(doc.data.sheets)) {
      const selection = record(doc.data.shippingSelection) ? doc.data.shippingSelection : null;
      if (selection?.reviewed === true) for (const r of rows(sheet.shippingRecords)) {
        const detail = record(r.shipping) ? r.shipping : null;
        if (detail && detail.key === selection.key) shipping.push({ count: numeric(detail.pizzasPerCase), pallet: numeric(detail.casesPerPallet),
          source: `${doc.file} · ${text(sheet.name)} row ${r.sourceRow ?? "?"} · ${text(r.brand)}` });
      }
      for (const raw of rows(sheet.recipes)) {
        const premix = record(raw.premix) ? raw.premix : null;
        for (const pull of premix ? rows(premix.pullInstructions) : []) {
          preparation.push(`${doc.file} · ${text(sheet.name)} · ${text(raw.name)} · row ${pull.sourceRow ?? "?"}: ${text(pull.text)}${numeric(pull.daysEarly) !== null ? ` (${pull.daysEarly} days early)` : ""}`);
        }
        if (premix?.section === "preparation") continue;
        const cheese = record(raw.cheese) ? raw.cheese : null;
        const cheeseSelection = record(doc.data.cheeseSelection) ? doc.data.cheeseSelection : null;
        if (cheese && cheeseSelection && !strings(cheeseSelection.keys).includes(text(cheese.key))) continue;
        const resolved = canonical("recipe", doc.brand, text(raw.name));
        const key = `r_${id([doc.data.importKind, resolved.brand, resolved.name, raw])}`;
        if (recipes.has(key)) continue;
        const issues = [raw.dough, raw.cheese, raw.sauce, raw.premix].flatMap(issueMessages);
        const source = record(raw.source) ? raw.source : {};
        recipes.set(key, { raw, brand: doc.brand, choice: {
          id: key, name: resolved.name, brand: resolved.brand, kind: text(doc.data.importKind),
          source: `${doc.file} · ${text(source.sheet) || text(sheet.name)} row ${source.startRow ?? "?"}`,
          columns: columns(raw), issues,
        } });
      }
    }
  }
  if (sections.length > 200 || recipes.size > 200 || preparation.length > 500) throw new HttpError(413, "Too many source alternatives for one run. Review this product's attached sources first.");
  const selected = options.sectionId ? sections.find(s => s.id === options.sectionId) : sections.length === 1 ? sections[0] : undefined;
  if (options.sectionId && !selected) throw new HttpError(409, "The selected specification section is no longer available. Refresh and review the product.");
  if (!selected) globalIssues.push(sections.length ? "Choose the specification section for this run. Different source versions or merged flavors must not have their per-pizza amounts combined." : "No structured product specifications are attached. Import the product's spec sheet first.");
  const shippingCounts = [...new Set(shipping.map(s => s.count).filter((n): n is number => n !== null && Number.isSafeInteger(n) && n > 0 && n <= 1000))];
  const suppliedPack = options.unitsPerCase;
  if (suppliedPack !== undefined && (!Number.isInteger(suppliedPack) || suppliedPack < 1 || suppliedPack > 1000)) throw new HttpError(400, "Enter a whole pizzas-per-case count between 1 and 1,000.");
  const unitsPerCase = suppliedPack ?? (shippingCounts.length === 1 && shipping.every(s => s.count === shippingCounts[0]) ? shippingCounts[0] : null);
  if (!unitsPerCase) globalIssues.push("Pizzas per case is missing or conflicting. Confirm the case pack explicitly; no default has been invented.");
  const totalPizzas = unitsPerCase ? targetCases * unitsPerCase : null;
  if (totalPizzas !== null && !Number.isSafeInteger(totalPizzas)) throw new HttpError(400, "The total pizza count is outside the supported range.");
  const links = options.links ?? [];
  if (links.length > 200 || new Set(links.map(l => l.itemId)).size !== links.length) throw new HttpError(400, "Recipe choices must identify each requirement only once.");
  let calculatedRows = 0;
  const items: RunRequirementItem[] = selected ? rows(selected.raw.ingredients).map((raw, index) => {
    const itemId = `${selected.id}:${index}`;
    const link = links.find(l => l.itemId === itemId);
    const originalName = text(raw.name);
    const ref = canonical("recipe", selected.brand, originalName);
    const exact = [...recipes.values()].filter(r => nameKey({ kind: "recipe", brand: r.choice.brand, name: r.choice.name }) === nameKey(ref));
    if (link?.directIngredient && link.recipeId) throw new HttpError(400, "Choose either a recipe or a direct ingredient, not both.");
    const recipe = link?.recipeId ? recipes.get(link.recipeId) : link?.directIngredient || link?.recipeId === null ? undefined : exact.length === 1 ? exact[0] : undefined;
    if (link?.recipeId && !recipe) throw new HttpError(409, "The selected batch formula is no longer attached to this product. Refresh and review it.");
    const displayName = recipe || ref.name !== originalName ? ref.name : canonical("ingredient", selected.brand, originalName).name;
    const amounts = rows(raw.amounts).map(a => ({ column: String(a.column), value: String(a.value ?? "") }));
    const amount = link?.amountColumn ? amounts.find(a => a.column === link.amountColumn) : amounts.length === 1 ? amounts[0] : undefined;
    if (link?.amountColumn && !amount) throw new HttpError(409, "The selected per-pizza source column is no longer available.");
    const usageUnit = link?.usageUnit ?? unit(selected.raw.unit);
    if (usageUnit && !["oz", "lb", "g", "kg", "each"].includes(usageUnit)) throw new HttpError(400, "Unsupported per-pizza unit.");
    const perPizza = amount ? numeric(amount.value) : null;
    const issues: string[] = [...strings(selected.raw.warnings)];
    if (!amount) issues.push("Select the per-pizza source column; parallel amounts are not added together.");
    if (perPizza === null) issues.push("The per-pizza amount is missing, annotated, or not an unambiguous nonnegative number.");
    if (!usageUnit) issues.push("Confirm the per-pizza unit.");
    if (!recipe && !link?.directIngredient) issues.push(exact.length > 1 ? "More than one source formula has this recipe name. Select the correct formula explicitly." : "No batch formula is linked. Select a recipe or explicitly confirm this is a direct ingredient.");
    const totalRequired = totalPizzas !== null && perPizza !== null && usageUnit ? round(totalPizzas * perPizza) : null;
    const rawDough = recipe && record(recipe.raw.dough) ? recipe.raw.dough : null;
    const previousSelection = rawDough && record(rawDough.selection) ? rawDough.selection : null;
    const batchColumn = link?.batchColumn ?? (recipe?.choice.columns.length === 1 ? recipe.choice.columns[0].column : numeric(previousSelection?.batchColumn));
    const batch = recipe?.choice.columns.find(c => c.column === batchColumn);
    if (recipe && link?.batchColumn !== undefined && !batch) throw new HttpError(409, "The chosen batch column is no longer available.");
    const resolvedAlternatives = batch && rawDough && Array.isArray(rawDough.issues)
      ? rawDough.issues.filter(record).filter(i => i.code === "multiple_batches").map(i => text(i.message)) : [];
    if (recipe) issues.push(...recipe.choice.issues.filter(message => !resolvedAlternatives.includes(message)));
    if (recipe && !batch) issues.push("Choose one batch formula column. Alternative batch sizes must not be combined.");
    if (recipe && batch && (!batch.unit || batch.yield === null || batch.yield <= 0)) issues.push("The selected batch needs an explicit positive yield and a supported weight/count unit.");
    const batchDemand = totalRequired !== null && usageUnit && batch?.unit ? convert(totalRequired, usageUnit, batch.unit) : null;
    if (recipe && totalRequired !== null && batch?.unit && batchDemand === null) issues.push("Per-pizza usage and batch yield use incompatible units. No mass/volume or count/weight conversion was assumed.");
    const formula = recipe && batch?.unit ? rows(recipe.raw.ingredients).map(ingredient => {
      const sourceAmount = rows(ingredient.amounts).find(a => a.column === batch.column);
      const value = sourceAmount ? numeric(sourceAmount.value) : null;
      // Dough columns can be labelled "2 Bag" instead of repeating "LBS".
      // Use the explicitly parsed unit of that same named source column,
      // never a default unit or a mass/volume assumption.
      const from = sourceAmount ? unit(sourceAmount.label) ?? (
        rawDough && text(sourceAmount.label).trim().toLowerCase() === batch.label.trim().toLowerCase() ? batch.unit : null
      ) : null;
      const converted = value !== null && from ? convert(value, from, batch.unit!) : null;
      return { name: canonical("ingredient", recipe.brand, text(ingredient.name)).name, value: converted };
    }) : [];
    calculatedRows += formula.length;
    if (calculatedRows > 10000) throw new HttpError(413, "The selected formulas have too many ingredient rows for one run.");
    if (recipe && (!formula.length || formula.some(i => i.value === null))) issues.push("One or more batch ingredients lack a numeric amount in the chosen column or have incompatible units. The formula cannot be scaled.");
    if (batch?.yield && formula.length && formula.every(i => i.value !== null)) {
      const sum = formula.reduce((n, i) => n + (i.value ?? 0), 0);
      if (Math.abs(sum - batch.yield) > Math.max(0.01, batch.yield * 0.000001)) issues.push(`Batch ingredient sum ${round(sum)} ${batch.unit} differs from the listed yield ${batch.yield} ${batch.unit}. Reference review is not approval to correct it.`);
    }
    const exactBatches = recipe && batch?.yield && batchDemand !== null && !issues.length && totalPizzas !== null ? batchDemand / batch.yield : null;
    const whole = exactBatches !== null ? Math.ceil(exactBatches) : null;
    if (whole !== null && (!Number.isSafeInteger(whole) || whole > 1e9)) throw new HttpError(400, "The requested batch count is outside the supported planning range.");
    return {
      id: itemId, name: recipe?.choice.name ?? displayName, originalName,
      source: `${selected.source} · ${text(selected.raw.sheet)} row ${raw.sourceRow ?? "?"}`,
      ingredientRole: raw.ingredientRole === "sauce" || raw.ingredientRole === "pep_applicator" ||
        raw.ingredientRole === "cheese_applicator" ? raw.ingredientRole : "ingredient",
      sourceCoordinates: {
        sheet: text(record(raw.sourceCoordinates) ? raw.sourceCoordinates.sheet : null) || text(selected.raw.sheet),
        row: numeric(record(raw.sourceCoordinates) ? raw.sourceCoordinates.row : raw.sourceRow),
        nameColumn: text(record(raw.sourceCoordinates) ? raw.sourceCoordinates.nameColumn : null) || null,
      },
      station: recipe?.choice.kind === "dough_guide" || recipe?.choice.kind === "sauce_guide" ? "Dough & sauce preparation" : "Production line",
      stationArea: recipe?.choice.kind === "dough_guide" || recipe?.choice.kind === "sauce_guide" ? "dough_sauce_prep" : "production_line",
      amountChoices: amounts, amountColumn: amount?.column ?? null, usageUnit, perPizza, totalRequired,
      recipeId: recipe?.choice.id ?? null, recipeSource: recipe?.choice.source ?? null,
      directIngredient: link?.directIngredient === true,
      batchColumn: batch?.column ?? null, batchUnit: batch?.unit ?? null, batchYield: batch?.yield ?? null,
      batchesExact: exactBatches !== null ? round(exactBatches) : null, wholeBatches: whole,
      remainder: whole !== null && batch?.yield && batchDemand !== null ? round(whole * batch.yield - batchDemand) : null,
      ingredients: exactBatches !== null && whole !== null && batch?.unit ? formula.map(i => ({
        name: i.name, unit: batch.unit!, perBatch: i.value!, exactRequired: round(i.value! * exactBatches), wholeBatchRequired: round(i.value! * whole),
      })) : [],
      instructions: recipe ? [...rows(recipe.raw.steps).map(s => text(s.text)), ...strings(recipe.raw.notes)] : [],
      issues: [...new Set(issues)],
    };
  }) : [];
  if (items.length > 200) throw new HttpError(413, "Too many per-pizza ingredient requirements for one plan.");
  if (links.some(l => !items.some(i => i.id === l.itemId))) throw new HttpError(409, "A recipe choice belongs to a different specification section. Review the selected section.");
  if (selected && !items.length) globalIssues.push("This specification section has no structured ingredient rows.");
  // Consolidate usage only for the exact same selected source formula/column,
  // never for a similar display name, a sub-mix, or a different batch size.
  const batchPreparation: RunRequirementItem[] = [];
  const groups = new Map<string, RunRequirementItem[]>();
  for (const item of items) if (item.recipeId) {
    const key = `${item.recipeId}:${item.batchColumn}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const [key, members] of groups) {
    if (members.some(i => i.issues.length || i.batchesExact === null)) {
      for (const item of members) if (!item.issues.length) item.issues.push("Another use of this same formula is unresolved. Combined batch preparation is withheld.");
      continue;
    }
    const first = members[0];
    const demand = members.reduce((sum, item) => sum + convert(item.perPizza! * totalPizzas!, item.usageUnit!, first.batchUnit!)!, 0);
    const fraction = demand / first.batchYield!;
    const whole = Math.ceil(fraction);
    if (!Number.isSafeInteger(whole) || whole > 1e9) throw new HttpError(400, "The combined batch count is outside the supported planning range.");
    batchPreparation.push({ ...first, id: `batch:${key}`,
      source: members.map(i => `${i.originalName}: ${i.source}`).join("; "),
      originalName: members.map(i => i.originalName).join(" + "),
      amountChoices: [], amountColumn: null, perPizza: null, usageUnit: first.batchUnit, totalRequired: round(demand),
      batchesExact: round(fraction), wholeBatches: whole, remainder: round(whole * first.batchYield! - demand),
      ingredients: first.ingredients.map(i => ({ ...i, exactRequired: round(i.perBatch * fraction), wholeBatchRequired: round(i.perBatch * whole) })),
    });
  }
  const packaging: string[] = [];
  if (shipping.length === 1) {
    packaging.push(`Packaging source: ${shipping[0].source}`);
    const perPallet = shipping[0].pallet;
    if (perPallet && Number.isInteger(perPallet) && perPallet > 0) packaging.push(`${perPallet} cases per pallet: ${Math.floor(targetCases / perPallet)} full pallets and ${targetCases % perPallet} remaining cases.`);
    else packaging.push("Cases per pallet is unconfirmed; no pallet count calculated.");
  } else packaging.push(shipping.length ? "Multiple packaging variants are attached. Review their source rows before palletizing; no variant was silently selected." : "No reviewed packaging variant is attached. Confirm packaging instructions separately.");
  return {
    version: 1, productLabel: `${profile.brand} / ${profile.flavor}`, profileRevision: profile.revision, nameRevision: profile.nameResolution?.revision ?? 0, targetCases,
    unitsPerCase, casePackSource: suppliedPack ? "Explicit run case-pack choice" : unitsPerCase ? shipping.map(s => s.source).join("; ") : "Unconfirmed",
    totalPizzas, options, status: globalIssues.length || items.some(i => i.issues.length) ? "needs_review" : "ready",
    finishedWeightSpec: selected ? {
      range: text(selected.raw.weightSpecRange) || null,
      unit: text(selected.raw.unit).toLowerCase() || (/^oz$/i.test(text(selected.raw.sheet)) ? "oz" : null),
      source: `${selected.source} · ${text(selected.raw.sheet)} row ${selected.raw.headerRow ?? "?"}`,
    } : null,
    sections: sections.map(({ raw: _raw, brand: _brand, ...s }) => s), sectionId: selected?.id ?? null,
    recipes: [...recipes.values()].map(r => r.choice), items, batchPreparation,
    preparation: [...new Set(preparation)], packaging, issues: globalIssues,
  };
}
