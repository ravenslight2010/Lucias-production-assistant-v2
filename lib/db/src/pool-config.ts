export function createPoolWithValidatedMax<T>(
  rawPoolMax: string | undefined,
  createPool: (poolMax: number) => T,
): { pool: T; poolMax: number } {
  const poolMax = Number(rawPoolMax ?? "4");

  if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 20) {
    throw new Error("DB_POOL_MAX must be an integer between 1 and 20.");
  }

  return { pool: createPool(poolMax), poolMax };
}
