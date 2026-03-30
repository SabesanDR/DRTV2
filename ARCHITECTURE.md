# Durham Region Transit App - Architecture & Technical Guide

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (Browser)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  HTML5/CSS3 + Vanilla JavaScript (SPA)                   │  │
│  │  ├─ Dashboard (System Overview)                          │  │
│  │  ├─ Live Map (Leaflet.js + Real-time Vehicles)          │  │
│  │  ├─ Reports (Chart.js Analytics)                        │  │
│  │  ├─ Intelligence (Predictions & Insights)               │  │
│  │  └─ Admin Panel (Flags & Data Management)               │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↕ HTTP/REST
┌─────────────────────────────────────────────────────────────────┐
│              Backend API (Node.js + Express)                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Routes:                                                 │  │
│  │  ├─ GET /api/vehicles          → Vehicle positions      │  │
│  │  ├─ GET /api/trip-updates      → Delay data            │  │
│  │  ├─ GET /api/alerts            → Service alerts        │  │
│  │  ├─ GET /api/metrics           → System metrics        │  │
│  │  ├─ GET/POST /api/flags        → Flagged stops         │  │
│  │  └─ POST /api/predict/*        → ML predictions        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌────────────────────────────┐    ┌──────────────────────┐   │
│  │  In-Memory Cache           │    │  Scheduler (cron)    │   │
│  │  - Vehicles                │    │  - Fetch RT feeds    │   │
│  │  - Alerts                  │    │  - Update cache      │   │
│  │  - Trip Updates            │    │  - Every 30s         │   │
│  └────────────────────────────┘    └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│              Data Processing (Python)                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  parse_gtfs.py → Loads GTFS static to SQLite             │  │
│  │  predict.py    → ML models (delay, congestion)           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│        Data Layer (SQLite Database)                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Tables:                                                 │  │
│  │  ├─ routes            (static GTFS)                      │  │
│  │  ├─ stops             (static GTFS)                      │  │
│  │  ├─ trips             (static GTFS)                      │  │
│  │  ├─ stop_times        (static GTFS)                      │  │
│  │  ├─ trip_updates_history (for ML)                        │  │
│  │  ├─ flagged_stops     (user reports)                     │  │
│  │  └─ static_metrics    (computed)                         │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│        External Data Sources (Durham Open Data Portal)          │
│  ├─ GTFS Static Schedule (google_transit.zip)                  │
│  ├─ GTFS-RT Vehicle Positions (protobuf)                       │
│  ├─ GTFS-RT Trip Updates (protobuf)                            │
│  ├─ GTFS-RT Service Alerts (protobuf)                          │
│  ├─ Routes GeoJSON (REST API)                                  │
│  └─ Stops GeoJSON (REST API)                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. System Initialization
```
1. Backend starts → Connect to SQLite
2. Load GTFS tables from database
3. Initialize empty cache
4. Start scheduler for real-time updates
5. Serve frontend static files
```

### 2. Real-Time Data Pipeline (Every 30 seconds)
```
Scheduler:
  → Fetch GTFS-RT protobuf feeds (vehicles, trips, alerts)
  → Decode protobuf messages
  → Transform to JSON format
  → Update global.cache
  → Optionally store trip_updates_history for ML
```

### 3. Frontend Data Requests
```
User navigates tab:
  → Dashboard: fetch /metrics, /vehicles, /alerts
  → Map: fetch /vehicles, /flags (then render with Leaflet)
  → Reports: fetch /trip-updates (then chart with Chart.js)
  → Intelligence: fetch /metrics, /flags/analytics/summary
  → Admin: fetch /flags (filtered by status)
```

### 4. Prediction Pipeline
```
User inputs route + stop in Intelligence tab:
  → Frontend POST to /api/predict/delay
  → Backend calls Python predict.py script
  → Python queries trip_updates_history from SQLite
  → Calculate historical average delay
  → Return JSON with prediction + confidence
  → Frontend displays result
```

## Key Components

### Frontend (SPA - Single Page Application)

**Entry Point**: `frontend/index.html`
```html
- Leaflet.js library for mapping
- Chart.js for analytics
- Vanilla JavaScript (no frameworks)
- 5 main tabs with dynamic content
```

**JavaScript Modules**:
1. **app.js** - Core application logic, tab switching, dashboard updates
2. **map.js** - Leaflet map initialization, layer management, flagging
3. **analytics.js** - Chart creation, report loading, predictions
4. **admin.js** - Admin authentication, flag management, data upload

**CSS**: `css/style.css`
- Responsive grid layout
- Mobile-friendly design
- Component styling (cards, charts, tables)
- 1000+ lines of clean CSS

### Backend (Express.js API)

**Entry Point**: `backend/server.js`
```javascript
- Port: 3000 (configurable via .env)
- CORS enabled for frontend communication
- Body parser for JSON
- Scheduler for real-time data
- Static file serving (serves frontend)
```

**Route Handlers**:
1. **vehicles.js** - Current vehicle positions, filtered by route
2. **tripUpdates.js** - Trip delays, historical data storage
3. **alerts.js** - Service alerts, severity filtering
4. **metrics.js** - System overview, route-specific stats
5. **flags.js** - CRUD for flagged stops, analytics
6. **predict.js** - Calls Python ML models via child_process

**Database** (`db.js`):
- SQLite connection management
- Automatic table creation
- Promise-based query interface
- Index creation for performance

### Python Scripts

**parse_gtfs.py**: GTFS Data Loader
```python
- Reads google_transit.zip
- Extracts & parses CSV files
- Loads into SQLite with proper schema
- Creates indexes
- Computes static metrics
- ~300 lines with full error handling
```

**predict.py**: Predictive Analytics
```python
- Three prediction methods:
  1. delay() - Historical average delays by route/stop/hour
  2. congestion() - Stop activity prediction by time-of-day
  3. alert_impact() - Trip/stop count affected by alerts
- JSON input/output
- Confidence scoring
- ~250 lines of ML logic
```

## Database Schema

### ROUTES Table
```sql
route_id (PRIMARY KEY)
route_short_name
route_long_name
route_type (0-3: tram, subway, bus, ferry)
route_url
route_color
route_text_color
```

### STOPS Table
```sql
stop_id (PRIMARY KEY)
stop_code
stop_name
stop_lat
stop_lon
stop_url
zone_id
stop_timezone
```

### TRIPS Table
```sql
trip_id (PRIMARY KEY)
route_id (FOREIGN KEY)
service_id
trip_headsign
direction_id (0 or 1)
```

### STOP_TIMES Table
```sql
trip_id (FOREIGN KEY)
stop_sequence
stop_id (FOREIGN KEY)
arrival_time
departure_time
stop_headsign
pickup_type
drop_off_type
PRIMARY KEY: (trip_id, stop_sequence)
```

### TRIP_UPDATES_HISTORY Table
```sql
id (PRIMARY KEY, AUTO INCREMENT)
trip_id
stop_id
arrival_delay (seconds)
departure_delay (seconds)
timestamp (for time-of-day patterns)
route_id
Indexes: trip_id, stop_id, route_id
```

### FLAGGED_STOPS Table
```sql
flag_id (PRIMARY KEY, AUTO INCREMENT)
stop_id (FOREIGN KEY)
stop_name
stop_lat
stop_lon
reason (enum: missing_shelter, safety_concern, etc.)
comment
status (open/resolved)
created_at
resolved_at
created_by
```

## Real-Time Data Handling

### Cache Structure
```javascript
global.cache = {
  vehicles: [
    {
      vehicle_id: "123",
      route_id: "5",
      latitude: 43.85,
      longitude: -79.05,
      timestamp: "2024-03-24T14:30:00Z",
      trip_id: "trip_001",
      arrival_delay: 120 // seconds
    },
    // ... more vehicles
  ],
  tripUpdates: [
    {
      trip_id: "trip_001",
      stop_id: "stop_123",
      arrival_delay: 180,
      departure_delay: 180,
      route_id: "5"
    },
    // ... more updates
  ],
  alerts: [
    {
      alert_id: "alert_001",
      severity: "SEVERE",
      header_text: "Service disruption",
      description: "Route 5 delayed",
      affected_routes: ["5", "7"],
      effect_text: "REDUCED_SERVICE"
    },
    // ... more alerts
  ],
  lastUpdated: {
    vehicles: "2024-03-24T14:30:15Z",
    tripUpdates: "2024-03-24T14:30:15Z",
    alerts: "2024-03-24T14:30:15Z"
  }
}
```

### Scheduler (node-cron)
```javascript
// Every 30 seconds
cron.schedule('*/30 * * * * *', async () => {
  // Fetch real-time data
  // Decode protobuf
  // Update cache
  // Save history
})
```

## Flagged Stops Feature

### Workflow
```
1. User right-clicks on map stop
   ↓
2. Modal popup appears with:
   - Stop ID (read-only)
   - Stop name (read-only)
   - Issue type dropdown
   - Comment textarea
   ↓
3. After submit:
   - Frontend POST /api/flags
   - Backend inserts into flagged_stops table
   - Success response with flag_id
   ↓
4. Flagged stop appears on map with special marker
   (orange flag icon with flag emoji)
   ↓
5. Admin can:
   - View all flags
   - Click "Resolve" to mark as done
   - View flag analytics (frequency by type)
```

## Predictive Analytics

### Delay Prediction Algorithm
```
Input: route_id, stop_id, hour_of_day

Process:
1. Query trip_updates_history for route + stop
2. Calculate average arrival_delay
3. Calculate confidence based on sample size
4. Return {
     predicted_delay_seconds,
     confidence: 0.0-1.0,
     basis_samples,
     model: "historical_average"
   }

Confidence = 0.3 + min(0.6, sample_count / 100)
```

### Stop Congestion Forecast Algorithm
```
Input: stop_id, hours_ahead (1-4)

Process:
1. Query historical arrivals at stop
2. Determine future hour (now + hours_ahead)
3. Check if hour is peak (7-9am, 4-7pm)
4. Peak probability: 0.7, Off-peak: 0.4
5. Return {
     predicted_hour,
     congestion_probability,
     expected_arrivals_estimate,
     model: "time_of_day_pattern"
   }
```

## Performance Considerations

### Optimization Strategies

1. **Database Indexes**
   - trip_id (for queries)
   - route_id (for filtering)
   - status (for flag queries)
   - Speeds up queries from ~500ms to <50ms

2. **Caching**
   - In-memory cache for real-time data
   - 30-second update interval (balance freshness vs load)
   - Avoids repeated DB queries for frequently-accessed data

3. **Frontend**
   - Lazy-load charts only when Reports tab clicked
   - Map layers are toggled (hidden vs shown)
   - Limited vehicle markers (only visible bounds)
   - CSS animations use transform/opacity (GPU)

4. **Database**
   - SQLite file-based (no network overhead)
   - Indexes on foreign key columns
   - VACUUM command for cleanup (optional)

## API Response Examples

### GET /api/vehicles
```json
{
  "data": [
    {
      "vehicle_id": "123",
      "route_id": "5",
      "latitude": 43.85,
      "longitude": -79.05,
      "timestamp": "2024-03-24T14:30:00Z"
    }
  ],
  "count": 45,
  "lastUpdated": "2024-03-24T14:30:15Z"
}
```

### POST /api/predict/delay
```json
{
  "route_id": "5",
  "stop_id": "12345",
  "predicted_delay_seconds": 240,
  "confidence": 0.75,
  "basis_samples": 156,
  "model": "historical_average"
}
```

### GET /api/flags/analytics/summary
```json
{
  "flagsByReason": [
    {"reason": "missing_shelter", "count": 12, "status": "open"},
    {"reason": "safety_concern", "count": 5, "status": "open"}
  ],
  "resolutionRate": {
    "total": 25,
    "resolved": 8,
    "percentage": 32
  }
}
```

## Deployment Considerations

### Local Development
- Single machine
- Port 3000
- SQLite (file-based)
- Real-time updates every 30s

### Production Deployment
1. **Server**
   - Multi-process PM2/Supervisor
   - Reverse proxy (nginx)
   - SSL/TLS certificates
   - Environment variables (not .env)

2. **Database**
   - PostgreSQL or MySQL (instead of SQLite)
   - Connection pooling
   - Backup strategy
   - Replication

3. **Caching**
   - Redis for distributed cache
   - Session management
   - Rate limiting

4. **Maps**
   - Vector tile server (tileserver-gl)
   - CDN for static assets
   - Map data caching

5. **Monitoring**
   - Health check endpoints
   - Error logging (Sentry)
   - Performance monitoring (New Relic)
   - Log aggregation (ELK)

## Security Considerations

### Current Limitations
- Simple password for admin (no encryption)
- No user authentication
- No rate limiting
- CORS allows all origins
- No input validation on some fields

### Production Recommendations
1. Implement OAuth 2.0 / OpenID Connect
2. Add input validation & sanitization
3. Enable rate limiting per IP/user
4. Use HTTPS only
5. Implement CSRF protection
6. Add API key authentication for external services
7. Database connection with least-privilege user
8. Secrets management (HashiCorp Vault, AWS Secrets)

## Testing Strategy

### Unit Tests (Not included, but recommended)
```javascript
// Test prediction algorithms
// Test database queries
// Test API endpoints
```

### Integration Tests
```javascript
// Full request-response cycles
// Database with sample data
// External service mocking
```

### Manual Testing Checklist
- [ ] All 5 dashboard cards load
- [ ] Map layers toggle correctly
- [ ] Flagging a stop works
- [ ] Admin login/logout works
- [ ] Charts render properly
- [ ] Predictions return results
- [ ] Mobile responsive layout

## Troubleshooting Guide

### 500 Error on API Call
→ Check backend console for error
→ Verify database file exists
→ Try restarting backend

### Empty Map
→ Ensure routes.geojson and stops.geojson exist
→ Check browser console for fetch errors
→ Verify Leaflet library loaded

### Slow Performance
→ Check database has indexes
→ Verify cache is being used
→ Profile with browser DevTools

### Python Script Fails
→ Verify Python installed: `python --version`
→ Check PYTHONPATH includes current directory
→ Ensure dependencies installed: `pip install -r requirements.txt`
