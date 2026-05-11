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

export const MAP_CENTER = { lat: 40.730, lng: -73.960 };
export const SCALE = 1200;

export function geoToXZ(lat, lng) {
    const x = (lng - MAP_CENTER.lng) * SCALE * Math.cos(MAP_CENTER.lat * Math.PI / 180);
    const z = -((lat - MAP_CENTER.lat) * SCALE);
    return { x, z };
}

export function xzToGeo(x, z) {
    const lng = x / (SCALE * Math.cos(MAP_CENTER.lat * Math.PI / 180)) + MAP_CENTER.lng;
    const lat = (-z / SCALE) + MAP_CENTER.lat;
    return { lat, lng };
}

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