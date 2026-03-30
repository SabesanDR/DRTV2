'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const { route_id } = req.query;
  let vehicles = global.cache.vehicles || [];
  if (route_id) vehicles = vehicles.filter(v => v.route_id === route_id);
  res.json({
    data: vehicles, count: vehicles.length,
    lastUpdated: global.cache.lastUpdated.vehicles,
    staleCount:  vehicles.filter(v => v.is_stale).length,
    snappedCount: vehicles.filter(v => v.snapped).length,
  });
});

router.get('/:vehicleId', (req, res) => {
  const v = global.cache.vehicles.find(v => v.vehicle_id === req.params.vehicleId);
  if (!v) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(v);
});

module.exports = router;
