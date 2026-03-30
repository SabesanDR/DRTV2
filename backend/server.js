'use strict';
/**
 * ================================================================
 * DRT Operations Hub — Express Backend
 * No SQLite. All data in-memory via db.js / global.cache.
 * ================================================================
 */

const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const bodyParser = require('body-parser');
const path       = require('path');
const axios      = require('axios');
const protobuf   = require('protobufjs');
require('dotenv').config();

const db = require('./db');

// ── route handlers ───────────────────────────────────────────────
const vehicleRoutes    = require('./routes/vehicles');
const tripUpdateRoutes = require('./routes/tripUpdates');
const alertRoutes      = require('./routes/alerts');
const metricsRoutes    = require('./routes/metrics');
const flagsRoutes      = require('./routes/flags');
const shapesRoutes     = require('./routes/shapes');
const stopsRoutes      = require('./routes/stops');
const routesRoutes     = require('./routes/routesApi');
const analyticsRoutes  = require('./routes/analytics');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── GTFS-RT endpoints ────────────────────────────────────────────
const RT_URLS = {
  vehiclePositions: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
  tripUpdates:      'https://drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates',
  alerts:           'https://maps.durham.ca/OpenDataGTFS/alerts.pb',
};

// ── global cache ─────────────────────────────────────────────────
global.cache = {
  vehicles:    [],
  tripUpdates: [],
  alerts:      [],
  lastUpdated: { vehicles: null, tripUpdates: null, alerts: null },
  // RT history (rolling 30-min window for analytics)
  vehicleHistory: [],   // [ {vehicle_id, route_id, lat, lon, timestamp} ]
  delayHistory:   [],   // [ {trip_id, route_id, delay_sec, timestamp} ]
};

// ── haversine (meters) ───────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(df/2)**2 + Math.cos(f1)*Math.cos(f2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── snap GPS point to nearest shape polyline ────────────────────
function snapToShape(lat, lon, shapeCoords) {
  // shapeCoords: [[lon, lat], ...]  (GeoJSON order)
  if (!shapeCoords || shapeCoords.length === 0) return { lat, lon, snapped: false };

  let bestDist = Infinity, bestLat = lat, bestLon = lon;
  for (const [slon, slat] of shapeCoords) {
    const d = haversine(lat, lon, slat, slon);
    if (d < bestDist) { bestDist = d; bestLat = slat; bestLon = slon; }
  }
  const SNAP_THRESHOLD_M = 150;
  if (bestDist <= SNAP_THRESHOLD_M) {
    return { lat: bestLat, lon: bestLon, snapped: true, snap_distance_m: Math.round(bestDist) };
  }
  return { lat, lon, snapped: false, snap_distance_m: Math.round(bestDist) };
}

// ── GTFS-RT protobuf parsing ─────────────────────────────────────
// We use a hand-rolled minimal proto parser since we don't have
// the .proto file on disk. protobufjs can parse from JSON descriptor.
// Falls back to binary scan if descriptor unavailable.

const GTFS_RT_PROTO_JSON = {
  "nested": {
    "transit_realtime": {
      "nested": {
        "FeedMessage": {
          "fields": {
            "header":  { "id": 1, "type": "FeedHeader",  "rule": "required" },
            "entity":  { "id": 2, "type": "FeedEntity",  "rule": "repeated" }
          }
        },
        "FeedHeader": {
          "fields": {
            "gtfs_realtime_version": { "id": 1, "type": "string",  "rule": "required" },
            "timestamp":             { "id": 4, "type": "uint64",  "rule": "optional" }
          }
        },
        "FeedEntity": {
          "fields": {
            "id":              { "id": 1, "type": "string",        "rule": "required" },
            "is_deleted":      { "id": 2, "type": "bool",          "rule": "optional" },
            "trip_update":     { "id": 3, "type": "TripUpdate",    "rule": "optional" },
            "vehicle":         { "id": 4, "type": "VehiclePosition","rule": "optional" },
            "alert":           { "id": 5, "type": "Alert",         "rule": "optional" }
          }
        },
        "TripDescriptor": {
          "fields": {
            "trip_id":           { "id": 1, "type": "string", "rule": "optional" },
            "route_id":          { "id": 5, "type": "string", "rule": "optional" },
            "direction_id":      { "id": 6, "type": "uint32", "rule": "optional" },
            "schedule_relationship": { "id": 4, "type": "uint32", "rule": "optional" }
          }
        },
        "VehicleDescriptor": {
          "fields": {
            "id":    { "id": 1, "type": "string", "rule": "optional" },
            "label": { "id": 2, "type": "string", "rule": "optional" }
          }
        },
        "VehiclePosition": {
          "fields": {
            "trip":             { "id": 1, "type": "TripDescriptor",    "rule": "optional" },
            "position":         { "id": 2, "type": "Position",          "rule": "optional" },
            "current_stop_sequence": { "id": 3, "type": "uint32",       "rule": "optional" },
            "vehicle":          { "id": 8, "type": "VehicleDescriptor", "rule": "optional" },
            "timestamp":        { "id": 5, "type": "uint64",            "rule": "optional" },
            "congestion_level": { "id": 6, "type": "uint32",            "rule": "optional" },
            "occupancy_status": { "id": 9, "type": "uint32",            "rule": "optional" }
          }
        },
        "Position": {
          "fields": {
            "latitude":  { "id": 1, "type": "float",  "rule": "required" },
            "longitude": { "id": 2, "type": "float",  "rule": "required" },
            "bearing":   { "id": 3, "type": "float",  "rule": "optional" },
            "speed":     { "id": 4, "type": "float",  "rule": "optional" }
          }
        },
        "TripUpdate": {
          "fields": {
            "trip":    { "id": 1, "type": "TripDescriptor",          "rule": "required" },
            "vehicle": { "id": 3, "type": "VehicleDescriptor",       "rule": "optional" },
            "stop_time_update": { "id": 2, "type": "StopTimeUpdate", "rule": "repeated" },
            "timestamp": { "id": 4, "type": "uint64",                "rule": "optional" }
          }
        },
        "StopTimeUpdate": {
          "fields": {
            "stop_sequence": { "id": 1, "type": "uint32",          "rule": "optional" },
            "stop_id":       { "id": 4, "type": "string",          "rule": "optional" },
            "arrival":       { "id": 2, "type": "StopTimeEvent",   "rule": "optional" },
            "departure":     { "id": 3, "type": "StopTimeEvent",   "rule": "optional" }
          }
        },
        "StopTimeEvent": {
          "fields": {
            "delay":       { "id": 1, "type": "int32",  "rule": "optional" },
            "time":        { "id": 2, "type": "int64",  "rule": "optional" },
            "uncertainty": { "id": 3, "type": "int32",  "rule": "optional" }
          }
        },
        "Alert": {
          "fields": {
            "active_period":        { "id": 1, "type": "TimeRange",            "rule": "repeated" },
            "informed_entity":      { "id": 5, "type": "EntitySelector",       "rule": "repeated" },
            "cause":                { "id": 6, "type": "uint32",               "rule": "optional" },
            "effect":               { "id": 7, "type": "uint32",               "rule": "optional" },
            "url":                  { "id": 8, "type": "TranslatedString",     "rule": "optional" },
            "header_text":          { "id": 10, "type": "TranslatedString",    "rule": "optional" },
            "description_text":     { "id": 11, "type": "TranslatedString",    "rule": "optional" }
          }
        },
        "TimeRange": {
          "fields": {
            "start": { "id": 1, "type": "uint64", "rule": "optional" },
            "end":   { "id": 2, "type": "uint64", "rule": "optional" }
          }
        },
        "EntitySelector": {
          "fields": {
            "agency_id":  { "id": 1, "type": "string",          "rule": "optional" },
            "route_id":   { "id": 2, "type": "string",          "rule": "optional" },
            "route_type": { "id": 3, "type": "int32",           "rule": "optional" },
            "trip":       { "id": 4, "type": "TripDescriptor",  "rule": "optional" },
            "stop_id":    { "id": 5, "type": "string",          "rule": "optional" }
          }
        },
        "TranslatedString": {
          "fields": {
            "translation": { "id": 1, "type": "Translation", "rule": "repeated" }
          }
        },
        "Translation": {
          "fields": {
            "text":     { "id": 1, "type": "string", "rule": "required" },
            "language": { "id": 2, "type": "string", "rule": "optional" }
          }
        }
      }
    }
  }
};

let FeedMessage;
try {
  const root = protobuf.Root.fromJSON(GTFS_RT_PROTO_JSON);
  FeedMessage = root.lookupType('transit_realtime.FeedMessage');
} catch (e) {
  console.warn('protobuf setup warning:', e.message);
}

function decodeProtobuf(buffer) {
  if (!FeedMessage) return null;
  try {
    return FeedMessage.decode(new Uint8Array(buffer));
  } catch (e) {
    return null;
  }
}

// ── staleness check ──────────────────────────────────────────────
const STALE_MS = 90_000; // 90 seconds

function enrichVehicle(v) {
  const now = Date.now();
  const tsMs = (v.timestamp || 0) * 1000;
  const ageMs = now - tsMs;
  return {
    ...v,
    is_stale:          ageMs > STALE_MS,
    staleness_percent: Math.min(100, Math.round((ageMs / STALE_MS) * 100)),
    age_seconds:       Math.round(ageMs / 1000),
  };
}

// ── vehicle deduplication / teleport filter ──────────────────────
const prevPositions = {};  // vehicle_id → {lat, lon, ts}
const MAX_SPEED_MPS = 40;  // ~144 km/h — flag if exceeded

function filterTeleport(vehicle) {
  const id  = vehicle.vehicle_id;
  const prev = prevPositions[id];
  if (prev) {
    const dist = haversine(prev.lat, prev.lon, vehicle.latitude, vehicle.longitude);
    const dt   = Math.max(1, (vehicle.timestamp || 0) - (prev.ts || 0));
    const speed = dist / dt;
    if (speed > MAX_SPEED_MPS) {
      vehicle.teleport_flagged = true;
      vehicle.implied_speed_kmh = Math.round(speed * 3.6);
    }
  }
  prevPositions[id] = { lat: vehicle.latitude, lon: vehicle.longitude, ts: vehicle.timestamp };
  return vehicle;
}

// ── fetch vehicle positions ──────────────────────────────────────
async function fetchVehiclePositions() {
  try {
    const res = await axios.get(RT_URLS.vehiclePositions, {
      responseType: 'arraybuffer', timeout: 10_000,
      headers: { Accept: 'application/x-google-protobuf, application/octet-stream' },
    });

    const feed = decodeProtobuf(res.data);
    if (!feed || !feed.entity) throw new Error('decode failed');

    const now  = Date.now();
    const vehicles = [];

    for (const entity of feed.entity) {
      const vp = entity.vehicle;
      if (!vp || !vp.position) continue;

      const tripId   = vp.trip?.trip_id  || '';
      const routeId  = vp.trip?.route_id || db.store.tripToRoute[tripId] || '';
      const vehicleId = vp.vehicle?.id || entity.id || '';
      const lat      = vp.position.latitude;
      const lon      = vp.position.longitude;
      const ts       = Number(vp.timestamp) || Math.floor(now / 1000);

      // Get shape for snapping
      let snappedLat = lat, snappedLon = lon, snapped = false, snapDist = null;
      if (routeId) {
        const rShape = db.store.routeShapes[routeId];
        if (rShape && rShape.shapes && rShape.shapes.length > 0) {
          const snap = snapToShape(lat, lon, rShape.shapes[0].coordinates);
          snappedLat = snap.lat; snappedLon = snap.lon;
          snapped = snap.snapped; snapDist = snap.snap_distance_m;
        }
      }

      let vehicle = {
        vehicle_id:       vehicleId,
        trip_id:          tripId,
        route_id:         routeId,
        latitude:         snappedLat,
        longitude:        snappedLon,
        raw_latitude:     lat,
        raw_longitude:    lon,
        bearing:          vp.position.bearing   || 0,
        speed:            vp.position.speed      ? Math.round(vp.position.speed * 3.6) : null,
        timestamp:        ts,
        snapped,
        snap_distance_m:  snapDist,
        occupancy_status: vp.occupancy_status || 0,
        data_source:      'live',
      };

      vehicle = filterTeleport(vehicle);
      vehicles.push(enrichVehicle(vehicle));
    }

    global.cache.vehicles    = vehicles;
    global.cache.lastUpdated.vehicles = new Date().toISOString();

    // Record history for analytics (rolling 30 min)
    const cutoff = now - 30 * 60_000;
    global.cache.vehicleHistory = [
      ...global.cache.vehicleHistory.filter(h => h.ts > cutoff),
      ...vehicles.map(v => ({ vehicle_id: v.vehicle_id, route_id: v.route_id,
                               lat: v.latitude, lon: v.longitude, ts: now })),
    ];

    console.log(`Vehicles: ${vehicles.length} (${vehicles.filter(v => v.snapped).length} snapped)`);
  } catch (err) {
    console.warn('Vehicle positions error:', err.message);
  }
}

// ── fetch trip updates ───────────────────────────────────────────
async function fetchTripUpdates() {
  try {
    const res = await axios.get(RT_URLS.tripUpdates, {
      responseType: 'arraybuffer', timeout: 10_000,
      headers: { Accept: 'application/x-google-protobuf, application/octet-stream' },
    });

    const feed = decodeProtobuf(res.data);
    if (!feed || !feed.entity) throw new Error('decode failed');

    const updates = [];
    for (const entity of feed.entity) {
      const tu = entity.trip_update;
      if (!tu) continue;
      const tripId  = tu.trip?.trip_id  || '';
      const routeId = tu.trip?.route_id || db.store.tripToRoute[tripId] || '';
      const ts      = Number(tu.timestamp) || Math.floor(Date.now() / 1000);

      // Extract per-stop delays
      const stopUpdates = (tu.stop_time_update || []).map(stu => ({
        stop_id:        stu.stop_id || '',
        stop_sequence:  stu.stop_sequence || 0,
        arrival_delay:  stu.arrival?.delay   || 0,
        departure_delay:stu.departure?.delay  || 0,
        arrival_time:   Number(stu.arrival?.time)   || 0,
        departure_time: Number(stu.departure?.time)  || 0,
      }));

      const firstDelay = stopUpdates.length > 0 ? stopUpdates[0].arrival_delay : 0;

      updates.push({
        trip_id:       tripId,
        route_id:      routeId,
        arrival_delay: firstDelay,
        stop_updates:  stopUpdates,
        timestamp:     ts,
      });
    }

    global.cache.tripUpdates    = updates;
    global.cache.lastUpdated.tripUpdates = new Date().toISOString();

    // Record delay history
    const now    = Date.now();
    const cutoff = now - 30 * 60_000;
    global.cache.delayHistory = [
      ...global.cache.delayHistory.filter(h => h.ts > cutoff),
      ...updates.map(u => ({ trip_id: u.trip_id, route_id: u.route_id,
                              delay_sec: u.arrival_delay, ts: now })),
    ];

    console.log(`Trip updates: ${updates.length}`);
  } catch (err) {
    console.warn('Trip updates error:', err.message);
  }
}

// ── fetch alerts ─────────────────────────────────────────────────
async function fetchAlerts() {
  try {
    const res = await axios.get(RT_URLS.alerts, {
      responseType: 'arraybuffer', timeout: 10_000,
      headers: { Accept: 'application/x-google-protobuf, application/octet-stream' },
    });

    const feed = decodeProtobuf(res.data);
    if (!feed || !feed.entity) throw new Error('decode failed');

    const alerts = [];
    for (const entity of feed.entity) {
      const a = entity.alert;
      if (!a) continue;
      const header = a.header_text?.translation?.[0]?.text || '';
      const desc   = a.description_text?.translation?.[0]?.text || '';
      const affectedRoutes = (a.informed_entity || [])
        .map(ie => ie.route_id).filter(Boolean);

      alerts.push({
        alert_id:       entity.id,
        header_text:    header,
        description:    desc,
        severity:       ['UNKNOWN','INFO','WARNING','SEVERE'][a.effect || 0] || 'INFO',
        cause:          a.cause || 0,
        effect:         a.effect || 0,
        affected_routes: affectedRoutes,
        active_periods: (a.active_period || []).map(p => ({
          start: Number(p.start) || 0,
          end:   Number(p.end)   || 0,
        })),
      });
    }

    global.cache.alerts    = alerts;
    global.cache.lastUpdated.alerts = new Date().toISOString();
    console.log(`Alerts: ${alerts.length}`);
  } catch (err) {
    console.warn('Alerts error:', err.message);
  }
}

// ── API routes ───────────────────────────────────────────────────
app.use('/api/vehicles',     vehicleRoutes);
app.use('/api/trip-updates', tripUpdateRoutes);
app.use('/api/alerts',       alertRoutes);
app.use('/api/metrics',      metricsRoutes);
app.use('/api/flags',        flagsRoutes);
app.use('/api/shapes',       shapesRoutes);
app.use('/api/stops',        stopsRoutes);
app.use('/api/routes',       routesRoutes);
app.use('/api/analytics',    analyticsRoutes);

// ── health ───────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const store = db.store;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gtfs: {
      routes:  store.routesList.length,
      stops:   Object.keys(store.stopsById).length,
      trips:   Object.keys(store.tripsById).length,
      shapes:  Object.keys(store.routeShapes).length,
    },
    realtime: {
      vehicles:    global.cache.vehicles.length,
      tripUpdates: global.cache.tripUpdates.length,
      alerts:      global.cache.alerts.length,
      lastUpdated: global.cache.lastUpdated,
    },
    dataQuality: {
      snappedVehicles: global.cache.vehicles.filter(v => v.snapped).length,
      staleVehicles:   global.cache.vehicles.filter(v => v.is_stale).length,
      flaggedTeleports:global.cache.vehicles.filter(v => v.teleport_flagged).length,
    },
  });
});

app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '../frontend/index.html')));

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── startup ──────────────────────────────────────────────────────
async function startServer() {
  try {
    await db.init();
    console.log('GTFS data loaded');

    // Initial RT fetch
    await Promise.allSettled([
      fetchVehiclePositions(),
      fetchTripUpdates(),
      fetchAlerts(),
    ]);

    // Refresh every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
      await Promise.allSettled([
        fetchVehiclePositions(),
        fetchTripUpdates(),
        fetchAlerts(),
      ]);
    });

    app.listen(PORT, () => {
      console.log(`\n🚌 DRT Operations Hub running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
}

startServer();
