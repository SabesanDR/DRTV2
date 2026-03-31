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

function withinWindow(ts, windowMs) {
  return Date.now() - ts <= windowMs;
}

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/overview
   Executive KPI summary
─────────────────────────────────────────────────────────────── */

router.get('/overview', (_req, res) => {
  const vehicles    = global.cache.vehicles || [];
  const tripUpdates = global.cache.tripUpdates || [];
  const alerts      = global.cache.alerts || [];
  const store       = db.store;

  const delays = tripUpdates.map(u => u.arrival_delay || 0);
  const onTime = delays.filter(d => Math.abs(d) <= 300).length;
  const avgDelay = Math.round(avg(delays));

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

  res.json({
    vehicles: vehicles.length,
    activeRoutes,
    totalRoutes: store.routesList.length,
    totalStops: Object.keys(store.stopsById).length,
    alerts: alerts.length,

    delayedTrips: delays.filter(d => d > 300).length,
    onTimePercent: pct(onTime, delays.length),
    avgDelaySeconds: avgDelay,
    avgDelayMinutes: Math.round((avgDelay / 60) * 10) / 10,

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
   Route-level on-time performance
─────────────────────────────────────────────────────────────── */

router.get('/on-time', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const byRoute = {};

  for (const u of tripUpdates) {
    if (!u.route_id) continue;
    if (!byRoute[u.route_id]) byRoute[u.route_id] = [];
    byRoute[u.route_id].push(u.arrival_delay || 0);
  }

  const rows = Object.entries(byRoute).map(([routeId, delays]) => {
    const route = store.routesById[routeId];
    const onTimeCt = delays.filter(d => Math.abs(d) <= 300).length;

    return {
      route_id: routeId,
      route_short_name: route?.route_short_name || routeId,
      route_color: route?.route_color || '2E7D32',
      total_trips: delays.length,
      on_time: onTimeCt,
      delayed: delays.filter(d => d > 300).length,
      early: delays.filter(d => d < -60).length,
      on_time_percent: pct(onTimeCt, delays.length),
      avg_delay_sec: Math.round(avg(delays)),
      avg_delay_min: Math.round((avg(delays) / 60) * 10) / 10
    };
  });

  rows.sort((a, b) => b.total_trips - a.total_trips);

  res.json({ by_route: rows });
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
   Top delayed and busiest stops
─────────────────────────────────────────────────────────────── */

router.get('/stops', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];
  const store = db.store;

  const stopMap = {};

  for (const u of tripUpdates) {
    for (const s of u.stop_updates || []) {
      if (!s.stop_id) continue;
      if (!stopMap[s.stop_id]) stopMap[s.stop_id] = { delays: [], count: 0 };
      stopMap[s.stop_id].delays.push(s.arrival_delay || 0);
      stopMap[s.stop_id].count++;
    }
  }

  const rows = Object.entries(stopMap).map(([stopId, d]) => {
    const stop = store.stopsById[stopId];
    return {
      stop_id: stopId,
      stop_name: stop?.stop_name || stopId,
      stop_lat: stop?.stop_lat,
      stop_lon: stop?.stop_lon,
      trip_count: d.count,
      avg_delay_sec: Math.round(avg(d.delays)),
      avg_delay_min: Math.round((avg(d.delays) / 60) * 10) / 10,
      max_delay_sec: d.delays.length ? Math.max(...d.delays) : 0
    };
  });

  res.json({
    top_delayed: [...rows].sort((a, b) => b.avg_delay_sec - a.avg_delay_sec).slice(0, 20),
    top_busiest: [...rows].sort((a, b) => b.trip_count - a.trip_count).slice(0, 20)
  });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/analytics/delay-trend
   Delay trend over rolling 30 minutes
─────────────────────────────────────────────────────────────── */

router.get('/delay-trend', (_req, res) => {
  const history = global.cache.delayHistory || [];
  if (!history.length)
    return res.json({ buckets: [], message: 'No history yet' });

  const now = Date.now();
  const windowMs = 30 * 60 * 1000;
  const bucketMs = 5 * 60 * 1000;

  const buckets = [];

  for (let t = now - windowMs; t < now; t += bucketMs) {
    const entries = history.filter(h => h.ts >= t && h.ts < t + bucketMs);
    const delays = entries.map(e => e.delay_sec || 0);

    buckets.push({
      label: new Date(t).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }),
      avg_delay_sec: delays.length ? Math.round(avg(delays)) : 0,
      avg_delay_min: delays.length ? Math.round((avg(delays) / 60) * 10) / 10 : 0,
      trip_count: entries.length
    });
  }

  res.json({ window_minutes: 30, bucket_minutes: 5, buckets });
});

/* ───────────────────────────────────────────────────────────────
   EXPORT ROUTER (ONLY ONCE)
─────────────────────────────────────────────────────────────── */

module.exports = router;
