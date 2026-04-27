'use strict';
/**
 * ================================================================
 * Rewind API — DRT Operations Hub
 * ================================================================
 * Serves historical vehicle position data from the in-memory
 * historyStore buffer (populated every 30s by server.js).
 *
 * Endpoints:
 *   GET /api/rewind/window
 *     Returns the available time window (earliest → latest ts).
 *
 *   GET /api/rewind/snapshots?route_id=905&from=<ms>&to=<ms>&step=30
 *     Returns all distinct timestamps (bucketed) and the count of
 *     vehicles per bucket for a route within a time window.
 *     Used by the frontend to build the slider tick marks.
 *
 *   GET /api/rewind/at?route_id=905&ts=<ms>
 *     Returns vehicle positions closest to the requested timestamp
 *     (within ±20 seconds). One entry per vehicle_id (latest wins).
 *     This is the core "seek" endpoint called on every slider move.
 * ================================================================
 */

const express = require('express');
const router  = express.Router();

// Tolerance window for "nearest snapshot" lookup (ms)
const SEEK_TOLERANCE_MS = 20_000;

// ── helpers ──────────────────────────────────────────────────────

function getSnapshots() {
  return global.historyStore?.vehicleSnapshots || [];
}

/** Return all snapshots for a route within a time range. */
function snapshotsForRoute(routeId, fromMs, toMs) {
  const snaps = getSnapshots();
  if (!routeId) return snaps.filter(s => s.ts >= fromMs && s.ts <= toMs);
  return snaps.filter(s => s.route_id === routeId && s.ts >= fromMs && s.ts <= toMs);
}

/**
 * Given an array of snapshots and a target timestamp, return the
 * latest snapshot for each vehicle_id that falls within ±tolerance.
 */
function vehiclesNear(snaps, targetMs, toleranceMs) {
  const rangeMin = targetMs - toleranceMs;
  const rangeMax = targetMs + toleranceMs;
  const inRange  = snaps.filter(s => s.ts >= rangeMin && s.ts <= rangeMax);

  // One entry per vehicle: latest wins (closest to target)
  const byVehicle = {};
  for (const s of inRange) {
    const prev = byVehicle[s.vehicle_id];
    if (!prev || Math.abs(s.ts - targetMs) < Math.abs(prev.ts - targetMs)) {
      byVehicle[s.vehicle_id] = s;
    }
  }
  return Object.values(byVehicle);
}

// ── GET /api/rewind/window ────────────────────────────────────────
router.get('/window', (_req, res) => {
  const snaps = getSnapshots();
  if (!snaps.length) {
    return res.json({
      available: false,
      message:   'No history yet — data accumulates after the server starts polling.',
      earliest:  null,
      latest:    null,
      count:     0,
    });
  }
  const ts = snaps.map(s => s.ts);
  res.json({
    available: true,
    earliest:  Math.min(...ts),
    latest:    Math.max(...ts),
    count:     snaps.length,
    retention_hours: global.historyStore?.retentionHours || 24,
  });
});

// ── GET /api/rewind/snapshots ─────────────────────────────────────
// Returns bucketed timeline metadata for the slider
router.get('/snapshots', (req, res) => {
  const routeId = req.query.route_id || '';
  const now     = Date.now();
  const fromMs  = req.query.from ? parseInt(req.query.from, 10) : now - 2 * 3600_000;
  const toMs    = req.query.to   ? parseInt(req.query.to,   10) : now;
  const stepSec = Math.max(10, parseInt(req.query.step || '30', 10));
  const stepMs  = stepSec * 1000;

  const snaps   = snapshotsForRoute(routeId, fromMs, toMs);
  if (!snaps.length) {
    return res.json({ route_id: routeId, from: fromMs, to: toMs, step_sec: stepSec, buckets: [] });
  }

  // Build buckets aligned to stepMs boundaries
  const earliest = Math.min(...snaps.map(s => s.ts));
  const latest   = Math.max(...snaps.map(s => s.ts));
  const start    = Math.floor(earliest / stepMs) * stepMs;

  const bucketMap = {};
  for (const s of snaps) {
    const bucket = Math.floor(s.ts / stepMs) * stepMs;
    if (!bucketMap[bucket]) bucketMap[bucket] = new Set();
    bucketMap[bucket].add(s.vehicle_id);
  }

  const buckets = [];
  for (let t = start; t <= latest + stepMs; t += stepMs) {
    const vids = bucketMap[t];
    if (vids) {
      buckets.push({ ts: t, vehicle_count: vids.size });
    }
  }

  res.json({
    route_id:   routeId,
    from:       fromMs,
    to:         toMs,
    earliest,
    latest,
    step_sec:   stepSec,
    buckets,
  });
});

// ── GET /api/rewind/at ────────────────────────────────────────────
// Core seek endpoint: returns vehicles at a specific timestamp
router.get('/at', (req, res) => {
  const routeId   = req.query.route_id || '';
  const targetMs  = parseInt(req.query.ts, 10);

  if (!targetMs || isNaN(targetMs)) {
    return res.status(400).json({ error: 'ts (millisecond timestamp) is required' });
  }

  const windowMs  = 2 * 3600_000;
  const fromMs    = targetMs - windowMs;
  const toMs      = targetMs + windowMs;

  const snaps     = snapshotsForRoute(routeId, fromMs, toMs);
  const vehicles  = vehiclesNear(snaps, targetMs, SEEK_TOLERANCE_MS);

  const features  = vehicles.map(v => ({
    type:       'Feature',
    geometry:   { type: 'Point', coordinates: [v.lon, v.lat] },
    properties: {
      vehicle_id:   v.vehicle_id,
      route_id:     v.route_id,
      trip_id:      v.trip_id,
      bearing:      v.bearing,
      speed_kmh:    v.speed_kmh,
      perf_status:  v.perf_status,
      delay_sec:    v.delay_sec,
      ts:           v.ts,
      age_ms:       Math.abs(v.ts - targetMs),
    },
  }));

  res.json({
    type:      'FeatureCollection',
    target_ts: targetMs,
    count:     features.length,
    features,
  });
});

module.exports = router;
