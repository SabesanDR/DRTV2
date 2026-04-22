'use strict';

/**
 * ================================================================
 * History Store — DRT Operations Hub
 * ================================================================
 * Accumulates GTFS-RT polling snapshots in memory with a
 * configurable retention window (default 24 h).
 *
 * Attaches itself to `global.historyStore` so that server.js and
 * the export route can both access it without circular imports.
 *
 * Usage in server.js:
 *   const historyStore = require('./historyStore');
 *   // Then after each fetchVehiclePositions() call:
 *   historyStore.recordVehicles(global.cache.vehicles);
 *   // After each fetchTripUpdates() call:
 *   historyStore.recordTripUpdates(global.cache.tripUpdates, db.store);
 * ================================================================
 */

const RETENTION_HOURS = Number(process.env.HISTORY_RETENTION_HOURS) || 24;
const RETENTION_MS    = RETENTION_HOURS * 60 * 60 * 1000;

const EARLY_THRESHOLD_SEC = -29;
const LATE_THRESHOLD_SEC  = 5 * 60 + 29; // 329 s

function classifyDelay(sec) {
  if (sec == null) return 'unknown';
  if (sec > LATE_THRESHOLD_SEC)  return 'late';
  if (sec < EARLY_THRESHOLD_SEC) return 'early';
  return 'on_time';
}

function scheduledToUnix(actualUnix, hhmmss) {
  if (!actualUnix || !hhmmss) return null;
  const parts = (hhmmss + '').split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s]        = parts;
  const scheduledSecOfDay = h * 3600 + m * 60 + s;
  const DAY_SEC           = 86400;
  // Use Eastern Time midnight anchor — not server local (UTC on Linux prod).
  const d   = new Date(actualUnix * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dp = Object.fromEntries(
    fmt.formatToParts(d).filter(p => p.type !== 'literal')
       .map(p => [p.type, parseInt(p.value, 10)])
  );
  const utcMs    = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const torMs    = new Date(d.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const offsetSec = Math.round((torMs - utcMs) / 1000);
  const torontoMidnightUtcSec =
    Date.UTC(dp.year, dp.month - 1, dp.day, 0, 0, 0) / 1000 - offsetSec;
  let best = null, bestDiff = Infinity;
  for (let offset = -1; offset <= 1; offset++) {
    const candidate = torontoMidnightUtcSec + offset * DAY_SEC + scheduledSecOfDay;
    const diff      = Math.abs(candidate - actualUnix);
    if (diff < bestDiff) { bestDiff = diff; best = candidate; }
  }
  return bestDiff <= 12 * 3600 ? best : null;
}

// ── prune expired records ────────────────────────────────────────
function prune(arr) {
  const cutoff = Date.now() - RETENTION_MS;
  return arr.filter(r => r.ts >= cutoff);
}

// ── initialise global store ──────────────────────────────────────
if (!global.historyStore) {
  global.historyStore = {
    retentionHours:   RETENTION_HOURS,
    vehicleSnapshots: [],   // per-vehicle per-poll GPS + status
    delaySnapshots:   [],   // per-trip-update per-poll delay info
    stopPerformance:  [],   // per-stop arrival observations
  };
}

const hs = global.historyStore;

// ── record vehicle positions ─────────────────────────────────────
/**
 * Call once per polling cycle after vehicles array is refreshed.
 * @param {Object[]} vehicles - enriched vehicle objects from server.js
 */
function recordVehicles(vehicles) {
  if (!Array.isArray(vehicles)) return;
  const now = Date.now();

  const snapshots = vehicles.map(v => ({
    ts:           now,
    vehicle_id:   v.vehicle_id,
    route_id:     v.route_id     || '',
    trip_id:      v.trip_id      || '',
    lat:          v.latitude,
    lon:          v.longitude,
    bearing:      v.bearing      != null ? v.bearing : null,
    speed_kmh:    v.speed        != null ? v.speed : null,
    occupancy:    v.occupancy_status != null ? v.occupancy_status : null,
    perf_status:  v.performance_status || 'unknown',
    delay_sec:    v.delay_seconds != null ? v.delay_seconds : null,
    snapped:      !!v.snapped,
    snap_dist_m:  v.snap_distance_m != null ? v.snap_distance_m : null,
  }));

  hs.vehicleSnapshots = prune([...hs.vehicleSnapshots, ...snapshots]);
}

// ── record trip update delays ────────────────────────────────────
/**
 * Call once per polling cycle after trip updates are refreshed.
 * @param {Object[]} tripUpdates - parsed trip update objects from server.js
 * @param {Object}   store       - db.store for static GTFS lookups
 */
function recordTripUpdates(tripUpdates, store) {
  if (!Array.isArray(tripUpdates)) return;
  const now = Date.now();

  const delaySnaps = [];
  const stopSnaps  = [];

  for (const u of tripUpdates) {
    if (!u.trip_id) continue;
    const routeId = u.route_id || '';

    // Per-trip summary row
    delaySnaps.push({
      ts:             now,
      trip_id:        u.trip_id,
      route_id:       routeId,
      stop_id:        u.stop_updates?.[0]?.stop_id      || '',
      stop_seq:       u.stop_updates?.[0]?.stop_sequence ?? null,
      arrival_delay:  u.arrival_delay   != null ? u.arrival_delay   : null,
      departure_delay: u.departure_delay != null ? u.departure_delay : null,
      perf_status:    u.status || classifyDelay(u.arrival_delay),
      scheduled_unix: null,
      actual_unix:    null,
    });

    // Per-stop observation rows (all stops in this trip update)
    const stopTimes = store?.stopTimesByTrip?.[u.trip_id] || [];

    for (const stu of (u.stop_updates || [])) {
      const actualUnix = stu.arrival_time || stu.departure_time || null;
      const staticStop = stopTimes.find(s => s.stop_sequence === stu.stop_sequence)
                      || stopTimes.find(s => s.stop_id       === stu.stop_id);

      let scheduledUnix = null;
      let delaySec      = null;

      if (staticStop?.arrival_time && actualUnix) {
        scheduledUnix = scheduledToUnix(actualUnix, staticStop.arrival_time);
        if (scheduledUnix) delaySec = actualUnix - scheduledUnix;
      }

      // Prefer explicit RT delay field
      const finalDelay = stu.arrival_delay != null ? stu.arrival_delay : delaySec;

      stopSnaps.push({
        ts:            now,
        trip_id:       u.trip_id,
        route_id:      routeId,
        stop_id:       stu.stop_id       || staticStop?.stop_id || '',
        stop_seq:      stu.stop_sequence ?? null,
        delay_sec:     finalDelay,
        perf_status:   classifyDelay(finalDelay),
        scheduled_unix: scheduledUnix,
        actual_unix:   actualUnix || null,
      });
    }
  }

  hs.delaySnapshots  = prune([...hs.delaySnapshots,  ...delaySnaps]);
  hs.stopPerformance = prune([...hs.stopPerformance, ...stopSnaps]);
}

// ── manual pruning (call on a slow timer if desired) ─────────────
function pruneAll() {
  hs.vehicleSnapshots = prune(hs.vehicleSnapshots);
  hs.delaySnapshots   = prune(hs.delaySnapshots);
  hs.stopPerformance  = prune(hs.stopPerformance);
}

module.exports = { recordVehicles, recordTripUpdates, pruneAll };
