/**
 * Garages API
 * Exposes operational garage locations (non-GTFS)
 */

'use strict';

const express = require('express');
const { store } = require('../db');

const router = express.Router();

// GET /api/garages
router.get('/', (req, res) => {
  res.json(store.garages || []);
});

module.exports = router;
