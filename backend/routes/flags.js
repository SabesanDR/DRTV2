'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/', (req, res) => {
  const flags = db.getFlags(req.query.status || null);
  res.json({ data: flags, count: flags.length });
});

router.post('/', (req, res) => {
  const { stop_id, stop_name, stop_lat, stop_lon, reason, comment, created_by } = req.body;
  if (!stop_id || !reason || stop_lat == null || stop_lon == null)
    return res.status(400).json({ error: 'Missing required fields' });
  const flag = db.addFlag({ stop_id, stop_name: stop_name || '', stop_lat: +stop_lat,
                             stop_lon: +stop_lon, reason, comment: comment || '',
                             created_by: created_by || 'web-user' });
  res.json({ success: true, flag_id: flag.flag_id });
});

router.get('/analytics/summary', (_req, res) => {
  const flags = db.getFlags();
  const byReason = {};
  flags.forEach(f => { byReason[f.reason] = (byReason[f.reason] || 0) + 1; });
  const resolved = flags.filter(f => f.status === 'resolved').length;
  res.json({ total: flags.length, resolved, open: flags.length - resolved,
             byReason, resolutionRate: flags.length ? Math.round(resolved/flags.length*100) : 0 });
});

router.get('/:flag_id', (req, res) => {
  const flag = db.getFlags().find(f => f.flag_id === +req.params.flag_id);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  res.json(flag);
});

router.put('/:flag_id', (req, res) => {
  const { status } = req.body;
  if (!['open','resolved'].includes(status))
    return res.status(400).json({ error: 'Status must be open or resolved' });
  const ok = db.updateFlag(+req.params.flag_id, status);
  if (!ok) return res.status(404).json({ error: 'Flag not found' });
  res.json({ success: true });
});

module.exports = router;
