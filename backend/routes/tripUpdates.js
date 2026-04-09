'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const { route_id, limit = 100 } = req.query;
  let updates = global.cache.tripUpdates || [];

  if (route_id) {
    updates = updates.filter(u => u.route_id === route_id);
  }

  const normalized = updates.map(u => {
    const firstStop = u.stop_updates?.[0];

    return {
      trip_id: u.trip_id,
      route_id: u.route_id,
      vehicle_id: u.vehicle_id,
      delay_seconds: firstStop?.arrival_time && firstStop?.scheduled_time
        ? firstStop.arrival_time - firstStop.scheduled_time
        : null,
      timestamp: u.timestamp
    };
  });

  res.json({
    data: normalized.slice(0, +limit),
    count: normalized.length,
    lastUpdated: global.cache.lastUpdated.tripUpdates
  });
});

module.exports = router;
