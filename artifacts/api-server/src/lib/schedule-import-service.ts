import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, facilityImportBatchesTable, facilityProductProfilesTable, productionRunsTable } from "@workspace/db";
import type { RunPlanningReview, RunRequirementsPlan } from "@workspace/api-zod";
import { HttpError } from "./http-error";
import { lockProfileNames } from "./profile-names";
import { loadNameResolution, resolutionForProfile } from "./name-resolution";
import { buildRunRequirements } from "./run-requirements";

export type ScheduleImportRow = {
  date: string;
  brand: string;
  flavor: string;
  productProfileId: string;
  casesPlanned: number;
  notes: string;
  source: { sheet: string; row: number };
};

export type ScheduleImportInput = {
  sourceName: string;
  sourceHash: string;
  importDate: string;
  ignoredPastCount: number;
  runs: ScheduleImportRow[];
  planningByProfile: { productProfileId: string; review: RunPlanningReview }[];
};

function stableUuid(...parts: string[]) {
  const hex = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function requestHash(input: ScheduleImportInput, rows: ScheduleImportRow[], ignoredPastCount: number) {
  return createHash("sha256")
    .update(JSON.stringify({
      sourceName: input.sourceName,
      sourceHash: input.sourceHash.toLowerCase(),
      importDate: input.importDate,
      ignoredPastCount,
      runs: rows,
      planningByProfile: [...input.planningByProfile].sort((a, b) =>
        a.productProfileId.localeCompare(b.productProfileId),
      ),
    }))
    .digest("hex");
}

function previousImportResult(
  summary: unknown,
  importId: string,
  expectedRequestHash: string,
) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new HttpError(409, "This schedule import record is incomplete and cannot be replayed.");
  }
  const record = summary as Record<string, unknown>;
  if (record.requestHash !== expectedRequestHash) {
    throw new HttpError(409, "This schedule was already imported with different profile mappings or run details.");
  }
  if (
    typeof record.importedCount !== "number" ||
    typeof record.ignoredPastCount !== "number" ||
    typeof record.needsReviewRunCount !== "number"
  ) {
    throw new HttpError(409, "This schedule import record is incomplete and cannot be replayed.");
  }
  return {
    importId,
    importedCount: record.importedCount,
    ignoredPastCount: record.ignoredPastCount,
    needsReviewRunCount: record.needsReviewRunCount,
    replayed: true,
  };
}

export async function importSchedule(input: ScheduleImportInput & {
  facilityId: string;
  actorUserId: string;
}) {
  const sourceName = input.sourceName.normalize("NFKC").trim();
  if (!sourceName || /[/\\\u0000-\u001f]/.test(sourceName)) {
    throw new HttpError(400, "Choose a valid schedule file name.");
  }
  const normalizedInput = { ...input, sourceName, sourceHash: input.sourceHash.toLowerCase() };
  const currentDateRuns = input.runs.filter((run) => run.date >= input.importDate);
  const ignoredPastCount = input.ignoredPastCount + (input.runs.length - currentDateRuns.length);
  if (currentDateRuns.length === 0) {
    throw new HttpError(400, "There are no schedule rows dated today or later to import.");
  }

  const normalizedRows = currentDateRuns.map((run) => ({
    ...run,
    brand: run.brand.normalize("NFKC").trim().replace(/\s+/g, " "),
    flavor: run.flavor.normalize("NFKC").trim().replace(/\s+/g, " "),
    notes: run.notes.normalize("NFKC").trim(),
    source: { ...run.source, sheet: run.source.sheet.normalize("NFKC").trim() },
  }));
  const sourceKeys = new Set<string>();
  for (const row of normalizedRows) {
    const sourceKey = `${row.source.sheet}\0${row.source.row}`;
    if (sourceKeys.has(sourceKey)) {
      throw new HttpError(400, "The schedule contains duplicate source rows. Review the workbook and try again.");
    }
    sourceKeys.add(sourceKey);
    if (!row.brand || !row.source.sheet || !Number.isInteger(row.casesPlanned) || row.casesPlanned < 1) {
      throw new HttpError(400, "One or more schedule rows are incomplete.");
    }
  }

  const canonicalRows = [...normalizedRows].sort((a, b) =>
    a.source.sheet.localeCompare(b.source.sheet) || a.source.row - b.source.row,
  );
  const importId = stableUuid("schedule-import", input.facilityId, normalizedInput.sourceHash);
  const expectedHash = requestHash(normalizedInput, canonicalRows, ignoredPastCount);

  return db.transaction(async (tx) => {
    await lockProfileNames(tx, input.facilityId);
    // Serializes retries of the same file so a concurrent upload cannot create duplicate runs.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.facilityId}), hashtext(${normalizedInput.sourceHash}))`);
    const [previousBatch] = await tx
      .select({ id: facilityImportBatchesTable.id, summary: facilityImportBatchesTable.summary })
      .from(facilityImportBatchesTable)
      .where(and(
        eq(facilityImportBatchesTable.id, importId),
        eq(facilityImportBatchesTable.facilityId, input.facilityId),
      ))
      .limit(1);
    if (previousBatch) {
      return previousImportResult(previousBatch.summary, importId, expectedHash);
    }

    const profileIds = [...new Set(normalizedRows.map((row) => row.productProfileId))];
    const profiles = await tx
      .select()
      .from(facilityProductProfilesTable)
      .where(and(
        eq(facilityProductProfilesTable.facilityId, input.facilityId),
        inArray(facilityProductProfilesTable.id, profileIds),
        isNull(facilityProductProfilesTable.mergedIntoId),
      ));
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    if (profileById.size !== profileIds.length) {
      throw new HttpError(409, "One or more selected product profiles changed. Refresh profiles and review the schedule mapping.");
    }

    const resolution = await loadNameResolution(tx, input.facilityId);
    const planningByProfile = new Map<string, RunPlanningReview>();
    for (const selection of input.planningByProfile) {
      if (planningByProfile.has(selection.productProfileId)) {
        throw new HttpError(400, "Review each scheduled product profile exactly once before importing.");
      }
      planningByProfile.set(selection.productProfileId, selection.review);
    }
    if (
      planningByProfile.size !== profileIds.length ||
      profileIds.some((profileId) => !planningByProfile.has(profileId))
    ) {
      throw new HttpError(400, "Review every scheduled product profile before importing.");
    }

    for (const profileId of profileIds) {
      const profile = profileById.get(profileId)!;
      const review = planningByProfile.get(profileId)!;
      if (
        review.expectedProfileRevision !== profile.revision ||
        review.expectedNameRevision !== resolution.revision
      ) {
        throw new HttpError(409, "A product profile or remembered name changed after its requirements were reviewed. Refresh and review the schedule again.");
      }
    }

    const planCache = new Map<string, RunRequirementsPlan>();
    const runValues = normalizedRows.map((row) => {
      const profile = profileById.get(row.productProfileId)!;
      const nameResolution = resolutionForProfile(profile, resolution);
      const review = planningByProfile.get(profile.id)!;
      const planKey = JSON.stringify([
        profile.id,
        profile.revision,
        resolution.revision,
        row.casesPlanned,
        review.options,
      ]);
      let runRequirements = planCache.get(planKey);
      if (!runRequirements) {
        if (planCache.size >= 500) {
          throw new HttpError(413, "This schedule has too many distinct run sizes to calculate safely. Split it into smaller imports.");
        }
        runRequirements = buildRunRequirements(
          { ...profile, ...(nameResolution ? { nameResolution } : {}) },
          row.casesPlanned,
          review.options,
        );
        planCache.set(planKey, runRequirements);
      }
      return {
        id: stableUuid("scheduled-run", input.facilityId, normalizedInput.sourceHash, row.source.sheet, String(row.source.row)),
        facilityId: input.facilityId,
        name: `${profile.brand} / ${profile.flavor}`,
        productProfileId: profile.id,
        productSnapshot: {
          id: profile.id,
          brand: profile.brand,
          flavor: profile.flavor,
          revision: profile.revision,
          productData: profile.productData,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
          mergedIntoId: profile.mergedIntoId,
          ...(nameResolution ? { nameResolution } : {}),
          runRequirements,
        },
        targetCases: row.casesPlanned,
        status: "planned" as const,
        revision: 0,
        scheduledFor: row.date,
        scheduleNotes: row.notes || null,
        scheduleSource: {
          importId,
          file: sourceName,
          sheet: row.source.sheet,
          row: row.source.row,
          brand: row.brand,
          flavor: row.flavor,
        },
        createdBy: input.actorUserId,
        pauseIntervals: [],
      };
    });
    const insertedRuns: string[] = [];
    for (let start = 0; start < runValues.length; start += 250) {
      const inserted = await tx
        .insert(productionRunsTable)
        .values(runValues.slice(start, start + 250))
        .onConflictDoNothing({ target: productionRunsTable.id })
        .returning({ id: productionRunsTable.id });
      insertedRuns.push(...inserted.map((run) => run.id));
    }

    const needsReviewRunCount = runValues.filter(
      (run) => run.productSnapshot?.runRequirements.status === "needs_review",
    ).length;
    const summary = {
      requestHash: expectedHash,
      importDate: input.importDate,
      importedCount: insertedRuns.length,
      ignoredPastCount,
      needsReviewRunCount,
    };
    const [batch] = await tx
      .insert(facilityImportBatchesTable)
      .values({
        id: importId,
        facilityId: input.facilityId,
        sourceName,
        sourceHash: normalizedInput.sourceHash,
        importKind: "schedule",
        status: "applied",
        workbookData: {
          format: "lucia.schedule-import.v1",
          sourceHash: normalizedInput.sourceHash,
          importDate: input.importDate,
        },
        summary,
        createdBy: input.actorUserId,
        appliedAt: new Date(),
      })
      .onConflictDoNothing({ target: facilityImportBatchesTable.id })
      .returning({ id: facilityImportBatchesTable.id });
    if (!batch) {
      const [concurrentBatch] = await tx
        .select({ summary: facilityImportBatchesTable.summary })
        .from(facilityImportBatchesTable)
        .where(and(
          eq(facilityImportBatchesTable.id, importId),
          eq(facilityImportBatchesTable.facilityId, input.facilityId),
        ))
        .limit(1);
      if (!concurrentBatch) throw new HttpError(409, "The schedule import could not be confirmed. Refresh the import history before retrying.");
      return previousImportResult(concurrentBatch.summary, importId, expectedHash);
    }
    return { importId, ...summary, replayed: false };
  });
}
