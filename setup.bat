@echo off
echo === DRT Operations Hub Setup ===

echo.
echo 1. Installing Node.js dependencies...
cd backend
npm install
cd ..

echo.
echo 2. Pre-processing GTFS data...
cd python
python preprocess_gtfs.py --gtfs-zip ..\data\google_transit.zip --out ..\data\gtfs_json
cd ..

echo.
echo 3. Starting server...
echo    Dashboard: http://localhost:3000
cd backend && node server.js
