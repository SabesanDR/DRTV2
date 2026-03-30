'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const { route_id, limit = 100 } = req.query;
  let updates = global.cache.tripUpdates || [];
  if (route_id) updates = updates.filter(u => u.route_id === route_id);
  res.json({ data: updates.slice(0, +limit), count: updates.length,
             lastUpdated: global.cache.lastUpdated.tripUpdates });
});

module.exports = router;
