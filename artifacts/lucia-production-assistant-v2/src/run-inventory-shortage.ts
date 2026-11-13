export type InventoryUsageInput = {
  id: string;
  ingredientName: string;
  unit: string;
  inventoryOnHand: number | null;
};

export type InventoryShortage = {
  ingredientName: string;
  unit: string;
  onHand: number;
  enteredUse: number;
  shortage: number;
};

const round = (value: number) => Number(value.toFixed(6));

function stockKey(ingredientName: string, unit: string) {
  return `${ingredientName.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()}\u0000${unit}`;
}

export function findInventoryShortages(
  items: InventoryUsageInput[],
  actuals: Record<string, string>,
): InventoryShortage[] {
  const grouped = new Map<string, InventoryShortage>();

  for (const item of items) {
    const raw = actuals[item.id]?.trim();
    if (!raw || item.inventoryOnHand === null || !Number.isFinite(item.inventoryOnHand)) continue;

    const actualUsed = Number(raw);
    if (!Number.isFinite(actualUsed) || actualUsed < 0 || actualUsed >= 1e12) continue;

    const key = stockKey(item.ingredientName, item.unit);
    const existing = grouped.get(key);
    const enteredUse = round((existing?.enteredUse ?? 0) + round(actualUsed));
    grouped.set(key, {
      ingredientName: existing?.ingredientName ?? item.ingredientName,
      unit: item.unit,
      onHand: existing?.onHand ?? item.inventoryOnHand,
      enteredUse,
      shortage: 0,
    });
  }

  return [...grouped.values()]
    .filter((item) => item.enteredUse > 0 && item.enteredUse > item.onHand)
    .map((item) => ({ ...item, shortage: round(item.enteredUse - item.onHand) }));
}
