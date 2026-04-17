'use strict';
/**
 * ================================================================
 * On-Time Engine — DRT Operations Hub  (v2 — ETA Projection)
 * ================================================================
 *
 * HOW IT WORKS (Google Maps-style approach)
 * -----------------------------------------
 * Instead of waiting for a bus to physically reach a stop (the old
 * 50m radius gate that kept every bus grey), we project forward:
 *
 *   1. Find the NEXT scheduled stop for this vehicle on its trip —
 *      the first stop ahead of the vehicle's current position,
 *      identified by finding the closest stop and stepping forward
 *      in sequence if the bus is already at/past it.
 *
 *   2. Calculate the vehicle's current speed from the last two GPS
 *      fixes (stored in global.gpsHistory per vehicle_id).
 *      Falls back to GTFS-RT reported speed, then to a conservative
 *      urban default of 30 km/h.
 *
 *   3. Compute ETA = vehicle_timestamp + (distance_to_next_stop / speed)
 *
 *   4. Compare ETA to the scheduled arrival at that stop:
 *        delay = ETA − scheduled_unix
 *        delay < −29 s  → early    (DRT official threshold)
 *        delay ≤  329 s → on_time  (DRT official threshold)
 *        delay >  329 s → late     (DRT official threshold)
 *
 *   5. Results are written into global.ontimeState[vehicle_id] and
 *      attached to each vehicle object in-place by evaluateAll().
 *
 * SPEED CALCULATION
 * -----------------
 * On every poll cycle the previous GPS fix for each vehicle is kept
 * in global.gpsHistory[vehicle_id] = { lat, lon, ts }.
 * Speed = haversine(prev, curr) / (curr.ts − prev.ts)  [m/s]
 * Exposed on the vehicle object as:
 *   v.calculated_speed_kmh  — GPS-derived speed (km/h, 1 decimal)
 *   v.speed_source          — 'gps_delta' | 'gtfs_rt' | 'default'
 *   v.gps_delta_dist_m      — metres travelled between last two fixes
 *   v.gps_delta_dt_sec      — seconds between last two fixes
 *
 * ================================================================
 */

// ── DRT official on-time thresholds ─────────────────────────────
const EARLY_SEC = -29;   // more than 29 s ahead of schedule
const LATE_SEC  =  329;  // more than 5 min 29 s behind schedule

// Default cruising speed when only one GPS fix is available yet.
// 30 km/h is a typical urban bus speed between stops.
const DEFAULT_SPEED_MPS = 30 / 3.6;   // 8.33 m/s

// Maximum plausible bus speed — reject GPS-delta speeds above this
// (catches GPS jitter, teleports, stationary-bus noise).
const MAX_SPEED_MPS = 25;             // 90 km/h

// Minimum speed used for ETA calculation to avoid divide-by-zero
// (bus is stopped or barely moving).
const MIN_SPEED_MPS = 0.5;           // 1.8 km/h

// Distance threshold: bus is considered AT a stop and already served it
const AT_STOP_M = 80;

// ── Persistent state ─────────────────────────────────────────────
if (!global.ontimeState) global.ontimeState = {};
if (!global.gpsHistory)  global.gpsHistory  = {};

// ── haversine distance (metres) ──────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000;
  const f1 = lat1 * Math.PI / 180;
  const f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(df / 2) ** 2 +
             Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Convert a GTFS HH:MM:SS string to a Unix timestamp (seconds)
 * anchored to the correct service date.
 * Uses a ±6-hour window search so it works regardless of server
 * timezone and handles overnight trips (hours > 24).
 */
function scheduledToUnix(refTimestampSec, hhmmss) {
  if (!refTimestampSec || !hhmmss) return null;

  const parts = hhmmss.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  const scheduledSecOfDay = h * 3600 + m * 60 + s;

  const DAY_SEC = 86400;
  let best = null;
  let bestDiff = Infinity;

  for (let offset = -1; offset <= 1; offset++) {
    const midnightCandidate =
      Math.floor(refTimestampSec / DAY_SEC) * DAY_SEC + offset * DAY_SEC;
    const candidate = midnightCandidate + scheduledSecOfDay;
    const diff = Math.abs(candidate - refTimestampSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  if (bestDiff > 12 * 3600) return null;
  return best;
}

/**
 * Derive the vehicle's current speed in m/s.
 * Priority: GPS delta → GTFS-RT reported → conservative default.
 *
 * As a side-effect, updates global.gpsHistory[vehicleId] with the
 * current fix so the NEXT call can compute a delta.
 */
function deriveSpeed(vehicleId, lat, lon, ts, gtfsSpeedKmh) {
  const prev = global.gpsHistory[vehicleId];

  // Store current fix for next cycle BEFORE any early returns
  global.gpsHistory[vehicleId] = { lat, lon, ts };

  if (prev && prev.ts && ts > prev.ts) {
    const distM = haversine(prev.lat, prev.lon, lat, lon);
    const dtSec = ts - prev.ts;

    // Require at least 5 m of movement to filter stationary noise
    if (distM > 5 && dtSec > 0) {
      const rawMps = distM / dtSec;

      if (rawMps <= MAX_SPEED_MPS) {
        return {
          speedMps: rawMps,
          speedKmh: Math.round(rawMps * 3.6 * 10) / 10,
          source:   'gps_delta',
          distM:    Math.round(distM),
          dtSec,
        };
      }
      // Implausibly fast — fall through
    }
  }

  // GTFS-RT speed field (stored as km/h in server.js)
  if (typeof gtfsSpeedKmh === 'number' && gtfsSpeedKmh > 0) {
    const mps = Math.min(gtfsSpeedKmh / 3.6, MAX_SPEED_MPS);
    return {
      speedMps: mps,
      speedKmh: Math.round(mps * 3.6 * 10) / 10,
      source:   'gtfs_rt',
      distM:    null,
      dtSec:    null,
    };
  }

  // Conservative urban default
  return {
    speedMps: DEFAULT_SPEED_MPS,
    speedKmh: Math.round(DEFAULT_SPEED_MPS * 3.6 * 10) / 10,
    source:   'default',
    distM:    null,
    dtSec:    null,
  };
}

/**
 * Find the NEXT stop the vehicle is heading toward on its trip.
 *
 * Logic:
 *   1. Find the stop closest to the vehicle by distance.
 *   2. If the vehicle is within AT_STOP_M of that stop it is AT /
 *      just past it — return the next stop in sequence instead.
 *   3. Otherwise the closest stop IS the next target.
 *
 * Returns { stopEntry, staticStop, distM } or null.
 */
function findNextStop(vLat, vLon, tripId, store) {
  const tripStops = store.stopTimesByTrip?.[tripId];
  if (!tripStops || !tripStops.length) return null;

  // Build enriched candidate list
  const candidates = [];
  for (const stopEntry of tripStops) {
    const staticStop = store.stopsById[stopEntry.stop_id];
    if (!staticStop) continue;
    const distM = haversine(vLat, vLon, staticStop.stop_lat, staticStop.stop_lon);
    candidates.push({ stopEntry, staticStop, distM });
  }

  if (!candidates.length) return null;

  // Nearest stop
  candidates.sort((a, b) => a.distM - b.distM);
  const nearest = candidates[0];

  if (nearest.distM <= AT_STOP_M) {
    // Bus is AT this stop — find the next one in sequence
    const nextInSeq = candidates
      .filter(c => c.stopEntry.stop_sequence > nearest.stopEntry.stop_sequence)
      .sort((a, b) => a.stopEntry.stop_sequence - b.stopEntry.stop_sequence)[0];

    return nextInSeq || nearest; // if last stop, stay on nearest
  }

  return nearest;
}

/** Canonical unknown state object */
function _unknownState() {
  return {
    performance_status:  'unknown',
    delay_seconds:        null,
    eta_unix:             null,
    eta_seconds_away:     null,
    next_stop_id:         null,
    next_stop_name:       null,
    next_stop_dist_m:     null,
    next_stop_sequence:   null,
    speed_mps:            null,
    speed_kmh:            null,
    speed_source:         null,
    gps_delta_dist_m:     null,
    gps_delta_dt_sec:     null,
    matched_stop_id:      null,
    matched_stop_name:    null,
    matched_stop_dist_m:  null,
    stop_sequence:        null,
    between_stops:        true,
  };
}

/**
 * Classify a delay in seconds using DRT official thresholds.
 */
function classify(delaySec) {
  if (delaySec < EARLY_SEC) return 'early';
  if (delaySec > LATE_SEC)  return 'late';
  return 'on_time';
}

/**
 * Evaluate a single vehicle using GPS-projection ETA.
 * Mutates global.ontimeState[vehicle_id].
 * Returns the state object.
 */
function evaluateVehicle(vehicle, store) {
  const vid    = vehicle.vehicle_id;

  // Use raw (pre-snapping) GPS coordinates for accuracy
  const lat    = vehicle.raw_latitude  ?? vehicle.latitude;
  const lon    = vehicle.raw_longitude ?? vehicle.longitude;
  const vTs    = vehicle.timestamp;   // Unix seconds of GPS fix
  const tripId = vehicle.trip_id;

  if (!lat || !lon || !vTs || !tripId) {
    return global.ontimeState[vid] || _unknownState();
  }

  // ── Speed ────────────────────────────────────────────────────
  // vehicle.speed is stored as km/h by server.js
  const speedInfo = deriveSpeed(vid, lat, lon, vTs, vehicle.speed ?? null);

  // ── Next stop ────────────────────────────────────────────────
  const match = findNextStop(lat, lon, tripId, store);
  if (!match) {
    return global.ontimeState[vid] || _unknownState();
  }

  const { stopEntry, staticStop, distM } = match;

  // ── ETA ──────────────────────────────────────────────────────
  const effectiveSpeedMps = Math.max(speedInfo.speedMps, MIN_SPEED_MPS);
  const travelTimeSec     = distM / effectiveSpeedMps;
  const etaUnix           = vTs + travelTimeSec;

  // ── Scheduled arrival ────────────────────────────────────────
  const scheduledUnix = scheduledToUnix(vTs, stopEntry.arrival_time);

  if (!scheduledUnix) {
    // No schedule data — preserve previous state if available
    const prev = global.ontimeState[vid];
    if (prev) {
      return {
        ...prev,
        next_stop_dist_m:    Math.round(distM),
        matched_stop_dist_m: Math.round(distM),
        speed_mps:           Math.round(speedInfo.speedMps * 100) / 100,
        speed_kmh:           speedInfo.speedKmh,
        speed_source:        speedInfo.source,
        gps_delta_dist_m:    speedInfo.distM  ?? null,
        gps_delta_dt_sec:    speedInfo.dtSec  ?? null,
      };
    }
    return _unknownState();
  }

  // ── Delay & classification ────────────────────────────────────
  const delaySec = Math.round(etaUnix - scheduledUnix);
  const status   = classify(delaySec);

  const newState = {
    performance_status:  status,
    delay_seconds:       delaySec,
    eta_unix:            Math.round(etaUnix),
    eta_seconds_away:    Math.round(travelTimeSec),
    next_stop_id:        stopEntry.stop_id,
    next_stop_name:      staticStop.stop_name,
    next_stop_dist_m:    Math.round(distM),
    next_stop_sequence:  stopEntry.stop_sequence,
    scheduled_unix:      scheduledUnix,
    speed_mps:           Math.round(speedInfo.speedMps * 100) / 100,
    speed_kmh:           speedInfo.speedKmh,
    speed_source:        speedInfo.source,
    gps_delta_dist_m:    speedInfo.distM  ?? null,
    gps_delta_dt_sec:    speedInfo.dtSec  ?? null,
    evaluated_at_ms:     Date.now(),
    // Legacy aliases so existing map.js popup code works unchanged
    matched_stop_id:     stopEntry.stop_id,
    matched_stop_name:   staticStop.stop_name,
    matched_stop_dist_m: Math.round(distM),
    stop_sequence:       stopEntry.stop_sequence,
    between_stops:       distM > AT_STOP_M,
  };

  global.ontimeState[vid] = newState;
  return newState;
}

/**
 * Evaluate all vehicles. Attaches all on-time, ETA, and speed fields
 * directly to each vehicle object in-place.
 *
 * @param {Object[]} vehicles - array of enriched vehicle objects (mutated)
 * @param {Object}   store    - db.store
 */
function evaluateAll(vehicles, store) {
  for (const v of vehicles) {
    const state = evaluateVehicle(v, store);

    v.performance_status   = state.performance_status;
    v.delay_seconds        = state.delay_seconds;

    v.eta_unix             = state.eta_unix;
    v.eta_seconds_away     = state.eta_seconds_away;

    v.next_stop_id         = state.next_stop_id;
    v.next_stop_name       = state.next_stop_name;
    v.next_stop_dist_m     = state.next_stop_dist_m;
    v.next_stop_sequence   = state.next_stop_sequence;

    v.calculated_speed_kmh = state.speed_kmh;
    v.speed_source         = state.speed_source;
    v.gps_delta_dist_m     = state.gps_delta_dist_m;
    v.gps_delta_dt_sec     = state.gps_delta_dt_sec;

    // Legacy aliases (map.js popup uses these names)
    v.matched_stop_id      = state.matched_stop_id;
    v.matched_stop_name    = state.matched_stop_name;
    v.matched_stop_dist_m  = state.matched_stop_dist_m;
    v.at_stop_sequence     = state.stop_sequence;
    v.between_stops        = state.between_stops ?? true;
  }
}

/**
 * Prune stale entries from ontimeState and gpsHistory.
 * Call on a slow timer (every 5 min).
 */
function pruneState() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const vid of Object.keys(global.ontimeState)) {
    const s = global.ontimeState[vid];
    if (s.evaluated_at_ms && s.evaluated_at_ms < cutoff) {
      delete global.ontimeState[vid];
      delete global.gpsHistory[vid];
    }
  }
}

module.exports = { evaluateAll, evaluateVehicle, pruneState, EARLY_SEC, LATE_SEC };
