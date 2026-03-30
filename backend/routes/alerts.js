'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const { route_id, severity } = req.query;
  let alerts = global.cache.alerts || [];
  if (route_id)  alerts = alerts.filter(a => a.affected_routes?.includes(route_id));
  if (severity)  alerts = alerts.filter(a => a.severity === severity);
  res.json({ data: alerts, count: alerts.length, lastUpdated: global.cache.lastUpdated.alerts });
});

router.get('/:alertId', (req, res) => {
  const alert = (global.cache.alerts || []).find(a => a.alert_id === req.params.alertId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(alert);
});

module.exports = router;
