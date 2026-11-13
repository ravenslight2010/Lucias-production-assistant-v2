import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FACILITY_STATIONS,
  FacilityStationLayoutError,
  migrateLegacyFacilityStations,
  normalizeFacilityStations,
} from "../src/lib/facility-stations.ts";

test("starter lineup covers the V1 production map in order", () => {
  assert.equal(DEFAULT_FACILITY_STATIONS.length, 22);
  assert.deepEqual(
    DEFAULT_FACILITY_STATIONS.slice(8, 17).map((station) => station.name),
    ["Press", "Oven", "Sauce app", "App 1", "App 2", "Pep 1", "Pep 2", "App 3", "App 4"],
  );
  assert.equal(new Set(DEFAULT_FACILITY_STATIONS.map((station) => station.id)).size, 22);
  assert.equal(
    DEFAULT_FACILITY_STATIONS.find((station) => station.id === "prep-production-cooler").area,
    "warehouse",
  );
  assert.equal(
    DEFAULT_FACILITY_STATIONS.find((station) => station.id === "finish-freeze-tunnel").area,
    "freeze_tunnel",
  );
  assert.equal(
    DEFAULT_FACILITY_STATIONS.find((station) => station.id === "finish-packaging").area,
    "freezing_packaging",
  );
});

test("migrates known V1 station placements and preserves unknown custom stations", () => {
  const oldLayout = DEFAULT_FACILITY_STATIONS.map((station) => {
    if (station.id.startsWith("prep-")) {
      return { ...station, area: "dough_sauce_prep" };
    }
    if (station.id === "line-prep-1" || station.id === "line-prep-2") {
      return { ...station, name: station.id === "line-prep-1" ? "Prep 1" : "Prep 2" };
    }
    if (station.id === "finish-freeze-tunnel") {
      return { ...station, name: "Freezer tunnel", area: "freezing_packaging" };
    }
    return station;
  });
  oldLayout.push({
    id: "custom-prep-station",
    name: "Custom prep",
    area: "dough_sauce_prep",
    isActive: true,
  });

  const migrated = migrateLegacyFacilityStations(oldLayout);
  const byId = new Map(migrated.map((station) => [station.id, station]));
  assert.equal(byId.get("prep-production-cooler").area, "warehouse");
  assert.equal(byId.get("prep-sauce-area").area, "sauce_prep");
  assert.equal(byId.get("prep-dough-mixer").area, "dough_prep");
  assert.equal(byId.get("line-prep-1").name, "Pep 1");
  assert.equal(byId.get("line-prep-2").name, "Pep 2");
  assert.equal(byId.get("finish-freeze-tunnel").name, "Freeze tunnel");
  assert.equal(byId.get("finish-freeze-tunnel").area, "freeze_tunnel");
  assert.equal(byId.get("custom-prep-station").area, "dough_sauce_prep");
  assert.strictEqual(migrateLegacyFacilityStations(migrated), migrated);
});

test("updates keep station identities and preserve submitted order", () => {
  const first = DEFAULT_FACILITY_STATIONS[0];
  const result = normalizeFacilityStations(
    [first],
    [
      { id: first.id, name: "Dough staging", area: first.area, isActive: true },
      { name: "New station", area: "production_line", isActive: true },
    ],
    () => "new-station-id",
  );

  assert.deepEqual(result.map((station) => station.id), [first.id, "new-station-id"]);
  assert.deepEqual(result.map((station) => station.name), ["Dough staging", "New station"]);
});

test("rejects unknown, repeated, or omitted station identities", () => {
  const [first, second] = DEFAULT_FACILITY_STATIONS;
  assert.throws(
    () =>
      normalizeFacilityStations([first, second], [
        { id: "another-facility-station", name: "One", area: first.area, isActive: true },
        { id: second.id, name: "Two", area: second.area, isActive: true },
      ]),
    FacilityStationLayoutError,
  );
  assert.throws(
    () =>
      normalizeFacilityStations([first], [
        { id: first.id, name: "One", area: first.area, isActive: true },
        { id: first.id, name: "Two", area: first.area, isActive: true },
      ]),
    FacilityStationLayoutError,
  );
  assert.throws(
    () =>
      normalizeFacilityStations([first, second], [
        { id: first.id, name: "One", area: first.area, isActive: true },
      ]),
    FacilityStationLayoutError,
  );
});

test("trims names and rejects blank or duplicate names within an area", () => {
  const [first, second] = DEFAULT_FACILITY_STATIONS;
  assert.throws(
    () =>
      normalizeFacilityStations([first, second], [
        { id: first.id, name: "   ", area: first.area, isActive: true },
        { id: second.id, name: "Mixer", area: second.area, isActive: true },
      ]),
    FacilityStationLayoutError,
  );
  assert.throws(
    () =>
      normalizeFacilityStations([first, second], [
        { id: first.id, name: " Mixer ", area: first.area, isActive: true },
        { id: second.id, name: "mixer", area: first.area, isActive: true },
      ]),
    FacilityStationLayoutError,
  );
});
