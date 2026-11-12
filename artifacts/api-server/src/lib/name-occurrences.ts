import type { NameReference } from "@workspace/db";
import { HttpError } from "./http-error";

export type NameOccurrence = { reference: NameReference; profileId: string; usage: "formula" | "spec" | "ingredient" | "profile" };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ");

export function collectNameOccurrences(profiles: { id: string; brand: string; flavor: string; productData: unknown }[]): NameOccurrence[] {
  const out: NameOccurrence[] = [];
  const add = (profileId: string, kind: NameReference["kind"], brand: string, name: unknown, usage: NameOccurrence["usage"]) => {
    if (typeof name !== "string" || !clean(name)) return;
    out.push({ reference: { kind, brand: kind === "brand" ? "" : brand, name: clean(name) }, profileId, usage });
    if (out.length > 100_000) throw new HttpError(413, "This facility has too many name references for one review.");
  };
  for (const profile of profiles) {
    add(profile.id, "brand", "", profile.brand, "profile");
    add(profile.id, "flavor", profile.brand, profile.flavor, "profile");
    let inspected = 0;
    const visit = (value: unknown, brand: string, depth: number) => {
      if (!value || typeof value !== "object") return;
      if (depth > 16 || ++inspected > 10_000) throw new HttpError(413, "This profile has too many nested sources to review names safely.");
      if (Array.isArray(value)) { value.forEach(v => visit(v, brand, depth + 1)); return; }
      if (!record(value)) return;
      const scope = typeof value.brand === "string" && value.brand ? value.brand : brand;
      if (value.format === "lucia.product-spec.v1" && Array.isArray(value.sections)) {
        for (const section of value.sections) if (record(section) && Array.isArray(section.ingredients)) {
          for (const ingredient of section.ingredients) if (record(ingredient)) {
            add(profile.id, "ingredient", brand, ingredient.name, "spec");
            // A spec reference is not proof of a batch formula or approval.
            add(profile.id, "recipe", brand, ingredient.name, "spec");
          }
        }
        return;
      }
      if (value.format === "lucia.operational-workbook.v1" && Array.isArray(value.sheets)) {
        for (const sheet of value.sheets) if (record(sheet)) {
          if (Array.isArray(sheet.recipes)) for (const recipe of sheet.recipes) if (record(recipe)) {
            add(profile.id, "recipe", brand, recipe.name, "formula");
            if (Array.isArray(recipe.ingredients)) for (const ingredient of recipe.ingredients) if (record(ingredient)) {
              add(profile.id, "ingredient", brand, ingredient.name, "ingredient");
            }
          }
          if (Array.isArray(sheet.productMappings)) for (const mapping of sheet.productMappings) if (record(mapping)) {
            add(profile.id, "recipe", brand, mapping.recipe, "spec");
          }
        }
        return;
      }
      if (typeof value.brand === "string" && value.brand) {
        add(profile.id, "brand", "", value.brand, "profile");
        if (typeof value.flavor === "string") add(profile.id, "flavor", scope, value.flavor, "profile");
      }
      for (const key of ["sources", "content", "data", "structured"]) if (key in value) visit(value[key], scope, depth + 1);
    };
    visit(profile.productData, profile.brand, 0);
  }
  return out;
}
