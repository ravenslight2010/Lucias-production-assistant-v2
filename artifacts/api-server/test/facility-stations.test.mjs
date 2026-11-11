import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FACILITY_STATIONS,
  FacilityStationLayoutError,
  normalizeFacilityStations,
} from "../src/lib/facility-stations.ts";

test("starter lineup covers the V1 production map in order", () => {
  assert.equal(DEFAULT_FACILITY_STATIONS.length, 22);
  assert.deepEqual(
    DEFAULT_FACILITY_STATIONS.slice(8, 17).map((station) => station.name),
    ["Press", "Oven", "Sauce app", "App 1", "App 2", "Prep 1", "Prep 2", "App 3", "App 4"],
  );
  assert.equal(new Set(DEFAULT_FACILITY_STATIONS.map((station) => station.id)).size, 22);
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
