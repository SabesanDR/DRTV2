# Quick Start Commands

## 🚀 Get Running in 5 Minutes

### Step 1: Install Dependencies (2 min)
```bash
cd backend
npm install

cd ..
pip install -r python/requirements.txt
```

### Step 2: Prepare Database (1 min)
```bash
# Download google_transit.zip from opendata.durham.ca
# and save to: data/google_transit.zip

# Then parse it:
python python/parse_gtfs.py data/google_transit.zip
```

### Step 3: Start the Server (30 sec)
```bash
cd backend
npm start
```

### Step 4: Open in Browser (30 sec)
```
http://localhost:3000
```

**That's it! The app is running** 🎉

---

## 📋 All Commands

### Installation
```bash
# Backend setup
cd backend
npm install

# Python setup
pip install -r python/requirements.txt
```

### Data Processing
```bash
# Parse GTFS data
python python/parse_gtfs.py data/google_transit.zip

# View database
# (Install VS Code SQLite extension to browse)
```

### Running the Application
```bash
# Start backend server
cd backend
npm start

# For development with auto-reload
npm run dev
```

### Development Mode
```bash
# Backend terminal
cd backend
npm run dev

# This enables auto-reload when you edit files
```

### Accessing the App
```
Main app:    http://localhost:3000
API health:  http://localhost:3000/api/health
API vehicles: http://localhost:3000/api/vehicles
API metrics:  http://localhost:3000/api/metrics
```

### Troubleshooting Commands
```bash
# Port 3000 in use? (Windows)
netstat -ano | findstr :3000
taskkill /PID [PID] /F

# Port 3000 in use? (Mac/Linux)
lsof -i :3000
kill -9 [PID]

# Reinstall dependencies
rm -rf backend/node_modules
cd backend && npm install

# Reset database
rm data/gtfs.db
python python/parse_gtfs.py data/google_transit.zip
```

---

## 🎮 Testing Commands

### Test Backend API
```bash
# Get all vehicles
curl http://localhost:3000/api/vehicles

# Get health status
curl http://localhost:3000/api/health

# Get metrics
curl http://localhost:3000/api/metrics

# Get alerts
curl http://localhost:3000/api/alerts

# Get flagged stops
curl http://localhost:3000/api/flags
```

### Test Predictions (POST)
```bash
curl -X POST http://localhost:3000/api/predict/delay \
  -H "Content-Type: application/json" \
  -d '{
    "route_id": "1",
    "stop_id": "12345",
    "hour_of_day": 14
  }'
```

### Test Flag Submission
```bash
curl -X POST http://localhost:3000/api/flags \
  -H "Content-Type: application/json" \
  -d '{
    "stop_id": "12345",
    "stop_name": "Main Station",
    "stop_lat": 43.85,
    "stop_lon": -79.05,
    "reason": "missing_shelter",
    "comment": "Shelter roof damaged",
    "created_by": "test-user"
  }'
```

---

## 🔑 Important Credentials

### Admin Login
```
Username: (none - just password)
Password: admin123
```

Change in:
- `.env` file: `ADMIN_PASSWORD=your_password`
- `frontend/js/admin.js`: line ~5

### Database
```
Type: SQLite
File: data/gtfs.db
Default schema: Automatically created
```

---

## 📂 Key File Locations

```
Backend Entry:     backend/server.js
Frontend Entry:    frontend/index.html
Database:          data/gtfs.db
Configuration:     .env
GTFS Data:         data/google_transit.zip
```

---

## 🌐 Data Source URLs

Need to update `.env` with actual URLs from Durham portal:
```
GTFS_STATIC_URL=https://opendata.durham.ca/...
GTFS_RT_VEHICLES_URL=https://opendata.durham.ca/...
GTFS_RT_TRIPS_URL=https://opendata.durham.ca/...
GTFS_RT_ALERTS_URL=https://opendata.durham.ca/...
ROUTES_GEOJSON_URL=https://opendata.durham.ca/...
STOPS_GEOJSON_URL=https://opendata.durham.ca/...
```

Get these from: https://opendata.durham.ca

---

## 📊 Dashboard Access

Once running:

| Feature | URL | Access |
|---------|-----|--------|
| Dashboard | http://localhost:3000 | Direct |
| Live Map | http://localhost:3000#map | Tab button |
| Reports | http://localhost:3000#reports | Tab button |
| Intelligence | http://localhost:3000#intelligence | Tab button |
| Admin Panel | http://localhost:3000#admin | Tab button → password: admin123 |

---

## 🐛 Debug Mode

Enable more logging:
```bash
# Edit backend/server.js
// Add at top:
process.env.DEBUG = '*';

# Or in Linux/Mac:
DEBUG=* npm start
```

Check browser console:
- Press F12
- Go to Console tab
- Look for errors

---

## 📱 Mobile Testing

Test responsive design:
```bash
# Open DevTools (F12)
# Click device toggle (Ctrl+Shift+M)
# Test at different sizes
```

---

## 🚢 Deployment Preview

For production deployment, see ARCHITECTURE.md for:
- Environment setup
- Database migration
- Security hardening
- Performance optimization

---

## ✅ Verification Checklist

After installation, verify:
- [ ] `npm start` runs without errors
- [ ] Page loads at http://localhost:3000
- [ ] Dashboard shows data
- [ ] Map renders
- [ ] Can flag a stop
- [ ] Can access admin panel
- [ ] Charts appear in Reports
- [ ] Predictions work

If any issue, check RUNNING_LOCALLY.md or ARCHITECTURE.md troubleshooting section.

---

## 🎯 Most Common Commands

```bash
# 1. Install everything
cd backend && npm install && cd ..
pip install -r python/requirements.txt

# 2. Parse GTFS (after downloading)
python python/parse_gtfs.py data/google_transit.zip

# 3. Start the app
cd backend && npm start

# 4. Open browser
# Go to: http://localhost:3000

# 5. Login to admin
# Password: admin123
```

**That's all you need!** 🚀

For more details, see:
- README.md - Features and API docs
- RUNNING_LOCALLY.md - Detailed setup
- ARCHITECTURE.md - Technical details
- FEATURES_CHECKLIST.md - Complete inventory
