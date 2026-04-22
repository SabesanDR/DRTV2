'use strict';

/**
 * ================================================================
 * Analytics API — DRT Operations Hub
 * Serves all dashboard metrics from in-memory GTFS-RT data.
 * No database required (rolling window).
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ───────────────────────────────────────────────────────────────
// Safety guard — prevents infinite analytics calculations
// ───────────────────────────────────────────────────────────────
function ensureData(res) {
  if (
    !db.store ||
    !db.store.stopTimesByTrip ||
    !db.store.routesById
  ) {
    res.json({
      status: "no-data",
      message: "GTFS static data not ready"
    });
    return false;
  }
  return true;
}

/* ───────────────────────────────────────────────────────────────
   Helper functions
─────────────────────────────────────────────────────────────── */

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ── Haversine distance (meters) ─────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000; // Earth radius in meters

  const f1 = lat1 * Math.PI / 180;
  const f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(df / 2) ** 2 +
    Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ───────────────────────────────────────────────────────────────
   GTFS static ↔ RT time helpers
─────────────────────────────────────────────────────────────── */

function scheduledStopTimeToUnix(actualUnix, hhmmss) {
  if (!actualUnix || !hhmmss) return null;
  const parts = (hhmmss + '').split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s]        = parts;
  const scheduledSecOfDay = h * 3600 + m * 60 + s;
  const DAY_SEC           = 86400;
  // Anchor to Eastern Time midnight, not UTC midnight.
  // setHours(0,0,0,0) uses the server's local timezone (UTC on Linux prod),
  // producing a 4–5 hour systematic error for all DRT schedule times.
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

/* ───────────────────────────────────────────────────────────────
   On‑time performance helpers
─────────────────────────────────────────────────────────────── */

const EARLY_THRESHOLD_SEC = -29;
const LATE_THRESHOLD_SEC  = 5 * 60 + 29; // 329 seconds

function classifyArrivalBySeconds(deltaSec) {
  if (deltaSec > LATE_THRESHOLD_SEC) return 'late';
  if (deltaSec < EARLY_THRESHOLD_SEC) return 'early';
  return 'on_time';
}

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/overview
   Executive KPI summary (✅ NOW SYNCED)
─────────────────────────────────────────────────────────────── */

router.get('/overview', (_req, res) => {
  if (!ensureData(res)) return;
  const vehicles    = global.cache.vehicles || [];
  const tripUpdates = global.cache.tripUpdates || [];
  const alerts      = global.cache.alerts || [];
  const store       = db.store;

  // ── On-time calculation ──────────────────────────────────────
  // PRIMARY: use performance_status written by ontimeEngine on every vehicle
  // each poll cycle via GPS-projection ETA. This is always populated and
  // works regardless of whether tripUpdates has valid arrival_time fields.
  let late = 0, early = 0, onTime = 0;

  for (const v of vehicles) {
    if      (v.performance_status === 'late')    late++;
    else if (v.performance_status === 'early')   early++;
    else if (v.performance_status === 'on_time') onTime++;
  }

  // FALLBACK: if engine hasn't classified anything yet (cold start / no
  // stop_times loaded), fall back to tripUpdates static-GTFS join.
  if (late + early + onTime === 0) {
    for (const u of tripUpdates) {
      if (!u.trip_id || !u.stop_updates?.length) continue;
      const stopTimes = store.stopTimesByTrip?.[u.trip_id];
      if (!stopTimes) continue;
      const rtStop = u.stop_updates[0];
      const actualUnix = rtStop.arrival_time;
      if (actualUnix == null) continue;
      const staticStop =
        stopTimes.find(s => s.stop_sequence === rtStop.stop_sequence) ||
        stopTimes.find(s => s.stop_id === rtStop.stop_id);
      if (!staticStop?.arrival_time) continue;
      const scheduledUnix = scheduledStopTimeToUnix(actualUnix, staticStop.arrival_time);
      if (!scheduledUnix) continue;
      const deltaSec = actualUnix - scheduledUnix;
      if (!Number.isFinite(deltaSec)) continue;
      const status = classifyArrivalBySeconds(deltaSec);
      if      (status === 'late')  late++;
      else if (status === 'early') early++;
      else                         onTime++;
    }
  }

  const totalTripsMeasured = late + early + onTime;
  const onTimePercent = pct(onTime, totalTripsMeasured);

  const activeRoutes = new Set(
    vehicles.map(v => v.route_id).filter(Boolean)
  ).size;

  const snapped    = vehicles.filter(v => v.snapped).length;
  const stale      = vehicles.filter(v => v.is_stale).length;
  const teleport   = vehicles.filter(v => v.teleport_flagged).length;
  const withGPS    = vehicles.filter(v => v.latitude && v.longitude).length;

  const now = Date.now();
  const feedAge = ts =>
    ts ? Math.round((now - new Date(ts).getTime()) / 1000) : null;

// ── Average delay by route (for Performance Summary chart) ──
const routeDelayMap = {};

for (const u of tripUpdates) {
  if (!u.trip_id || !u.route_id || !u.stop_updates?.length) continue;

  const stopTimes = store.stopTimesByTrip[u.trip_id];
  if (!stopTimes) continue;

  const rtStop = u.stop_updates[0];
  if (!rtStop.arrival_time) continue;

  const staticStop =
    stopTimes.find(s => s.stop_sequence === rtStop.stop_sequence) ||
    stopTimes.find(s => s.stop_id === rtStop.stop_id);

  if (!staticStop?.arrival_time) continue;

  const scheduledUnix =
    scheduledStopTimeToUnix(rtStop.arrival_time, staticStop.arrival_time);
  if (!scheduledUnix) continue;

  const deltaSec = rtStop.arrival_time - scheduledUnix;

  if (!routeDelayMap[u.route_id]) {
    routeDelayMap[u.route_id] = [];
  }

  routeDelayMap[u.route_id].push(deltaSec);
}

const performanceByRoute = Object.entries(routeDelayMap).map(
  ([route_id, deltas]) => {
    const avgSec = Math.round(
      deltas.reduce((a, b) => a + b, 0) / deltas.length
    );

    return {
      route_id,
      avg_delay_sec: avgSec,
      avg_delay_min: Math.round((avgSec / 60) * 100) / 100
    };
  }
);

res.json({
  vehicles: vehicles.length,
  activeRoutes,
  totalRoutes: store.routesList.length,
  totalStops: Object.keys(store.stopsById).length,
  alerts: alerts.length,
  performanceByRoute,

  // canonical GTFS-accurate metrics
  delayedTrips: late,
  earlyTrips: early,
  onTimeTrips: onTime,
  onTimePercent,
  totalTripsMeasured,

  // legacy compatibility (Reports page)
  totalTrips: totalTripsMeasured,
  avgDelaySeconds: late
    ? Math.round(
        (late * LATE_THRESHOLD_SEC) / late
      )
    : 0,
  avgDelayMinutes: late
    ? Math.round(
        ((late * LATE_THRESHOLD_SEC) / late) / 60 * 10
      ) / 10
    : 0,


    dataQuality: {
      vehiclesWithGPS: withGPS,
      snappedVehicles: snapped,
      snappedPercent: pct(snapped, vehicles.length),
      staleVehicles: stale,
      stalePercent: pct(stale, vehicles.length),
      teleportFlagged: teleport
    },

    feedLatency: {
      vehicles_age_sec: feedAge(global.cache.lastUpdated.vehicles),
      tripUpdates_age_sec: feedAge(global.cache.lastUpdated.tripUpdates),
      alerts_age_sec: feedAge(global.cache.lastUpdated.alerts)
    }
  });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/on-time
   Route-level on-time performance.
   PRIMARY: vehicles[].performance_status (ontimeEngine, every 30s).
   Does not depend on tripUpdates having arrival_time fields.
─────────────────────────────────────────────────────────────── */

router.get('/on-time', (_req, res) => {
  if (!ensureData(res)) return;
  const vehicles = global.cache.vehicles || [];
  const store    = db.store;

  const byRoute = {};

  for (const v of vehicles) {
    const rid = v.route_id;
    if (!rid || !v.performance_status || v.performance_status === 'unknown') continue;

    if (!byRoute[rid]) {
      byRoute[rid] = { early: 0, on_time: 0, late: 0, total: 0, delays: [] };
    }
    byRoute[rid][v.performance_status]++;
    byRoute[rid].total++;
    if (typeof v.delay_seconds === 'number') {
      byRoute[rid].delays.push(v.delay_seconds);
    }
  }

  const rows = Object.entries(byRoute).map(([routeId, stats]) => {
    const route  = store.routesById?.[routeId];
    const delays = stats.delays;
    const avgSec = delays.length
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : 0;
    return {
      route_id:         routeId,
      route_short_name: route?.route_short_name || routeId,
      route_color:      route?.route_color      || '2E7D32',
      total_trips:      stats.total,
      early:            stats.early,
      on_time:          stats.on_time,
      late:             stats.late,
      on_time_percent:  pct(stats.on_time, stats.total),
      avg_delay_sec:    avgSec,
      avg_delay_min:    Math.round((avgSec / 60) * 10) / 10,
    };
  });

  rows.sort((a, b) => b.total_trips - a.total_trips);
  res.json({ by_route: rows });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/on-time/debug
   Diagnostic table: RT vs Scheduled arrivals
─────────────────────────────────────────────────────────────── */

router.get('/on-time/debug', (_req, res) => {
  if (!ensureData(res)) return;
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const rows = [];

  for (const u of tripUpdates) {
    if (!u.trip_id || !u.route_id || !u.stop_updates?.length) continue;

    const stopTimes = store.stopTimesByTrip?.[u.trip_id];
    if (!stopTimes) continue;

    const rtStop = u.stop_updates[0];
const actualUnix = rtStop.arrival_time;
  if (actualUnix === null || actualUnix === undefined) continue;

// Match by stop_sequence
let staticStop = stopTimes.find(
  s => s.stop_sequence === rtStop.stop_sequence
);

// Fallback by stop_id
if (!staticStop) {
  staticStop = stopTimes.find(
    s => s.stop_id === rtStop.stop_id
  );
}

if (!staticStop || !staticStop.arrival_time) continue;

const scheduledUnix =
  scheduledStopTimeToUnix(
    actualUnix,
    staticStop.arrival_time
  );

if (!scheduledUnix) continue;
const deltaSec = actualUnix - scheduledUnix;
if (!Number.isFinite(deltaSec)) continue;
const status = classifyArrivalBySeconds(deltaSec);

    rows.push({
      trip_id: u.trip_id,
      route_id: u.route_id,
      stop_id: rtStop.stop_id,
      stop_sequence: rtStop.stop_sequence,

      scheduled_time: staticStop.arrival_time,
      scheduled_unix: scheduledUnix,

      actual_unix: actualUnix,
      actual_time_iso: new Date(actualUnix * 1000).toISOString(),

      delta_seconds: deltaSec,
      delta_minutes: Math.round((deltaSec / 60) * 100) / 100,
      classification: status
    });

    // limit output so browser doesn’t choke
    if (rows.length >= 50) break;
  }

  res.json({
    sample_size: rows.length,
    rows
  });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/headway
   Headway consistency per route
─────────────────────────────────────────────────────────────── */

router.get('/headway', (_req, res) => {
    if (!ensureData(res)) return;
  const vehicles = global.cache.vehicles || [];
  const store = db.store;

  const byRoute = {};

  // 1️⃣ Group active vehicles by route
  for (const v of vehicles) {
    if (!v.route_id || v.is_stale) continue;
    if (v.latitude == null || v.longitude == null) continue;

    if (!byRoute[v.route_id]) {
      byRoute[v.route_id] = [];
    }

    byRoute[v.route_id].push(v);
  }

  const rows = [];

  // 2️⃣ Compute spacing per route
  for (const [routeId, routeVehicles] of Object.entries(byRoute)) {
    if (routeVehicles.length < 2) continue;

    // Prefer most active routes
    const vehicleCount = routeVehicles.length;

    // Sort vehicles in a consistent order
  routeVehicles.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return a.timestamp - b.timestamp;
  });


    const distances = [];

    for (let i = 1; i < routeVehicles.length; i++) {
      const v1 = routeVehicles[i - 1];
      const v2 = routeVehicles[i];

      const d = haversine(
        v1.latitude,
        v1.longitude,
        v2.latitude,
        v2.longitude
      );

      if (d > 0 && d < 20_000) { // sanity filter (20 km)
        distances.push(d);
      }
    }

    // convert spacing from meters to kilometers
    const distancesKm = distances.map(m => m / 1000);

    if (!distances.length) continue;

const avgKm =
  distancesKm.reduce((a, b) => a + b, 0) / distancesKm.length;

const minKm = Math.min(...distancesKm);
const maxKm = Math.max(...distancesKm);
const route = store.routesById[routeId];
rows.push({
  route_id: routeId,
  route_short_name: route?.route_short_name || routeId,
  route_color: route?.route_color || '2E7D32',

  vehicle_count: vehicleCount,

  // ✅ spacing in KILOMETERS ONLY
  avg_spacing_km: Math.round(avgKm * 100) / 100,
  min_spacing_km: Math.round(minKm * 100) / 100,
  max_spacing_km: Math.round(maxKm * 100) / 100,

  // ✅ frontend compatibility (Vehicle Spacing Consistency chart)
  avg_headway_min: Math.round(avgKm * 100) / 100,
  min_headway_min: Math.round(minKm * 100) / 100,
  max_headway_min: Math.round(maxKm * 100) / 100
});
  }

  // 3️⃣ Sort to prioritize routes with most buses
  rows.sort((a, b) =>
    b.vehicle_count - a.vehicle_count
  );

  res.json({ by_route: rows });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/fleet
   Fleet utilization and health
─────────────────────────────────────────────────────────────── */

router.get('/fleet', (_req, res) => {
  if (!ensureData(res)) return;
  const vehicles = global.cache.vehicles || [];
  const store = db.store;

  const byRoute = {};

  for (const v of vehicles) {
    if (!v.route_id) continue;
    if (!byRoute[v.route_id]) byRoute[v.route_id] = { active: 0, stale: 0 };
    byRoute[v.route_id].active++;
    if (v.is_stale) byRoute[v.route_id].stale++;
  }

  const routeBreakdown = Object.entries(byRoute).map(([routeId, d]) => {
    const route = store.routesById[routeId];
    return {
      route_id: routeId,
      route_short_name: route?.route_short_name || routeId,
      active_vehicles: d.active,
      stale_vehicles: d.stale,
      live_vehicles: d.active - d.stale
    };
  });

  const noRoute = vehicles.filter(v => !v.route_id).length;
  const snapped = vehicles.filter(v => v.snapped).length;
  const staleAll = vehicles.filter(v => v.is_stale).length;

  res.json({
    total_vehicles: vehicles.length,
    active_on_route: vehicles.length - noRoute,
    unassigned: noRoute,
    live_gps: vehicles.length - staleAll,
    stale_gps: staleAll,
    snapped_to_route: snapped,
    utilization_pct: pct(vehicles.length - noRoute, vehicles.length),
    by_route: routeBreakdown.sort((a, b) => b.active_vehicles - a.active_vehicles)
  });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/rt-sanity
   To check what data is available in GTFS-RT feed (for debugging and development)
─────────────────────────────────────────────────────────────── */
router.get('/rt-sanity', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];

  res.json({
    tripUpdates_total: tripUpdates.length,
    with_trip_id: tripUpdates.filter(u => !!u.trip_id).length,
    with_stop_updates: tripUpdates.filter(u => u.stop_updates?.length).length,
    with_arrival_time: tripUpdates.filter(
      u => u.stop_updates?.[0]?.arrival_time
    ).length,
    with_departure_time: tripUpdates.filter(
      u => u.stop_updates?.[0]?.departure_time
    ).length,
    sample: tripUpdates.slice(0, 2)
  });
});
/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/stops
   Top delayed and busiest stops (GTFS-accurate)
─────────────────────────────────────────────────────────────── */

router.get('/stops', (_req, res) => {
  if (!ensureData(res)) return;
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const EARLY_THRESHOLD_SEC = -29;
  const LATE_THRESHOLD_SEC  = 5 * 60 + 29; // 329 seconds

  function classifyBySeconds(deltaSec) {
    if (deltaSec > LATE_THRESHOLD_SEC) return 'late';
    if (deltaSec < EARLY_THRESHOLD_SEC) return 'early';
    return 'on_time';
  }

  const stopMap = {};

  for (const u of tripUpdates) {
    if (!u.trip_id || !u.stop_updates?.length) continue;

    const stopTimes = store.stopTimesByTrip?.[u.trip_id];
    if (!stopTimes) continue;

    for (const s of u.stop_updates) {
      if (!s.stop_id || !s.arrival_time) continue;

      const staticStop =
        stopTimes.find(st => st.stop_sequence === s.stop_sequence) ||
        stopTimes.find(st => st.stop_id === s.stop_id);

      if (!staticStop || !staticStop.arrival_time) continue;

      const scheduledUnix =
        scheduledStopTimeToUnix(s.arrival_time, staticStop.arrival_time);
      if (!scheduledUnix) continue;

      const deltaSec = s.arrival_time - scheduledUnix;
      const status = classifyBySeconds(deltaSec);

      if (!stopMap[s.stop_id]) {
        stopMap[s.stop_id] = {
          count: 0,
          late: 0,
          early: 0,
          on_time: 0,
          deltas: []
        };
      }

      stopMap[s.stop_id].count++;
      stopMap[s.stop_id][status]++;
      stopMap[s.stop_id].deltas.push(deltaSec);
    }
  }

const rows = Object.entries(stopMap).map(([stopId, d]) => {
  const stop = store.stopsById[stopId];

  const avgDeltaSec = d.deltas.length
    ? Math.round(d.deltas.reduce((a, b) => a + b, 0) / d.deltas.length)
    : 0;

  const maxDeltaSec = d.deltas.length
    ? Math.max(...d.deltas)
    : 0;

return {
  stop_id: stopId,
  stop_name: stop?.stop_name || stopId,
  stop_lat: stop?.stop_lat,
  stop_lon: stop?.stop_lon,

  trip_count: d.count,

  late: d.late,
  early: d.early,
  on_time: d.on_time,

  // canonical fields
  avg_delay_sec: avgDeltaSec,
  avg_delay_min: Math.round((avgDeltaSec / 60) * 10) / 10,
  max_delay_sec: maxDeltaSec,
  max_delay_min: Math.round((maxDeltaSec / 60) * 10) / 10,

  // legacy aliases (frontend compatibility)
  avg_delay: avgDeltaSec,
  max_delay: maxDeltaSec
};

});

  res.json({
    top_delayed: [...rows]
      .sort((a, b) => b.avg_delay_sec - a.avg_delay_sec)
      .slice(0, 20),

    top_busiest: [...rows]
      .sort((a, b) => b.trip_count - a.trip_count)
      .slice(0, 20)
  });
});


/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/delay-trend
   Rolling 30-minute delay trend in 5-minute buckets.

   SOURCE: global.cache.delayHistory — populated by server.js every
   poll cycle from vehicle delay_seconds values. This avoids the old
   tripUpdates.timestamp approach, where DRT's feed sends timestamp=0
   on most entries, leaving every bucket empty.

   Each bucket shows the average delay_seconds across all vehicles
   whose GPS timestamp fell inside that 5-minute window.
─────────────────────────────────────────────────────────────── */

router.get('/delay-trend', (_req, res) => {
  if (!ensureData(res)) return;

  const now       = Date.now();
  const windowMs  = 30 * 60 * 1000;  // 30-minute rolling window
  const bucketMs  =  5 * 60 * 1000;  // 5-minute buckets
  const history   = global.cache.delayHistory || [];

  // Build time-labelled buckets
  const buckets = [];
  for (let t = now - windowMs; t < now; t += bucketMs) {
    const bucketStart = t;
    const bucketEnd   = t + bucketMs;

    const inBucket = history.filter(h =>
      h.ts >= bucketStart && h.ts < bucketEnd &&
      typeof h.delay_sec === 'number' &&
      Math.abs(h.delay_sec) <= 90 * 60   // exclude stale-trip outliers
    );

    const avgDelaySec = inBucket.length
      ? Math.round(inBucket.reduce((a, b) => a + b.delay_sec, 0) / inBucket.length)
      : null;

    // Count breakdown
    const lateCount   = inBucket.filter(h => h.delay_sec > 329).length;
    const earlyCount  = inBucket.filter(h => h.delay_sec < -29).length;
    const onTimeCount = inBucket.length - lateCount - earlyCount;

    buckets.push({
      label:         new Date(t).toLocaleTimeString('en-CA', {
                       timeZone: 'America/Toronto',
                       hour: '2-digit', minute: '2-digit', hour12: false,
                     }),
      avg_delay_sec: avgDelaySec,
      avg_delay_min: avgDelaySec != null
        ? Math.round((avgDelaySec / 60) * 10) / 10
        : null,
      trip_count:    inBucket.length,
      late_count:    lateCount,
      early_count:   earlyCount,
      on_time_count: onTimeCount,
    });
  }

  res.json({ window_minutes: 30, bucket_minutes: 5, buckets });
});


/* ───────────────────────────────────────────────────────────────
   EXPORT ROUTER (ONLY ONCE)
─────────────────────────────────────────────────────────────── */

module.exports = router;