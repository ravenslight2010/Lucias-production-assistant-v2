export type RunStatus = "draft" | "running" | "paused" | "completed";
export type RunAction = "start" | "pause" | "resume" | "complete";

export interface RunLifecycleState {
  status: RunStatus;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
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
      if (current.status !== "draft") {
        throw new RunLifecycleConflict("Only a draft run can be started.");
      }
      return { ...current, status: "running", startedAt: at };
    case "pause":
      if (current.status !== "running") {
        throw new RunLifecycleConflict("Only a running run can be paused.");
      }
      return { ...current, status: "paused", pausedAt: at };
    case "resume":
      if (current.status !== "paused") {
        throw new RunLifecycleConflict("Only a paused run can be resumed.");
      }
      return { ...current, status: "running", pausedAt: null };
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
      };
  }
}
