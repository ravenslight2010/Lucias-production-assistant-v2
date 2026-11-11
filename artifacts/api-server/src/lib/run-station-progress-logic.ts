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
  | "paused"
  | "completed";
export type StoredRunStationProgressStatus = Exclude<
  RunStationProgressStatus,
  "paused"
>;

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
  snapshot: {
    status?: StoredRunStationProgressStatus;
    revision?: number;
    updatedAt?: Date | null;
    updatedBy?: string | null;
  } = {},
) {
  const {
    status = "not_started",
    revision = 0,
    updatedAt = null,
    updatedBy = null,
  } = snapshot;
  return stations
    .filter((station) => station.isActive)
    .map((station, stationOrder) => ({
      runId,
      stationId: station.id,
      stationName: station.name,
      stationArea: station.area,
      stationOrder,
      status,
      revision,
      updatedAt,
      updatedBy,
    }));
}

export function stationStatusForRun(
  runStatus: string,
): RunStationProgressStatus {
  switch (runStatus) {
    case "running":
      return "in_progress";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    default:
      return "not_started";
  }
}

export function storedStationStatusForRun(
  runStatus: string,
): StoredRunStationProgressStatus {
  return runStatus === "completed"
    ? "completed"
    : runStatus === "running" || runStatus === "paused"
      ? "in_progress"
      : "not_started";
}
