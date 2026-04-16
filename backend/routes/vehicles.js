'use strict';
/**
 * ================================================================
 * GET /api/vehicles  —  DRT Operations Hub
 * ================================================================
 * Serves live vehicle data. On-time status is computed by
 * ontimeEngine.js (GPS position → nearest static stop →
 * timestamp vs scheduled arrival_time). Results are already
 * attached to each vehicle object by server.js before caching.
 * This route just serves them cleanly.
 * ================================================================
 */

const express       = require('express');
const router        = express.Router();

// ── GET /api/vehicles ─────────────────────────────────────────────

router.get('/', (req, res) => {
  const { route_id } = req.query;
  let vehicles = global.cache.vehicles || [];

  if (route_id) {
    vehicles = vehicles.filter(v => v.route_id === route_id);
  }

  // performance_status and delay_seconds are already set on each
  // vehicle by ontimeEngine.evaluateAll() in server.js.
  // We just strip internal debug fields before sending.
  const cleaned = vehicles.map(v => {
    const out = { ...v };
    delete out._scheduled_unix;
    delete out._vehicle_ts;
    delete out._arrival_time_str;
    return out;
  });

  res.json({
    data:         cleaned,
    count:        cleaned.length,
    lastUpdated:  global.cache.lastUpdated.vehicles,
    staleCount:   cleaned.filter(v => v.is_stale).length,
    snappedCount: cleaned.filter(v => v.snapped).length,
    lateCount:    cleaned.filter(v => v.performance_status === 'late').length,
    earlyCount:   cleaned.filter(v => v.performance_status === 'early').length,
    onTimeCount:  cleaned.filter(v => v.performance_status === 'on_time').length,
    unknownCount: cleaned.filter(v => v.performance_status === 'unknown').length,
  });
});

// ── GET /api/vehicles/:vehicleId ──────────────────────────────────

router.get('/:vehicleId', (req, res) => {
  const v = (global.cache.vehicles || []).find(
    v => v.vehicle_id === req.params.vehicleId
  );
  if (!v) return res.status(404).json({ error: 'Vehicle not found' });

  const out = { ...v };
  delete out._scheduled_unix;
  delete out._vehicle_ts;
  delete out._arrival_time_str;
  res.json(out);
});

module.exports = router;