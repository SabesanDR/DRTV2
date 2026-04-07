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

/* ───────────────────────────────────────────────────────────────
   GTFS static ↔ RT time helpers
─────────────────────────────────────────────────────────────── */

function scheduledStopTimeToUnix(actualUnix, hhmmss) {
  if (!actualUnix || !hhmmss) return null;

  const baseDate = new Date(actualUnix * 1000);
  baseDate.setHours(0, 0, 0, 0);

  const [h, m, s] = hhmmss.split(':').map(Number);
  return Math.floor(baseDate.getTime() / 1000) + (h * 3600 + m * 60 + s);
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
  const vehicles    = global.cache.vehicles || [];
  const tripUpdates = global.cache.tripUpdates || [];
  const alerts      = global.cache.alerts || [];
  const store       = db.store;

  // ✅ Accurate on‑time calculation (same as /on-time)
  let late = 0;
  let early = 0;
  let onTime = 0;

  for (const u of tripUpdates) {
    if (!u.trip_id || !u.stop_updates?.length) continue;

    const stopTimes = store.stopTimesByTrip[u.trip_id];
    if (!stopTimes) continue;

    const rtStop = u.stop_updates[0];
    const actualUnix = rtStop.arrival_time;
    if (!actualUnix) continue;

    let staticStop = stopTimes.find(
      s => s.stop_sequence === rtStop.stop_sequence
    );

    if (!staticStop) {
      staticStop = stopTimes.find(
        s => s.stop_id === rtStop.stop_id
      );
    }
    if (!staticStop || !staticStop.arrival_time) continue;

    const scheduledUnix =
      scheduledStopTimeToUnix(actualUnix, staticStop.arrival_time);

    if (!scheduledUnix) continue;

    const deltaSec = actualUnix - scheduledUnix;
    const status = classifyArrivalBySeconds(deltaSec);

    if (status === 'late') late++;
    else if (status === 'early') early++;
    else onTime++;
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
   Route‑level on‑time performance
   (Computed from GTFS‑RT vs static stop_times)
─────────────────────────────────────────────────────────────── */

router.get('/on-time', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const byRoute = {};

  for (const u of tripUpdates) {
    if (!u.trip_id || !u.route_id || !u.stop_updates?.length) continue;

    const stopTimes = store.stopTimesByTrip[u.trip_id];
    if (!stopTimes) continue;

// Use the FIRST observed stop update
const rtStop = u.stop_updates[0];

const actualUnix = rtStop.arrival_time;
if (!actualUnix) continue;

// Match by stop_sequence
let staticStop = stopTimes.find(
  s => s.stop_sequence === rtStop.stop_sequence
);

// Fallback by stop_id
if (!staticStop || !staticStop.arrival_time) {
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
const status = classifyArrivalBySeconds(deltaSec);


    if (!byRoute[u.route_id]) {
      byRoute[u.route_id] = {
        early: 0,
        on_time: 0,
        late: 0,
        total: 0
      };
    }

    byRoute[u.route_id][status]++;
    byRoute[u.route_id].total++;
  }

  const rows = Object.entries(byRoute).map(([routeId, stats]) => {
    const route = store.routesById[routeId];

    return {
      route_id: routeId,
      route_short_name: route?.route_short_name || routeId,
      route_color: route?.route_color || '2E7D32',

      total_trips: stats.total,
      early: stats.early,
      on_time: stats.on_time,
      late: stats.late,
      on_time_percent: pct(stats.on_time, stats.total)
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
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const rows = [];

  for (const u of tripUpdates) {
    if (!u.trip_id || !u.route_id || !u.stop_updates?.length) continue;

    const stopTimes = store.stopTimesByTrip?.[u.trip_id];
    if (!stopTimes) continue;

    const rtStop = u.stop_updates[0];
const actualUnix = rtStop.arrival_time;
if (!actualUnix) continue;

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

const deltaSec = actualUnix - scheduledUnix;
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
  const vehicles = global.cache.vehicles || [];
  const store = db.store;

  const byRoute = {};

  for (const v of vehicles) {
    if (!v.route_id || !v.timestamp) continue;
    if (!byRoute[v.route_id]) byRoute[v.route_id] = [];
    byRoute[v.route_id].push(v.timestamp);
  }

  const rows = Object.entries(byRoute).map(([routeId, ts]) => {
    const sorted = [...ts].sort((a, b) => a - b);
    const gaps = [];

    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i] - sorted[i - 1]) / 60;
      if (gap > 0 && gap < 120) gaps.push(gap);
    }

    const route = store.routesById[routeId];

    return {
      route_id: routeId,
      route_short_name: route?.route_short_name || routeId,
      vehicle_count: ts.length,
      avg_headway_min: gaps.length ? Math.round(avg(gaps) * 10) / 10 : null,
      min_headway_min: gaps.length ? Math.round(Math.min(...gaps) * 10) / 10 : null,
      max_headway_min: gaps.length ? Math.round(Math.max(...gaps) * 10) / 10 : null,
      headway_regularity:
        gaps.length >= 2
          ? Math.max(0, 100 - Math.round((stdDev(gaps) / (avg(gaps) || 1)) * 100))
          : null
    };
  });

  rows.sort((a, b) => (b.vehicle_count || 0) - (a.vehicle_count || 0));
  res.json({ by_route: rows });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/fleet
   Fleet utilization and health
─────────────────────────────────────────────────────────────── */

router.get('/fleet', (_req, res) => {
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
   GET /api/analytics/stops
   Top delayed and busiest stops (GTFS-accurate)
─────────────────────────────────────────────────────────────── */

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/stops
   Top delayed and busiest stops (GTFS-accurate)
─────────────────────────────────────────────────────────────── */

router.get('/stops', (_req, res) => {
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
   Delay trend over rolling 15 minutes
─────────────────────────────────────────────────────────────── */

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/delay-trend
   Accurate delay trend (GTFS-RT vs static GTFS)
   Rolling 15 minutes, 5-minute buckets
─────────────────────────────────────────────────────────────── */

router.get('/delay-trend', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const now = Date.now();
  const windowMs = 15 * 60 * 1000;  // last 15 minutes
  const bucketMs = 5 * 60 * 1000;   // 5-minute buckets

  const buckets = [];

  for (let t = now - windowMs; t < now; t += bucketMs) {
    const bucketStartSec = Math.floor(t / 1000);
    const bucketEndSec = Math.floor((t + bucketMs) / 1000);

    const deltas = [];

    for (const u of tripUpdates) {
      if (!u.trip_id || !u.stop_updates?.length) continue;
      if (!u.timestamp) continue;

      // Only include RT updates that occurred in this time bucket
      if (u.timestamp < bucketStartSec || u.timestamp >= bucketEndSec) continue;

      const stopTimes = store.stopTimesByTrip?.[u.trip_id];
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

      deltas.push(deltaSec);
    }

    const avgDelaySec = deltas.length
      ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
      : 0;

    buckets.push({
      label: new Date(t).toLocaleTimeString('en-CA', {
        hour: '2-digit',
        minute: '2-digit'
      }),
      avg_delay_sec: avgDelaySec,
      avg_delay_min: Math.round((avgDelaySec / 60) * 10) / 10,
      trip_count: deltas.length
    });
  }

  res.json({
    window_minutes: 15,
    bucket_minutes: 5,
    buckets
  });
});


/* ───────────────────────────────────────────────────────────────
   EXPORT ROUTER (ONLY ONCE)
─────────────────────────────────────────────────────────────── */

module.exports = router;