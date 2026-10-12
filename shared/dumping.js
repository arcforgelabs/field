// Dump-site facts only. Disposal RATES are owned by the Field price catalogue
// item that declares each disposal stream's costing basis (per_tonne /
// per_load / per_m3) and the conversion factor that basis needs — see
// server/catalog/store.js. This module never carries a rate,
// cost, charge, or markup constant; add one here and you have recreated the
// second source of truth this file used to be (DEL-46).

export const DEFAULT_SOIL_DUMPS = [
  buildDumpSite({
    id: "integrated-waste-services-wingfield",
    name: "Integrated Waste Services",
    suburb: "Wingfield",
    addr: "Wingfield Rd & Hanson Rd, Wingfield SA 5013 AU",
    dist: 22,
    drive: 31,
    lat: -34.8466,
    lng: 138.5677,
    accepts: ["clean fill", "unclean fill", "concrete waste", "green waste"],
    hours: "Mon-Fri 6am-4:30pm, Sat 7am-12pm",
    open: true,
    defaultForUnspecified: true,
  }),
  buildDumpSite({
    id: "adelaide-hills-recycling-strathalbyn",
    name: "Adelaide Hills Recycling",
    suburb: "Strathalbyn",
    addr: "Callington Road, Strathalbyn SA 5255 AU",
    dist: 73,
    drive: 67,
    lat: -35.2463085,
    lng: 138.9267821,
    accepts: ["clean fill", "unclean fill", "concrete waste", "green waste"],
    hours: "Call to confirm opening hours",
    open: true,
    defaultForUnspecified: false,
  }),
];

export const DEFAULT_SOIL_DUMP = DEFAULT_SOIL_DUMPS[0];

/** Haversine distance in km between two lat/lng points */
export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate driving distance from straight-line haversine (Adelaide metro ~1.35x factor).
 * TODO: Replace with OSRM or Google Maps Distance Matrix API for accurate road distances.
 * Haversine * 1.35 is within ~10% for Adelaide metro but diverges for rural/highway routes.
 */
export function estimateDrivingDistanceKm(straightLineKm) {
  return Math.round(straightLineKm * 1.35 * 10) / 10;
}

/**
 * Estimate drive time in minutes from driving distance (assumes ~50 km/h average).
 * TODO: Replace with routing API (OSRM is free/self-hostable, Google Maps Distance Matrix
 * has a free tier) to get actual travel times accounting for road type and traffic.
 */
export function estimateDriveMinutes(drivingDistanceKm) {
  return Math.round((drivingDistanceKm / 50) * 60);
}

/** Sort dumps by distance from a given lat/lng, replacing dist/drive with computed values */
export function sortDumpsByDistance(dumps, lat, lng) {
  return dumps
    .map((dump) => {
      const straightLine = haversineDistanceKm(lat, lng, dump.lat, dump.lng);
      const dist = estimateDrivingDistanceKm(straightLine);
      const drive = estimateDriveMinutes(dist);
      return { ...dump, dist, drive };
    })
    .sort((a, b) => a.dist - b.dist);
}

function buildDumpSite({
  id,
  name,
  suburb,
  addr,
  dist,
  drive,
  lat,
  lng,
  accepts,
  hours,
  open,
  defaultForUnspecified = false,
}) {
  return {
    id,
    name,
    suburb,
    addr,
    dist,
    drive,
    lat,
    lng,
    accepts,
    hours,
    open,
    defaultForUnspecified,
  };
}
