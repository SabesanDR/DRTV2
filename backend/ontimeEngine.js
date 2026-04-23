'use strict';
/**
 * ================================================================
 * On-Time Engine v3 — DRT Operations Hub
 * ================================================================
 *
 * HOW IT WORKS (Google Maps-style ETA projection)
 * ------------------------------------------------
 *   1. Find the NEXT scheduled stop on the vehicle's trip by
 *      locating the closest stop by GPS distance. If the vehicle
 *      is already within 80 m of it (i.e. at/just past it), step
 *      forward one stop in sequence.
 *
 *   2. Calculate speed from consecutive GPS fixes stored in
 *      global.gpsHistory. Uses wall-clock time (Date.now()) as
 *      the delta denominator — NOT the GPS timestamp — because
 *      DRT's feed quantises timestamps to the minute, which would
 *      produce ts_prev === ts_curr and zero speed every poll.
 *      Falls back to GTFS-RT reported speed, then 30 km/h default.
 *
 *   3. ETA = vehicle_timestamp + (distance_to_stop / speed_mps)
 *
 *   4. delay = ETA − scheduled_arrival_at_stop
 *        < −29 s  → 'early'
 *        ≤  329 s → 'on_time'
 *        >  329 s → 'late'
 *
 * TRIP-ID NORMALIZATION
 * ----------------------
 * DRT's GTFS-RT feed appends suffixes to trip_ids
 * (e.g. "5608__2026-04"). The static GTFS JSON may be keyed by
 * either the full or the stripped id. getStopTimesForTrip() tries
 * both, using the stopTimesByTripNorm index built by db.js.
 *
 * ARRIVAL-TIME FIELD
 * ------------------
 * db.js normalises every stop-time row so arrival_time is always
 * an HH:MM:SS string (converting from arrival_time_sec if needed).
 * scheduledToUnix() uses a ±12-hour window, so it works regardless
 * of server timezone and handles overnight trips (hours > 24).
 * ================================================================
 */

// ── DRT official on-time thresholds (seconds) ────────────────────
const EARLY_SEC = -29;    // more than 29 s ahead of schedule
const LATE_SEC  =  329;   // more than 5 min 29 s behind schedule

// Speed constants
const DEFAULT_SPEED_MPS = 30 / 3.6;   // 8.33 m/s — conservative urban fallback
const MAX_SPEED_MPS     = 25;          // 90 km/h — above this we assume bad GPS
const MIN_SPEED_MPS     = 0.5;         // 1.8 km/h — floor to keep ETA finite

// A vehicle within this distance of a stop is considered to be AT it
const AT_STOP_M = 80;

// ── Persistent globals ────────────────────────────────────────────
// ontimeState: last computed status per vehicle_id
// gpsHistory:  last GPS fix + wall-clock capture time per vehicle_id
if (!global.ontimeState) global.ontimeState = {};
if (!global.gpsHistory)  global.gpsHistory  = {};

// ─────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────

/** Haversine distance in metres between two WGS-84 points. */
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
 * Convert a GTFS HH:MM:SS arrival_time string to a Unix timestamp,
 * anchored to the correct Eastern Time service day.
 *
 * ROOT CAUSE FIX (Bug 1 — "4 hours off"):
 * The old code used Math.floor(ts / 86400) * 86400 which is UTC midnight.
 * GTFS times for DRT are in Eastern Time (America/Toronto).
 * On a UTC server, "14:32:00" resolved to 10:32 AM Eastern instead of
 * 2:32 PM Eastern — a 4-hour (EDT) or 5-hour (EST) systematic error that
 * made every bus appear hours late or early.
 *
 * Fix: derive midnight in America/Toronto using the Intl API, then convert
 * that Eastern midnight to a UTC Unix timestamp as the anchor point.
 * Works correctly for both EST (UTC-5) and EDT (UTC-4), and handles
 * overnight GTFS trips (hours > 24) via the ±1 day search.
 *
 * @param  {number} refTimestampSec  GPS fix timestamp (Unix seconds)
 * @param  {string} hhmmss           Scheduled arrival, e.g. "14:32:00"
 * @returns {number|null}
 */
function scheduledToUnix(refTimestampSec, hhmmss) {
  if (!refTimestampSec || !hhmmss || typeof hhmmss !== 'string') return null;

  const parts = hhmmss.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;

  const [h, m, s]        = parts;
  const scheduledSecOfDay = h * 3600 + m * 60 + s;
  const DAY_SEC           = 86400;

  // ── Derive Eastern midnight as a UTC Unix timestamp ───────────
  // Step 1: find the calendar date in Toronto timezone
  const d   = new Date(refTimestampSec * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateParts = Object.fromEntries(
    fmt.formatToParts(d)
       .filter(p => p.type !== 'literal')
       .map(p => [p.type, parseInt(p.value, 10)])
  );

  // Step 2: find the current UTC offset for America/Toronto at this moment
  // (handles EST/EDT transitions automatically)
  const utcMs = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const torMs = new Date(d.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const offsetSec = Math.round((torMs - utcMs) / 1000); // e.g. -14400 for EDT

  // Step 3: midnight in Toronto on this service date, expressed as UTC seconds
  // e.g. midnight EDT Apr 20 = 04:00 UTC Apr 20 → Date.UTC(2026,3,20) + 4*3600
  const torontoMidnightUtcSec =
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 0, 0, 0) / 1000
    - offsetSec;

  // Step 4: search ±1 service day to handle overnight trips (hours > 24)
  let best = null;
  let bestDiff = Infinity;

  for (let offset = -1; offset <= 1; offset++) {
    const candidate = torontoMidnightUtcSec + offset * DAY_SEC + scheduledSecOfDay;
    const diff      = Math.abs(candidate - refTimestampSec);
    if (diff < bestDiff) { bestDiff = diff; best = candidate; }
  }

  // Sanity: reject if more than 12 h away (mismatched service day)
  return bestDiff <= 12 * 3600 ? best : null;
}

/**
 * Look up stop-time rows for a trip_id, tolerating the __ suffix
 * that DRT's GTFS-RT feed appends to trip IDs.
 *
 * Search order:
 *   1. store.stopTimesByTrip[tripId]          — exact match
 *   2. store.stopTimesByTrip[normalized]      — strip __ suffix
 *   3. store.stopTimesByTripNorm[normalized]  — alias index in db.js
 *
 * @returns {Array|null}
 */
function getStopTimesForTrip(tripId, store) {
  if (!tripId) return null;

  // 1. Exact match
  const exact = store.stopTimesByTrip?.[tripId];
  if (exact && exact.length) return exact;

  // 2. Strip suffix (e.g. "5608__2026-04" → "5608")
  const normId = tripId.includes('__') ? tripId.split('__')[0] : null;
  if (normId) {
    const byNormKey = store.stopTimesByTrip?.[normId];
    if (byNormKey && byNormKey.length) return byNormKey;

    const byNormIdx = store.stopTimesByTripNorm?.[normId];
    if (byNormIdx && byNormIdx.length) return byNormIdx;
  }

  // 3. Try the alias index with the original id (covers the reverse case
  //    where JSON keys have suffixes but RT ids are stripped)
  const byAliasOrig = store.stopTimesByTripNorm?.[tripId];
  if (byAliasOrig && byAliasOrig.length) return byAliasOrig;

  return null;
}

// ─────────────────────────────────────────────────────────────────
// Speed calculation
// ─────────────────────────────────────────────────────────────────

/**
 * Derive the vehicle's speed in m/s from consecutive GPS fixes.
 *
 * KEY FIX (Bug 4): Uses wall-clock time (Date.now()) for the time
 * delta, not the GPS timestamp. DRT's feed quantises vehicle
 * timestamps to the minute, so ts_prev === ts_curr on the poll
 * immediately after a quantisation boundary → GPS delta never fires.
 * Wall-clock time is always strictly increasing between polls.
 *
 * Side-effect: updates global.gpsHistory[vehicleId].
 *
 * @param  {string}      vehicleId
 * @param  {number}      lat           current latitude
 * @param  {number}      lon           current longitude
 * @param  {number}      gpsTs         GPS timestamp (Unix seconds)
 * @param  {number|null} gtfsSpeedKmh  speed from GTFS-RT (km/h) or null
 * @returns {{ speedMps, speedKmh, source, distM, dtSec }}
 */
function deriveSpeed(vehicleId, lat, lon, gpsTs, gtfsSpeedKmh) {
  const nowMs  = Date.now();
  const prev   = global.gpsHistory[vehicleId];

  // Always update before returning so the NEXT call has a baseline
  global.gpsHistory[vehicleId] = { lat, lon, gpsTs, capturedMs: nowMs };

  if (prev) {
    const distM  = haversine(prev.lat, prev.lon, lat, lon);

    // Use wall-clock delta; fall back to GPS delta if wall clock is missing
    const dtMs   = prev.capturedMs ? (nowMs - prev.capturedMs) : 0;
    const dtSec  = dtMs > 0
      ? dtMs / 1000
      : (gpsTs > (prev.gpsTs || 0) ? gpsTs - prev.gpsTs : 0);

    // Need at least 5 m of movement to reject stationary-bus noise
    if (distM > 5 && dtSec > 0) {
      const rawMps = distM / dtSec;

      if (rawMps <= MAX_SPEED_MPS) {
        return {
          speedMps: rawMps,
          speedKmh: Math.round(rawMps * 3.6 * 10) / 10,
          source:   'gps_delta',
          distM:    Math.round(distM),
          dtSec:    Math.round(dtSec),
        };
      }
      // Speed implausibly high — GPS jitter or teleport, fall through
    }
  }

  // GTFS-RT reported speed (stored as km/h in server.js)
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

  // Last-resort urban default
  return {
    speedMps: DEFAULT_SPEED_MPS,
    speedKmh: Math.round(DEFAULT_SPEED_MPS * 3.6 * 10) / 10,
    source:   'default',
    distM:    null,
    dtSec:    null,
  };
}

// ─────────────────────────────────────────────────────────────────
// Next-stop finder
// ─────────────────────────────────────────────────────────────────

/**
 * Find the next stop the vehicle is heading toward.
 *
 * ROOT CAUSE FIX (Bug 2 — wrong stop selected):
 * The old approach (nearest stop by GPS distance) returns the stop
 * the bus JUST LEFT when the bus is within ~80–200 m of having
 * departed it. That stop's scheduled time is now in the past, so
 * delay = ETA − past_scheduled_time becomes a huge positive number.
 *
 * Fix: use the schedule to determine which stops are still upcoming.
 * A stop is considered "served / in the past" if its scheduled
 * arrival is more than PAST_TOLERANCE_SEC ago. We pick the closest
 * upcoming stop from the filtered set.
 *
 * Edge cases handled:
 *   • If ALL stops are in the past (end of trip), fall back to the
 *     nearest stop so the bus still gets a status.
 *   • If the bus is within AT_STOP_M of the chosen stop, step
 *     forward one more in sequence (bus is AT this stop, not en route).
 *
 * @returns {{ stopEntry, staticStop, distM }} or null
 */

// How many seconds ago a stop can be scheduled before we consider
// the bus to have already served it.
// 30 s gives enough margin for a bus arriving slightly early to a stop.
// We also guard with distance: if the bus is within AT_STOP_M of the
// stop it is still AT that stop even if the time is slightly past.
const PAST_TOLERANCE_SEC = 30;

// If ALL stops on a trip are in the past AND the last stop was scheduled
// more than this many seconds ago, the trip has fully completed.
// The GTFS-RT feed often keeps broadcasting a vehicle on a trip_id that
// finished hours ago. Returning null here causes the vehicle to show
// 'unknown' instead of a fabricated 4–14 hour "late" delay.
const TRIP_COMPLETED_SEC = 5 * 60; // 5 minutes grace after final stop

// Hard sanity cap. No DRT bus is realistically delayed more than 90 minutes.
// Any computed |delay| beyond this almost certainly means the vehicle is
// broadcasting on a completed or wrong trip_id — treat as unknown.
const MAX_BELIEVABLE_DELAY_SEC = 90 * 60; // 90 minutes

function findNextStop(vLat, vLon, tripId, gpsTs, store) {
  const tripStops = getStopTimesForTrip(tripId, store);
  if (!tripStops || !tripStops.length) return null;

  // Build enriched candidate list with distance and scheduled unix time
  const candidates = [];
  for (const stopEntry of tripStops) {
    const staticStop = store.stopsById?.[stopEntry.stop_id];
    if (!staticStop || isNaN(staticStop.stop_lat) || isNaN(staticStop.stop_lon)) continue;
    const distM   = haversine(vLat, vLon, staticStop.stop_lat, staticStop.stop_lon);
    const schUnix = scheduledToUnix(gpsTs, stopEntry.arrival_time);
    // A stop is considered served (past) when:
    //   • Its scheduled time is more than PAST_TOLERANCE_SEC ago, AND
    //   • The bus is not still at/near the stop (> AT_STOP_M away)
    // This correctly handles a late bus still approaching its next stop
    // even when the scheduled time has already passed.
    const isScheduledPast = schUnix != null && schUnix < gpsTs - PAST_TOLERANCE_SEC;
    const isBusAway       = distM > AT_STOP_M;
    const isPast          = isScheduledPast && isBusAway;
    candidates.push({ stopEntry, staticStop, distM, schUnix, isPast });
  }

  if (!candidates.length) return null;

  // ── Completed-trip guard ──────────────────────────────────────
  // If every stop is "past" AND the last scheduled stop was more than
  // TRIP_COMPLETED_SEC ago, this trip has finished. The vehicle is
  // still transmitting a stale trip_id from the RT feed. Return null
  // so the caller assigns 'unknown' instead of a false huge delay.
  const allPast = candidates.every(c => c.isPast);
  if (allPast) {
    const lastStop = candidates.reduce((a, b) =>
      b.stopEntry.stop_sequence > a.stopEntry.stop_sequence ? b : a);
    if (lastStop.schUnix && gpsTs - lastStop.schUnix > TRIP_COMPLETED_SEC) {
      return null;
    }
  }

  // Use upcoming stops; fall back to all if none qualify (end of trip)
  const upcoming = candidates.filter(c => !c.isPast);
  const pool     = upcoming.length > 0 ? upcoming : candidates;

  // Pick the closest stop from the eligible pool
  pool.sort((a, b) => a.distM - b.distM);
  const nearest = pool[0];

  // If the bus is AT this stop, advance one in sequence
  if (nearest.distM <= AT_STOP_M) {
    const nextInSeq = pool
      .filter(c => c.stopEntry.stop_sequence > nearest.stopEntry.stop_sequence)
      .sort((a, b) => a.stopEntry.stop_sequence - b.stopEntry.stop_sequence)[0];
    return nextInSeq || nearest;
  }

  return nearest;
}

// ─────────────────────────────────────────────────────────────────
// Core evaluation
// ─────────────────────────────────────────────────────────────────

/** Classify a delay in seconds using DRT official thresholds. */
function classify(delaySec) {
  if (delaySec < EARLY_SEC) return 'early';
  if (delaySec > LATE_SEC)  return 'late';
  return 'on_time';
}

/** Canonical unknown-state object returned when evaluation cannot proceed. */
function unknownState() {
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
    // Legacy field aliases (map.js popup reads these)
    matched_stop_id:      null,
    matched_stop_name:    null,
    matched_stop_dist_m:  null,
    stop_sequence:        null,
    between_stops:        true,
  };
}

/**
 * Evaluate one vehicle.  Writes result into global.ontimeState[vid].
 * Returns the state object (also written to vehicle in evaluateAll).
 */
function evaluateVehicle(vehicle, store) {
  const vid    = vehicle.vehicle_id;

  // Prefer raw (pre-snapping) coordinates for proximity maths
  const lat    = vehicle.raw_latitude  ?? vehicle.latitude;
  const lon    = vehicle.raw_longitude ?? vehicle.longitude;
  const gpsTs  = vehicle.timestamp;        // Unix seconds
  const tripId = vehicle.trip_id;

  // Guard: can't do anything without GPS + trip assignment
  if (!lat || !lon || !gpsTs || !tripId) {
    return global.ontimeState[vid] || unknownState();
  }

  // ── 1. Speed ─────────────────────────────────────────────────
  // vehicle.speed is stored as km/h by server.js (converted from m/s on receipt)
  const speedInfo = deriveSpeed(vid, lat, lon, gpsTs, vehicle.speed ?? null);

  // ── 2. Next stop ─────────────────────────────────────────────
  const match = findNextStop(lat, lon, tripId, gpsTs, store);
  if (!match) {
    // No stop data for this trip — preserve sticky state or return unknown
    return global.ontimeState[vid] || unknownState();
  }

  const { stopEntry, staticStop, distM } = match;

  // ── 3. ETA ───────────────────────────────────────────────────
  const effectiveMps  = Math.max(speedInfo.speedMps, MIN_SPEED_MPS);
  const travelTimeSec = distM / effectiveMps;
  const etaUnix       = gpsTs + travelTimeSec;

  // ── 4. Scheduled arrival ─────────────────────────────────────
  // stopEntry.arrival_time is always HH:MM:SS (db.js normalises this)
  const scheduledUnix = scheduledToUnix(gpsTs, stopEntry.arrival_time);

  if (!scheduledUnix) {
    // No valid schedule time — keep sticky state with refreshed speed/distance
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
        evaluated_at_ms:     Date.now(),
      };
    }
    return unknownState();
  }

  // ── 5. Delay & classification ─────────────────────────────────
  const delaySec = Math.round(etaUnix - scheduledUnix);

  // Sanity cap: if the computed delay is beyond any believable real-world
  // value, the vehicle is almost certainly on a stale/wrong trip_id.
  // Return unknown rather than showing "14 hours late" in the dashboard.
  if (Math.abs(delaySec) > MAX_BELIEVABLE_DELAY_SEC) {
    return global.ontimeState[vid] || unknownState();
  }

  const status   = classify(delaySec);

  const state = {
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
    // Legacy aliases
    matched_stop_id:     stopEntry.stop_id,
    matched_stop_name:   staticStop.stop_name,
    matched_stop_dist_m: Math.round(distM),
    stop_sequence:       stopEntry.stop_sequence,
    between_stops:       distM > AT_STOP_M,
  };

  global.ontimeState[vid] = state;
  return state;
}

/**
 * Evaluate all vehicles and attach on-time, ETA, and speed fields
 * directly to each vehicle object in-place.
 *
 * @param {Object[]} vehicles  Enriched vehicle objects from server.js (mutated)
 * @param {Object}   store     db.store (stopsById, stopTimesByTrip, …)
 */
function evaluateAll(vehicles, store) {
  for (const v of vehicles) {
    try {
      const s = evaluateVehicle(v, store);

      // On-time classification
      v.performance_status   = s.performance_status;
      v.delay_seconds        = s.delay_seconds;

      // ETA
      v.eta_unix             = s.eta_unix;
      v.eta_seconds_away     = s.eta_seconds_away;

      // Next stop
      v.next_stop_id         = s.next_stop_id;
      v.next_stop_name       = s.next_stop_name;
      v.next_stop_dist_m     = s.next_stop_dist_m;
      v.next_stop_sequence   = s.next_stop_sequence;

      // Speed
      v.calculated_speed_kmh = s.speed_kmh;
      v.speed_source         = s.speed_source;
      v.gps_delta_dist_m     = s.gps_delta_dist_m;
      v.gps_delta_dt_sec     = s.gps_delta_dt_sec;

      // Legacy field aliases (map.js popup reads these)
      v.matched_stop_id      = s.matched_stop_id;
      v.matched_stop_name    = s.matched_stop_name;
      v.matched_stop_dist_m  = s.matched_stop_dist_m;
      v.at_stop_sequence     = s.stop_sequence;
      v.between_stops        = s.between_stops ?? true;
    } catch (err) {
      // One bad vehicle must not crash the entire evaluation loop.
      // Mark it unknown and continue with the rest of the fleet.
      v.performance_status = 'unknown';
      v.delay_seconds      = null;
    }
  }
}

/**
 * Prune entries for vehicles not seen in the last 5 minutes.
 * Call on a slow timer (e.g. every 5 min in server.js).
 */
function pruneState() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const vid of Object.keys(global.ontimeState)) {
    if ((global.ontimeState[vid].evaluated_at_ms || 0) < cutoff) {
      delete global.ontimeState[vid];
      delete global.gpsHistory[vid];
    }
  }
}

module.exports = { evaluateAll, evaluateVehicle, pruneState, EARLY_SEC, LATE_SEC };
