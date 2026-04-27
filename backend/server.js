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
const exportRoutes     = require('./routes/export');
const rewindRoutes     = require('./routes/rewind');
const historyStore     = require('./historyStore');
const ontimeEngine     = require('./ontimeEngine');
const garagesApi    = require('./routes/garages');

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

const { store } = require('./db');

// ── Normalize GTFS-RT trip_id to static GTFS trip_id ──
// Example:
//   RT: 5608__201026_Timetable_-_2026-04
//   Static: 5608
function normalizeTripId(rtTripId) {
  if (!rtTripId) return rtTripId;
  return rtTripId.split('__')[0];
}

function deriveRouteVariant(routeId, branch) {
  if (!routeId) return null;
  if (!branch || typeof branch !== 'string') return routeId;

  const trimmed = branch.trim();
  // Common DRT pattern: "C - Uxbridge" becomes 905C
  const letterMatch = trimmed.match(/^([A-Za-z0-9]+)\s*-\s*.*/);
  if (letterMatch) {
    const variant = letterMatch[1].toUpperCase();
    if (/^[A-Z][0-9]?$/.test(variant)) {
      return `${routeId}${variant}`;
    }
  }

  return routeId;
}

// ── Classify delay using the same thresholds as ontimeEngine ──
// (used only for console metrics, NOT for vehicle performance_status)
const EARLY_THRESHOLD_SEC = ontimeEngine.EARLY_SEC;  // -29
const LATE_THRESHOLD_SEC  = ontimeEngine.LATE_SEC;   // 329

function classifyArrivalBySeconds(deltaSec) {
  if (deltaSec > LATE_THRESHOLD_SEC) return 'late';
  if (deltaSec < EARLY_THRESHOLD_SEC) return 'early';
  return 'on_time';
}

/**
 * Convert a GTFS HH:MM:SS string to a Unix timestamp anchored to the
 * service date, using the same ±6h window logic as ontimeEngine.
 * This avoids the local-midnight bug in the old scheduledStopTimeToUnix().
 */
function scheduledStopTimeToUnix(actualUnix, hhmmss) {
  if (!actualUnix || !hhmmss) return null;

  const parts = hhmmss.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  const scheduledSecOfDay = h * 3600 + m * 60 + s;

  const DAY_SEC = 86400;
  let best = null;
  let bestDiff = Infinity;

  for (let offset = -1; offset <= 1; offset++) {
    const midnightCandidate = Math.floor(actualUnix / DAY_SEC) * DAY_SEC + offset * DAY_SEC;
    const candidate = midnightCandidate + scheduledSecOfDay;
    const diff = Math.abs(candidate - actualUnix);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  if (bestDiff > 12 * 3600) return null;
  return best;
}

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

// ── derive scheduled arrival time (unix seconds) ────────────────
function getScheduledArrivalUnix(tripId, stopSequence) {
  const tripStops = db.store.stopTimesByTrip?.[tripId] || db.store.stopTimesByTripNorm?.[tripId];
  if (!tripStops || tripStops.length === 0) return null;

  const stop = stopSequence
    ? tripStops.find(s => s.stop_sequence === stopSequence)
    : tripStops[0];

  if (!stop || stop.arrival_time_sec == null) return null;

  const serviceDateMidnight = db.store.serviceDateMidnight || 0;
  return serviceDateMidnight + stop.arrival_time_sec;
}

// ── GTFS-RT protobuf parsing ─────────────────────────────────────
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
const STALE_MS = 7 * 60_000;

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
const prevPositions = {};
const MAX_SPEED_MPS = 40;

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

      const rawTripId = vp.trip?.trip_id || '';
      const tripId = normalizeTripId(rawTripId);
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
      
      const staticShapeId =
        db.store.tripToShape?.[tripId] || null;

      const branch =
        db.store.tripToHeadsign?.[tripId] ||
        db.store.shapeToHeadsign?.[staticShapeId] ||
        null;

      const route_variant = deriveRouteVariant(routeId, branch);

      const direction_id = db.store.tripsById[tripId]?.direction_id;
      const direction = direction_id === '1' ? 'Southbound' : direction_id === '0' ? 'Northbound' : null;

      let vehicle = {
        vehicle_id:       vehicleId,

        trip_id:          tripId,
        route_id:         routeId,
        route_variant,
        direction,

        // ✅ AUTHORITATIVE DATA (static GTFS)
        branch,
        shape_id:     staticShapeId,


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

    // ── FIX: Run ontimeEngine on ALL vehicles after array is complete ──
    // This is the single authoritative source for performance_status,
    // delay_seconds, matched_stop_id, matched_stop_name, and between_stops.
    // It uses raw_latitude/raw_longitude (actual GPS) for proximity matching
    // so shape-snapping does not distort the stop-distance calculation.
    ontimeEngine.evaluateAll(vehicles, db.store);

    global.cache.vehicles    = vehicles;
    global.cache.lastUpdated.vehicles = new Date().toISOString();

    // Record to historyStore for export page (rolling 24h)
    historyStore.recordVehicles(vehicles);

    // Record delay history for analytics delay-trend chart (rolling 30 min)
    // Use vehicles rather than tripUpdates — vehicles always have delay_seconds
    // from ontimeEngine, whereas tripUpdates.arrival_delay is usually null for DRT.
    const cutoff = now - 30 * 60_000;
    global.cache.delayHistory = [
      ...global.cache.delayHistory.filter(h => h.ts > cutoff),
      ...vehicles
        .filter(v => typeof v.delay_seconds === 'number' && v.performance_status !== 'unknown')
        .map(v => ({
          vehicle_id: v.vehicle_id,
          route_id:   v.route_id,
          delay_sec:  v.delay_seconds,
          status:     v.performance_status,
          ts:         now,
        })),
    ];

    // Record history for map trails (rolling 30 min)
    global.cache.vehicleHistory = [
      ...global.cache.vehicleHistory.filter(h => h.ts > cutoff),
      ...vehicles.map(v => ({ vehicle_id: v.vehicle_id, route_id: v.route_id,
                               lat: v.latitude, lon: v.longitude, ts: now })),
    ];

    // Console summary
    const late    = vehicles.filter(v => v.performance_status === 'late').length;
    const early   = vehicles.filter(v => v.performance_status === 'early').length;
    const onTime  = vehicles.filter(v => v.performance_status === 'on_time').length;
    const unknown = vehicles.filter(v => v.performance_status === 'unknown').length;
    console.log(
      `Vehicles: ${vehicles.length} (${vehicles.filter(v => v.snapped).length} snapped) | ` +
      `Late: ${late} | Early: ${early} | OnTime: ${onTime} | Unknown: ${unknown}`
    );
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
      const rawTripId = tu.trip?.trip_id || '';
      const tripId = normalizeTripId(rawTripId);
      const routeId = tu.trip?.route_id || db.store.tripToRoute[tripId] || '';
      const ts      = Number(tu.timestamp) || Math.floor(Date.now() / 1000);

      const stopUpdates = (tu.stop_time_update || []).map(stu => {
        const arrivalDelay = (typeof stu.arrival?.delay === 'number') ? stu.arrival.delay : null;
        const departureDelay = (typeof stu.departure?.delay === 'number') ? stu.departure.delay : null;

        return {
          stop_id:         stu.stop_id || '',
          stop_sequence:   stu.stop_sequence || 0,
          arrival_delay:   arrivalDelay,
          departure_delay: departureDelay,
          arrival_time:    Number(stu.arrival?.time)   || 0,
          departure_time:  Number(stu.departure?.time)  || 0,
        };
      });

      let firstDelay = null;
      let delaySource = 'none';

      if (stopUpdates.length > 0) {
        if (updates.length < 3) {
          console.log(`[DEBUG] Trip ${tripId}: stop_updates=`, JSON.stringify(stopUpdates.slice(0, 2)));
        }

        for (const stop of stopUpdates) {
          if (stop.arrival_delay !== null && stop.arrival_delay !== undefined) {
            firstDelay = stop.arrival_delay;
            delaySource = 'arrival_delay';
            break;
          }
          if (stop.departure_delay !== null && stop.departure_delay !== undefined) {
            firstDelay = stop.departure_delay;
            delaySource = 'departure_delay';
            break;
          }
        }
      }

      let derivedDelay = null;

      if (firstDelay === null && stopUpdates.length > 0) {
        const gpsVehicle = global.cache.vehicles.find(v => v.trip_id === tripId);

        if (gpsVehicle && gpsVehicle.snapped && gpsVehicle.timestamp) {
          const nextStop = stopUpdates.find(s => s.stop_sequence > 0);
          if (nextStop) {
            const scheduledUnix = getScheduledArrivalUnix(tripId, nextStop.stop_sequence);

            if (scheduledUnix !== null && scheduledUnix > 0) {
              derivedDelay = Math.round(gpsVehicle.timestamp - scheduledUnix);
              firstDelay = derivedDelay;
              delaySource = 'derived_from_gps';
            }
          }
        }
      }

      // status string uses on_time (underscore) to match ontimeEngine convention
      let status = 'unknown';
      if (firstDelay !== null && typeof firstDelay === 'number') {
        if (firstDelay > LATE_THRESHOLD_SEC) status = 'late';
        else if (firstDelay < EARLY_THRESHOLD_SEC) status = 'early';
        else status = 'on_time';
      }

      updates.push({
        trip_id:               tripId,
        route_id:              routeId,
        arrival_delay:         firstDelay,
        derived_arrival_delay: derivedDelay,
        status,
        delay_source:          delaySource,
        stop_updates:          stopUpdates,
        timestamp:             ts,
      });
    }

    global.cache.tripUpdates    = updates;
    global.cache.lastUpdated.tripUpdates = new Date().toISOString();

    // Record to historyStore for export page (rolling 24h)
    historyStore.recordTripUpdates(updates, db.store);

    // ── Feed health statistics ──
    const delayStats = {
      with_rt_delay: updates.filter(u =>
        u.delay_source === 'arrival_delay' ||
        u.delay_source === 'departure_delay'
      ).length,
      derived_gps: updates.filter(u => u.delay_source === 'derived_from_gps').length,
      unknown:     updates.filter(u => u.delay_source === 'none').length,
    };

    // ── Console on-time metrics (static GTFS join) ──
    let late = 0, early = 0, onTime = 0;

    for (const u of updates) {
      if (!u.trip_id || !u.stop_updates?.length) continue;

      const stopTimes = db.store.stopTimesByTrip[u.trip_id];
      if (!stopTimes) continue;

      const rtStop = u.stop_updates[0];
      const actualUnix = rtStop.arrival_time;
      if (!actualUnix) continue;

      let staticStop = stopTimes.find(
        s => s.stop_sequence === rtStop.stop_sequence
      ) || stopTimes.find(
        s => s.stop_id === rtStop.stop_id
      );

      if (!staticStop || !staticStop.arrival_time) continue;

      const scheduledUnix = scheduledStopTimeToUnix(actualUnix, staticStop.arrival_time);
      if (!scheduledUnix) continue;

      const deltaSec = actualUnix - scheduledUnix;
      const status = classifyArrivalBySeconds(deltaSec);

      if (status === 'late') late++;
      else if (status === 'early') early++;
      else onTime++;
    }

    console.log(
      `Trip updates: ${updates.length} | ` +
      `RT: ${delayStats.with_rt_delay} | ` +
      `GPS: ${delayStats.derived_gps} | ` +
      `Unknown: ${delayStats.unknown} | ` +
      `Late: ${late} | Early: ${early} | OnTime: ${onTime}`
    );

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
app.use('/api/export',       exportRoutes);
app.use('/api/rewind',       rewindRoutes);
app.use('/api/garages',      garagesApi);

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
      snappedVehicles:  global.cache.vehicles.filter(v => v.snapped).length,
      staleVehicles:    global.cache.vehicles.filter(v => v.is_stale).length,
      flaggedTeleports: global.cache.vehicles.filter(v => v.teleport_flagged).length,
    },
    onTimeStatus: {
      late:    global.cache.vehicles.filter(v => v.performance_status === 'late').length,
      early:   global.cache.vehicles.filter(v => v.performance_status === 'early').length,
      on_time: global.cache.vehicles.filter(v => v.performance_status === 'on_time').length,
      unknown: global.cache.vehicles.filter(v => v.performance_status === 'unknown').length,
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

    // Prune stale ontimeEngine entries every 5 minutes
    setInterval(() => ontimeEngine.pruneState(), 5 * 60_000);

    // Refresh every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
      await Promise.allSettled([
        fetchVehiclePositions(),
        fetchTripUpdates(),
        fetchAlerts(),
      ]);
    });

    // ── Start HTTP server with proper error handling ──────────────
    // The plain app.listen() call had no error handler, so if port 3000
    // was already in use (previous process still in TIME_WAIT, or a second
    // terminal accidentally running the server), Node threw an uncaught
    // EADDRINUSE error and crashed — with no useful message.
    const server = app.listen(PORT)
      .on('listening', () => {
        console.log(`\n🚌 DRT Operations Hub → http://localhost:${PORT}`);
        console.log(`   Press Ctrl+C to stop\n`);
      })
      .on('error', err => {
        if (err.code === 'EADDRINUSE') {
          console.error(`\n❌  Port ${PORT} is already in use.`);
          console.error(`   Another instance of the server is probably running.`);
          console.error(`   To fix this, run ONE of the following:\n`);
          console.error(`   Option 1 — kill the process using the port:`);
          console.error(`     npx kill-port ${PORT}\n`);
          console.error(`   Option 2 — use a different port:`);
          console.error(`     PORT=3001 node server.js\n`);
          console.error(`   Option 3 — find and kill the process manually:`);
          console.error(`     lsof -ti :${PORT} | xargs kill -9\n`);
        } else {
          console.error('Server error:', err.message);
        }
        process.exit(1);
      });

    // ── Graceful shutdown ─────────────────────────────────────────
    // Properly close the server on SIGINT (Ctrl+C) and SIGTERM so the
    // port is released immediately — eliminating the TIME_WAIT race
    // that caused EADDRINUSE on quick restarts.
    function shutdown(signal) {
      console.log(`\n${signal} received — shutting down gracefully...`);
      server.close(() => {
        console.log('HTTP server closed. Port released. Goodbye 👋');
        process.exit(0);
      });
      // Force-kill if graceful shutdown takes more than 5 seconds
      setTimeout(() => {
        console.warn('Forced shutdown after 5s timeout.');
        process.exit(1);
      }, 5000);
    }
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
}

startServer();