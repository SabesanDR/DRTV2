/**
 * ================================================================
 * DRT In-Memory Data Store  (No SQLite / No external DB)
 * ================================================================
 * Loads pre-processed GTFS JSON files at startup.
 * Falls back to streaming from the raw GTFS zip when JSON files
 * are not yet present (first-run convenience).
 * ================================================================
 */

'use strict';

const fs        = require('fs');
const path      = require('path');
const readline  = require('readline');
const unzipper  = require('unzipper');

// ── path constants ──────────────────────────────────────────────
const JSON_DIR  = path.join(__dirname, '../data/gtfs_json');
const ZIP_PATH  = path.join(__dirname, '../data/google_transit.zip');

// ── in-memory store ─────────────────────────────────────────────
const store = {
  routesList:      [],
  routesById:      {},
  tripsById:       {},
  tripsByRoute:    {},
  shapeByTrip:     {},
  shapePoints:     {},
  routeShapes:     {},
  stopsById:       {},
  stopsByRoute:    {},
  stopTimes:       {},
  tripToRoute:     {},
  flags:           [],
  flagIdCounter:   1,
};

// ── helpers ─────────────────────────────────────────────────────
function jsonPath(name) { return path.join(JSON_DIR, name); }

function loadJSON(name) {
  const p = jsonPath(name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.warn(`  WARNING: Could not parse ${name}: ${e.message}`);
    return null;
  }
}

// ── main init ───────────────────────────────────────────────────
async function init() {
  const hasJSON = fs.existsSync(JSON_DIR) &&
    fs.existsSync(jsonPath('routes.json'));

  if (hasJSON) {
    console.log('Loading pre-processed GTFS JSON files...');
    loadFromJSON();
  } else {
    console.log('JSON files not found — streaming from GTFS zip (slow first run)...');
    await loadFromZip();
  }
  buildStopTimesByTrip();

  buildDerivedLookups();
  console.log(`Store ready: ${store.routesList.length} routes, ` +
              `${Object.keys(store.stopsById).length} stops, ` +
              `${Object.keys(store.tripsById).length} trips`);
}

// ── load from pre-processed JSON (fast) ─────────────────────────
function loadFromJSON() {
  const loaders = [
    ['routes.json',         d => { store.routesList   = d || []; }],
    ['routes_by_id.json',   d => { store.routesById   = d || {}; }],
    ['trips_by_id.json',    d => { store.tripsById    = d || {}; }],
    ['trips_by_route.json', d => { store.tripsByRoute = d || {}; }],
    ['shape_by_trip.json',  d => { store.shapeByTrip  = d || {}; }],
    ['shape_points.json',   d => { store.shapePoints  = d || {}; }],
    ['route_shapes.json',   d => { store.routeShapes  = d || {}; }],
    ['stops_by_id.json',    d => { store.stopsById    = d || {}; }],
    ['stops_by_route.json', d => { store.stopsByRoute = d || {}; }],
    ['stop_times.json',     d => { store.stopTimes    = d || {}; }],
    ['trip_to_route.json',  d => { store.tripToRoute  = d || {}; }],
  ];
  for (const [name, apply] of loaders) {
    const data = loadJSON(name);
    if (data !== null) {
      apply(data);
      console.log(`  Loaded: ${name}`);
    } else {
      console.warn(`  Missing: ${name}`);
    }
  }
}

// ── load from raw zip (slow, first-run fallback) ─────────────────
async function loadFromZip() {
  if (!fs.existsSync(ZIP_PATH)) {
    console.warn(`  GTFS zip not found at ${ZIP_PATH}`);
    return;
  }
  await loadShapesFromZip();
  await loadTripsFromZip();
  await loadRoutesFromZip();
  await loadStopsFromZip();
  await loadStopTimesFromZip();  // FIX: was missing — stopTimesByTrip was always empty on first run
}

// ── load stop_times from zip ──────────────────────────────────────
// Required for ontimeEngine ETA calculation. Streams stop_times.txt
// and groups rows by trip_id. Each entry has: trip_id, stop_id,
// stop_sequence (int), arrival_time (HH:MM:SS string).
async function loadStopTimesFromZip() {
  return new Promise(resolve => {
    const zip = fs.createReadStream(ZIP_PATH).pipe(unzipper.Parse({ forceStream: true }));
    let handled = false;
    zip.on('entry', async entry => {
      if (entry.path !== 'stop_times.txt') { entry.autodrain(); return; }
      handled = true;
      const rl = readline.createInterface({ input: entry });
      let header = null, idx = {}, count = 0;
      const grouped = {};
      rl.on('line', line => {
        const cols = line.split(',');
        if (!header) {
          header = cols;
          cols.forEach((c, i) => { idx[c.trim()] = i; });
          return;
        }
        const trip_id      = cols[idx.trip_id]?.trim();
        const stop_id      = cols[idx.stop_id]?.trim();
        const arrival_time = cols[idx.arrival_time]?.trim() || cols[idx.departure_time]?.trim() || '';
        const seq          = parseInt(cols[idx.stop_sequence], 10);
        if (!trip_id || !stop_id) return;
        if (!grouped[trip_id]) grouped[trip_id] = [];
        grouped[trip_id].push({ trip_id, stop_id, stop_sequence: seq, arrival_time });
        count++;
      });
      rl.on('close', () => {
        store.stopTimes = grouped;
        console.log(`  Loaded ${count} stop_time rows across ${Object.keys(grouped).length} trips`);
        resolve();
      });
    });
    zip.on('finish', () => { if (!handled) resolve(); });
    zip.on('error', () => resolve());
  });
}

async function loadShapesFromZip() {
  return new Promise(resolve => {
    const zip = fs.createReadStream(ZIP_PATH).pipe(unzipper.Parse({ forceStream: true }));
    let handled = false;
    zip.on('entry', async entry => {
      if (entry.path !== 'shapes.txt') { entry.autodrain(); return; }
      handled = true;
      const rl = readline.createInterface({ input: entry });
      let header = true, count = 0;
      const raw = {};
      rl.on('line', line => {
        if (header) { header = false; return; }
        const [sid, lat, lon, seq] = line.split(',');
        if (!raw[sid]) raw[sid] = [];
        raw[sid].push({ lat: parseFloat(lat), lon: parseFloat(lon), seq: parseInt(seq, 10) });
        count++;
      });
      rl.on('close', () => {
        for (const sid in raw) raw[sid].sort((a, b) => a.seq - b.seq);
        store.shapePoints = raw;
        console.log(`  Loaded ${count} shape points`);
        resolve();
      });
    });
    zip.on('finish', () => { if (!handled) resolve(); });
    zip.on('error', () => resolve());
  });
}

async function loadTripsFromZip() {
  return new Promise(resolve => {
    const zip = fs.createReadStream(ZIP_PATH).pipe(unzipper.Parse({ forceStream: true }));
    let handled = false;
    zip.on('entry', async entry => {
      if (entry.path !== 'trips.txt') { entry.autodrain(); return; }
      handled = true;
      const rl = readline.createInterface({ input: entry });
      let header = null, idx = {}, count = 0;
      rl.on('line', line => {
        const cols = line.split(',');
        if (!header) { header = cols; cols.forEach((c, i) => { idx[c.trim()] = i; }); return; }
        const trip_id  = cols[idx.trip_id]?.trim();
        const route_id = cols[idx.route_id]?.trim();
        const shape_id = cols[idx.shape_id]?.trim();
        if (!trip_id) return;
        store.tripsById[trip_id] = { trip_id, route_id, shape_id,
          trip_headsign: cols[idx.trip_headsign]?.trim() || '',
          direction_id:  cols[idx.direction_id]?.trim()  || '0',
        };
        if (route_id) {
          if (!store.tripsByRoute[route_id]) store.tripsByRoute[route_id] = [];
          store.tripsByRoute[route_id].push(trip_id);
        }
        if (shape_id) store.shapeByTrip[trip_id] = shape_id;
        count++;
      });
      rl.on('close', () => { console.log(`  Loaded ${count} trips`); resolve(); });
    });
    zip.on('finish', () => { if (!handled) resolve(); });
    zip.on('error', () => resolve());
  });
}

async function loadRoutesFromZip() {
  return new Promise(resolve => {
    const zip = fs.createReadStream(ZIP_PATH).pipe(unzipper.Parse({ forceStream: true }));
    let handled = false;
    zip.on('entry', async entry => {
      if (entry.path !== 'routes.txt') { entry.autodrain(); return; }
      handled = true;
      const rl = readline.createInterface({ input: entry });
      let header = null, idx = {};
      rl.on('line', line => {
        const cols = line.split(',');
        if (!header) { header = cols; cols.forEach((c, i) => { idx[c.trim()] = i; }); return; }
        const route_id = cols[idx.route_id]?.trim();
        if (!route_id) return;
        const r = {
          route_id,
          route_short_name: cols[idx.route_short_name]?.trim() || '',
          route_long_name:  cols[idx.route_long_name]?.trim()  || '',
          route_color:     (cols[idx.route_color]?.trim()      || '0070C0'),
          route_text_color:(cols[idx.route_text_color]?.trim() || 'FFFFFF'),
        };
        store.routesById[route_id] = r;
        store.routesList.push(r);
      });
      rl.on('close', () => { console.log(`  Loaded ${store.routesList.length} routes`); resolve(); });
    });
    zip.on('finish', () => { if (!handled) resolve(); });
    zip.on('error', () => resolve());
  });
}

async function loadStopsFromZip() {
  return new Promise(resolve => {
    const zip = fs.createReadStream(ZIP_PATH).pipe(unzipper.Parse({ forceStream: true }));
    let handled = false;
    zip.on('entry', async entry => {
      if (entry.path !== 'stops.txt') { entry.autodrain(); return; }
      handled = true;
      const rl = readline.createInterface({ input: entry });
      let header = null, idx = {}, count = 0;
      rl.on('line', line => {
        const cols = line.split(',');
        if (!header) { header = cols; cols.forEach((c, i) => { idx[c.trim()] = i; }); return; }
        const stop_id = cols[idx.stop_id]?.trim();
        if (!stop_id) return;
        store.stopsById[stop_id] = {
          stop_id,
          stop_name: cols[idx.stop_name]?.trim() || '',
          stop_code: cols[idx.stop_code]?.trim() || '',
          stop_lat:  parseFloat(cols[idx.stop_lat]),
          stop_lon:  parseFloat(cols[idx.stop_lon]),
        };
        count++;
      });
      rl.on('close', () => { console.log(`  Loaded ${count} stops`); resolve(); });
    });
    zip.on('finish', () => { if (!handled) resolve(); });
    zip.on('error', () => resolve());
  });
}

// ------------------------------------------------------------
// Build stopTimesByTrip index
//
// Handles three different stop_times.json shapes:
//   A) Already keyed by trip_id, each value is an array of rows
//   B) Flat object whose values each have a trip_id field
//   C) Raw array of rows (future-proofing)
//
// Also normalises each row so ontimeEngine always sees:
//   arrival_time   — HH:MM:SS string (converted from arrival_time_sec if needed)
//   stop_sequence  — integer
//
// Builds TWO indexes:
//   store.stopTimesByTrip        — keyed by the raw trip_id in the JSON
//   store.stopTimesByTripNorm    — keyed by the normalized trip_id
//     (strips __... suffix that DRT's GTFS-RT feed appends)
// ontimeEngine looks up both so it works regardless of whether
// the JSON was built from a feed with or without suffixes.
// ------------------------------------------------------------
function buildStopTimesByTrip() {
  store.stopTimesByTrip     = {};
  store.stopTimesByTripNorm = {};

  const stopTimesRaw = store.stopTimes || {};

  function addEntry(tripId, row) {
    // Ensure arrival_time is always an HH:MM:SS string
    if (!row.arrival_time && row.arrival_time_sec != null) {
      const sec  = row.arrival_time_sec;
      const h    = Math.floor(sec / 3600);
      const m    = Math.floor((sec % 3600) / 60);
      const s    = sec % 60;
      row = { ...row, arrival_time: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` };
    }
    // Ensure stop_sequence is a number
    if (typeof row.stop_sequence !== 'number') {
      row = { ...row, stop_sequence: parseInt(row.stop_sequence, 10) || 0 };
    }

    if (!store.stopTimesByTrip[tripId]) store.stopTimesByTrip[tripId] = [];
    store.stopTimesByTrip[tripId].push(row);

    // Also index under normalized trip_id (strip __ suffix)
    const normId = tripId.split('__')[0];
    if (normId !== tripId) {
      if (!store.stopTimesByTripNorm[normId]) store.stopTimesByTripNorm[normId] = [];
      store.stopTimesByTripNorm[normId].push(row);
    }
  }

  if (Array.isArray(stopTimesRaw)) {
    // Shape C: flat array
    for (const row of stopTimesRaw) {
      if (row.trip_id) addEntry(row.trip_id, row);
    }
  } else {
    for (const [key, value] of Object.entries(stopTimesRaw)) {
      if (Array.isArray(value)) {
        // Shape A: already grouped
        for (const row of value) addEntry(key, row);
      } else if (value && value.trip_id) {
        // Shape B: flat object entries
        addEntry(value.trip_id, value);
      }
    }
  }

  // Sort all arrays by stop_sequence
  const sortBySeq = arr => arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  for (const tripId in store.stopTimesByTrip)     sortBySeq(store.stopTimesByTrip[tripId]);
  for (const tripId in store.stopTimesByTripNorm) sortBySeq(store.stopTimesByTripNorm[tripId]);

  const rawCount  = Object.keys(store.stopTimesByTrip).length;
  const normCount = Object.keys(store.stopTimesByTripNorm).length;
  console.log(
    `[GTFS] stopTimesByTrip built: ${rawCount} trips (+ ${normCount} normalized-id aliases)`
  );
}


// ── build derived route-shape structures if loaded from zip ──────
function buildDerivedLookups() {
  if (Object.keys(store.routeShapes).length > 0) return;

  for (const [routeId, tripIds] of Object.entries(store.tripsByRoute)) {
    const counts = {};
    for (const tid of tripIds) {
      const sid = store.shapeByTrip[tid];
      if (sid && store.shapePoints[sid]) counts[sid] = (counts[sid] || 0) + 1;
    }
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 2);
    const shapes = [];
    for (const sid of top) {
      const pts = store.shapePoints[sid] || [];
      if (!pts.length) continue;
      const step = Math.max(1, Math.floor(pts.length / 600));
      const sampled = pts.filter((_, i) => i % step === 0);
      const lats = sampled.map(p => p.lat), lons = sampled.map(p => p.lon);
      shapes.push({
        shape_id: sid,
        coordinates: sampled.map(p => [p.lon, p.lat]),
        bbox: { minLat: Math.min(...lats), maxLat: Math.max(...lats),
                minLon: Math.min(...lons), maxLon: Math.max(...lons) },
      });
    }
    if (!shapes.length) continue;
    store.routeShapes[routeId] = {
      route_id: routeId, shapes,
      bbox: {
        minLat: Math.min(...shapes.map(s => s.bbox.minLat)),
        maxLat: Math.max(...shapes.map(s => s.bbox.maxLat)),
        minLon: Math.min(...shapes.map(s => s.bbox.minLon)),
        maxLon: Math.max(...shapes.map(s => s.bbox.maxLon)),
      },
    };
  }

  for (const [tid, t] of Object.entries(store.tripsById)) {
    if (t.route_id) store.tripToRoute[tid] = t.route_id;
  }
}

// ── flag management (in-memory CRUD) ─────────────────────────────
function addFlag(data) {
  const flag = { ...data, flag_id: store.flagIdCounter++, status: 'open',
                 created_at: new Date().toISOString() };
  store.flags.push(flag);
  return flag;
}

function getFlags(status = null) {
  return status ? store.flags.filter(f => f.status === status) : [...store.flags];
}

function updateFlag(flagId, status) {
  const f = store.flags.find(f => f.flag_id === flagId);
  if (!f) return false;
  f.status = status;
  if (status === 'resolved') f.resolved_at = new Date().toISOString();
  return true;
}

module.exports = { init, store, addFlag, getFlags, updateFlag };
