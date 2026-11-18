/** Plain geography: a point, the distance between two, the nearest of some within a radius. */

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The place nearest to `point` that is at most `radiusM` away, or null. */
export function nearestWithin<T extends LatLon>(
  point: LatLon,
  places: readonly T[],
  radiusM: number,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const place of places) {
    const distance = distanceMeters(point, place);
    if (distance <= radiusM && distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  return best;
}
