import test from "node:test";
import assert from "node:assert/strict";
import { dashboardPrimaryAction } from "../src/dashboard-primary-action.ts";

test("managers and owners can create a production run from the dashboard", () => {
  for (const role of ["owner", "manager"]) {
    assert.deepEqual(dashboardPrimaryAction(role, [], [], true), {
      kind: "link",
      label: "New production run",
      href: "/runs",
    });
  }
});

test("operators are directed to active work before the planned queue", () => {
  assert.deepEqual(dashboardPrimaryAction(
    "operator",
    [{ id: "active/7" }],
    [{ id: "planned-8" }],
    true,
  ), {
    kind: "link",
    label: "Open active run",
    href: "/runs/active%2F7",
  });
});

test("operators can open a planned run but are not invited to create one", () => {
  assert.deepEqual(dashboardPrimaryAction("operator", [], [{ id: "planned-8" }], true), {
    kind: "link",
    label: "Open planned run",
    href: "/runs/planned-8",
  });
});

test("operators see a manager handoff instead of a dead creation action", () => {
  assert.deepEqual(dashboardPrimaryAction("operator", [], [], true), {
    kind: "notice",
    text: "No run is planned. Ask a manager to schedule the next production run.",
  });
});

test("unknown facility role never receives a create-run action", () => {
  assert.equal(dashboardPrimaryAction(null, [], [], true).kind, "notice");
});

test("operators see the run list while dashboard data is still loading", () => {
  assert.deepEqual(dashboardPrimaryAction("operator", [], [], false), {
    kind: "link",
    label: "View runs",
    href: "/runs",
  });
});
