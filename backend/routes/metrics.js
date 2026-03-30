'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/', (_req, res) => {
  const vehicles    = global.cache.vehicles    || [];
  const tripUpdates = global.cache.tripUpdates || [];
  const alerts      = global.cache.alerts      || [];
  const store       = db.store;

  const delays = tripUpdates.map(u => u.arrival_delay || 0);
  const onTime = delays.filter(d => Math.abs(d) <= 300).length;

  res.json({
    // Legacy shape (map.js reads this)
    routes: store.routesList,
    stops:  Object.values(store.stopsById),
    metrics: {
      activeVehicles: vehicles.length,
      activeRoutes:   new Set(vehicles.map(v => v.route_id).filter(Boolean)).size,
      activeAlerts:   alerts.length,
      delayedTrips:   delays.filter(d => d > 300).length,
      totalRoutes:    store.routesList.length,
      totalStops:     Object.keys(store.stopsById).length,
      totalTrips:     Object.keys(store.tripsById).length,
      onTimePercent:  delays.length ? Math.round(onTime / delays.length * 100) : null,
    },
    lastUpdated: global.cache.lastUpdated,
  });
});

router.get('/route/:route_id', (req, res) => {
  const { route_id } = req.params;
  const vehicles    = (global.cache.vehicles    || []).filter(v => v.route_id === route_id);
  const tripUpdates = (global.cache.tripUpdates || []).filter(u => u.route_id === route_id);
  const route       = db.store.routesById[route_id];
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const delays   = tripUpdates.map(u => u.arrival_delay || 0);
  const avgDelay = delays.length ? Math.round(delays.reduce((s, d) => s + d, 0) / delays.length) : 0;
  const onTime   = delays.filter(d => Math.abs(d) <= 300).length;

  res.json({
    route,
    activeVehicles: vehicles.length,
    averageDelay:   avgDelay,
    onTimePercent:  delays.length ? Math.round(onTime / delays.length * 100) : null,
    delayedTrips:   delays.filter(d => d > 300).length,
    lastUpdated:    global.cache.lastUpdated.vehicles,
  });
});

module.exports = router;
