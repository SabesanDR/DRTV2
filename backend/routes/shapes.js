'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/shapes/route/:routeId — full GeoJSON-ready shape for a route
router.get('/route/:routeId', (req, res) => {
  const { routeId } = req.params;
  const rs = db.store.routeShapes[routeId];
  if (!rs) {
    return res.json({ route_id: routeId, shapes: [], count: 0,
                      warning: 'No shape data for this route' });
  }
  // Also expose flat array for legacy map.js callers
  const flat = rs.shapes.flatMap(s =>
    s.coordinates.map(([lon, lat]) => ({ shape_pt_lat: lat, shape_pt_lon: lon }))
  );
  res.json({ route_id: routeId, shapes: rs.shapes, bbox: rs.bbox,
             data: flat, count: flat.length });
});

// GET /api/shapes — debug: counts
router.get('/', (_req, res) => {
  res.json({ total_routes_with_shapes: Object.keys(db.store.routeShapes).length });
});

module.exports = router;
