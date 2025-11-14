// Ghost simulator for Route A on vehicle code YUG-199
// Requirements:
// - Next.js server running with env:
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, PUBLISH_JWT_SECRET
// - Access the server at BASE_URL (defaults to http://localhost:3000)
//
// Usage:
//   node scripts/ghostRouteA.js
//   BASE_URL=http://localhost:3000 SPEED_KMH=60 LOOP=true node scripts/ghostRouteA.js
//
// It will:
// 1) Start an operator session for public_code YUG-199
// 2) Publish pings along a straight-line Route A between two stops
// 3) Optionally loop back and forth (LOOP=true)
//
// Open the tracker at /track/YUG-199 to see it move.

const BASE_URL = process.env.BASE_URL || process.env.NEXT_PUBLIC_TRACK_BASE_URL || 'http://localhost:3000';
const PUBLIC_CODE = process.env.PUBLIC_CODE || 'YUG-199';
const SPEED_KMH = Number(process.env.SPEED_KMH || 70); // travel speed for simulation
const LOOP = String(process.env.LOOP || 'true').toLowerCase() === 'true';
const TICK_MS = Number(process.env.TICK_MS || 1000); // send a ping roughly every second

// Route A stops (London -> Mississauga)
const A_START = { lat: 42.9814206, lng: -81.2465922 }; // London, York Street
const A_END   = { lat: 43.6159874, lng: -79.7018163 }; // Mississauga, Bancroft Drive

function numEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Allow overriding start/end via env for alternate test routes
const START = {
  lat: numEnv('START_LAT', A_START.lat),
  lng: numEnv('START_LNG', A_START.lng),
};
// Movement end (where the marker drives to). Back-compat: END_* aliases MOVE_END_*.
const MOVE_END = {
  lat: numEnv('MOVE_END_LAT', numEnv('END_LAT', A_END.lat)),
  lng: numEnv('MOVE_END_LNG', numEnv('END_LNG', A_END.lng)),
};
// Route polyline end (where the displayed route points to). Defaults to MOVE_END if not set.
const ROUTE_END = {
  lat: numEnv('ROUTE_END_LAT', MOVE_END.lat),
  lng: numEnv('ROUTE_END_LNG', MOVE_END.lng),
};

// Utilities
function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function haversineMeters(a, b) {
  const R = 6371e3;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function interpolateGreatCircle(a, b, steps) {
  // Simple linear interpolation in lat/lng (sufficient for visualization)
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    coords.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    });
  }
  return coords;
}

async function fetchOsrmRoute(start, end) {
  // OSRM public endpoint: returns road-following route geometry in GeoJSON
  // Coordinates must be lon,lat
  const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OSRM ${r.status}`);
  const data = await r.json();
  const coords = data?.routes?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('OSRM: no geometry');
  // Convert [lon,lat] -> {lat,lng}
  return coords.map(([lon, lat]) => ({ lat, lng: lon }));
}

async function getRoadRoute(start, end) {
  // Try OSRM first; fall back to simple interpolation if routing fails
  try {
    const coords = await fetchOsrmRoute(start, end);
    return coords;
  } catch (e) {
    console.warn('[sim] OSRM routing failed, falling back to straight interpolation:', e.message || e);
    // Target ~20–30m between points for smooth updates
    const totalDist = haversineMeters(start, end);
    const stepDist = 25; // meters
    const steps = Math.max(8, Math.round(totalDist / stepDist));
    return interpolateGreatCircle(start, end, steps);
  }
}

async function startSession() {
  const r = await fetch(`${BASE_URL}/api/operator/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_code: PUBLIC_CODE }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`start session failed: ${r.status} ${text}`);
  }
  return r.json();
}

async function ping(token, sample) {
  const r = await fetch(`${BASE_URL}/api/operator/ping?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sample),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`ping failed: ${r.status} ${text}`);
  }
}

async function main() {
  console.log(`[sim] BASE_URL=${BASE_URL} PUBLIC_CODE=${PUBLIC_CODE} SPEED_KMH=${SPEED_KMH} LOOP=${LOOP}`);
  console.log(`[sim] START=(${START.lat.toFixed(6)}, ${START.lng.toFixed(6)}) MOVE_END=(${MOVE_END.lat.toFixed(6)}, ${MOVE_END.lng.toFixed(6)}) ROUTE_END=(${ROUTE_END.lat.toFixed(6)}, ${ROUTE_END.lng.toFixed(6)})`);
  const { publish_token, vehicle_id } = await startSession();
  console.log(`[sim] started session, vehicle_id=${vehicle_id}`);

  // Build road-following paths:
  // - moveForward: path the marker follows
  // - routeForward: polyline shown in the UI (can be different destination)
  const moveForward = await getRoadRoute(START, MOVE_END);
  const routeForward = await getRoadRoute(START, ROUTE_END);
  const moveBackward = [...moveForward].reverse();

  // Convert speed to m/s
  const speedMps = Math.max(1, (SPEED_KMH * 1000) / 3600);

  // Emit loop
  let trip = 0;
  while (true) {
    trip++;
    console.log(`[sim] trip ${trip} forward (move=${moveForward.length} pts, route=${routeForward.length} pts)`);
    await runOneLeg(publish_token, moveForward, routeForward);
    if (!LOOP) break;
    console.log(`[sim] trip ${trip} backward (move=${moveBackward.length} pts, route=${routeForward.length} pts)`);
    await runOneLeg(publish_token, moveBackward, routeForward);
  }
  console.log('[sim] done');
}

async function runOneLeg(token, moveCoords, routeCoords) {
  // Publish along the provided coordinates
  // Include the full remaining route in each payload so web UI can render the polyline and destination
  for (let i = 0; i < moveCoords.length; i++) {
    const here = moveCoords[i];
    const next = moveCoords[Math.min(i + 1, moveCoords.length - 1)];
    const segDist = Math.max(1, haversineMeters(here, next));
    const segHeading = bearingDeg(here, next);
    const dtSec = Math.max(0.8, segDist / speedMps()); // time to next point at current speed
    // Provide the full route polyline; the web trims it client-side near the current head.
    const route = { coordinates: routeCoords.map(p => ({ lat: p.lat, lng: p.lng })) };
    const sample = {
      lat: here.lat,
      lng: here.lng,
      speed: speedMps(),
      heading: segHeading,
      accuracy: 15,
      ts: new Date().toISOString(),
      route,
    };
    try {
      await ping(token, sample);
    } catch (e) {
      console.error('[sim] ping error:', e.message || e);
    }
    await sleep(dtSec * 1000);
  }
}

function speedMps() {
  return Math.max(1, (SPEED_KMH * 1000) / 3600);
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


