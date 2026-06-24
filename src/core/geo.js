// src/core/geo.js
// Geographic projection: WGS-84 lat/lng -> Three.js XZ world coordinates.
//
// Coordinate conventions:
//   - X axis: increases eastward
//   - Z axis: increases southward (Three.js Y-up, so south = +Z)
//   - Y axis: up (elevation - not used for 2D map)
// 
// The cosine correction on longitude compensates for the fact that degrees of 
// longitude are shorter at higher latitudes (~85 km/deg at 40°N vs ~111 km/deg
// at the equator). Without it the map stretches horizontally.

// Geographic center of the map - midtown Manhattan
export const MAP_CENTER = { lat: 40.730, lng: -73.960 };

// Scale factor: threadName.js units per degree of latitude.
// At SCALE=1200, the full NYC subway system fits in roughly a 200x200 unit canvas,
// which suits the default camera orbit radius of 70.
export const SCALE = 1200;

/**
 * Project a WGS-84 coordinate to Three.js XZ world space.
 * 
 * @param {number} lat Decimal degrees latitude
 * @param {number} lng Decimal degrees longitude
 * @returns {{x: number, z: number}}
 */
export function geoToXZ(lat, lng) {
    const x = (lng - MAP_CENTER.lng) * SCALE * Math.cos(MAP_CENTER.lat * Math.PI / 180);
    const z = -((lat - MAP_CENTER.lat) * SCALE);
    return { x, z };
}

/**
 * Inverse of geoToXZ - Three.js XZ back to lat/lng.
 * Useful for converting raycaster hit positions to geographic coordinates.
 * 
 * @param {number} x 
 * @param {number} z 
 * @returns {{lat: number, lng: number}}
 */
export function xzToGeo(x, z) {
    const lng = x / (SCALE * Math.cos(MAP_CENTER.lat * Math.PI / 180)) + MAP_CENTER.lng;
    const lat = (-z / SCALE) + MAP_CENTER.lat;
    return { lat, lng };
}

// Meters per degree of latitude (WGS-84 approximation, accurate enough at NYC's latitude).
const METERS_PER_DEGREE_LAT = 111320;

/**
 * Project a WGS-84 coordinate to local meters relative to MAP_CENTER, using the
 * same equirectangular approximation as geoToXZ but in real-world units instead
 * of app-specific scale units.
 *
 * Used as the Three.js model-space coordinate for the Maplibre custom layer:
 * the layer's model matrix converts these local meters into Mercator world
 * space, so geometry built from this function lines up with the map underneath.
 *
 * x increases eastward, y increases southward (matching Mercator's Y axis,
 * which also increases southward) so the model matrix can be a plain
 * translate + uniform scale with no axis permutation.
 *
 * @param {number} lat Decimal degrees latitude
 * @param {number} lng Decimal degrees longitude
 * @returns {{x: number, y: number}}
 */
export function geoToLocalMeters(lat, lng) {
    const x = (lng - MAP_CENTER.lng) * METERS_PER_DEGREE_LAT * Math.cos(MAP_CENTER.lat * Math.PI / 180);
    const y = -((lat - MAP_CENTER.lat) * METERS_PER_DEGREE_LAT);
    return { x, y };
}

/**
 * Haversine great-circle distance between two points, in kilometers.
 * 
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number}
 */
export function haversineKm(a, b) {
    const R = 6371; // Earth radius in km
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const chord = 
        sinLat * sinLat +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng;
    return R * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord));
}

/**
 * Uniformly downsample an array of points to at most maxPoints entries.
 * Always preserves the first and last points so routes don't get cut short.
 * Needed because shapes.txt can have thousands of waypoints per route - 
 * TubeGeometry segment counts scale with point count, so we cap at ~300.
 * 
 * @template T
 * @param {T[]} points
 * @param {number} [maxPoints=300]
 * @returns {T[]} 
 */
export function downsample(points, maxPoints = 300) {
    if (points.length <= maxPoints) {
        return points;
    }
    const stride = Math.ceil(points.length / maxPoints);
    const result = points.filter((_, i) => i % stride === 0);
    const last = points[points.length - 1];
    if (result[result.length - 1] !== last) {
        result.push(last);
    }
    return result;
}