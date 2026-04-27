/* ═══════════════════════════════════════════════════════════
   rawMap.js — DRT Operations Hub · Raw GPS Map
   Purpose: Ground-truth view (unsnapped, unprocessed)
   Shows every vehicle using raw GTFS-RT GPS coordinates.
   No on-time processing. Pure feed comparison tool.
═══════════════════════════════════════════════════════════ */
'use strict';

let rawMap           = null;
let rawVehiclesLayer = null;
let _rawMapInited    = false;   // only set true AFTER successful init
let _rawRefreshTimer = null;
let _rawAllVehicles  = [];
let _rawSearchTerm   = '';

// Tile layers for satellite toggle
let _rawStreetLayer    = null;
let _rawSatelliteLayer = null;
let _rawUseSatellite   = false;

/* ── init ──────────────────────────────────────────────── */
window.initRawMap = function () {
  // BUG FIX: old code set _rawMapInited = true BEFORE checking rect.width,
  // so the deferred setTimeout re-called initRawMap() but the guard
  // returned immediately — map was never actually created.
  // Fix: don't set the flag until init fully succeeds.
  if (_rawMapInited) return;

  const el = document.getElementById('rawMap');
  if (!el) { console.warn('[RawMap] #rawMap element not found'); return; }

  // If tab not yet painted (zero width), defer and retry — but do NOT
  // set _rawMapInited yet so the retry actually runs.
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) {
    setTimeout(window.initRawMap, 300);
    return;
  }

  // ── Mark initialised ONLY here ───────────────────────────────
  _rawMapInited = true;

  rawMap = L.map(el, {
    center: [43.91, -78.95],
    zoom: 11,
    preferCanvas: true,
  });
  window.rawMap = rawMap;

  // ── Tile layers ───────────────────────────────────────────────
  _rawStreetLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxZoom: 19 }
  );

  _rawSatelliteLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles © Esri — Source: Esri, USGS, NOAA',
      maxZoom: 19,
    }
  );

  _rawStreetLayer.addTo(rawMap);

  rawVehiclesLayer = L.layerGroup().addTo(rawMap);

  // Wire satellite toggle button
  const satBtn = document.getElementById('rawSatToggle');
  if (satBtn) {
    satBtn.addEventListener('click', () => {
      _rawUseSatellite = !_rawUseSatellite;
      if (_rawUseSatellite) {
        rawMap.removeLayer(_rawStreetLayer);
        _rawSatelliteLayer.addTo(rawMap);
        satBtn.textContent = '🗺️ Street View';
        satBtn.title = 'Switch to street map';
      } else {
        rawMap.removeLayer(_rawSatelliteLayer);
        _rawStreetLayer.addTo(rawMap);
        satBtn.textContent = '🛰️ Satellite';
        satBtn.title = 'Switch to satellite imagery';
      }
    });
  }

  // Wire search
  const searchEl = document.getElementById('rawSearch');
  if (searchEl) {
    searchEl.addEventListener('input', e => {
      _rawSearchTerm = e.target.value.trim().toLowerCase();
      renderRawSidebar(_rawAllVehicles);
    });
  }

  setTimeout(() => { if (rawMap) rawMap.invalidateSize(); }, 150);

  refreshRawMapVehicles();
  _rawRefreshTimer = setInterval(refreshRawMapVehicles, 20_000);
};

/* ── Raw vehicle icon ──────────────────────────────────── */
function rawVehicleIcon(v) {
  const isStale = v.is_stale;
  const bg      = isStale ? '#94a3b8' : '#0f172a';
  const opacity = isStale ? 0.6 : 1;
  const label   = v.route_id || '?';
  return L.divIcon({
    className: '',
    html: `<div style="
      width:22px;height:22px;background:${bg};border-radius:50%;
      border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-size:8px;font-weight:800;opacity:${opacity};
      pointer-events:auto">${label}</div>`,
    iconSize:   [22, 22],
    iconAnchor: [11, 11],
  });
}

/* ── Refresh vehicles ──────────────────────────────────── */
async function refreshRawMapVehicles() {
  if (!rawMap || !rawVehiclesLayer) return;
  try {
    const res  = await fetch('/api/vehicles?limit=500');
    const json = await res.json();
    const vehicles = json.data || [];
    _rawAllVehicles = vehicles;

    // Update counters
    const routeSet = new Set(vehicles.map(v => v.route_id).filter(Boolean));
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('rawCountTotal',  vehicles.length);
    setTxt('rawCountRoutes', routeSet.size);
    setTxt('rawLastUpdated', 'Updated ' + new Date().toLocaleTimeString('en-CA', { hour:'2-digit', minute:'2-digit', second:'2-digit' }));

    renderRawMarkers(vehicles);
    renderRawSidebar(vehicles);

    // Fit bounds on first draw
    if (!rawMap._hasFit) {
      const pts = vehicles
        .filter(v => typeof v.raw_latitude === 'number' && typeof v.raw_longitude === 'number')
        .map(v => [v.raw_latitude, v.raw_longitude]);
      if (pts.length) {
        rawMap.fitBounds(pts, { padding: [40, 40] });
        rawMap._hasFit = true;
      }
    }
  } catch (e) {
    console.warn('[RawMap] Refresh failed:', e);
  }
}

// Marker registry for smooth updates
const _rawMarkerRegistry = {};

function renderRawMarkers(vehicles) {
  const seen = new Set();
  vehicles.forEach(v => {
    const lat = v.raw_latitude  ?? v.latitude;
    const lon = v.raw_longitude ?? v.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;

    const vid = v.vehicle_id;
    seen.add(vid);

    const popup = buildRawVehiclePopup(v);

    if (_rawMarkerRegistry[vid]) {
      _rawMarkerRegistry[vid]
        .setLatLng([lat, lon])
        .setIcon(rawVehicleIcon(v))
        .bindPopup(popup);
    } else {
      const m = L.marker([lat, lon], { icon: rawVehicleIcon(v) });
      m.bindPopup(popup);
      m.addTo(rawVehiclesLayer);
      _rawMarkerRegistry[vid] = m;
    }
  });

  // Remove gone vehicles
  for (const vid of Object.keys(_rawMarkerRegistry)) {
    if (!seen.has(vid)) {
      rawMap.removeLayer(_rawMarkerRegistry[vid]);
      delete _rawMarkerRegistry[vid];
    }
  }
}

/* ── Popup ─────────────────────────────────────────────── */
function buildRawVehiclePopup(v) {
  const lat = v.raw_latitude  ?? v.latitude;
  const lon = v.raw_longitude ?? v.longitude;
  const spd = v.calculated_speed_kmh != null
    ? `${v.calculated_speed_kmh} km/h <span style="color:#16a34a;font-size:.72em">GPS Δ</span>`
    : v.speed != null
      ? `${v.speed} km/h`
      : '–';
  const age     = v.age_seconds != null
    ? (v.age_seconds < 60 ? `${v.age_seconds}s ago` : `${Math.floor(v.age_seconds/60)}m ago`)
    : '–';
  const snapped = v.snapped && v.snap_distance_m != null
    ? `<br><small style="color:#2563eb">📍 Processed map pos offset: ${v.snap_distance_m < 1000 ? v.snap_distance_m+'m' : (v.snap_distance_m/1000).toFixed(1)+'km'}</small>`
    : '';

  return `<div style="min-width:215px;font-size:.8rem;line-height:1.7">
    <strong style="font-size:.88rem">🛰️ Vehicle ${v.vehicle_id || '–'}</strong>
    <br>Route: <b>${v.route_id || '–'}</b>${v.branch ? ` · <span style="color:#64748b">${v.branch}</span>` : ''}
    ${v.direction ? `<br>Direction: ${v.direction}` : ''}
    ${v.trip_id ? `<br>Trip: <span style="color:#64748b;font-size:.75rem">${v.trip_id}</span>` : ''}
    <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
    <div style="font-family:monospace;font-size:.75rem;color:#475569">
      <div>Raw Lat: ${lat?.toFixed(6)}</div>
      <div>Raw Lon: ${lon?.toFixed(6)}</div>
    </div>
    ${snapped}
    ${v.bearing != null ? `<br>Bearing: ${Math.round(v.bearing)}°` : ''}
    <br>🚀 ${spd}
    <br><small style="color:${v.is_stale ? '#d97706' : '#16a34a'}">
      ${v.is_stale ? '⚠️ Stale GPS' : '✓ Live'} — ${age}
    </small>
    <br><small style="color:#94a3b8">${v.timestamp
      ? new Date(v.timestamp * 1000).toLocaleTimeString() : '–'}</small>
  </div>`;
}

/* ── Sidebar table ─────────────────────────────────────── */
function renderRawSidebar(vehicles) {
  const tbody = document.getElementById('rawVehicleList');
  if (!tbody) return;

  const filtered = _rawSearchTerm
    ? vehicles.filter(v =>
        (v.vehicle_id || '').toLowerCase().includes(_rawSearchTerm) ||
        (v.route_id   || '').toLowerCase().includes(_rawSearchTerm) ||
        (v.branch     || '').toLowerCase().includes(_rawSearchTerm))
    : vehicles;

  const sorted = [...filtered].sort((a, b) => {
    const ra = parseInt(a.route_id) || 9999;
    const rb = parseInt(b.route_id) || 9999;
    return ra !== rb ? ra - rb : (a.vehicle_id || '').localeCompare(b.vehicle_id || '');
  });

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:.6rem;color:#94a3b8;text-align:center">
      ${_rawSearchTerm ? 'No matches' : 'No vehicles reporting'}</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(v => {
    const age = v.age_seconds != null
      ? (v.age_seconds < 60 ? v.age_seconds+'s' : Math.floor(v.age_seconds/60)+'m')
      : '–';
    const dot = `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;
      margin-right:4px;flex-shrink:0;background:${v.is_stale ? '#94a3b8' : '#16a34a'}"></span>`;
    const staleStyle = v.is_stale ? 'opacity:.65' : '';
    return `<tr style="border-bottom:1px solid #f1f5f9;cursor:pointer;${staleStyle}"
      onclick="window._rawFocus('${v.vehicle_id}')"
      onmouseover="this.style.background='#f8fafc'"
      onmouseout="this.style.background=''">
      <td style="padding:.32rem .55rem">${dot}<b style="font-size:.78rem">${v.vehicle_id || '–'}</b></td>
      <td style="padding:.32rem .55rem;font-weight:700;font-size:.78rem">${v.route_id || '–'}${v.branch ? `<br><span style="font-weight:400;color:#64748b;font-size:.68rem">${v.branch}</span>` : ''}</td>
      <td style="padding:.32rem .55rem;color:#64748b;font-size:.72rem">${age}</td>
    </tr>`;
  }).join('');
}

window._rawFocus = function (vehicleId) {
  const m = _rawMarkerRegistry[vehicleId];
  if (!m || !rawMap) return;
  rawMap.panTo(m.getLatLng(), { animate: true });
  m.openPopup();
};

/* ── Cleanup ───────────────────────────────────────────── */
window.destroyRawMap = function () {
  if (_rawRefreshTimer) clearInterval(_rawRefreshTimer);
  _rawRefreshTimer = null;
  _rawMapInited = false;
  if (rawMap) { rawMap.remove(); rawMap = null; window.rawMap = null; }
};
