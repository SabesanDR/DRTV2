'use strict';

const express = require('express');
const router  = express.Router();
const { store } = require('../db');

/* ───────────────────────────────────────────────────────────────
   On-time helpers
─────────────────────────────────────────────────────────────── */

const EARLY_THRESHOLD_SEC = -29;
const LATE_THRESHOLD_SEC  = 5 * 60 + 29;

function classifyArrivalBySeconds(deltaSec) {
  if (deltaSec > LATE_THRESHOLD_SEC) return 'late';
  if (deltaSec < EARLY_THRESHOLD_SEC) return 'early';
  return 'on_time';
}

function scheduledStopTimeToUnix(actualUnix, hhmmss) {
  if (!actualUnix || !hhmmss) return null;
  const d = new Date(actualUnix * 1000);
  d.setHours(0, 0, 0, 0);
  const [h, m, s] = hhmmss.split(':').map(Number);
  return Math.floor(d.getTime() / 1000) + h * 3600 + m * 60 + s;
}

/* ───────────────────────────────────────────────────────────────
   GET /api/vehicles
   Live vehicles with delay_seconds correctly resolved
─────────────────────────────────────────────────────────────── */

router.get('/', (req, res) => {
  const { route_id } = req.query;
  let vehicles = global.cache.vehicles || [];
  const tripUpdates = Array.isArray(global.cache.tripUpdates)
    ? global.cache.tripUpdates
    : [];

  if (route_id) {
    vehicles = vehicles.filter(v => v.route_id === route_id);
  }

  const enriched = vehicles.map(v => {
    let delay_seconds = null;
    let performance_status = 'unknown';

    if (v.trip_id) {
      const tripUpdate = tripUpdates.find(u => u.trip_id === v.trip_id);

      if (tripUpdate) {
        // ── 1. Direct arrival_delay from GTFS-RT feed (most common) ──
        if (typeof tripUpdate.arrival_delay === 'number') {
          delay_seconds = tripUpdate.arrival_delay;
          performance_status = classifyArrivalBySeconds(delay_seconds);
        }
        // ── 2. GPS-derived delay (fallback when feed has no delay field) ──
        else if (typeof tripUpdate.derived_arrival_delay === 'number') {
          delay_seconds = tripUpdate.derived_arrival_delay;
          performance_status = classifyArrivalBySeconds(delay_seconds);
        }
        // ── 3. Compute from absolute stop timestamps vs GTFS static ──
        else if (tripUpdate.stop_updates && tripUpdate.stop_updates.length > 0) {
          const rtStop = tripUpdate.stop_updates[0];
          // stop_updates use flat fields (arrival_time / departure_time), not nested
          const actualUnix = rtStop.arrival_time || rtStop.departure_time || null;
          const stopTimes = store && store.stopTimesByTrip
            ? store.stopTimesByTrip[v.trip_id]
            : null;

          if (actualUnix && stopTimes) {
            const staticStop =
              stopTimes.find(s => s.stop_sequence === rtStop.stop_sequence) ||
              stopTimes.find(s => s.stop_id === rtStop.stop_id);

            if (staticStop && staticStop.arrival_time) {
              const scheduledUnix = scheduledStopTimeToUnix(actualUnix, staticStop.arrival_time);
              if (scheduledUnix) {
                delay_seconds = actualUnix - scheduledUnix;
                performance_status = classifyArrivalBySeconds(delay_seconds);
              }
            }
          }
        }
      }

      // ── 4. Use pre-computed trip_delay on vehicle (set by server.js buildTripDelayMap) ──
      if (delay_seconds === null && typeof v.trip_delay === 'number') {
        delay_seconds = v.trip_delay;
        performance_status = classifyArrivalBySeconds(delay_seconds);
      }
    }

    return {
      ...v,
      delay_seconds,
      performance_status,
    };
  });

  res.json({
    data: enriched,
    count: enriched.length,
    lastUpdated: global.cache.lastUpdated.vehicles,
    staleCount: enriched.filter(v => v.is_stale).length,
    snappedCount: enriched.filter(v => v.snapped).length,
    lateCount: enriched.filter(v => v.performance_status === 'late').length,
    earlyCount: enriched.filter(v => v.performance_status === 'early').length,
    onTimeCount: enriched.filter(v => v.performance_status === 'on_time').length,
  });
});

/* ───────────────────────────────────────────────────────────────
   GET /api/vehicles/:vehicleId
─────────────────────────────────────────────────────────────── */

router.get('/:vehicleId', (req, res) => {
  const v = global.cache.vehicles.find(
    v => v.vehicle_id === req.params.vehicleId
  );
  if (!v) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(v);
});

module.exports = router;

