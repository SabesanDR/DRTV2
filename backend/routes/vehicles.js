'use strict';

const express = require('express');
const router  = express.Router();
const { store } = require('../db');

/* ───────────────────────────────────────────────────────────────
   Shared on‑time helpers (same as analytics)
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
   Live vehicles with performance status
─────────────────────────────────────────────────────────────── */

router.get('/', (req, res) => {
  const { route_id } = req.query;
  let vehicles = global.cache.vehicles || [];
  const tripUpdates = global.cache.tripUpdates || [];

  if (route_id) {
    vehicles = vehicles.filter(v => v.route_id === route_id);
  }

  const enriched = vehicles.map(v => {
    let performance_status = 'unknown';

    if (v.trip_id) {
      const tripUpdate = tripUpdates.find(
        u => u.trip_id === v.trip_id
      );

      if (tripUpdate?.stop_updates?.length) {
        const rtStop = tripUpdate.stop_updates[0];
        const actualUnix = rtStop.arrival_time;

        const stopTimes = store.stopTimesByTrip?.[v.trip_id];

        if (actualUnix && stopTimes) {
          let staticStop = stopTimes.find(
            s => s.stop_sequence === rtStop.stop_sequence
          ) || stopTimes.find(
            s => s.stop_id === rtStop.stop_id
          );

          if (staticStop?.arrival_time) {
            const scheduledUnix =
              scheduledStopTimeToUnix(
                actualUnix,
                staticStop.arrival_time
              );

            if (scheduledUnix) {
              
const deltaSec = actualUnix - scheduledUnix;
performance_status = classifyArrivalBySeconds(deltaSec);

            }
          }
        }
      }
    }

    return {
      ...v,
      performance_status
    };
  });

  res.json({
    data: enriched,
    count: enriched.length,
    lastUpdated: global.cache.lastUpdated.vehicles,
    staleCount: enriched.filter(v => v.is_stale).length,
    snappedCount: enriched.filter(v => v.snapped).length,
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
