# DRT Operations Hub

Real-Time Durham Region Transit operations dashboard.  
**No SQLite. No external database.** All data stored in-memory from GTFS files.

## Quick Start

```bash
# Option A — automated
./setup.sh          # Linux/Mac
setup.bat           # Windows

# Option B — manual
cd python
python3 preprocess_gtfs.py --gtfs-zip ../data/google_transit.zip --out ../data/gtfs_json

cd ../backend
npm install
node server.js
```

Then open **http://localhost:3000**

---

## Architecture

```
data/
  google_transit.zip   ← GTFS static (routes, trips, shapes, stops, stop_times)
  gtfs_json/           ← Pre-processed JSON (created by preprocess_gtfs.py)

python/
  preprocess_gtfs.py   ← Reads zip → writes 11 optimized JSON files

backend/
  db.js                ← In-memory store; loads JSON files or falls back to zip
  server.js            ← Express + real protobuf GTFS-RT parsing + GPS snapping
  routes/
    routesApi.js       ← GET /api/routes, /api/routes/:id/shape, /vehicles, /stops
    vehicles.js        ← GET /api/vehicles (with staleness metadata)
    analytics.js       ← All 6 analytics endpoints (on-time, headway, fleet, etc.)
    shapes.js          ← GET /api/shapes/route/:id
    stops.js           ← GET /api/stops/:id, next-arrivals
    alerts.js          ← GET /api/alerts
    flags.js           ← CRUD for flagged stops (in-memory)
    metrics.js         ← System metrics
    tripUpdates.js     ← GTFS-RT trip delays

frontend/
  index.html           ← Single page app
  css/style.css        ← Full design system
  js/app.js            ← Main controller, dashboard, KPIs
  js/map.js            ← Leaflet map, route selector, GPS snapping display
  js/analytics.js      ← Chart.js analytics panels
  js/admin.js          ← Flagged stops admin
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | System health + data quality stats |
| GET | `/api/routes` | All routes |
| GET | `/api/routes/:id/shape` | GeoJSON shape + bbox |
| GET | `/api/routes/:id/vehicles` | Live vehicles on route |
| GET | `/api/routes/:id/stops` | Stops served by route |
| GET | `/api/vehicles` | All vehicles (with snapping metadata) |
| GET | `/api/vehicles?route_id=X` | Filter by route |
| GET | `/api/alerts` | Service alerts |
| GET | `/api/stops/:id` | Stop info + routes |
| GET | `/api/stops/:id/next-arrivals` | Upcoming arrivals |
| GET | `/api/analytics/overview` | KPI summary |
| GET | `/api/analytics/on-time` | On-time % per route |
| GET | `/api/analytics/delay-trend` | 30-min rolling delay trend |
| GET | `/api/analytics/fleet` | Fleet utilization |
| GET | `/api/analytics/headway` | Headway consistency |
| GET | `/api/analytics/stops` | Top delayed/busiest stops |
| GET | `/api/analytics/gtfs-health` | Data quality metrics |
| POST | `/api/flags` | Report stop issue |
| GET | `/api/flags` | List flags |
| PUT | `/api/flags/:id` | Resolve flag |

## Key Features

- **Real protobuf decoding** — GTFS-RT feed parsed with embedded proto schema
- **GPS snapping** — vehicle positions snapped to nearest route polyline (≤150m threshold)
- **Teleport detection** — flags GPS jumps implying >144 km/h movement
- **Route-based map view** — dropdown → draws shape, shows stops, zooms to bounds
- **Staleness tracking** — vehicles flagged after 90s without update
- **Analytics dashboard** — on-time %, headway, fleet utilization, delay trends, GTFS health
- **No database** — everything in Node.js memory from pre-processed JSON files
