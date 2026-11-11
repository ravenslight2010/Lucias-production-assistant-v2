export type RunStatus = "planned" | "draft" | "running" | "paused" | "completed";
export type RunAction = "start" | "pause" | "resume" | "complete";

export interface RunLifecycleState {
  status: RunStatus;
  startedAt: Date | null;
  pausedAt: Date | null;
  resumedAt: Date | null;
  completedAt: Date | null;
  pauseIntervals: Array<{ startedAt: string; endedAt: string | null }>;
}

export class RunLifecycleConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLifecycleConflict";
  }
}

export function transitionRun(
  current: RunLifecycleState,
  action: RunAction,
  at: Date,
): RunLifecycleState {
  switch (action) {
    case "start":
      if (current.status !== "planned" && current.status !== "draft") {
        throw new RunLifecycleConflict("Only a planned run can be started.");
      }
      return { ...current, status: "running", startedAt: at, resumedAt: null };
    case "pause":
      if (current.status !== "running") {
        throw new RunLifecycleConflict("Only a running run can be paused.");
      }
      return {
        ...current,
        status: "paused",
        pausedAt: at,
        pauseIntervals: [
          ...current.pauseIntervals,
          { startedAt: at.toISOString(), endedAt: null },
        ],
      };
    case "resume":
      if (current.status !== "paused") {
        throw new RunLifecycleConflict("Only a paused run can be resumed.");
      }
      return {
        ...current,
        status: "running",
        pausedAt: null,
        resumedAt: at,
        pauseIntervals: current.pauseIntervals.map((interval, index) =>
          index === current.pauseIntervals.length - 1 && interval.endedAt === null
            ? { ...interval, endedAt: at.toISOString() }
            : interval,
        ),
      };
    case "complete":
      if (current.status !== "running" && current.status !== "paused") {
        throw new RunLifecycleConflict(
          "Only a running or paused run can be completed.",
        );
      }
      return {
        ...current,
        status: "completed",
        pausedAt: null,
        completedAt: at,
        pauseIntervals: current.pauseIntervals.map((interval, index) =>
          current.status === "paused" &&
          index === current.pauseIntervals.length - 1 &&
          interval.endedAt === null
            ? { ...interval, endedAt: at.toISOString() }
            : interval,
        ),
      };
  }
}
