import type { SoilDump } from "../client/src/lib/types";

// shared/dumping.js carries dump-site facts only (DEL-46) — no rate, cost,
// charge, or markup export. Adding one back here would let TypeScript
// green-light a client import that crashes at runtime against the real
// module, recreating the exact second-owner defect criterion 2 removed.
export const DEFAULT_SOIL_DUMPS: SoilDump[];
export const DEFAULT_SOIL_DUMP: SoilDump;

export function haversineDistanceKm(
  lat1: number, lng1: number, lat2: number, lng2: number
): number;

export function estimateDrivingDistanceKm(straightLineKm: number): number;

export function estimateDriveMinutes(drivingDistanceKm: number): number;

export function sortDumpsByDistance(
  dumps: SoilDump[], lat: number, lng: number
): SoilDump[];
