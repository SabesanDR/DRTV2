'use strict';

const express = require('express');
const router = express.Router();

// GET /api/vehicles
router.get('/', (req, res) => {
  const { route_id } = req.query;

  let vehicles = global.cache.vehicles || [];

  if (route_id) {
    // If route_id is a variant (e.g., "905C"), filter by route_variant
    // Otherwise, filter by route_id (base route)
    const isVariant = /^[0-9]+[A-Z]$/.test(route_id);
    vehicles = vehicles.filter(v => {
      if (isVariant) {
        return v.route_variant === route_id;
      } else {
        return v.route_id === route_id;
      }
    });
  }

  const cleaned = vehicles.map(v => {
    const out = { ...v };

    delete out._scheduled_unix;
    delete out._vehicle_ts;
    delete out._arrival_time_str;

    return out;
  });

  res.json({
    data: cleaned,
    count: cleaned.length,
    lastUpdated: global.cache.lastUpdated?.vehicles,

    staleCount: cleaned.filter(v => v.is_stale).length,
    snappedCount: cleaned.filter(v => v.snapped).length,

    lateCount: cleaned.filter(v => v.performance_status === 'late').length,
    earlyCount: cleaned.filter(v => v.performance_status === 'early').length,
    onTimeCount: cleaned.filter(v => v.performance_status === 'on_time').length,
    unknownCount: cleaned.filter(v => v.performance_status === 'unknown').length,
  });
});

// GET /api/vehicles/:vehicleId
router.get('/:vehicleId', (req, res) => {
  const vehicles = global.cache.vehicles || [];
  const v = vehicles.find(v => v.vehicle_id === req.params.vehicleId);

  if (!v) {
    return res.status(404).json({ error: 'Vehicle not found' });
  }

  const out = { ...v };
  delete out._scheduled_unix;
  delete out._vehicle_ts;
  delete out._arrival_time_str;

  res.json(out);
});

module.exports = router;