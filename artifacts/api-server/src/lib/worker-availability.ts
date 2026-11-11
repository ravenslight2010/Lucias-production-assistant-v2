export type WorkerAvailability = "starting" | "available" | "restarting";

let workerAvailability: WorkerAvailability = "starting";

export function getWorkerAvailability(): WorkerAvailability {
  return workerAvailability;
}

export function updateWorkerAvailabilityFromSupervisor(
  message: unknown,
): void {
  if (typeof message !== "object" || message === null) return;

  const update = message as {
    type?: unknown;
    status?: unknown;
  };
  if (
    update.type !== "worker-availability" ||
    (update.status !== "starting" &&
      update.status !== "available" &&
      update.status !== "restarting")
  ) {
    return;
  }

  workerAvailability = update.status;
}
