'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/routes — list all routes
router.get('/', (_req, res) => {
  res.json({ data: db.store.routesList, count: db.store.routesList.length });
});

// GET /api/routes/:route_id — single route info
router.get('/:route_id', (req, res) => {
  const route = db.store.routesById[req.params.route_id];
  if (!route) return res.status(404).json({ error: 'Route not found' });
  const rs   = db.store.routeShapes[req.params.route_id];
  res.json({ ...route, has_shape: !!rs, bbox: rs?.bbox || null });
});

// GET /api/routes/:route_id/shape — GeoJSON-ready shape + bbox
router.get('/:route_id/shape', (req, res) => {
  const rs = db.store.routeShapes[req.params.route_id];
  if (!rs) return res.status(404).json({ error: 'No shape for this route' });
  res.json(rs);
});

// GET /api/routes/:route_id/vehicles — live vehicles on this route
router.get('/:route_id/vehicles', (req, res) => {
  const vehicles = (global.cache.vehicles || [])
    .filter(v => v.route_id === req.params.route_id);
  res.json({ route_id: req.params.route_id, data: vehicles, count: vehicles.length });
});

// GET /api/routes/:route_id/stops — stops served by this route
router.get('/:route_id/stops', (req, res) => {
  const stops = db.store.stopsByRoute[req.params.route_id] || [];
  res.json({ route_id: req.params.route_id, data: stops, count: stops.length });
});

module.exports = router;
