#!/bin/bash
set -e
echo "=== DRT Operations Hub Setup ==="

echo ""
echo "1. Installing Node.js dependencies..."
cd backend
npm install
cd ..

echo ""
echo "2. Pre-processing GTFS data (Python)..."
cd python
if python3 -c "import zipfile, csv, json, argparse, math" 2>/dev/null; then
  python3 preprocess_gtfs.py \
    --gtfs-zip ../data/google_transit.zip \
    --out ../data/gtfs_json
  echo "   GTFS JSON files written to data/gtfs_json/"
else
  echo "   WARNING: Python3 not available. Server will load from zip at startup (slower)."
fi
cd ..

echo ""
echo "3. Starting server..."
echo "   Dashboard: http://localhost:3000"
echo ""
cd backend && node server.js
