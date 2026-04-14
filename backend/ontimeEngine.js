'use strict';
/**
 * ================================================================
 * On-Time Engine — DRT Operations Hub
 * ================================================================
 * Computes per-vehicle on-time status by:
 *
 *   1. Taking the vehicle's live GPS position (lat/lon) and the
 *      GTFS-RT vehicle timestamp (when the GPS fix was taken).
 *
 *   2. Finding the nearest GTFS static stop on the vehicle's trip
 *      that matches by coordinate proximity (haversine ≤ STOP_RADIUS_M).
 *      We cross-reference stopsById (lat/lon) with stopTimesByTrip
 *      (schedule) to find the right stop.
 *
 *   3. Converting the static scheduled arrival_time (HH:MM:SS) to
 *      a Unix timestamp anchored to the service date derived from
 *      the vehicle's own timestamp.
 *
 *   4. Comparing vehicle timestamp − scheduled arrival:
 *        < -29 s  → early
 *        ≤ 329 s  → on_time   (DRT official thresholds)
 *        > 329 s  → late
 *
 *   5. Sticky status: once a vehicle receives a classification at a
 *      stop it keeps that status until it gets close enough to the
 *      NEXT stop and a new comparison is made.
 *
 * The result is stored in global.ontimeState[vehicle_id] and
 * attached to each vehicle object as:
 *   { performance_status, delay_seconds, matched_stop_id,
 *     matched_stop_name, matched_stop_dist_m, stop_sequence }
 *
 * Usage in server.js  (call AFTER vehicles array is built):
 *   const ontime = require('./ontimeEngine');
 *   ontime.evaluateAll(vehicles, db.store);
 * ================================================================
 */

const STOP_RADIUS_M    = 50;   // metres — vehicle must be this close to a stop
const EARLY_SEC        = -29;  // seconds ahead of schedule → early
const LATE_SEC         = 329;  // seconds behind schedule → late (5 min 29 s)

// Per-vehicle sticky state persisted across polling cycles
if (!global.ontimeState) {
  global.ontimeState = {};
  // { [vehicle_id]: { performance_status, delay_seconds,
  //                   matched_stop_id, matched_stop_name,
  //                   matched_stop_dist_m, stop_sequence,
  //                   evaluated_at_ms } }
}

// ── haversine distance (metres) ───────────────────────────────────
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
 * Convert a GTFS HH:MM:SS string (may be > 24 h for overnight trips)
 * to a Unix timestamp (seconds) anchored to the service date.
 *
 * @param {number} vehicleTimestampSec  - Unix seconds from vehicle GPS fix
 * @param {string} hhmmss               - GTFS scheduled time e.g. "14:32:00"
 * @returns {number|null}
 */
function scheduledToUnix(vehicleTimestampSec, hhmmss) {
  if (!vehicleTimestampSec || !hhmmss) return null;

  // Service date midnight = floor to local midnight in UTC-based arithmetic.
  // GTFS times use local service-day midnight (Eastern time for DRT).
  // We derive service midnight from the vehicle timestamp: find the most
  // recent midnight (00:00) that the vehicle timestamp could belong to.
  // We use UTC because server may not be in Eastern time; we offset by -5h
  // for EST (DRT operates in Eastern Time, UTC-5 / UTC-4 in summer).
  // A more robust approach: find the midnight such that the scheduled time
  // is within ±6 h of the vehicle timestamp — handles day boundaries.

  const parts = hhmmss.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  const scheduledSecOfDay = h * 3600 + m * 60 + s;

  // Try the service day whose midnight + scheduledSecOfDay is closest
  // to the vehicle timestamp. Check today and yesterday.
  const DAY_SEC = 86400;
  const vTs = vehicleTimestampSec;

  let best = null;
  let bestDiff = Infinity;

  for (let offset = -1; offset <= 1; offset++) {
    // Candidate midnight: floor vehicle ts to day boundary, offset by N days
    const midnightCandidate = Math.floor(vTs / DAY_SEC) * DAY_SEC + offset * DAY_SEC;
    const candidate = midnightCandidate + scheduledSecOfDay;
    const diff = Math.abs(candidate - vTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  // Sanity: reject if more than 12 h away (data quality guard)
  if (bestDiff > 12 * 3600) return null;
  return best;
}

/**
 * Find the nearest static stop to the vehicle on its trip.
 * Returns { stopEntry, staticStop, distM } or null.
 *
 * stopEntry  = row from stopTimesByTrip  (stop_id, stop_sequence, arrival_time)
 * staticStop = row from stopsById        (stop_lat, stop_lon, stop_name)
 * distM      = distance in metres
 */
function findNearestStopOnTrip(vLat, vLon, tripId, store) {
  const tripStops = store.stopTimesByTrip?.[tripId];
  if (!tripStops || !tripStops.length) return null;

  let best = null;
  let bestDist = Infinity;

  for (const stopEntry of tripStops) {
    const staticStop = store.stopsById[stopEntry.stop_id];
    if (!staticStop) continue;

    const dist = haversine(vLat, vLon, staticStop.stop_lat, staticStop.stop_lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = { stopEntry, staticStop, distM: dist };
    }
  }

  return best;
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
 * Evaluate a single vehicle.
 * Mutates global.ontimeState[vehicle_id].
 * Returns the state object.
 *
 * @param {Object} vehicle - enriched vehicle from server.js
 * @param {Object} store   - db.store
 */
function evaluateVehicle(vehicle, store) {
  const vid  = vehicle.vehicle_id;
  const prev = global.ontimeState[vid] || null;

  // We need: GPS position, timestamp, trip_id
  const lat     = vehicle.raw_latitude  ?? vehicle.latitude;
  const lon     = vehicle.raw_longitude ?? vehicle.longitude;
  const vTs     = vehicle.timestamp; // Unix seconds from GPS fix
  const tripId  = vehicle.trip_id;

  if (!lat || !lon || !vTs || !tripId) {
    // Can't evaluate — preserve previous sticky state if any
    return prev || {
      performance_status: 'unknown',
      delay_seconds:       null,
      matched_stop_id:     null,
      matched_stop_name:   null,
      matched_stop_dist_m: null,
      stop_sequence:       null,
    };
  }

  // Find nearest stop on trip by coordinate match
  const match = findNearestStopOnTrip(lat, lon, tripId, store);

  if (!match) {
    return prev || {
      performance_status: 'unknown',
      delay_seconds:       null,
      matched_stop_id:     null,
      matched_stop_name:   null,
      matched_stop_dist_m: null,
      stop_sequence:       null,
    };
  }

  const { stopEntry, staticStop, distM } = match;

  // Only re-evaluate when the vehicle is within STOP_RADIUS_M of a stop.
  // Outside the radius we keep the last sticky classification.
  if (distM > STOP_RADIUS_M) {
    if (prev) {
      // Return sticky state but update the proximity field
      return {
        ...prev,
        matched_stop_dist_m: Math.round(distM),
        // Mark that we're between stops
        between_stops: true,
      };
    }
    // No previous state and not near a stop — truly unknown
    return {
      performance_status: 'unknown',
      delay_seconds:       null,
      matched_stop_id:     stopEntry.stop_id,
      matched_stop_name:   staticStop.stop_name,
      matched_stop_dist_m: Math.round(distM),
      stop_sequence:       stopEntry.stop_sequence,
      between_stops:       true,
    };
  }

  // Vehicle IS within STOP_RADIUS_M — perform a fresh classification.
  // Check we haven't already evaluated this exact stop in the last 90 s
  // (prevents the same stop from generating a new reading every 30 s poll).
  if (
    prev &&
    prev.matched_stop_id === stopEntry.stop_id &&
    prev.stop_sequence   === stopEntry.stop_sequence
  ) {
    const ageSec = (Date.now() - (prev.evaluated_at_ms || 0)) / 1000;
    if (ageSec < 90) {
      // Return the existing reading — don't overwrite with a new one
      // but update the distance measurement
      return {
        ...prev,
        matched_stop_dist_m: Math.round(distM),
        between_stops: false,
      };
    }
  }

  // Compute scheduled Unix from stop's GTFS arrival_time
  const scheduledUnix = scheduledToUnix(vTs, stopEntry.arrival_time);

  if (!scheduledUnix) {
    // Scheduled time couldn't be resolved — keep previous or unknown
    return prev || {
      performance_status: 'unknown',
      delay_seconds:       null,
      matched_stop_id:     stopEntry.stop_id,
      matched_stop_name:   staticStop.stop_name,
      matched_stop_dist_m: Math.round(distM),
      stop_sequence:       stopEntry.stop_sequence,
    };
  }

  // ✅ Core calculation: vehicle GPS timestamp vs scheduled arrival
  const delaySec = vTs - scheduledUnix;
  const status   = classify(delaySec);

  const newState = {
    performance_status:  status,
    delay_seconds:       Math.round(delaySec),
    matched_stop_id:     stopEntry.stop_id,
    matched_stop_name:   staticStop.stop_name,
    matched_stop_dist_m: Math.round(distM),
    stop_sequence:       stopEntry.stop_sequence,
    between_stops:       false,
    evaluated_at_ms:     Date.now(),
    // Debug fields (stripped in API response)
    _scheduled_unix:     scheduledUnix,
    _vehicle_ts:         vTs,
    _arrival_time_str:   stopEntry.arrival_time,
  };

  global.ontimeState[vid] = newState;
  return newState;
}

/**
 * Evaluate all vehicles in the current polling cycle.
 * Attaches performance_status and delay_seconds directly
 * to each vehicle object in-place.
 *
 * @param {Object[]} vehicles - array of vehicle objects (mutated)
 * @param {Object}   store    - db.store
 */
function evaluateAll(vehicles, store) {
  for (const v of vehicles) {
    const state = evaluateVehicle(v, store);

    v.performance_status  = state.performance_status;
    v.delay_seconds        = state.delay_seconds;
    v.matched_stop_id      = state.matched_stop_id;
    v.matched_stop_name    = state.matched_stop_name;
    v.matched_stop_dist_m  = state.matched_stop_dist_m;
    v.at_stop_sequence     = state.stop_sequence;
    v.between_stops        = state.between_stops ?? true;
  }
}

/**
 * Prune stale entries from ontimeState (vehicles seen > 5 min ago).
 * Call on a slow timer.
 */
function pruneState() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const vid of Object.keys(global.ontimeState)) {
    const s = global.ontimeState[vid];
    if (s.evaluated_at_ms && s.evaluated_at_ms < cutoff) {
      delete global.ontimeState[vid];
    }
  }
}

module.exports = { evaluateAll, evaluateVehicle, pruneState, EARLY_SEC, LATE_SEC };
