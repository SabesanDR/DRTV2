'use strict';
/**
 * Analytics API — serves all dashboard metrics from in-memory data.
 * No database required.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ── helpers ──────────────────────────────────────────────────────
function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function pct(n, total) {
  return total ? Math.round(n / total * 100) : 0;
}

// GET /api/analytics/overview — top-level KPIs
router.get('/overview', (_req, res) => {
  const vehicles    = global.cache.vehicles    || [];
  const tripUpdates = global.cache.tripUpdates || [];
  const alerts      = global.cache.alerts      || [];
  const store       = db.store;

  const delays   = tripUpdates.map(u => u.arrival_delay || 0);
  const onTimeCt = delays.filter(d => Math.abs(d) <= 300).length;
  const avgDelay = Math.round(avg(delays));

  const activeRoutes = new Set(vehicles.map(v => v.route_id).filter(Boolean)).size;

  // GPS data quality
  const snapped      = vehicles.filter(v => v.snapped).length;
  const stale        = vehicles.filter(v => v.is_stale).length;
  const teleported   = vehicles.filter(v => v.teleport_flagged).length;
  const withGPS      = vehicles.filter(v => v.latitude && v.longitude).length;

  // Feed latency
  const now = Date.now();
  const feedAge = (ts) => ts ? Math.round((now - new Date(ts).getTime()) / 1000) : null;

  res.json({
    vehicles:        vehicles.length,
    activeRoutes,
    totalRoutes:     store.routesList.length,
    totalStops:      Object.keys(store.stopsById).length,
    alerts:          alerts.length,
    delayedTrips:    delays.filter(d => d > 300).length,
    onTimePercent:   pct(onTimeCt, delays.length),
    avgDelaySeconds: avgDelay,
    avgDelayMinutes: Math.round(avgDelay / 60 * 10) / 10,

    dataQuality: {
      vehiclesWithGPS:    withGPS,
      snappedVehicles:    snapped,
      snappedPercent:     pct(snapped, vehicles.length),
      staleVehicles:      stale,
      stalePercent:       pct(stale, vehicles.length),
      teleportFlagged:    teleported,
    },
    feedLatency: {
      vehicles_age_sec:    feedAge(global.cache.lastUpdated.vehicles),
      tripUpdates_age_sec: feedAge(global.cache.lastUpdated.tripUpdates),
      alerts_age_sec:      feedAge(global.cache.lastUpdated.alerts),
    },
  });
});

// GET /api/analytics/on-time — per-route on-time performance
router.get('/on-time', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];
  const store       = db.store;

  // Group delays by route
  const byRoute = {};
  for (const u of tripUpdates) {
    if (!u.route_id) continue;
    if (!byRoute[u.route_id]) byRoute[u.route_id] = [];
    byRoute[u.route_id].push(u.arrival_delay || 0);
  }

  const rows = Object.entries(byRoute).map(([routeId, delays]) => {
    const route    = store.routesById[routeId];
    const onTimeCt = delays.filter(d => Math.abs(d) <= 300).length;
    return {
      route_id:         routeId,
      route_short_name: route?.route_short_name || routeId,
      route_color:      route?.route_color || '0070C0',
      total_trips:      delays.length,
      on_time:          onTimeCt,
      delayed:          delays.filter(d => d > 300).length,
      early:            delays.filter(d => d < -60).length,
      on_time_percent:  pct(onTimeCt, delays.length),
      avg_delay_sec:    Math.round(avg(delays)),
      avg_delay_min:    Math.round(avg(delays) / 60 * 10) / 10,
    };
  });

  rows.sort((a, b) => b.total_trips - a.total_trips);

  // System summary
  const allDelays    = tripUpdates.map(u => u.arrival_delay || 0);
  const sysOnTime    = allDelays.filter(d => Math.abs(d) <= 300).length;

  res.json({
    system: {
      total_trips:     allDelays.length,
      on_time_percent: pct(sysOnTime, allDelays.length),
      avg_delay_sec:   Math.round(avg(allDelays)),
    },
    by_route: rows,
  });
});

// GET /api/analytics/headway — headway consistency per route
router.get('/headway', (_req, res) => {
  const vehicles = global.cache.vehicles || [];
  const store    = db.store;

  // Group vehicle timestamps by route
  const byRoute = {};
  for (const v of vehicles) {
    if (!v.route_id || !v.timestamp) continue;
    if (!byRoute[v.route_id]) byRoute[v.route_id] = [];
    byRoute[v.route_id].push(v.timestamp);
  }

  const rows = Object.entries(byRoute).map(([routeId, timestamps]) => {
    const sorted  = [...timestamps].sort((a, b) => a - b);
    const gaps    = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i] - sorted[i-1]) / 60; // minutes
      if (gap > 0 && gap < 120) gaps.push(gap);
    }
    const route = store.routesById[routeId];
    return {
      route_id:          routeId,
      route_short_name:  route?.route_short_name || routeId,
      vehicle_count:     timestamps.length,
      avg_headway_min:   gaps.length ? Math.round(avg(gaps) * 10) / 10 : null,
      min_headway_min:   gaps.length ? Math.round(Math.min(...gaps) * 10) / 10 : null,
      max_headway_min:   gaps.length ? Math.round(Math.max(...gaps) * 10) / 10 : null,
      headway_regularity: gaps.length >= 2
        ? Math.max(0, 100 - Math.round(stdDev(gaps) / (avg(gaps) || 1) * 100))
        : null,
    };
  });

  rows.sort((a, b) => (b.vehicle_count || 0) - (a.vehicle_count || 0));
  res.json({ by_route: rows });
});

// GET /api/analytics/fleet — fleet utilization
router.get('/fleet', (_req, res) => {
  const vehicles = global.cache.vehicles || [];
  const store    = db.store;

  // Vehicles per route
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
      route_id:         routeId,
      route_short_name: route?.route_short_name || routeId,
      active_vehicles:  d.active,
      stale_vehicles:   d.stale,
      live_vehicles:    d.active - d.stale,
    };
  }).sort((a, b) => b.active_vehicles - a.active_vehicles);

  const noRoute  = vehicles.filter(v => !v.route_id).length;
  const snapped  = vehicles.filter(v => v.snapped).length;
  const staleAll = vehicles.filter(v => v.is_stale).length;

  res.json({
    total_vehicles:    vehicles.length,
    active_on_route:   vehicles.length - noRoute,
    unassigned:        noRoute,
    live_gps:          vehicles.length - staleAll,
    stale_gps:         staleAll,
    snapped_to_route:  snapped,
    utilization_pct:   pct(vehicles.length - noRoute, Math.max(vehicles.length, 1)),
    by_route:          routeBreakdown.slice(0, 20),
  });
});

// GET /api/analytics/stops — top delayed / busiest stops
router.get('/stops', (_req, res) => {
  const tripUpdates = global.cache.tripUpdates || [];
  const store       = db.store;

  // Aggregate delay by stop from stop_updates
  const stopDelays = {};
  for (const u of tripUpdates) {
    for (const su of (u.stop_updates || [])) {
      if (!su.stop_id) continue;
      if (!stopDelays[su.stop_id]) stopDelays[su.stop_id] = { delays: [], count: 0 };
      stopDelays[su.stop_id].delays.push(su.arrival_delay || 0);
      stopDelays[su.stop_id].count++;
    }
  }

  const rows = Object.entries(stopDelays).map(([stopId, d]) => {
    const stop = store.stopsById[stopId];
    return {
      stop_id:        stopId,
      stop_name:      stop?.stop_name || stopId,
      stop_lat:       stop?.stop_lat,
      stop_lon:       stop?.stop_lon,
      trip_count:     d.count,
      avg_delay_sec:  Math.round(avg(d.delays)),
      avg_delay_min:  Math.round(avg(d.delays) / 60 * 10) / 10,
      max_delay_sec:  Math.max(...d.delays),
    };
  });

  rows.sort((a, b) => b.avg_delay_sec - a.avg_delay_sec);
  res.json({ top_delayed: rows.slice(0, 20), top_busiest: [...rows].sort((a,b) => b.trip_count - a.trip_count).slice(0, 20) });
});

// GET /api/analytics/delay-trend — delay over rolling history window
router.get('/delay-trend', (_req, res) => {
  const history = global.cache.delayHistory || [];
  if (!history.length) return res.json({ buckets: [], message: 'No history yet' });

  // Bucket into 5-minute intervals
  const now    = Date.now();
  const window = 30 * 60 * 1000; // 30 min
  const bucketMs = 5 * 60 * 1000;
  const numBuckets = window / bucketMs;

  const buckets = Array.from({ length: numBuckets }, (_, i) => {
    const bucketEnd   = now - i * bucketMs;
    const bucketStart = bucketEnd - bucketMs;
    const entries     = history.filter(h => h.ts >= bucketStart && h.ts < bucketEnd);
    const delays      = entries.map(h => h.delay_sec || 0);
    return {
      label:         new Date(bucketStart).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }),
      ts:            bucketStart,
      avg_delay_sec: delays.length ? Math.round(avg(delays)) : 0,
      avg_delay_min: delays.length ? Math.round(avg(delays) / 60 * 10) / 10 : 0,
      trip_count:    entries.length,
    };
  }).reverse();

  res.json({ buckets, window_minutes: 30, bucket_minutes: 5 });
});

// GET /api/analytics/gtfs-health — data quality metrics
router.get('/gtfs-health', (_req, res) => {
  const vehicles    = global.cache.vehicles    || [];
  const tripUpdates = global.cache.tripUpdates || [];
  const store       = db.store;
  const now         = Date.now();

  const feedAge = (ts) => ts ? Math.round((now - new Date(ts).getTime()) / 1000) : null;

  // Trip coverage: how many active vehicles have a known trip_id
  const withTrip   = vehicles.filter(v => v.trip_id).length;
  const withRoute  = vehicles.filter(v => v.route_id).length;
  const withGPS    = vehicles.filter(v => v.latitude && v.longitude).length;
  const snapped    = vehicles.filter(v => v.snapped).length;
  const stale      = vehicles.filter(v => v.is_stale).length;
  const teleported = vehicles.filter(v => v.teleport_flagged).length;

  const vehiclesAgeS  = feedAge(global.cache.lastUpdated.vehicles);
  const updatesAgeS   = feedAge(global.cache.lastUpdated.tripUpdates);
  const alertsAgeS    = feedAge(global.cache.lastUpdated.alerts);

  const feedStatus = (ageS) => {
    if (ageS === null) return 'unknown';
    if (ageS < 60)    return 'live';
    if (ageS < 300)   return 'delayed';
    return 'stale';
  };

  res.json({
    feeds: {
      vehicles:    { age_sec: vehiclesAgeS,  status: feedStatus(vehiclesAgeS),  count: vehicles.length },
      tripUpdates: { age_sec: updatesAgeS,   status: feedStatus(updatesAgeS),   count: tripUpdates.length },
      alerts:      { age_sec: alertsAgeS,    status: feedStatus(alertsAgeS),    count: (global.cache.alerts||[]).length },
    },
    coverage: {
      vehicles_total:      vehicles.length,
      with_trip_id:        withTrip,
      with_route_id:       withRoute,
      with_gps:            withGPS,
      trip_coverage_pct:   pct(withTrip, vehicles.length),
      route_coverage_pct:  pct(withRoute, vehicles.length),
      gps_coverage_pct:    pct(withGPS, vehicles.length),
    },
    accuracy: {
      snapped_vehicles:    snapped,
      snapped_pct:         pct(snapped, vehicles.length),
      stale_vehicles:      stale,
      stale_pct:           pct(stale, vehicles.length),
      teleport_flagged:    teleported,
    },
    static: {
      routes:   store.routesList.length,
      stops:    Object.keys(store.stopsById).length,
      trips:    Object.keys(store.tripsById).length,
      shapes:   Object.keys(store.routeShapes).length,
    },
  });
});

// ── utility ──────────────────────────────────────────────────────
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

module.exports = router;
