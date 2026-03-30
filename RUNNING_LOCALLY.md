# Durham Region Transit App - Running Locally in VS Code

## Complete Setup Instructions

### 1. Environment Setup

#### Windows Users:
```powershell
cd "c:\Users\sivaku_sa\DRT App"
.\setup.bat
```

#### Mac/Linux Users:
```bash
cd c:\Users\sivaku_sa\DRT App
chmod +x setup.sh
./setup.sh
```

### 2. Get GTFS Data

Visit https://opendata.durham.ca and:
1. Search for "GTFS" or "Transit"
2. Download the GTFS Static Schedule ZIP file
3. Save as `data/google_transit.zip`

### 3. Parse Static GTFS Data

```bash
cd python
python parse_gtfs.py ../data/google_transit.zip
cd ..
```

Expected output:
```
✓ Loaded X routes
✓ Loaded Y stops
✓ Loaded Z trips
✓ Computed static metrics
✓ Database indexes created
✓ GTFS parsing complete!
```

### 4. Configure Real-Time Data Sources

Edit `.env` and fill in the actual URLs:

```bash
GTFS_RT_VEHICLES_URL=https://[actual URL from Durham portal]
GTFS_RT_TRIPS_URL=https://[actual URL from Durham portal]
GTFS_RT_ALERTS_URL=https://[actual URL from Durham portal]
ROUTES_GEOJSON_URL=https://[actual URL from Durham portal]
STOPS_GEOJSON_URL=https://[actual URL from Durham portal]
```

To find the URLs:
1. Go to https://opendata.durham.ca
2. Search for each data type
3. Look for REST API or GeoJSON query endpoints
4. Copy the full URL

### 5. Start the Application

#### Terminal 1 - Backend Server:
```bash
cd backend
npm start
```

You should see:
```
Connected to SQLite database at ../data/gtfs.db
🚌 Durham Transit App server running on http://localhost:3000
```

#### Terminal 2 (optional) - Watch for file changes:
```bash
cd backend
npm run dev
```

(Requires `nodemon` - installed by setup script)

### 6. Access the Application

Open your browser: **http://localhost:3000**

## Using in VS Code

### 1. Open the workspace
```
File > Open Folder > c:\Users\sivaku_sa\DRT App
```

### 2. Create VS Code tasks

Add to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start Backend Server",
      "type": "shell",
      "command": "node",
      "args": ["backend/server.js"],
      "problemMatcher": [],
      "group": {
        "kind": "build",
        "isDefault": true
      }
    },
    {
      "label": "Parse GTFS Data",
      "type": "shell",
      "command": "python",
      "args": ["python/parse_gtfs.py", "data/google_transit.zip"],
      "problemMatcher": []
    }
  ]
}
```

### 3. Use VS Code Terminal

Press `Ctrl+`` to open terminal and run:
```bash
cd backend && npm start
```

### 4. Install Useful Extensions

- **REST Client** - Test API endpoints
- **SQLite** - Browse the database
- **Live Server** - Serve frontend files
- **Thunder Client** - Alternative API testing
- **Python** - For Python script editing

## Testing Without Real Data

The app includes sample/mock data:
1. Dummy routes and stops are generated
2. Vehicle positions are simulated
3. Alerts and metrics are mocked
4. Charts show realistic patterns

**Don't wait for real data - start exploring now!**

## Troubleshooting

### Port 3000 already in use?
```bash
# Windows - Find and kill process
netstat -ano | findstr :3000
taskkill /PID [PID] /F

# Mac/Linux
lsof -i :3000
kill -9 [PID]
```

### Database errors?
```bash
# Delete and re-create
rm data/gtfs.db
python python/parse_gtfs.py data/google_transit.zip
```

### Python module not found?
```bash
pip install --upgrade -r python/requirements.txt
```

### Map not showing?
1. Check browser console (F12) for errors
2. Verify Leaflet CDN is accessible
3. Check your internet connection

## Development Workflow

1. **Backend changes**: Server auto-reloads (with `npm run dev`)
2. **Frontend changes**: Refresh browser (F5)
3. **Database changes**: Reparse GTFS data
4. **Python changes**: Changes take effect on next API call

## Next Steps

1. Explore the **Dashboard** tab for system overview
2. Check the **Live Map** - right-click to flag stops
3. View **Reports** for performance analytics
4. Review **Intelligence** for predictions and metrics
5. Access **Admin** panel (password: `admin123`)

## File Structure Reference

```
Backend:
- server.js           → Main Express server
- db.js              → SQLite operations
- routes/            → API endpoints

Frontend:
- index.html         → Main page
- css/style.css      → All styling
- js/app.js          → Core logic
- js/map.js          → Leaflet map
- js/analytics.js    → Charts
- js/admin.js        → Admin panel

Data:
- gtfs.db            → SQLite database
- google_transit.zip → GTFS static data

Python:
- parse_gtfs.py      → Data loader
- predict.py         → ML models
```

## Debugging Tips

1. **Browser Console** - F12, look for errors
2. **Network Tab** - See API calls and responses
3. **Backend Logs** - Watch terminal output
4. **SQLite Browser** - Use VS Code SQLite extension to inspect database

## Performance Notes

- Map loads ~50 vehicle markers (browser dependent)
- Charts render in <2 seconds
- Database queries should be <500ms
- API responses cached for 30 seconds

Ready to explore? Open http://localhost:3000 now!
