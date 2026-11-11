import { eq } from "drizzle-orm";
import { db, facilitiesTable, facilityMembersTable } from "@workspace/db";
import type { FacilityMember } from "@workspace/db";
import { HttpError } from "./http-error";
import type { RunAction } from "./run-lifecycle";

export async function getFacilityMembership(userId: string) {
  const [membership] = await db
    .select({
      facilityId: facilitiesTable.id,
      facilityName: facilitiesTable.name,
      facilityCreatedAt: facilitiesTable.createdAt,
      role: facilityMembersTable.role,
    })
    .from(facilityMembersTable)
    .innerJoin(
      facilitiesTable,
      eq(facilityMembersTable.facilityId, facilitiesTable.id),
    )
    .where(eq(facilityMembersTable.userId, userId))
    .limit(1);
  return membership ?? null;
}

export type RunPermissionAction = "create" | RunAction;

const operatorActions = new Set<RunPermissionAction>([
  "start",
  "pause",
  "resume",
]);

export function assertRunPermission(
  role: FacilityMember["role"],
  action: RunPermissionAction,
) {
  if (role === "owner" || role === "manager") return;
  if (role === "operator" && operatorActions.has(action)) return;

  throw new HttpError(
    403,
    role === "operator"
      ? "Operators may start, pause, and resume runs, but cannot create or complete them."
      : "This facility role cannot perform that run action.",
  );
}
