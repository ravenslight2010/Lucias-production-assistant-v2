import { randomUUID } from "node:crypto";
import type {
  FacilityStation,
  FacilityStationArea,
} from "@workspace/db";

export type FacilityStationInput = {
  id?: string;
  name: string;
  area: FacilityStationArea;
  isActive: boolean;
};

export const DEFAULT_FACILITY_STATIONS: FacilityStation[] = [
  { id: "prep-standby-dough", name: "Standby dough", area: "dough_prep", isActive: true },
  { id: "prep-dough-mixer", name: "Dough mixer", area: "dough_prep", isActive: true },
  { id: "prep-dough-hopper", name: "Dough hopper", area: "dough_prep", isActive: true },
  { id: "prep-filling-dough-trays", name: "Filling dough trays", area: "dough_prep", isActive: true },
  { id: "prep-standby-dough-trays", name: "Standby dough trays", area: "dough_prep", isActive: true },
  { id: "prep-using-dough-trays", name: "Using dough trays", area: "dough_prep", isActive: true },
  { id: "prep-production-cooler", name: "Production cooler", area: "warehouse", isActive: true },
  { id: "prep-sauce-area", name: "Sauce area", area: "sauce_prep", isActive: true },
  { id: "line-press", name: "Press", area: "production_line", isActive: true },
  { id: "line-oven", name: "Oven", area: "production_line", isActive: true },
  { id: "line-sauce-app", name: "Sauce app", area: "production_line", isActive: true },
  { id: "line-app-1", name: "App 1", area: "production_line", isActive: true },
  { id: "line-app-2", name: "App 2", area: "production_line", isActive: true },
  { id: "line-prep-1", name: "Pep 1", area: "production_line", isActive: true },
  { id: "line-prep-2", name: "Pep 2", area: "production_line", isActive: true },
  { id: "line-app-3", name: "App 3", area: "production_line", isActive: true },
  { id: "line-app-4", name: "App 4", area: "production_line", isActive: true },
  { id: "finish-freeze-tunnel", name: "Freeze tunnel", area: "freeze_tunnel", isActive: true },
  { id: "finish-wrapper", name: "Wrapper", area: "freezing_packaging", isActive: true },
  { id: "finish-packaging", name: "Packaging", area: "freezing_packaging", isActive: true },
  { id: "warehouse-cooler", name: "Warehouse cooler", area: "warehouse", isActive: true },
  { id: "warehouse-freezer", name: "Warehouse freezer", area: "warehouse", isActive: true },
];

const defaultDoughStationIds = new Set([
  "prep-standby-dough",
  "prep-dough-mixer",
  "prep-dough-hopper",
  "prep-filling-dough-trays",
  "prep-standby-dough-trays",
  "prep-using-dough-trays",
]);

/**
 * Moves only known V1 default stations into the corrected sections. Unknown
 * custom stations stay in the legacy section for an explicit manager choice.
 */
export function migrateLegacyFacilityStations(
  stations: FacilityStation[],
): FacilityStation[] {
  let changed = false;
  const migrated = stations.map((station) => {
    let area = station.area;
    let name = station.name;

    if (defaultDoughStationIds.has(station.id)) area = "dough_prep";
    if (station.id === "prep-sauce-area") area = "sauce_prep";
    if (station.id === "prep-production-cooler") area = "warehouse";
    if (station.id === "finish-freeze-tunnel") {
      area = "freeze_tunnel";
      if (name.trim().toLocaleLowerCase() === "freezer tunnel") {
        name = "Freeze tunnel";
      }
    }
    if (
      station.id === "line-prep-1" &&
      name.trim().toLocaleLowerCase() === "prep 1"
    ) {
      name = "Pep 1";
    }
    if (
      station.id === "line-prep-2" &&
      name.trim().toLocaleLowerCase() === "prep 2"
    ) {
      name = "Pep 2";
    }

    if (area === station.area && name === station.name) return station;
    changed = true;
    return { ...station, area, name };
  });

  return changed ? migrated : stations;
}

export class FacilityStationLayoutError extends Error {}

export function normalizeFacilityStations(
  current: FacilityStation[],
  requested: FacilityStationInput[],
  createId: () => string = randomUUID,
): FacilityStation[] {
  if (requested.length < current.length || requested.length > 50) {
    throw new FacilityStationLayoutError(
      "Keep all existing stations and use no more than 50 stations.",
    );
  }

  const knownIds = new Set(current.map((station) => station.id));
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const normalized: FacilityStation[] = [];

  for (const station of requested) {
    const name = station.name.trim();
    if (!name || name.length > 80) {
      throw new FacilityStationLayoutError(
        "Station names must contain 1 to 80 characters.",
      );
    }

    const id = station.id ?? createId();
    if ((station.id && !knownIds.has(id)) || seenIds.has(id)) {
      throw new FacilityStationLayoutError(
        "A station does not belong to this facility or appears more than once.",
      );
    }
    seenIds.add(id);

    const nameKey = `${station.area}:${name.toLocaleLowerCase()}`;
    if (seenNames.has(nameKey)) {
      throw new FacilityStationLayoutError(
        "Station names must be unique within each area.",
      );
    }
    seenNames.add(nameKey);
    normalized.push({ id, name, area: station.area, isActive: station.isActive });
  }

  if ([...knownIds].some((id) => !seenIds.has(id))) {
    throw new FacilityStationLayoutError(
      "Archive a station instead of removing it from the lineup.",
    );
  }
  return normalized;
}
