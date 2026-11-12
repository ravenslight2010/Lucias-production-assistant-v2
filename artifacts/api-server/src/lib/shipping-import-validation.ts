export function normalizedShippingBrand(brand: string) {
  return brand.normalize("NFKC").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLowerCase();
}

export function shippingDataMatchesBrand(productData: Record<string, unknown>, brand: string) {
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
