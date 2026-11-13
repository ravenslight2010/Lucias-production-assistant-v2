import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  facilityInventoryTable,
  inventoryTransactionsTable,
  productionRunsTable,
  runInventoryReconciliationsTable,
  runStationProgressTable,
} from "@workspace/db";
import type {
  FacilityInventoryList,
  InventoryAdjustmentInput,
  RunInventoryUsage,
  RunInventoryUsageInput,
  RunRequirementsPlan,
} from "@workspace/api-zod";
import { calculateRunRequirementsProgress } from "./run-requirements";
import { HttpError } from "./http-error";

const INVENTORY_UNITS = new Set(["oz", "lb", "g", "kg", "each"]);
const round = (value: number) => Number(value.toFixed(6));
const ingredientKey = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
const requestHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function capturedRequirements(snapshot: unknown): RunRequirementsPlan | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const plan = (snapshot as Record<string, unknown>).runRequirements;
  if (plan === undefined || plan === null) return null;
  if (
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    !Array.isArray((plan as Record<string, unknown>).items) ||
    !Array.isArray((plan as Record<string, unknown>).batchPreparation) ||
    typeof (plan as Record<string, unknown>).targetCases !== "number"
  ) {
    throw new Error("The captured run requirements are malformed.");
  }
  return plan as RunRequirementsPlan;
}

async function inventoryList(
  query: Pick<typeof db, "select">,
  facilityId: string,
): Promise<FacilityInventoryList> {
  const [items, entries] = await Promise.all([
    query
      .select()
      .from(facilityInventoryTable)
      .where(eq(facilityInventoryTable.facilityId, facilityId))
      .orderBy(asc(facilityInventoryTable.ingredientName), asc(facilityInventoryTable.unit)),
    query
      .select()
      .from(inventoryTransactionsTable)
      .where(eq(inventoryTransactionsTable.facilityId, facilityId))
      .orderBy(desc(inventoryTransactionsTable.createdAt))
      .limit(500),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      ingredientName: item.ingredientName,
      unit: item.unit,
      onHand: item.onHand,
      revision: item.revision,
      updatedAt: item.updatedAt,
    })),
    entries: entries.map((entry) => ({
      id: entry.id,
      inventoryId: entry.inventoryId,
      ingredientName: entry.ingredientName,
      unit: entry.unit,
      kind: entry.kind as "run_usage" | "stock_adjustment" | "correction",
      delta: entry.delta,
      note: entry.note,
      runId: entry.runId,
      reconciliationId: entry.reconciliationId,
      correctsEntryId: entry.correctsEntryId,
      proposalId: entry.proposalId,
      requirementId: entry.requirementId,
      requirementName: entry.requirementName,
      sourceAmount: entry.sourceAmount,
      quantityBasis: entry.quantityBasis as "per_pizza" | "per_batch" | "unresolved",
      source: entry.source,
      amountColumn: entry.amountColumn,
      batchColumn: entry.batchColumn,
      proposedQuantity: entry.proposedQuantity,
      actualUsed: entry.actualUsed,
      createdAt: entry.createdAt,
    })),
  };
}

export function getFacilityInventory(facilityId: string) {
  return inventoryList(db, facilityId);
}

async function usageForRun(
  query: Pick<typeof db, "select">,
  facilityId: string,
  runId: string,
): Promise<RunInventoryUsage> {
  const [run] = await query
    .select({
      id: productionRunsTable.id,
      status: productionRunsTable.status,
      productSnapshot: productionRunsTable.productSnapshot,
    })
    .from(productionRunsTable)
    .where(
      and(
        eq(productionRunsTable.id, runId),
        eq(productionRunsTable.facilityId, facilityId),
      ),
    )
    .limit(1);
  if (!run) throw new HttpError(404, "Run not found.");

  const plan = capturedRequirements(run.productSnapshot);
  const stationRows = await query
    .select()
    .from(runStationProgressTable)
    .where(eq(runStationProgressTable.runId, runId));
  const progress = plan
    ? calculateRunRequirementsProgress(
        plan,
        stationRows.map((station) => ({
          area: station.stationArea as
            | "dough_sauce_prep"
            | "production_line"
            | "freezing_packaging"
            | "warehouse",
          completedCases: station.completedCases,
          recorded: station.countUpdatedAt !== null,
        })),
      )
    : null;
  const [reconciliation] = await query
    .select()
    .from(runInventoryReconciliationsTable)
    .where(
      and(
        eq(runInventoryReconciliationsTable.facilityId, facilityId),
        eq(runInventoryReconciliationsTable.runId, runId),
      ),
    )
    .limit(1);
  const history = reconciliation
    ? await query
        .select()
        .from(inventoryTransactionsTable)
        .where(
          and(
            eq(inventoryTransactionsTable.facilityId, facilityId),
            eq(inventoryTransactionsTable.reconciliationId, reconciliation.id),
          ),
        )
        .orderBy(asc(inventoryTransactionsTable.createdAt))
    : [];
  const allStock = await query
    .select()
    .from(facilityInventoryTable)
    .where(eq(facilityInventoryTable.facilityId, facilityId));
  const stockByKey = new Map(
    allStock.map((item) => [
      `${item.ingredientKey}\u0000${item.unit}`,
      { onHand: item.onHand, revision: item.revision },
    ]),
  );
  const historyByProposal = new Map(
    history.flatMap((entry) =>
      entry.proposalId ? [[entry.proposalId, entry] as const] : [],
    ),
  );
  const proposalRows = progress?.items.flatMap((item) => item.proposedUsage) ?? [];
  const items = proposalRows.map((proposal) => {
    const recorded = historyByProposal.get(proposal.id);
    const stock = INVENTORY_UNITS.has(proposal.unit)
      ? stockByKey.get(`${ingredientKey(proposal.ingredientName)}\u0000${proposal.unit}`)
      : undefined;
    return {
      id: proposal.id,
      requirementId: proposal.requirementId,
      requirementName: proposal.requirementName,
      ingredientName: proposal.ingredientName,
      unit: proposal.unit,
      source: proposal.source,
      sourceAmount: proposal.sourceAmount,
      quantityBasis: proposal.quantityBasis,
      amountColumn: proposal.amountColumn,
      batchColumn: proposal.batchColumn,
      proposedQuantity: proposal.proposedQuantity,
      actualUsed: recorded?.actualUsed ?? null,
      inventoryOnHand: stock?.onHand ?? null,
      inventoryRevision: stock?.revision ?? null,
      blockedReason: proposal.blockedReason,
    };
  });
  const eligibleCount = items.filter(
    (item) => item.blockedReason === null && item.proposedQuantity !== null,
  ).length;
  return {
    runId,
    runStatus: run.status,
    canConfirm: run.status === "completed" && !reconciliation && eligibleCount > 0,
    blockedCount: items.filter((item) => item.blockedReason !== null).length,
    items,
    reconciliation: reconciliation
      ? {
          id: reconciliation.id,
          createdAt: reconciliation.createdAt,
          entries: items.filter((item) => item.actualUsed !== null),
        }
      : null,
  };
}

export function getRunInventoryUsage(input: {
  facilityId: string;
  runId: string;
}) {
  return usageForRun(db, input.facilityId, input.runId);
}

export async function confirmRunInventoryUsage(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  update: RunInventoryUsageInput;
}): Promise<RunInventoryUsage> {
  const { facilityId, actorUserId, runId, update } = input;
  const normalizedItems = [...update.items]
    .map((item) => ({
      id: item.id,
      actualUsed: round(item.actualUsed),
      ...(item.expectedInventoryRevision === undefined
        ? {}
        : { expectedInventoryRevision: item.expectedInventoryRevision }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const hash = requestHash({ facilityId, actorUserId, runId, items: normalizedItems });

  await db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: productionRunsTable.id,
        status: productionRunsTable.status,
        productSnapshot: productionRunsTable.productSnapshot,
      })
      .from(productionRunsTable)
      .where(
        and(
          eq(productionRunsTable.id, runId),
          eq(productionRunsTable.facilityId, facilityId),
        ),
      )
      .for("update")
      .limit(1);
    if (!run) throw new HttpError(404, "Run not found.");
    if (run.status !== "completed") {
      throw new HttpError(409, "Ingredient usage can only be confirmed after the run is complete.");
    }

    const [existing] = await tx
      .select()
      .from(runInventoryReconciliationsTable)
      .where(
        and(
          eq(runInventoryReconciliationsTable.facilityId, facilityId),
          eq(runInventoryReconciliationsTable.runId, runId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.commandId !== update.commandId || existing.requestHash !== hash) {
        throw new HttpError(409, "This run's ingredient usage was already confirmed. Review the inventory history and record a correction if needed.");
      }
      return;
    }

    const plan = capturedRequirements(run.productSnapshot);
    if (!plan) throw new HttpError(409, "This run has no saved requirements plan to reconcile.");
    const stationRows = await tx
      .select()
      .from(runStationProgressTable)
      .where(eq(runStationProgressTable.runId, runId));
    const progress = calculateRunRequirementsProgress(
      plan,
      stationRows.map((station) => ({
        area: station.stationArea as
          | "dough_sauce_prep"
          | "production_line"
          | "freezing_packaging"
          | "warehouse",
        completedCases: station.completedCases,
        recorded: station.countUpdatedAt !== null,
      })),
    );
    const proposals = progress.items.flatMap((item) => item.proposedUsage);
    const eligible = proposals.filter(
      (item) => item.blockedReason === null && item.proposedQuantity !== null,
    );
    if (eligible.length === 0) {
      throw new HttpError(409, "No ingredient quantities have both a resolved source unit and a saved station count.");
    }
    const submitted = new Map<string, number>();
    const submittedItems = new Map(update.items.map((item) => [item.id, item]));
    for (const item of normalizedItems) {
      if (submitted.has(item.id) || !Number.isFinite(item.actualUsed) || item.actualUsed < 0) {
        throw new HttpError(400, "Enter one nonnegative actual quantity for each resolved usage row.");
      }
      submitted.set(item.id, item.actualUsed);
    }
    if (
      submitted.size !== eligible.length ||
      eligible.some((item) => !submitted.has(item.id))
    ) {
      throw new HttpError(400, "Confirm every resolved ingredient row. Unresolved rows cannot be applied.");
    }

    const [savedReconciliation] = await tx
      .insert(runInventoryReconciliationsTable)
      .values({
        facilityId,
        runId,
        commandId: update.commandId,
        requestHash: hash,
        actorUserId,
      })
      .returning();
    const stockGroups = new Map<string, {
      ingredientName: string;
      unit: string;
      expectedInventoryRevision: number | null | undefined;
      actualUsed: number;
      proposals: typeof eligible;
    }>();
    for (const proposal of eligible) {
      if (!INVENTORY_UNITS.has(proposal.unit)) {
        throw new HttpError(400, "An unresolved or unsupported unit cannot be applied to inventory.");
      }
      const key = ingredientKey(proposal.ingredientName);
      const stockKey = `${key}\u0000${proposal.unit}`;
      const inputItem = submittedItems.get(proposal.id);
      if (!inputItem) throw new HttpError(400, "Confirm every resolved ingredient row.");
      const existingGroup = stockGroups.get(stockKey);
      if (
        existingGroup &&
        existingGroup.expectedInventoryRevision !== inputItem.expectedInventoryRevision
      ) {
        throw new HttpError(400, "Repeated ingredient rows must use the same reviewed stock revision.");
      }
      if (existingGroup) {
        existingGroup.actualUsed = round(existingGroup.actualUsed + submitted.get(proposal.id)!);
        existingGroup.proposals.push(proposal);
      } else {
        stockGroups.set(stockKey, {
          ingredientName: proposal.ingredientName,
          unit: proposal.unit,
          expectedInventoryRevision: inputItem.expectedInventoryRevision,
          actualUsed: submitted.get(proposal.id)!,
          proposals: [proposal],
        });
      }
    }

    const orderedStockGroups = [...stockGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => group);
    for (const group of orderedStockGroups) {
      const key = ingredientKey(group.ingredientName);
      const [inserted] = await tx
        .insert(facilityInventoryTable)
        .values({
          facilityId,
          ingredientKey: key,
          ingredientName: group.ingredientName,
          unit: group.unit,
        })
        .onConflictDoNothing()
        .returning({ id: facilityInventoryTable.id });
      const [inventory] = await tx
        .select()
        .from(facilityInventoryTable)
        .where(
          and(
            eq(facilityInventoryTable.facilityId, facilityId),
            eq(facilityInventoryTable.ingredientKey, key),
            eq(facilityInventoryTable.unit, group.unit),
          ),
        )
        .for("update")
        .limit(1);
      if (!inventory) throw new Error("Inventory balance could not be locked.");

      if (group.expectedInventoryRevision !== undefined) {
        const expectedAbsent = group.expectedInventoryRevision === null;
        const stockChanged = expectedAbsent
          ? !inserted
          : Boolean(inserted) || inventory.revision !== group.expectedInventoryRevision;
        if (stockChanged) {
          throw new HttpError(409, "Inventory changed after you reviewed it. Refresh the run, check the updated warning, and confirm again.");
        }
      } else if (group.actualUsed > inventory.onHand) {
        // Older clients do not send a revision. Fail closed only when their
        // stale view could cause a confirmed use to push stock below zero.
        throw new HttpError(409, "Inventory may have changed. Refresh the run and review the current stock before confirming.");
      }

      const [updated] = await tx
        .update(facilityInventoryTable)
        .set({
          onHand: round(inventory.onHand - group.actualUsed),
          revision: inventory.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(facilityInventoryTable.id, inventory.id))
        .returning({ id: facilityInventoryTable.id });
      if (!updated) throw new Error("Inventory balance could not be updated.");

      for (const proposal of group.proposals) {
        const actualUsed = submitted.get(proposal.id)!;
        await tx.insert(inventoryTransactionsTable).values({
          facilityId,
          inventoryId: inventory.id,
          reconciliationId: savedReconciliation.id,
          runId,
          kind: "run_usage",
          delta: round(-actualUsed),
          note: "Operator-confirmed actual ingredient use.",
          ingredientName: proposal.ingredientName,
          unit: proposal.unit,
          source: proposal.source,
          proposalId: proposal.id,
          requirementId: proposal.requirementId,
          requirementName: proposal.requirementName,
          sourceAmount: proposal.sourceAmount,
          quantityBasis: proposal.quantityBasis,
          amountColumn: proposal.amountColumn,
          batchColumn: proposal.batchColumn,
          proposedQuantity: proposal.proposedQuantity,
          actualUsed,
          actorUserId,
        });
      }
    }
  });

  return getRunInventoryUsage({ facilityId, runId });
}

export async function adjustFacilityInventory(input: {
  facilityId: string;
  actorUserId: string;
  update: InventoryAdjustmentInput;
}): Promise<FacilityInventoryList> {
  const { facilityId, actorUserId, update } = input;
  const ingredientName = update.ingredientName.trim().replace(/\s+/g, " ");
  const note = update.note.trim();
  const delta = round(update.delta);
  if (
    !ingredientName ||
    !INVENTORY_UNITS.has(update.unit) ||
    !Number.isFinite(delta) ||
    delta === 0 ||
    Math.abs(delta) >= 1e12 ||
    note.length < 3
  ) {
    throw new HttpError(400, "Enter a supported source unit, a nonzero quantity change, and a review note.");
  }
  const key = ingredientKey(ingredientName);
  const hash = requestHash({
    facilityId,
    actorUserId,
    ingredientName,
    unit: update.unit,
    delta,
    note,
    correctsEntryId: update.correctsEntryId,
  });

  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(inventoryTransactionsTable)
      .where(
        and(
          eq(inventoryTransactionsTable.facilityId, facilityId),
          eq(inventoryTransactionsTable.commandId, update.commandId),
        ),
      )
      .limit(1);
    if (previous) {
      if (previous.requestHash !== hash) {
        throw new HttpError(409, "This retry key was already used for a different inventory adjustment.");
      }
      return;
    }

    let correctsEntryId: string | null = null;
    if (update.correctsEntryId) {
      const [corrected] = await tx
        .select({
          id: inventoryTransactionsTable.id,
          inventoryId: inventoryTransactionsTable.inventoryId,
          ingredientKey: facilityInventoryTable.ingredientKey,
          unit: facilityInventoryTable.unit,
        })
        .from(inventoryTransactionsTable)
        .innerJoin(
          facilityInventoryTable,
          eq(inventoryTransactionsTable.inventoryId, facilityInventoryTable.id),
        )
        .where(
          and(
            eq(inventoryTransactionsTable.facilityId, facilityId),
            eq(inventoryTransactionsTable.id, update.correctsEntryId),
          ),
        )
        .limit(1);
      if (!corrected) throw new HttpError(404, "The inventory entry to correct was not found.");
      if (corrected.ingredientKey !== key || corrected.unit !== update.unit) {
        throw new HttpError(400, "A correction must use the same ingredient and source unit as the entry it references.");
      }
      correctsEntryId = corrected.id;
    }

    await tx
      .insert(facilityInventoryTable)
      .values({
        facilityId,
        ingredientKey: key,
        ingredientName,
        unit: update.unit,
      })
      .onConflictDoNothing();
    const [inventory] = await tx
      .select()
      .from(facilityInventoryTable)
      .where(
        and(
          eq(facilityInventoryTable.facilityId, facilityId),
          eq(facilityInventoryTable.ingredientKey, key),
          eq(facilityInventoryTable.unit, update.unit),
        ),
      )
      .for("update")
      .limit(1);
    if (!inventory) throw new Error("Inventory balance could not be locked.");
    await tx
      .update(facilityInventoryTable)
      .set({
        onHand: round(inventory.onHand + delta),
        revision: inventory.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(facilityInventoryTable.id, inventory.id));
    await tx.insert(inventoryTransactionsTable).values({
      facilityId,
      inventoryId: inventory.id,
      kind: correctsEntryId ? "correction" : "stock_adjustment",
      delta,
      note,
      correctsEntryId,
      commandId: update.commandId,
      requestHash: hash,
      ingredientName,
      unit: update.unit,
      source: "Manual inventory adjustment.",
      sourceAmount: null,
      quantityBasis: "unresolved",
      actorUserId,
    });
  });

  return getFacilityInventory(facilityId);
}
