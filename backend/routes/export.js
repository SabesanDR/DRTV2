'use strict';

/**
 * ================================================================
 * Historical Data Export — DRT Operations Hub
 * ================================================================
 * Exports accumulated GTFS-RT history to clean CSV files.
 *
 * Endpoints:
 *   GET /api/export/vehicle-positions   → CSV of vehicle position snapshots
 *   GET /api/export/trip-delays         → CSV of per-trip delay records
 *   GET /api/export/stop-performance    → CSV of per-stop on-time performance
 *   GET /api/export/summary             → CSV of per-route daily summary stats
 *   GET /api/export/status              → JSON info about what data is available
 *
 * Query params (all endpoints):
 *   ?from=<ISO8601 or unix ms>   filter start (default: all available)
 *   ?to=<ISO8601 or unix ms>     filter end   (default: now)
 *   ?route_id=<id>               filter to a specific route
 *   ?format=csv|json             output format (default: csv)
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ── CSV helpers ──────────────────────────────────────────────────

/**
 * Escape a single CSV cell value.
 * Wraps in quotes if it contains commas, quotes, or newlines.
 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert an array of objects to a CSV string.
 * @param {string[]} headers - ordered column names
 * @param {Object[]} rows    - data rows
 */
function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvCell(row[h])).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Send a CSV response with appropriate headers.
 */
function sendCsv(res, filename, headers, rows) {
  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// ── filter helpers ───────────────────────────────────────────────

function parseTime(val) {
  if (!val) return null;
  const n = Number(val);
  if (!isNaN(n)) return n; // unix ms
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function applyFilters(records, query) {
  let data = records;
  const from     = parseTime(query.from);
  const to       = parseTime(query.to);
  const routeId  = query.route_id;

  if (from)    data = data.filter(r => r.ts >= from);
  if (to)      data = data.filter(r => r.ts <= to);
  if (routeId) data = data.filter(r => r.route_id === routeId);

  return data;
}

function tsToIso(ms) {
  return ms ? new Date(ms).toISOString() : '';
}

// ── GET /api/export/status ────────────────────────────────────────

router.get('/status', (_req, res) => {
  const vh = global.historyStore?.vehicleSnapshots || [];
  const dh = global.historyStore?.delaySnapshots   || [];
  const sp = global.historyStore?.stopPerformance  || [];

  const oldest = arr =>
    arr.length ? new Date(Math.min(...arr.map(r => r.ts))).toISOString() : null;
  const newest = arr =>
    arr.length ? new Date(Math.max(...arr.map(r => r.ts))).toISOString() : null;

  res.json({
    vehicle_snapshots: {
      count:    vh.length,
      oldest:   oldest(vh),
      newest:   newest(vh),
    },
    delay_snapshots: {
      count:    dh.length,
      oldest:   oldest(dh),
      newest:   newest(dh),
    },
    stop_performance: {
      count:    sp.length,
      oldest:   oldest(sp),
      newest:   newest(sp),
    },
    retention_hours:  global.historyStore?.retentionHours || 24,
    endpoints: [
      'GET /api/export/vehicle-positions',
      'GET /api/export/trip-delays',
      'GET /api/export/stop-performance',
      'GET /api/export/summary',
    ],
  });
});

// ── GET /api/export/vehicle-positions ────────────────────────────

/**
 * One row per vehicle per polling cycle.
 * Columns:
 *   timestamp_iso, unix_ms, vehicle_id, route_id, trip_id,
 *   latitude, longitude, bearing, speed_kmh, occupancy_status,
 *   performance_status, delay_seconds, snapped, snap_distance_m
 */
router.get('/vehicle-positions', (req, res) => {
  const raw     = global.historyStore?.vehicleSnapshots || [];
  const records = applyFilters(raw, req.query);

  if (req.query.format === 'json') return res.json(records);

  const headers = [
    'timestamp_iso', 'unix_ms', 'vehicle_id', 'route_id', 'trip_id',
    'latitude', 'longitude', 'bearing', 'speed_kmh', 'occupancy_status',
    'performance_status', 'delay_seconds', 'snapped', 'snap_distance_m',
  ];

  const rows = records.map(r => ({
    timestamp_iso:    tsToIso(r.ts),
    unix_ms:          r.ts,
    vehicle_id:       r.vehicle_id,
    route_id:         r.route_id,
    trip_id:          r.trip_id         || '',
    latitude:         r.lat             != null ? r.lat.toFixed(6) : '',
    longitude:        r.lon             != null ? r.lon.toFixed(6) : '',
    bearing:          r.bearing         != null ? r.bearing        : '',
    speed_kmh:        r.speed_kmh       != null ? r.speed_kmh.toFixed(1) : '',
    occupancy_status: r.occupancy       != null ? r.occupancy      : '',
    performance_status: r.perf_status   || 'unknown',
    delay_seconds:    r.delay_sec       != null ? r.delay_sec      : '',
    snapped:          r.snapped         ? 'true' : 'false',
    snap_distance_m:  r.snap_dist_m     != null ? r.snap_dist_m    : '',
  }));

  const filename = `vehicle_positions_${Date.now()}.csv`;
  sendCsv(res, filename, headers, rows);
});

// ── GET /api/export/trip-delays ───────────────────────────────────

/**
 * One row per trip-update observation (every 30 s polling cycle).
 * Columns:
 *   timestamp_iso, unix_ms, trip_id, route_id, route_short_name,
 *   headsign, stop_id, stop_sequence, stop_name,
 *   arrival_delay_sec, departure_delay_sec, performance_status,
 *   scheduled_arrival_iso, actual_arrival_iso
 */
router.get('/trip-delays', (req, res) => {
  const raw     = global.historyStore?.delaySnapshots || [];
  const records = applyFilters(raw, req.query);

  if (req.query.format === 'json') return res.json(records);

  const { store } = db;

  const headers = [
    'timestamp_iso', 'unix_ms', 'trip_id', 'route_id', 'route_short_name',
    'headsign', 'stop_id', 'stop_sequence', 'stop_name',
    'arrival_delay_sec', 'departure_delay_sec', 'performance_status',
    'scheduled_arrival_iso', 'actual_arrival_iso',
  ];

  const rows = records.map(r => {
    const route         = store.routesById[r.route_id] || {};
    const trip          = store.tripsById[r.trip_id]   || {};
    const stop          = store.stopsById[r.stop_id]   || {};

    return {
      timestamp_iso:        tsToIso(r.ts),
      unix_ms:              r.ts,
      trip_id:              r.trip_id          || '',
      route_id:             r.route_id         || '',
      route_short_name:     route.route_short_name || '',
      headsign:             trip.trip_headsign  || '',
      stop_id:              r.stop_id          || '',
      stop_sequence:        r.stop_seq         != null ? r.stop_seq   : '',
      stop_name:            stop.stop_name      || '',
      arrival_delay_sec:    r.arrival_delay     != null ? r.arrival_delay   : '',
      departure_delay_sec:  r.departure_delay   != null ? r.departure_delay : '',
      performance_status:   r.perf_status       || 'unknown',
      scheduled_arrival_iso: r.scheduled_unix   ? tsToIso(r.scheduled_unix * 1000) : '',
      actual_arrival_iso:    r.actual_unix      ? tsToIso(r.actual_unix    * 1000) : '',
    };
  });

  const filename = `trip_delays_${Date.now()}.csv`;
  sendCsv(res, filename, headers, rows);
});

// ── GET /api/export/stop-performance ─────────────────────────────

/**
 * One row per stop-arrival observation.
 * Columns:
 *   timestamp_iso, unix_ms, stop_id, stop_name, stop_lat, stop_lon,
 *   route_id, route_short_name, trip_id, headsign,
 *   scheduled_arrival_iso, actual_arrival_iso,
 *   delay_seconds, performance_status
 */
router.get('/stop-performance', (req, res) => {
  const raw     = global.historyStore?.stopPerformance || [];
  const records = applyFilters(raw, req.query);

  if (req.query.format === 'json') return res.json(records);

  const { store } = db;

  const headers = [
    'timestamp_iso', 'unix_ms', 'stop_id', 'stop_name', 'stop_lat', 'stop_lon',
    'route_id', 'route_short_name', 'trip_id', 'headsign',
    'scheduled_arrival_iso', 'actual_arrival_iso',
    'delay_seconds', 'performance_status',
  ];

  const rows = records.map(r => {
    const stop  = store.stopsById[r.stop_id]   || {};
    const route = store.routesById[r.route_id] || {};
    const trip  = store.tripsById[r.trip_id]   || {};

    return {
      timestamp_iso:        tsToIso(r.ts),
      unix_ms:              r.ts,
      stop_id:              r.stop_id          || '',
      stop_name:            stop.stop_name      || '',
      stop_lat:             stop.stop_lat       != null ? stop.stop_lat.toFixed(6) : '',
      stop_lon:             stop.stop_lon       != null ? stop.stop_lon.toFixed(6) : '',
      route_id:             r.route_id          || '',
      route_short_name:     route.route_short_name || '',
      trip_id:              r.trip_id           || '',
      headsign:             trip.trip_headsign  || '',
      scheduled_arrival_iso: r.scheduled_unix   ? tsToIso(r.scheduled_unix * 1000) : '',
      actual_arrival_iso:    r.actual_unix      ? tsToIso(r.actual_unix    * 1000) : '',
      delay_seconds:        r.delay_sec         != null ? r.delay_sec      : '',
      performance_status:   r.perf_status        || 'unknown',
    };
  });

  const filename = `stop_performance_${Date.now()}.csv`;
  sendCsv(res, filename, headers, rows);
});

// ── GET /api/export/summary ───────────────────────────────────────

/**
 * Aggregated per-route summary — one row per route observed.
 * Columns:
 *   route_id, route_short_name, route_long_name,
 *   total_observations, on_time_count, late_count, early_count,
 *   on_time_pct, avg_delay_sec, max_delay_sec, min_delay_sec,
 *   period_start_iso, period_end_iso
 */
router.get('/summary', (req, res) => {
  const raw     = global.historyStore?.delaySnapshots || [];
  const records = applyFilters(raw, req.query);

  const { store } = db;

  // Group by route
  const byRoute = {};
  for (const r of records) {
    const rid = r.route_id || 'unknown';
    if (!byRoute[rid]) byRoute[rid] = [];
    byRoute[rid].push(r);
  }

  const summaryRows = Object.entries(byRoute).map(([route_id, recs]) => {
    const route    = store.routesById[route_id] || {};
    const delays   = recs.map(r => r.arrival_delay).filter(d => d != null);
    const statuses = recs.map(r => r.perf_status);

    const on_time  = statuses.filter(s => s === 'on_time').length;
    const late     = statuses.filter(s => s === 'late').length;
    const early    = statuses.filter(s => s === 'early').length;
    const total    = recs.length;

    const avgDelay = delays.length
      ? (delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(1)
      : '';
    const maxDelay = delays.length ? Math.max(...delays) : '';
    const minDelay = delays.length ? Math.min(...delays) : '';

    const times = recs.map(r => r.ts).filter(Boolean);
    const pStart = times.length ? new Date(Math.min(...times)).toISOString() : '';
    const pEnd   = times.length ? new Date(Math.max(...times)).toISOString() : '';

    return {
      route_id,
      route_short_name:  route.route_short_name || '',
      route_long_name:   route.route_long_name  || '',
      total_observations: total,
      on_time_count:     on_time,
      late_count:        late,
      early_count:       early,
      on_time_pct:       total ? ((on_time / total) * 100).toFixed(1) : '',
      avg_delay_sec:     avgDelay,
      max_delay_sec:     maxDelay,
      min_delay_sec:     minDelay,
      period_start_iso:  pStart,
      period_end_iso:    pEnd,
    };
  });

  if (req.query.format === 'json') return res.json(summaryRows);

  const headers = [
    'route_id', 'route_short_name', 'route_long_name',
    'total_observations', 'on_time_count', 'late_count', 'early_count',
    'on_time_pct', 'avg_delay_sec', 'max_delay_sec', 'min_delay_sec',
    'period_start_iso', 'period_end_iso',
  ];

  const filename = `route_summary_${Date.now()}.csv`;
  sendCsv(res, filename, headers, summaryRows);
});

module.exports = router;
