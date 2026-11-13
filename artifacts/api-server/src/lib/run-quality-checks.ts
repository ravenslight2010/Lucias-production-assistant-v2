import type { RunQualityCheckTarget } from "@workspace/api-zod";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value: number) => Number(value.toFixed(6));
const OUNCES_PER_GRAM = 1 / 28.349523125;
const weightToOz: Record<string, number> = {
  oz: 1,
  lb: 16,
  g: OUNCES_PER_GRAM,
  kg: 1000 * OUNCES_PER_GRAM,
};

function unresolvedTarget(
  target: Omit<RunQualityCheckTarget, "status" | "targetOz" | "minimumOz" | "maximumOz" | "toleranceOz" | "unavailableReason">,
  reason: string,
): RunQualityCheckTarget {
  return {
    ...target,
    status: "unresolved",
    targetOz: null,
    minimumOz: null,
    maximumOz: null,
    toleranceOz: null,
    unavailableReason: reason,
  };
}

function ingredientTolerance(role: unknown, sourceName: string) {
  const label = sourceName.normalize("NFKC").trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const knownApplicator = /^(?:(?:pizza )?sauce(?: applicator)?|(?:pep|pepperoni) applicator|cheese applicator)$/.test(label);
  if (/\bapplicators?\b/.test(label) && !knownApplicator) return 0.1;
  return role === "sauce" || role === "pep_applicator" ? 0.05 : 0.1;
}

function measurementRange(value: string): [number, number] | null {
  const match = value.match(/^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?|\.\d+)\s*$/i);
  if (!match) return null;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper < lower) return null;
  return [lower, upper];
}

export function buildRunQualityTargets(productSnapshot: unknown): {
  checks: RunQualityCheckTarget[];
  unavailableReason: string | null;
} {
  if (!record(productSnapshot) || !record(productSnapshot.runRequirements)) {
    return {
      checks: [],
      unavailableReason: "This run has no saved requirements plan.",
    };
  }

  const plan = productSnapshot.runRequirements;
  if (!Array.isArray(plan.items) || plan.items.length > 200) {
    return {
      checks: [],
      unavailableReason: "The saved requirements plan is unavailable for quality checks.",
    };
  }

  const checks: RunQualityCheckTarget[] = [];
  for (const rawItem of plan.items) {
    if (!record(rawItem)) continue;
    const itemId = text(rawItem.id);
    if (!itemId) continue;
    const name = text(rawItem.name) || text(rawItem.originalName) || "Unnamed ingredient";
    const source = text(rawItem.source) || "Captured product specification";
    const check = {
      id: `ingredient:${itemId}`,
      checkType: "ingredient_weight" as const,
      label: name.slice(0, 200),
      source: source.slice(0, 500),
    };
    const unit = text(rawItem.usageUnit).toLowerCase();
    const factor = weightToOz[unit];
    const perPizza = finiteNumber(rawItem.perPizza);

    if (perPizza === null || perPizza < 0) {
      checks.push(unresolvedTarget(check, "Confirm one per-pizza target from the captured source row."));
      continue;
    }
    if (!factor) {
      checks.push(unresolvedTarget(check, "The source is not a supported weight unit for an ounce check."));
      continue;
    }

    const convertedTarget = perPizza * factor;
    if (!Number.isFinite(convertedTarget) || convertedTarget > 10000) {
      checks.push(unresolvedTarget(check, "The source target is outside the supported scale range."));
      continue;
    }
    const targetOz = round(convertedTarget);
    const toleranceOz = ingredientTolerance(rawItem.ingredientRole, text(rawItem.originalName) || name);
    checks.push({
      ...check,
      status: "ready",
      targetOz,
      minimumOz: round(Math.max(0, targetOz - toleranceOz)),
      maximumOz: round(targetOz + toleranceOz),
      toleranceOz,
      unavailableReason: null,
    });
  }

  const finishedSpec = record(plan.finishedWeightSpec) ? plan.finishedWeightSpec : null;
  const finishedRangeText = finishedSpec ? text(finishedSpec.range) : "";
  const finishedUnit = finishedSpec ? text(finishedSpec.unit).toLowerCase() : "";
  const finishedSource = finishedSpec
    ? text(finishedSpec.source) || "Captured product specification"
    : "Captured product specification";
  const finishedCheck = {
    id: "finished-pizza-weight",
    checkType: "finished_weight" as const,
    label: "Finished pizza weight",
    source: finishedSource.slice(0, 500),
  };
  const range = measurementRange(finishedRangeText);
  const factor = weightToOz[finishedUnit];
  if (!finishedSpec || !range) {
    checks.push(unresolvedTarget(
      finishedCheck,
      finishedSpec
        ? "The captured spec range is not a clear numeric weight range."
        : "No finished-weight range was captured when this run was created.",
    ));
  } else if (!factor) {
    checks.push(unresolvedTarget(finishedCheck, "The captured range does not have a confirmed weight unit."));
  } else if (range[1] * factor > 10000) {
    checks.push(unresolvedTarget(finishedCheck, "The captured range is outside the supported scale range."));
  } else {
    checks.push({
      ...finishedCheck,
      status: "ready",
      targetOz: null,
      minimumOz: round(range[0] * factor),
      maximumOz: round(range[1] * factor),
      toleranceOz: null,
      unavailableReason: null,
    });
  }

  return { checks, unavailableReason: null };
}
