import { useMemo } from "react";
import { isUnconfirmedApplicator, parsePreservedProductSpec, productSpecIngredientRole } from "../importing/product-spec";
import type { ProductSpecData, ProductSpecSectionData } from "../importing/product-spec";
import type { NameResolution } from "@workspace/api-client-react";
import { ResolvedName } from "./resolved-name";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isProductSpecSection(value: unknown): value is ProductSpecSectionData {
  if (!isRecord(value)) return false;
  return typeof value.sheet === "string" &&
    Number.isInteger(value.headerRow) &&
    Number.isInteger(value.endRow) &&
    Array.isArray(value.ingredients) &&
    value.ingredients.every((ingredient) =>
      isRecord(ingredient) &&
      Number.isInteger(ingredient.sourceRow) &&
      typeof ingredient.name === "string" &&
      (ingredient.roleConfirmed === undefined || typeof ingredient.roleConfirmed === "boolean") &&
      Array.isArray(ingredient.amounts) &&
      ingredient.amounts.every((amount) =>
        isRecord(amount) && typeof amount.column === "string" && typeof amount.value === "string",
      ),
    ) &&
    (value.targetWeight === null || typeof value.targetWeight === "string") &&
    (value.weightSpecRange === null || typeof value.weightSpecRange === "string") &&
    (value.unit === null || typeof value.unit === "string") &&
    isStringArray(value.notes) &&
    isStringArray(value.warnings);
}

function isProductSpecData(value: unknown): value is ProductSpecData {
  return isRecord(value) &&
    value.format === "lucia.product-spec.v1" &&
    typeof value.brand === "string" &&
    typeof value.flavor === "string" &&
    Array.isArray(value.sections) &&
    value.sections.every(isProductSpecSection) &&
    isStringArray(value.warnings);
}

function findProductSpecData(value: unknown, brand?: string): (ProductSpecData & { sourceBrand?: string })[] {
  const found: (ProductSpecData & { sourceBrand?: string })[] = [];
  const seen = new Set<object>();
  let inspected = 0;
  const visit = (current: unknown, depth: number, scope?: string) => {
    if (depth > 12 || inspected >= 500 || !current || typeof current !== "object" || seen.has(current)) return;
    inspected++;
    seen.add(current);
    if (isProductSpecData(current)) {
      found.push({ ...current, sourceBrand: scope });
      return;
    }
    if (isRecord(current) && !isProductSpecData(current.structured)) {
      const preserved = parsePreservedProductSpec(current);
      if (preserved) {
        found.push({ ...preserved, sourceBrand: scope });
        return;
      }
    }
    if (Array.isArray(current)) {
      current.slice(0, 100).forEach((entry) => visit(entry, depth + 1, scope));
      return;
    }
    if (isRecord(current)) {
      for (const key of ["structured", "content", "sources", "data"]) {
        if (key in current) visit(current[key], depth + 1, typeof current.brand === "string" ? current.brand : scope);
      }
    }
  };
  visit(value, 0, brand);
  return found;
}

function amountCount(data: ProductSpecData) {
  return data.sections.reduce(
    (sum, section) => sum + section.ingredients.length,
    0,
  );
}

function ingredientRoleLabel(role: ReturnType<typeof productSpecIngredientRole>) {
  switch (role) {
    case "sauce": return "Sauce";
    case "pep_applicator": return "Pepperoni applicator";
    case "cheese_applicator": return "Cheese applicator";
    case "ingredient": return "Ingredient";
  }
}

export function ProductSpecSummary({
  data,
  title = "Product specifications",
  defaultOpen = false,
  brand,
  flavor,
  nameResolution,
}: {
  data: unknown;
  title?: string;
  defaultOpen?: boolean;
  brand?: string;
  flavor?: string;
  nameResolution?: NameResolution;
}) {
  const productSpecs = useMemo(() => findProductSpecData(data, brand), [data, brand]);
  if (!productSpecs.length) return null;
  const sectionCount = productSpecs.reduce((sum, item) => sum + item.sections.length, 0);
  const ingredientCount = productSpecs.reduce((sum, item) => sum + amountCount(item), 0);

  return (
    <details className="product-spec-summary" open={defaultOpen || undefined}>
      <summary>
        <span>{title}</span>
        <span>{sectionCount} {sectionCount === 1 ? "section" : "sections"} · {ingredientCount} ingredient rows</span>
      </summary>
      <div className="product-spec-summary-content">
        {productSpecs.map((spec, specIndex) => (
          <section className="product-spec-source" key={`${spec.brand}:${spec.flavor}:${specIndex}`}>
            <h4>{brand || spec.brand} / {flavor || spec.flavor}</h4>
            {spec.warnings.length > 0 && (
              <div className="notice" role="status">
                Review parser notes:
                <ul className="operational-items">
                  {spec.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              </div>
            )}
            {spec.sections.map((section, sectionIndex) => (
              <article className="product-spec-section" key={`${section.sheet}:${section.headerRow}:${sectionIndex}`}>
                <div className="product-spec-section-heading">
                  <strong>{section.sheet}</strong>
                  <span>Rows {section.headerRow}–{section.endRow}</span>
                </div>
                {(section.targetWeight || section.weightSpecRange) && (
                  <dl className="product-spec-measures">
                    {section.targetWeight && <div><dt>Target weight</dt><dd>{section.targetWeight}{section.unit ? ` ${section.unit}` : ""}</dd></div>}
                    {section.weightSpecRange && <div><dt>Weight spec range</dt><dd>{section.weightSpecRange}{section.unit ? ` ${section.unit}` : ""}</dd></div>}
                  </dl>
                )}
                {section.warnings.length > 0 && (
                  <ul className="operational-items">
                    {section.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                  </ul>
                )}
                {section.ingredients.length > 0 && (
                  <div>
                    <strong className="product-spec-subheading">Formula / ingredients</strong>
                    <ul className="product-spec-ingredients">
                        {section.ingredients.map((ingredient, index) => {
                          const unconfirmed = isUnconfirmedApplicator(ingredient);
                          const roleLabel = ingredientRoleLabel(productSpecIngredientRole(ingredient));
                          return (
                            <li key={`${ingredient.sourceRow}:${index}`}>
                              <ResolvedName name={ingredient.name} kind="spec" brand={spec.sourceBrand || brand || spec.brand} rules={nameResolution?.rules} />
                              <small className="product-spec-role">
                                Role: {roleLabel}{unconfirmed ? " (unconfirmed)" : ""}
                              </small>
                              {unconfirmed && (
                                <span className="product-spec-applicator-warning" role="status">
                                  Unrecognized applicator label — verify its role before using this run plan.
                                </span>
                              )}
                              {ingredient.amounts.length > 0 && (
                                <small>{ingredient.amounts.map((amount) => `${amount.value} (${amount.column}${section.unit ? ` ${section.unit}` : ""})`).join(" · ")}</small>
                              )}
                              <small className="product-spec-row">Source row {ingredient.sourceRow}</small>
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                )}
                {section.notes.length > 0 && (
                  <div>
                    <strong className="product-spec-subheading">Notes and allergens</strong>
                    <ul className="operational-items">
                      {section.notes.map((note, index) => <li key={index}>{note}</li>)}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </section>
        ))}
      </div>
    </details>
  );
}
