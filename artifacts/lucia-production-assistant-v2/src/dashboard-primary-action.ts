type RunLink = { id: string };
type FacilityRole = "owner" | "manager" | "operator";

export type DashboardPrimaryAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "notice"; text: string };

export function dashboardPrimaryAction(
  role: FacilityRole | null,
  activeRuns: RunLink[],
  plannedRuns: RunLink[],
  summaryLoaded: boolean,
): DashboardPrimaryAction {
  if (role === "owner" || role === "manager") {
    return { kind: "link", label: "New production run", href: "/runs" };
  }

  if (activeRuns[0]) {
    return {
      kind: "link",
      label: "Open active run",
      href: `/runs/${encodeURIComponent(activeRuns[0].id)}`,
    };
  }

  if (plannedRuns[0]) {
    return {
      kind: "link",
      label: "Open planned run",
      href: `/runs/${encodeURIComponent(plannedRuns[0].id)}`,
    };
  }

  if (!summaryLoaded) {
    return { kind: "link", label: "View runs", href: "/runs" };
  }

  return {
    kind: "notice",
    text: "No run is planned. Ask a manager to schedule the next production run.",
  };
}
