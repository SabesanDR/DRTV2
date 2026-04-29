/* ═══════════════════════════════════════════════════════════════
   coverage.js — DRT Network Coverage Gap Analysis
   Renders a Leaflet map with:
     • Stop markers colour-coded by trips-per-day frequency
     • Grid-cell gap overlay — cells with low stop density shown
       as semi-transparent red (configurable threshold)
     • KPI bar (total stops, coverage %, desert cell count)
     • Satellite toggle, route-filter, density threshold slider
═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── module state ─────────────────────────────────────────────── */
let _cvMap         = null;
let _cvInited      = false;
let _cvStops       = [];          // raw stop objects from API
let _cvAllStops    = [];          // unfiltered copy
let _cvStopLayer   = null;        // L.layerGroup for stop dots
let _cvGapLayer    = null;        // L.layerGroup for gap rectangles
let _cvStreetLayer = null;
let _cvSatLayer    = null;
let _cvUseSat      = false;

// Durham Region bounding box (tight)
const DRT_BOUNDS = {
  minLat: 43.68, maxLat: 44.18,
  minLon: -79.32, maxLon: -78.56,
};

// Grid resolution: ~500 m cells (≈0.0045 deg lat, 0.006 deg lon at 44°N)
const CELL_LAT = 0.0045;
const CELL_LON = 0.006;

/* ── public init ───────────────────────────────────────────────── */
window.initCoverage = async function () {
  if (_cvInited) {
    // Already built — just invalidate size in case tab was hidden
    if (_cvMap) setTimeout(() => _cvMap.invalidateSize(), 120);
    return;
  }
  _cvInited = true;

  // Build map
  _cvMap = L.map('coverageMap', {
    center: [43.93, -78.94],
    zoom: 11,
    preferCanvas: true,
    zoomControl: true,
  });

  _cvStreetLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxZoom: 19 }
  ).addTo(_cvMap);

  _cvSatLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri', maxZoom: 19 }
  );

  _cvStopLayer = L.layerGroup().addTo(_cvMap);
  _cvGapLayer  = L.layerGroup().addTo(_cvMap);

  // Wire controls
  document.getElementById('cvSatBtn')
    ?.addEventListener('click', _cvToggleSat);
  document.getElementById('cvRouteFilter')
    ?.addEventListener('change', _cvApplyFilter);
  document.getElementById('cvThreshold')
    ?.addEventListener('input', _cvOnThresholdChange);
  document.getElementById('cvShowGaps')
    ?.addEventListener('change', _cvRender);
  document.getElementById('cvShowStops')
    ?.addEventListener('change', _cvRender);

  setTimeout(() => _cvMap.invalidateSize(), 150);

  // Fetch data
  await _cvLoadData();
};

/* ── data loading ──────────────────────────────────────────────── */
async function _cvLoadData() {
  _cvSetStatus('Loading stops…');
  try {
    // Pull all stops (backend default limit=2000 covers full DRT network)
    const res   = await apiFetch('/stops?limit=5000');
    _cvAllStops = (res.data || []).filter(
      s => s.stop_lat && s.stop_lon &&
           s.stop_lat >= DRT_BOUNDS.minLat && s.stop_lat <= DRT_BOUNDS.maxLat &&
           s.stop_lon >= DRT_BOUNDS.minLon && s.stop_lon <= DRT_BOUNDS.maxLon
    );

    // Annotate each stop with route_count (how many routes serve it)
    // The /stops list doesn't include route_count, so we compute it from
    // stopsByRoute if exposed, otherwise we fetch per-stop lazily for
    // the popup. For the heatmap we use trip frequency as a proxy.
    // We fetch /analytics/stops once to get per-stop delay data which
    // also gives us a trip count proxy.
    let tripCounts = {};
    try {
      const analRes = await apiFetch('/analytics/stops');
      (analRes.data || []).forEach(s => {
        tripCounts[s.stop_id] = s.trip_count || s.trips || 0;
      });
    } catch (_) { /* analytics optional */ }

    _cvAllStops = _cvAllStops.map(s => ({
      ...s,
      trip_count: tripCounts[s.stop_id] || 0,
    }));

    _cvStops = _cvAllStops;
    _cvSetStatus('');
    _cvPopulateRouteFilter();
    _cvRender();
  } catch (e) {
    _cvSetStatus('⚠️ Failed to load stops — ' + e.message);
  }
}

/* ── route filter dropdown ─────────────────────────────────────── */
async function _cvPopulateRouteFilter() {
  const sel = document.getElementById('cvRouteFilter');
  if (!sel) return;
  try {
    const res    = await apiFetch('/routes');
    const routes = (res.data || []).sort((a, b) => {
      const an = parseInt(a.route_short_name || a.route_id, 10);
      const bn = parseInt(b.route_short_name || b.route_id, 10);
      return isNaN(an) || isNaN(bn) ? (a.route_id > b.route_id ? 1 : -1) : an - bn;
    });
    routes.forEach(r => {
      const opt   = document.createElement('option');
      opt.value   = r.route_id;
      opt.textContent = (r.route_short_name ? `${r.route_short_name} – ` : '') +
                        (r.route_long_name || r.route_id);
      sel.appendChild(opt);
    });
  } catch (_) {}
}

async function _cvApplyFilter() {
  const routeId = document.getElementById('cvRouteFilter')?.value || '';
  if (!routeId) {
    _cvStops = _cvAllStops;
    _cvRender();
    return;
  }
  // Fetch stops for this route
  _cvSetStatus('Filtering…');
  try {
    const res = await apiFetch(`/routes/${routeId}/stops`);
    const ids = new Set((res.data || []).map(s => s.stop_id));
    _cvStops = _cvAllStops.filter(s => ids.has(s.stop_id));
  } catch (_) {
    _cvStops = _cvAllStops;
  }
  _cvSetStatus('');
  _cvRender();
}

/* ── threshold slider label ────────────────────────────────────── */
function _cvOnThresholdChange() {
  const val = document.getElementById('cvThreshold')?.value ?? 1;
  const lbl = document.getElementById('cvThresholdLabel');
  if (lbl) lbl.textContent = val;
  _cvRender();
}

/* ── main render ───────────────────────────────────────────────── */
function _cvRender() {
  const showStops = document.getElementById('cvShowStops')?.checked ?? true;
  const showGaps  = document.getElementById('cvShowGaps')?.checked  ?? true;
  const threshold = parseInt(document.getElementById('cvThreshold')?.value ?? '1', 10);

  _cvStopLayer.clearLayers();
  _cvGapLayer.clearLayers();

  if (showStops)  _cvDrawStops();
  if (showGaps)   _cvDrawGaps(threshold);

  _cvUpdateKpis(threshold);
}

/* ── stop markers ──────────────────────────────────────────────── */
function _cvDrawStops() {
  const maxTrips = Math.max(..._cvStops.map(s => s.trip_count || 0), 1);

  _cvStops.forEach(stop => {
    const trips   = stop.trip_count || 0;
    const ratio   = maxTrips > 0 ? trips / maxTrips : 0;

    // Colour: grey (no trips) → amber → green (many trips)
    let colour;
    if (trips === 0)       colour = '#94a3b8';        // grey — no data
    else if (ratio < 0.2)  colour = '#f59e0b';        // amber — sparse
    else if (ratio < 0.5)  colour = '#3b82f6';        // blue — moderate
    else                   colour = '#16a34a';         // green — busy

    const radius = trips === 0 ? 4 : Math.max(4, Math.min(9, 4 + ratio * 5));

    const m = L.circleMarker([stop.stop_lat, stop.stop_lon], {
      radius,
      fillColor:   colour,
      color:       '#fff',
      weight:      1.5,
      opacity:     1,
      fillOpacity: 0.85,
    });

    m.bindPopup(_cvStopPopup(stop));
    m.addTo(_cvStopLayer);
  });
}

function _cvStopPopup(stop) {
  const trips = stop.trip_count || 0;
  const freq  = trips === 0 ? 'No data'
    : trips < 10  ? 'Low frequency'
    : trips < 30  ? 'Moderate frequency'
    : 'High frequency';
  return `
    <div style="min-width:180px;font-size:.8rem;line-height:1.7">
      <strong>${stop.stop_name || stop.stop_id}</strong>
      <br><span style="color:#64748b">Stop ${stop.stop_code || stop.stop_id}</span>
      <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
      📍 ${stop.stop_lat.toFixed(5)}, ${stop.stop_lon.toFixed(5)}
      <br>🚌 Trips/day: <b>${trips || '–'}</b>
      <br>📶 ${freq}
    </div>`;
}

/* ── gap grid overlay ──────────────────────────────────────────── */
function _cvDrawGaps(threshold) {
  // Build a Set of occupied cells from stop coordinates
  const occupied = new Set();
  _cvStops.forEach(s => {
    const ci = Math.floor((s.stop_lat - DRT_BOUNDS.minLat) / CELL_LAT);
    const cj = Math.floor((s.stop_lon - DRT_BOUNDS.minLon) / CELL_LON);
    occupied.add(`${ci},${cj}`);
  });

  // For each cell in the DRT bounding box, if it contains < threshold stops
  // AND at least one neighbour cell does have stops, flag it as a gap zone.
  // Pure wilderness cells outside the service area are excluded by requiring
  // at least one of the 8 surrounding cells to be occupied.
  const rowCount = Math.ceil((DRT_BOUNDS.maxLat - DRT_BOUNDS.minLat) / CELL_LAT);
  const colCount = Math.ceil((DRT_BOUNDS.maxLon - DRT_BOUNDS.minLon) / CELL_LON);

  // Count stops per cell
  const cellCount = {};
  _cvStops.forEach(s => {
    const ci  = Math.floor((s.stop_lat - DRT_BOUNDS.minLat) / CELL_LAT);
    const cj  = Math.floor((s.stop_lon - DRT_BOUNDS.minLon) / CELL_LON);
    const key = `${ci},${cj}`;
    cellCount[key] = (cellCount[key] || 0) + 1;
  });

  for (let ci = 0; ci < rowCount; ci++) {
    for (let cj = 0; cj < colCount; cj++) {
      const key   = `${ci},${cj}`;
      const count = cellCount[key] || 0;
      if (count >= threshold) continue;   // this cell has enough stops

      // Check if any of the 8 neighbours has stops (avoids colouring empty wilderness)
      let hasNeighbour = false;
      for (let di = -2; di <= 2 && !hasNeighbour; di++) {
        for (let dj = -2; dj <= 2 && !hasNeighbour; dj++) {
          if (di === 0 && dj === 0) continue;
          if (cellCount[`${ci + di},${cj + dj}`] > 0) hasNeighbour = true;
        }
      }
      if (!hasNeighbour) continue;

      const south = DRT_BOUNDS.minLat + ci * CELL_LAT;
      const west  = DRT_BOUNDS.minLon + cj * CELL_LON;
      const north = south + CELL_LAT;
      const east  = west  + CELL_LON;

      // Opacity proportional to how sparse: 0 stops = most opaque
      const opacity = count === 0 ? 0.35 : 0.2;

      const rect = L.rectangle([[south, west], [north, east]], {
        fillColor:   '#dc2626',
        fillOpacity: opacity,
        color:       '#dc2626',
        weight:      0.4,
        opacity:     0.25,
        interactive: true,
      });

      rect.bindTooltip(
        `⚠️ Coverage gap<br><small>${count === 0
          ? 'No stops in this ~500m cell'
          : `Only ${count} stop${count > 1 ? 's' : ''} here`}</small>`,
        { sticky: true }
      );

      rect.addTo(_cvGapLayer);
    }
  }
}

/* ── KPI bar ───────────────────────────────────────────────────── */
function _cvUpdateKpis(threshold) {
  const rowCount = Math.ceil((DRT_BOUNDS.maxLat - DRT_BOUNDS.minLat) / CELL_LAT);
  const colCount = Math.ceil((DRT_BOUNDS.maxLon - DRT_BOUNDS.minLon) / CELL_LON);

  const cellCount = {};
  _cvStops.forEach(s => {
    const ci  = Math.floor((s.stop_lat - DRT_BOUNDS.minLat) / CELL_LAT);
    const cj  = Math.floor((s.stop_lon - DRT_BOUNDS.minLon) / CELL_LON);
    const key = `${ci},${cj}`;
    cellCount[key] = (cellCount[key] || 0) + 1;
  });

  // Count gap cells near the network (same neighbour check as drawGaps)
  let gapCells = 0;
  let coveredCells = 0;
  for (let ci = 0; ci < rowCount; ci++) {
    for (let cj = 0; cj < colCount; cj++) {
      const key   = `${ci},${cj}`;
      const count = cellCount[key] || 0;
      let hasNeighbour = false;
      for (let di = -2; di <= 2 && !hasNeighbour; di++) {
        for (let dj = -2; dj <= 2 && !hasNeighbour; dj++) {
          if (di === 0 && dj === 0) continue;
          if (cellCount[`${ci + di},${cj + dj}`] > 0) hasNeighbour = true;
        }
      }
      if (!hasNeighbour) continue;
      if (count >= threshold) coveredCells++;
      else gapCells++;
    }
  }

  const totalCells = gapCells + coveredCells;
  const coveragePct = totalCells > 0
    ? Math.round((coveredCells / totalCells) * 100) : 0;

  const avgTrips = _cvStops.length > 0
    ? Math.round(_cvStops.reduce((s, v) => s + (v.trip_count || 0), 0) / _cvStops.length)
    : 0;

  _cvSetKpi('cvKpiStops',    _cvStops.length.toLocaleString());
  _cvSetKpi('cvKpiCoverage', coveragePct + '%');
  _cvSetKpi('cvKpiGaps',     gapCells.toLocaleString());
  _cvSetKpi('cvKpiAvgTrips', avgTrips);

  // Colour coverage KPI
  const covEl = document.getElementById('cvKpiCoverage');
  if (covEl) {
    covEl.style.color = coveragePct >= 80 ? 'var(--c-green, #16a34a)'
      : coveragePct >= 60 ? 'var(--c-amber, #d97706)'
      : '#dc2626';
  }
}

function _cvSetKpi(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── satellite toggle ──────────────────────────────────────────── */
function _cvToggleSat() {
  _cvUseSat = !_cvUseSat;
  const btn = document.getElementById('cvSatBtn');
  if (_cvUseSat) {
    _cvMap.removeLayer(_cvStreetLayer);
    _cvSatLayer.addTo(_cvMap);
    if (btn) btn.textContent = '🗺️ Street View';
  } else {
    _cvMap.removeLayer(_cvSatLayer);
    _cvStreetLayer.addTo(_cvMap);
    if (btn) btn.textContent = '🛰️ Satellite';
  }
}

/* ── status helper ─────────────────────────────────────────────── */
function _cvSetStatus(msg) {
  const el = document.getElementById('cvStatus');
  if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; }
}
