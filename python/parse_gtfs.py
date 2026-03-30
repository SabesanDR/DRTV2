#!/usr/bin/env python3
"""
DRT GTFS Preprocessor — No SQLite, outputs optimized JSON for Node.js in-memory use.
Usage: python3 preprocess_gtfs.py [--gtfs-zip ../data/google_transit.zip] [--out ../data/gtfs_json]
"""

import csv, json, os, sys, argparse, math, zipfile, io
from collections import defaultdict

# ─── helpers ──────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6_371_000
    f1, f2 = math.radians(lat1), math.radians(lat2)
    df = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(df/2)**2 + math.cos(f1)*math.cos(f2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def read_gtfs_file(source, filename):
    """Read a GTFS txt file from either a zip or a directory, return list of dicts."""
    if isinstance(source, zipfile.ZipFile):
        try:
            with source.open(filename) as f:
                content = f.read().decode('utf-8-sig')
                reader = csv.DictReader(io.StringIO(content))
                return list(reader)
        except KeyError:
            print(f"  ⚠  {filename} not found in zip")
            return []
    else:
        path = os.path.join(source, filename)
        if not os.path.exists(path):
            print(f"  ⚠  {path} not found")
            return []
        with open(path, 'r', encoding='utf-8-sig') as f:
            return list(csv.DictReader(f))

# ─── parsers ──────────────────────────────────────────────────────────────────

def parse_routes(source):
    rows = read_gtfs_file(source, 'routes.txt')
    by_id = {}
    for r in rows:
        rid = r.get('route_id','').strip()
        if rid:
            by_id[rid] = {
                'route_id': rid,
                'route_short_name': r.get('route_short_name','').strip(),
                'route_long_name':  r.get('route_long_name','').strip(),
                'route_type':       r.get('route_type','3').strip(),
                'route_color':      (r.get('route_color','') or '0070C0').strip(),
                'route_text_color': (r.get('route_text_color','') or 'FFFFFF').strip(),
                'route_desc':       r.get('route_desc','').strip(),
            }
    print(f"  ✓  {len(by_id)} routes")
    return by_id

def parse_trips(source):
    rows = read_gtfs_file(source, 'trips.txt')
    by_id, by_route, shape_by_trip = {}, defaultdict(list), {}
    for r in rows:
        tid = r.get('trip_id','').strip()
        rid = r.get('route_id','').strip()
        sid = r.get('shape_id','').strip()
        if not tid: continue
        by_id[tid] = {
            'trip_id':       tid,
            'route_id':      rid,
            'shape_id':      sid,
            'trip_headsign': r.get('trip_headsign','').strip(),
            'direction_id':  r.get('direction_id','0').strip(),
            'service_id':    r.get('service_id','').strip(),
        }
        if rid: by_route[rid].append(tid)
        if sid: shape_by_trip[tid] = sid
    print(f"  ✓  {len(by_id)} trips")
    return by_id, dict(by_route), shape_by_trip

def parse_shapes(source):
    rows = read_gtfs_file(source, 'shapes.txt')
    raw = defaultdict(list)
    for r in rows:
        sid = r.get('shape_id','').strip()
        try:
            raw[sid].append({
                'lat': float(r['shape_pt_lat']),
                'lon': float(r['shape_pt_lon']),
                'seq': int(r['shape_pt_sequence']),
            })
        except (KeyError, ValueError):
            pass
    out = {sid: sorted(pts, key=lambda x: x['seq']) for sid, pts in raw.items()}
    print(f"  ✓  {len(out)} shapes")
    return out

def parse_stops(source):
    rows = read_gtfs_file(source, 'stops.txt')
    by_id = {}
    for r in rows:
        sid = r.get('stop_id','').strip()
        try:
            by_id[sid] = {
                'stop_id':   sid,
                'stop_name': r.get('stop_name','').strip(),
                'stop_code': r.get('stop_code','').strip(),
                'stop_lat':  float(r['stop_lat']),
                'stop_lon':  float(r['stop_lon']),
                'wheelchair_boarding': r.get('wheelchair_boarding','0').strip(),
            }
        except (KeyError, ValueError):
            pass
    print(f"  ✓  {len(by_id)} stops")
    return by_id

def parse_stop_times(source):
    rows = read_gtfs_file(source, 'stop_times.txt')
    by_trip = defaultdict(list)
    for r in rows:
        tid = r.get('trip_id','').strip()
        sid = r.get('stop_id','').strip()
        try:
            by_trip[tid].append({
                'stop_id':      sid,
                'stop_sequence': int(r['stop_sequence']),
                'arrival_time':   r.get('arrival_time','').strip(),
                'departure_time': r.get('departure_time','').strip(),
            })
        except (KeyError, ValueError):
            pass
    for tid in by_trip:
        by_trip[tid].sort(key=lambda x: x['stop_sequence'])
    print(f"  ✓  stop times for {len(by_trip)} trips")
    return dict(by_trip)

# ─── derived structures ────────────────────────────────────────────────────────

def build_route_shapes(trips_by_route, trips_by_id, shape_pts):
    """Pick best 2 shapes per route, downsample, compute bbox."""
    route_shapes = {}
    for route_id, trip_ids in trips_by_route.items():
        counts = defaultdict(int)
        for tid in trip_ids:
            shp = trips_by_id.get(tid, {}).get('shape_id','')
            if shp and shp in shape_pts:
                counts[shp] += 1
        if not counts: continue
        top = sorted(counts, key=lambda s: counts[s], reverse=True)[:2]
        shapes_out = []
        for shp in top:
            pts = shape_pts[shp]
            if not pts: continue
            # Downsample to ≤600 points
            step = max(1, len(pts) // 600)
            sampled = pts[::step]
            if pts[-1] not in sampled: sampled.append(pts[-1])
            lats = [p['lat'] for p in sampled]
            lons = [p['lon'] for p in sampled]
            shapes_out.append({
                'shape_id': shp,
                'coordinates': [[p['lon'], p['lat']] for p in sampled],
                'bbox': {
                    'minLat': min(lats), 'maxLat': max(lats),
                    'minLon': min(lons), 'maxLon': max(lons),
                },
            })
        if not shapes_out: continue
        all_bbox = shapes_out
        route_shapes[route_id] = {
            'route_id': route_id,
            'shapes': shapes_out,
            'bbox': {
                'minLat': min(s['bbox']['minLat'] for s in all_bbox),
                'maxLat': max(s['bbox']['maxLat'] for s in all_bbox),
                'minLon': min(s['bbox']['minLon'] for s in all_bbox),
                'maxLon': max(s['bbox']['maxLon'] for s in all_bbox),
            },
        }
    print(f"  ✓  route shapes for {len(route_shapes)} routes")
    return route_shapes

def build_stops_by_route(trips_by_route, stop_times_by_trip, stops_by_id):
    stops_by_route = {}
    for route_id, trip_ids in trips_by_route.items():
        # Use first trip as representative
        rep = trip_ids[0] if trip_ids else None
        if not rep: continue
        out = []
        for st in stop_times_by_trip.get(rep, []):
            stop = stops_by_id.get(st['stop_id'])
            if stop:
                out.append({**stop,
                    'arrival_time':   st['arrival_time'],
                    'departure_time': st['departure_time'],
                    'stop_sequence':  st['stop_sequence'],
                })
        stops_by_route[route_id] = out
    return stops_by_route

def build_routes_list(routes_by_id, trips_by_route, stops_by_route, route_shapes):
    out = []
    for rid, r in routes_by_id.items():
        out.append({
            **r,
            'trip_count':  len(trips_by_route.get(rid, [])),
            'stop_count':  len(stops_by_route.get(rid, [])),
            'has_shape':   rid in route_shapes,
        })
    out.sort(key=lambda r: r.get('route_short_name') or r['route_id'])
    return out

# ─── main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--gtfs-zip',  default='../data/google_transit.zip')
    p.add_argument('--gtfs-dir',  default=None, help='Alternative: unpacked GTFS dir')
    p.add_argument('--out',       default='../data/gtfs_json')
    args = p.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print("🚌  DRT GTFS Preprocessor")

    # Open source
    if args.gtfs_dir:
        src = args.gtfs_dir
        print(f"   Reading from directory: {src}")
    elif os.path.exists(args.gtfs_zip):
        src = zipfile.ZipFile(args.gtfs_zip, 'r')
        print(f"   Reading from zip: {args.gtfs_zip}")
    else:
        print(f"   ⚠ Neither --gtfs-zip ({args.gtfs_zip}) nor --gtfs-dir found.")
        sys.exit(1)

    print("\n📂 Parsing GTFS files...")
    routes_by_id  = parse_routes(src)
    trips_by_id, trips_by_route, shape_by_trip = parse_trips(src)
    shape_pts      = parse_shapes(src)
    stops_by_id    = parse_stops(src)
    stop_times     = parse_stop_times(src)

    if isinstance(src, zipfile.ZipFile):
        src.close()

    print("\n🔧 Building derived structures...")
    route_shapes   = build_route_shapes(trips_by_route, trips_by_id, shape_pts)
    stops_by_route = build_stops_by_route(trips_by_route, stop_times, stops_by_id)
    trip_to_route  = {tid: t['route_id'] for tid, t in trips_by_id.items()}
    routes_list    = build_routes_list(routes_by_id, trips_by_route, stops_by_route, route_shapes)

    files = {
        'routes.json':          routes_list,
        'routes_by_id.json':    routes_by_id,
        'trips_by_id.json':     trips_by_id,
        'trips_by_route.json':  trips_by_route,
        'route_shapes.json':    route_shapes,
        'stops_by_id.json':     stops_by_id,
        'stops_by_route.json':  stops_by_route,
        'stop_times.json':      stop_times,
        'trip_to_route.json':   trip_to_route,
        'shape_by_trip.json':   shape_by_trip,
        'shape_points.json':    {sid: [{'lat': p['lat'], 'lon': p['lon']} for p in pts]
                                  for sid, pts in shape_pts.items()},
    }

    print("\n💾 Writing JSON files...")
    for fname, data in files.items():
        path = os.path.join(args.out, fname)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'))
        kb = os.path.getsize(path) // 1024
        print(f"   {fname:35s}  {kb:6d} KB")

    print("\n✅  Preprocessing complete!")

if __name__ == '__main__':
    main()
