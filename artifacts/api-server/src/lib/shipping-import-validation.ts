export function normalizedShippingBrand(brand: string) {
  return brand.normalize("NFKC").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLowerCase();
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));

/** A reviewed row is a variant choice, not an inferred alias for its original label. */
export function shippingSelectionIdentity(productData: Record<string, unknown>, brand: string, flavor: string): string | null {
  if (!isRecord(productData.structured)) throw new Error("Invalid shipping source.");
  const data = productData.structured;
  if (data.shippingSelection === undefined) return null;
  const selection = data.shippingSelection;
  if (!isRecord(selection) || selection.format !== "lucia.shipping-selection.v1" || selection.reviewed !== true ||
      selection.targetBrand !== brand || selection.targetFlavor !== flavor || typeof selection.key !== "string" || selection.key.length > 300 ||
      data.importKind !== "shipping" || data.filteredToBrand !== brand ||
      !Array.isArray(data.sheets) || data.sheets.length !== 1) throw new Error("Invalid shipping selection.");
  const sheet = data.sheets[0];
  if (!isRecord(sheet) || typeof sheet.name !== "string" || !sheet.name.trim() || sheet.name.length > 80 ||
      !Array.isArray(sheet.shippingRecords) || sheet.shippingRecords.length !== 1) throw new Error("Choose one shipping row.");
  const row = sheet.shippingRecords[0];
  if (!isRecord(row) || typeof row.brand !== "string" || !row.brand.trim() || row.brand.length > 300 ||
      !Number.isSafeInteger(row.sourceRow) || Number(row.sourceRow) < 1 || !isRecord(row.values) ||
      !isRecord(row.shipping) || row.shipping.format !== "lucia.shipping-details.v1" ||
      row.shipping.key !== selection.key || !Number.isSafeInteger(row.shipping.headerRow) ||
      Number(row.shipping.headerRow) < 1 || Number(row.shipping.headerRow) >= Number(row.sourceRow) ||
      !Array.isArray(row.shipping.cells) || !row.shipping.cells.length || row.shipping.cells.length > 100 ||
      !Array.isArray(row.shipping.issues) || row.shipping.issues.length > 100 ||
      !row.shipping.issues.every(i => typeof i === "string" && i.length <= 1000)) throw new Error("Invalid shipping row.");
  const coordinates = JSON.parse(selection.key);
  if (!Array.isArray(coordinates) || coordinates.length !== 2 || coordinates[0] !== sheet.name || coordinates[1] !== row.sourceRow) throw new Error("Invalid shipping coordinates.");
  const columns = new Set<number>();
  for (const cell of row.shipping.cells) {
    if (!isRecord(cell) || !Number.isSafeInteger(cell.column) || Number(cell.column) < 1 || columns.has(Number(cell.column)) ||
        typeof cell.label !== "string" || cell.label.length > 300 ||
        !["string", "number", "boolean"].includes(typeof cell.value) ||
        (typeof cell.value === "number" && !Number.isFinite(cell.value))) throw new Error("Invalid shipping cells.");
    columns.add(Number(cell.column));
  }
  for (const field of ["pizzasPerCase", "casesPerPallet", "packsPerCase", "pizzasPerPack"]) {
    if (row.shipping[field] !== undefined && (!Number.isSafeInteger(row.shipping[field]) || Number(row.shipping[field]) < 1)) throw new Error("Invalid shipping count.");
  }
  if ((row.shipping.packsPerCase === undefined) !== (row.shipping.pizzasPerPack === undefined) ||
      (row.shipping.packsPerCase !== undefined && Number(row.shipping.packsPerCase) * Number(row.shipping.pizzasPerPack) !== row.shipping.pizzasPerCase)) throw new Error("Invalid multipack count.");
  return JSON.stringify(["lucia.shipping-selection.v1", selection.key]);
}

export function shippingDataMatchesBrand(productData: Record<string, unknown>, brand: string, flavor = "") {
  if (isRecord(productData.structured) && productData.structured.shippingSelection !== undefined) {
    try { return shippingSelectionIdentity(productData, brand, flavor) !== null; } catch { return false; }
  }
  const structured = productData.structured;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return false;
  const parsed = structured as { importKind?: unknown; filteredToBrand?: unknown; sheets?: unknown };
  if (
    parsed.importKind !== "shipping" ||
    typeof parsed.filteredToBrand !== "string" ||
    normalizedShippingBrand(parsed.filteredToBrand) !== normalizedShippingBrand(brand) ||
    !Array.isArray(parsed.sheets)
  ) return false;

  let recordCount = 0;
  for (const sheet of parsed.sheets) {
    if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) return false;
    const shippingRecords = (sheet as { shippingRecords?: unknown }).shippingRecords;
    if (!Array.isArray(shippingRecords)) return false;
    for (const record of shippingRecords) {
      if (!record || typeof record !== "object" || Array.isArray(record)) return false;
      const recordBrand = (record as { brand?: unknown }).brand;
      if (typeof recordBrand !== "string" || normalizedShippingBrand(recordBrand) !== normalizedShippingBrand(brand)) {
        return false;
      }
      recordCount++;
    }
  }
  return recordCount > 0;
}
