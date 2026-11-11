export type FacilityStationArea =
  | "dough_sauce_prep"
  | "production_line"
  | "freezing_packaging"
  | "warehouse";

export type FacilityStationForRun = {
  id: string;
  name: string;
  area: FacilityStationArea;
  isActive: boolean;
};

export type RunStationProgressStatus =
  | "not_started"
  | "in_progress"
  | "completed";

export type RunStationProgressItem = {
  stationId: string;
  stationName: string;
  area: FacilityStationArea;
  order: number;
  status: RunStationProgressStatus;
  revision: number;
  updatedAt: string | null;
};

export type RunStationProgressList = {
  initialized: boolean;
  stations: RunStationProgressItem[];
};

export function buildRunStationProgressRows(
  runId: string,
  stations: FacilityStationForRun[],
) {
  return stations
    .filter((station) => station.isActive)
    .map((station, stationOrder) => ({
      runId,
      stationId: station.id,
      stationName: station.name,
      stationArea: station.area,
      stationOrder,
      status: "not_started" as const,
      revision: 0,
      updatedAt: null,
      updatedBy: null,
    }));
}

export function planStationProgressUpdate(
  current: { revision: number; status: string },
  expectedRevision: number,
  nextStatus: RunStationProgressStatus,
):
  | { type: "conflict" }
  | { type: "unchanged" }
  | { type: "updated"; status: RunStationProgressStatus; revision: number } {
  if (current.revision !== expectedRevision) return { type: "conflict" };
  if (current.status === nextStatus) return { type: "unchanged" };
  return {
    type: "updated",
    status: nextStatus,
    revision: current.revision + 1,
  };
}
