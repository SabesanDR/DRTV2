'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Parse HH:MM:SS (GTFS allows hour > 23) → total seconds
function timeToSeconds(t) {
  if (!t) return Infinity;
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// GET /api/stops/:stopId/next-arrivals
router.get('/:stopId/next-arrivals', (req, res) => {
  const { stopId } = req.params;
  const limit = Math.min(10, parseInt(req.query.limit) || 5);

  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  // Scan stop_times across trips to find upcoming arrivals for this stop
  const hits = [];
  for (const [tripId, times] of Object.entries(db.store.stopTimes)) {
    for (const st of times) {
      if (st.stop_id !== stopId) continue;
      const sec = timeToSeconds(st.arrival_time);
      const minutesUntil = Math.round((sec - nowSec) / 60);
      if (minutesUntil < -2 || minutesUntil > 90) continue; // within window

      const routeId = db.store.tripToRoute[tripId] || '';
      const route   = db.store.routesById[routeId];
      const trip    = db.store.tripsById[tripId];

      // Live delay from RT feed
      const tripUpdate = (global.cache.tripUpdates || []).find(u => u.trip_id === tripId);
      const stopUpdate = tripUpdate?.stop_updates?.find(su => su.stop_id === stopId);
      const delayMin   = stopUpdate ? Math.round((stopUpdate.arrival_delay || 0) / 60) : 0;

      hits.push({
        trip_id:          tripId,
        route_id:         routeId,
        route_short_name: route?.route_short_name || routeId,
        route_color:      route?.route_color || '0070C0',
        direction:        trip?.trip_headsign || '',
        scheduled_arrival: st.arrival_time,
        minutes_until:    minutesUntil,
        delay_minutes:    delayMin,
        adjusted_minutes: minutesUntil + delayMin,
        status:           Math.abs(delayMin) <= 1 ? 'on-time' : delayMin > 0 ? 'delayed' : 'early',
      });
      break; // one entry per trip
    }
  }

  hits.sort((a, b) => a.adjusted_minutes - b.adjusted_minutes);
  res.json({ stop_id: stopId, arrivals: hits.slice(0, limit), count: hits.length });
});

// GET /api/stops/:stopId
router.get('/:stopId', (req, res) => {
  const stop = db.store.stopsById[req.params.stopId];
  if (!stop) return res.status(404).json({ error: 'Stop not found' });

  // Collect routes serving this stop (from stopsByRoute)
  const routeIds = new Set();
  for (const [routeId, stops] of Object.entries(db.store.stopsByRoute)) {
    if (stops.some(s => s.stop_id === req.params.stopId)) routeIds.add(routeId);
  }
  const routes = [...routeIds].map(rid => {
    const r = db.store.routesById[rid];
    return { route_id: rid, route_short_name: r?.route_short_name || rid,
             route_color: r?.route_color || '0070C0' };
  });

  res.json({ ...stop, routes, route_count: routes.length });
});

// GET /api/stops — all stops (paginated)
router.get('/', (req, res) => {
  const { limit = 2000, offset = 0 } = req.query;
  const all = Object.values(db.store.stopsById);
  res.json({ data: all.slice(+offset, +offset + +limit), count: all.length });
});

module.exports = router;
