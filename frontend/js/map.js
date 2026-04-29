/* ═══════════════════════════════════════════════════════════
   map.js — DRT Operations Hub · Leaflet Map
═══════════════════════════════════════════════════════════ */
'use strict';
// Presenter Mode — live vehicle marker registry
window.liveVehicleMarkers = {};

let _map         = null;
let _mapInited   = false;
let _mapInterval = null;
let _showLateOnly  = false;
let _showEarlyOnly = false;

// Satellite toggle state
let _mapStreetLayer    = null;
let _mapSatLayer       = null;
let _mapUseSatellite   = false;

// Layer groups
const LG = {
  vehicles: null,
  early:    null,   // early-vehicle highlight overlay
  route:    null,
  stops:    null,
  alerts:   null,
  flags:    null,
  raw:      null,
  trails:   null,
  garages:  null,
};

// Trail state per vehicle
const _trails    = {};   // vehicleId → [{lat,lon,ts}]
const _trailPoly = {};   // vehicleId → L.Polyline
const MAX_TRAIL  = 8;

// Current route filter
let _currentRouteId = '';

// ── init (called when map tab activated) ─────────────────────────
function initMap() {
  if (_mapInited) return;
  _mapInited = true;

  _map = L.map('leafletMap', {
    center: [43.91, -78.95],
    zoom: 11,
    preferCanvas: true,
  });

  // ── Tile layers ───────────────────────────────────────────────
  _mapStreetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  });

  _mapSatLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles © Esri — Source: Esri, USGS, NOAA',
      maxZoom: 19,
    }
  );

  _mapStreetLayer.addTo(_map);

  // Wire satellite toggle button
  document.getElementById('mapSatBtn')?.addEventListener('click', () => {
    _mapUseSatellite = !_mapUseSatellite;
    const btn = document.getElementById('mapSatBtn');
    if (_mapUseSatellite) {
      _map.removeLayer(_mapStreetLayer);
      _mapSatLayer.addTo(_map);
      if (btn) { btn.textContent = '🗺️ Street View'; btn.title = 'Switch to street map'; }
    } else {
      _map.removeLayer(_mapSatLayer);
      _mapStreetLayer.addTo(_map);
      if (btn) { btn.textContent = '🛰️ Satellite'; btn.title = 'Switch to satellite imagery'; }
    }
  });
  
  // ── Map panes (visual hierarchy) ───────────────────────────────
  _map.createPane('garagePane');
  _map.getPane('garagePane').style.zIndex = 450;

  for (const key of Object.keys(LG)) {
    LG[key] = L.layerGroup().addTo(_map);
  }
  // Populate route dropdown
  populateRouteDropdown();

  // Wire controls
  document.getElementById('routeSelect').addEventListener('change', e => {
    _currentRouteId = e.target.value;
    onRouteChange(_currentRouteId);
  });

  document.getElementById('togLateOnly')?.addEventListener('change', e => {
    _showLateOnly = e.target.checked;
    if (_showLateOnly && _showEarlyOnly) {
      _showEarlyOnly = false;
      const earlyTog = document.getElementById('togEarlyOnly');
      if (earlyTog) earlyTog.checked = false;
    }
    refreshMapVehicles();
  });

  document.getElementById('togEarlyOnly')?.addEventListener('change', e => {
    _showEarlyOnly = e.target.checked;
    if (_showEarlyOnly && _showLateOnly) {
      _showLateOnly = false;
      const lateTog = document.getElementById('togLateOnly');
      if (lateTog) lateTog.checked = false;
    }
    refreshMapVehicles();
  });

  ['togVehicles','togEarly','togRoutes','togStops','togAlerts','togFlags','togSnapped','togGarages'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', syncLayerVisibility);
  });

  // Right-click on map → flag nearest stop
  _map.on('contextmenu', handleContextMenu);

  // Load garages
  loadGarages();

  // Start vehicle refresh
  refreshMapVehicles();
  _mapInterval = setInterval(refreshMapVehicles, 15_000);
}


// Official DRT on‑time performance thresholds (seconds)
// These match ontimeEngine.js — kept here for reference only.
// Do NOT use these for filtering; always use v.performance_status instead.
const PERFORMANCE_THRESHOLDS = {
  EARLY: -29,
  LATE:   329,
};

/* ── garages ───────────────────────────────────── */
async function loadGarages() {
  try {
    const data = await apiFetch('/garages');
    LG.garages.clearLayers();

    (data || []).forEach(g => {
      if (!g.lat || !g.lon) return;

      const m = L.marker([g.lat, g.lon], {
        pane: 'garagePane',
        zIndexOffset: -100,
        icon: L.divIcon({
          className: 'garage-marker',
          html: `
            <div class="garage-icon">
              <svg xmlns="http://www.w3.org/2000/svg"
                   viewBox="0 0 24 24"
                   width="18"
                   height="18"
                   fill="#ffffff">
                <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
              </svg>
            </div>
          `,
          iconSize: [36, 36],
          iconAnchor: [18, 20],
          popupAnchor: [0, -22],
        })
      });

      m.bindPopup(`
        <div style="min-width:180px">
          <strong>🏛️ ${g.name}</strong><br>
          <small style="color:#64748b">Garage</small><br>
          <small>${g.address || 'No address'}</small>
        </div>
      `);

      m.addTo(LG.garages);
    });
  } catch (e) {
    console.warn('Garage load error:', e);
  }
}

// ── populate route dropdown ───────────────────────────────────────
async function populateRouteDropdown() {
  try {
    const routesData = await apiFetch('/routes');
    const vehiclesData = await apiFetch('/vehicles');
    const sel = document.getElementById('routeSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— All Routes —</option>';

    const routeOptions = new Map(); // route_id -> display text

    // Add base routes
    (routesData.data || []).forEach(r => {
      const display = (r.route_short_name ? `${r.route_short_name} – ` : '') +
                      (r.route_long_name || r.route_id);
      routeOptions.set(r.route_id, display);
    });

    // Add variants from vehicles
    (vehiclesData.data || []).forEach(v => {
      const routeKey = v.route_variant || v.route_id;
      if (routeKey && !routeOptions.has(routeKey)) {
        routeOptions.set(routeKey, routeKey); // Simple display for variants
      }
    });

    // Sort and add options
    Array.from(routeOptions.entries())
      .sort(([a], [b]) => {
        // Sort numerically if possible, else alphabetically
        const aNum = parseInt(a, 10);
        const bNum = parseInt(b, 10);
        if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
        return a.localeCompare(b);
      })
      .forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        sel.appendChild(opt);
      });
  } catch (e) {
    console.warn('Route dropdown error:', e);
  }
}

// ── route change ─────────────────────────────────────────────────
async function onRouteChange(routeId) {
  // Clear route-specific layers
  LG.route.clearLayers();
  LG.stops.clearLayers();
  updateRouteInfoBox(null);

  _currentRouteId = routeId; // Ensure it's set

  if (!routeId) {
    // show all vehicles
    refreshMapVehicles();
    return;
  }

  const isVariant = /^[0-9]+[A-Z]$/.test(routeId);
  const baseRoute = isVariant ? routeId.replace(/[A-Z]$/, '') : routeId;

  try {
    // 1. Route info
    const routeData = await apiFetch(`/routes/${baseRoute}`);
    if (isVariant) {
      // Modify for variant display
      routeData.route_short_name = routeId;
      routeData.route_long_name = `${routeData.route_long_name} (${routeId})`;
    }
    updateRouteInfoBox(routeData);

    // 2. Draw shape
    const shapeData = await apiFetch(`/routes/${baseRoute}/shape`);
    drawRouteShape(shapeData, routeData);

    // 3. Load stops
    const stopsData = await apiFetch(`/routes/${baseRoute}/stops`);
    drawRouteStops(stopsData.data || []);

    // 4. Refresh vehicles (filtered)
    refreshMapVehicles();

  } catch (e) {
    console.warn('Route change error:', e);
  }
}

function updateRouteInfoBox(route) {
  const box   = document.getElementById('routeInfoBox');
  const badge = document.getElementById('routeBadge');
  const meta  = document.getElementById('routeMeta');
  if (!box) return;

  if (!route) { box.style.display = 'none'; return; }
  box.style.display = '';
  badge.style.background = '#' + (route.route_color || '0070C0');
  badge.textContent = route.route_short_name || route.route_id;
  meta.textContent  = route.route_long_name || '';
}

// ── draw route shape ──────────────────────────────────────────────
function drawRouteShape(shapeData, route) {
  LG.route.clearLayers();
  if (!shapeData || !shapeData.shapes || !shapeData.shapes.length) return;

  const color = '#' + (route?.route_color || '2563eb');

  shapeData.shapes.forEach((shape, i) => {
    const coords = shape.coordinates.map(([lon, lat]) => [lat, lon]);
    L.polyline(coords, {
      color,
      weight: i === 0 ? 4 : 2,
      opacity: i === 0 ? 0.85 : 0.5,
      dashArray: i === 0 ? null : '6 4',
    }).addTo(LG.route);
  });

  // Zoom to bbox
  if (shapeData.bbox) {
    const { minLat, maxLat, minLon, maxLon } = shapeData.bbox;
    _map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [30, 30] });
  }
}

// ── draw route stops ──────────────────────────────────────────────
function drawRouteStops(stops) {
  LG.stops.clearLayers();
  stops.forEach(stop => {
    if (!stop.stop_lat || !stop.stop_lon) return;
    const m = L.circleMarker([stop.stop_lat, stop.stop_lon], {
      radius: 5, fillColor: '#fff', color: '#1e293b',
      weight: 2, opacity: 1, fillOpacity: 1,
    });
    m.bindPopup(buildStopPopup(stop));
    m.on('contextmenu', () => openFlagModal(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon));
    m.addTo(LG.stops);
  });
}

function buildStopPopup(stop) {
  return `<div style="min-width:160px">
    <strong>${stop.stop_name || stop.stop_id}</strong>
    <br><small style="color:#64748b">Stop ${stop.stop_code || stop.stop_id}</small>
    ${stop.arrival_time ? `<br><small>Scheduled: ${stop.arrival_time}</small>` : ''}
    <br><br>
    <button onclick="openFlagModal('${stop.stop_id}','${(stop.stop_name||'').replace(/'/g,"\\'")}',${stop.stop_lat},${stop.stop_lon})"
      style="font-size:.7rem;cursor:pointer;padding:.1rem .4rem;border:1px solid #e2e8f0;border-radius:3px;background:#f8fafc">
      🚩 Report issue
    </button>
  </div>`;
}

// ── refresh vehicles ──────────────────────────────────────────────
async function refreshMapVehicles() {
  try {
    const url = _currentRouteId
      ? `/vehicles?route_id=${_currentRouteId}`
      : '/vehicles';
    const data = await apiFetch(url);
    const vehicles = data.data || [];
    let visibleVehicles = vehicles;

    // Filter by performance_status — mutually exclusive toggles
    if (_showLateOnly) {
      visibleVehicles = vehicles.filter(v => v.performance_status === 'late');
    } else if (_showEarlyOnly) {
      visibleVehicles = vehicles.filter(v => v.performance_status === 'early');
    }

    window.global_vehicles_cache = vehicles;

    LG.vehicles.clearLayers();
    LG.early.clearLayers();
    window.liveVehicleMarkers = {};
    LG.raw.clearLayers();

    visibleVehicles.forEach(v => {
      if (!v.latitude || !v.longitude) return;

      // Trail
      updateTrail(v);
      drawTrail(v.vehicle_id);

      // Main marker
      const m = L.marker([v.latitude, v.longitude], {
        icon: vehicleIcon(v),
        zIndexOffset: v.is_stale ? 0 : 100,
      });

      m.__vehicleData = v;
      window.liveVehicleMarkers[v.vehicle_id] = m;

      m.bindPopup(buildVehiclePopup(v));
      m.addTo(LG.vehicles);

      // Early vehicle highlight ring — added to a separate togglable layer
      // so operators can turn it on/off independently of the main vehicle layer
      if (v.performance_status === 'early') {
        const ring = L.circleMarker([v.latitude, v.longitude], {
          radius:      18,
          fillColor:   'transparent',
          color:       '#2563eb',
          weight:      2.5,
          opacity:     0.75,
          fillOpacity: 0,
          dashArray:   '5 4',
        });
        ring.bindTooltip(
          `🔵 Early — ${v.route_id || ''} · Veh ${v.vehicle_id}`,
          { sticky: true }
        );
        ring.addTo(LG.early);
      }

      // Raw GPS dot (shown when "show raw GPS" checked)
      if (v.raw_latitude && v.raw_longitude &&
          (v.raw_latitude !== v.latitude || v.raw_longitude !== v.longitude)) {
        const raw = L.circleMarker([v.raw_latitude, v.raw_longitude], {
          radius: 4, fillColor: '#f59e0b', color: '#fff', weight: 1,
          fillOpacity: 0.7, opacity: 0.8,
        });
        raw.bindTooltip('Raw GPS', { permanent: false });
        raw.addTo(LG.raw);
      }
    });

    // Update live counts
    const lc = document.getElementById('mapLiveCounts');
    if (lc) {
      const snapped = visibleVehicles.filter(v => v.snapped).length;
      const stale   = visibleVehicles.filter(v => v.is_stale).length;
      const filterLabel = _showLateOnly ? 'late ' : _showEarlyOnly ? 'early ' : '';
      lc.innerHTML =
        `<b>${visibleVehicles.length}</b> ${filterLabel}vehicles<br>` +
          `<span style="color:#16a34a">${snapped} snapped</span> · ` +
          `<span style="color:#d97706">${stale} stale</span>`;
    }

    // FIX: Use performance_status for the late bus summary panel too —
    // consistent with the filter and icon logic above.
    const lateVehicles = vehicles.filter(v => v.performance_status === 'late');
    renderLateBusSummary(lateVehicles);

    // Re‑apply Presenter Mode filtering after refresh
    if (
      window.presenterMapController &&
      presenterVehicleVisibility.activeRegion
    ) {
      applyRegionVehicleFilter(presenterVehicleVisibility.activeRegion);
    }
  } catch (e) {
    console.warn('Vehicle refresh error:', e);
  }
}

// ── vehicle icon ──────────────────────────────────────────────────
function vehicleIcon(v) {
  const status = v.performance_status || 'unknown';
  const delay  = typeof v.delay_seconds === 'number' ? v.delay_seconds : null;

  let bg = '#16a34a'; // on_time — DRT green
  if      (status === 'early')   bg = '#2563eb';
  else if (status === 'late')    bg = '#dc2626';
  else if (status === 'unknown') bg = '#64748b';
  else if (status === 'on_time' && delay !== null && delay > 180) bg = '#d97706';

  const size    = 28;
  const stale   = v.is_stale;
  const border  = stale ? '#94a3b8' : '#ffffff';
  const opacity = stale ? 0.55 : 1;
  const label   = v.route_variant || v.route_id || '?';

  // ── Direction arrow ───────────────────────────────────────────
  // Only shown when a route is selected — too noisy on the all-routes view.
  // Uses bearing from GTFS-RT (0=N, 90=E, 180=S, 270=W).
  let arrowHtml = '';
  const bearing = _currentRouteId &&
    typeof v.bearing === 'number' && v.bearing >= 0 ? v.bearing : null;
  if (bearing !== null) {
    // Offset the arrow tip 2px outside the circle border
    const arrowLen  = 8;   // px from centre to arrow tip
    const offset    = size / 2 + 3; // distance from icon centre to arrow base
    const rad       = (bearing - 90) * Math.PI / 180; // rotate so 0=up
    const tipX      = 50 + Math.cos(rad) * (offset + arrowLen);
    const tipY      = 50 + Math.sin(rad) * (offset + arrowLen);
    const baseL     = { x: 50 + Math.cos(rad - 0.5) * offset, y: 50 + Math.sin(rad - 0.5) * offset };
    const baseR     = { x: 50 + Math.cos(rad + 0.5) * offset, y: 50 + Math.sin(rad + 0.5) * offset };
    arrowHtml = `
      <svg viewBox="0 0 100 100" style="position:absolute;inset:-${size/2}px;width:${size*2}px;height:${size*2}px;pointer-events:none;overflow:visible">
        <polygon points="${tipX},${tipY} ${baseL.x},${baseL.y} ${baseR.x},${baseR.y}"
          fill="${bg}" stroke="${border}" stroke-width="1.5" opacity="${opacity}"/>
      </svg>`;
  }

  return L.divIcon({
    html: `<div style="position:relative;width:${size}px;height:${size}px">
      ${arrowHtml}
      <div class="v-icon ${stale ? 'v-icon--stale' : ''}"
        style="background:${bg};border-color:${border};width:${size}px;height:${size}px;
               opacity:${opacity};color:#fff;display:flex;align-items:center;justify-content:center;
               font-size:.6rem;font-weight:800;border-radius:50%;border:2px solid ${border};
               box-shadow:0 1px 4px rgba(0,0,0,.3);position:relative;z-index:1">
        ${label}
      </div>
    </div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
    className:  '',
  });
}

// ── vehicle popup ─────────────────────────────────────────────────
function buildVehiclePopup(v) {
  const status = v.performance_status || 'unknown';
  const delay  = typeof v.delay_seconds === 'number' ? v.delay_seconds : null;

  // ── Status line ───────────────────────────────────────────────
  let statusColour = '#16a34a';
  let statusIcon   = '🟢';
  let statusLabel  = 'On time';

  // Smart helpers — fall back to inline if app.js not loaded yet
  const _fmtDur  = window.fmtDuration || (s => `${Math.round(Math.abs(s))}s`);
  const _fmtDist = window.fmtDist     || (m => m < 1000 ? `${m} m` : `${(m/1000).toFixed(1)} km`);
  const _fmtEta  = window.fmtEta      || (s => s < 10 ? 'Now' : `${Math.round(s/60)} min`);

  if (status === 'late') {
    statusColour = '#dc2626'; statusIcon = '🔴';
    statusLabel  = delay !== null
      ? `Late — <b>+${_fmtDur(delay)}</b> behind schedule`
      : 'Late';
  } else if (status === 'early') {
    statusColour = '#2563eb'; statusIcon = '🔵';
    statusLabel  = delay !== null
      ? `Early — <b>${_fmtDur(Math.abs(delay))}</b> ahead of schedule`
      : 'Running early';
  } else if (status === 'on_time') {
    const secs = delay !== null ? ` (${delay > 0 ? '+' : ''}${delay}s)` : '';
    statusLabel = `On time${secs}`;
  } else {
    statusColour = '#64748b'; statusIcon = '⚪';
    statusLabel  = 'Calculating…';
  }

  // ── Next stop & ETA ───────────────────────────────────────────
  let nextStopLine = '';
  if (Array.isArray(v.next_stops) && v.next_stops.length) {
    const stopsHtml = v.next_stops.slice(0, 3).map((stop, idx) => {
      const distStr = stop.dist_m != null ? ` (${_fmtDist(stop.dist_m)} away)` : '';
      const etaStr = stop.eta_seconds_away != null ? ` - ETA <b>${_fmtEta(stop.eta_seconds_away)}</b>` : '';
      return `${idx + 1}. <b>${stop.stop_name}</b>${distStr}${etaStr}`;
    }).join('<br>');
    nextStopLine = `<br><small style="color:#475569">🚏 Upcoming:<br>${stopsHtml}</small>`;
  } else if (v.next_stop_name || v.matched_stop_name) {
    const stopName = v.next_stop_name || v.matched_stop_name;
    const distM    = v.next_stop_dist_m ?? v.matched_stop_dist_m;
    const etaSec   = v.eta_seconds_away;
    const etaStr   = etaSec != null ? ` - ETA <b>${_fmtEta(etaSec)}</b>` : '';
    const distStr  = distM  != null ? ` (${_fmtDist(distM)} away)` : '';
    nextStopLine = `<br><small style="color:#475569">🚏 Next: <b>${stopName}</b>${distStr}${etaStr}</small>`;
  }

  // ── Speed ─────────────────────────────────────────────────────
  let speedLine = '';
  if (v.calculated_speed_kmh != null) {
    const src = v.speed_source === 'gps_delta'
      ? `<span style="color:#16a34a" title="Calculated from last two GPS fixes">GPS Δ</span>`
      : v.speed_source === 'gtfs_rt'
        ? `<span style="color:#2563eb" title="Reported by vehicle transponder">RT</span>`
        : `<span style="color:#94a3b8" title="Default estimate">est.</span>`;
    const deltaDetail = v.speed_source === 'gps_delta' && v.gps_delta_dist_m != null
      ? ` <small style="color:#94a3b8">(${_fmtDist(v.gps_delta_dist_m)} / ${v.gps_delta_dt_sec}s)</small>`
      : '';
    speedLine = `<br>🚀 Speed: <b>${v.calculated_speed_kmh} km/h</b> ${src}${deltaDetail}`;
  } else if (v.speed != null) {
    speedLine = `<br>Speed: ${v.speed} km/h`;
  }

  // ── Data quality ──────────────────────────────────────────────
  const staleTxt = v.is_stale
    ? `<span style="color:#d97706">⚠️ Stale GPS (${v.age_seconds != null ? _fmtDur(v.age_seconds) : '?'} old)</span>`
    : '<span style="color:#16a34a">✓ Live GPS</span>';
  const snapTxt  = v.snapped
    ? `<span style="color:#2563eb">📍 Snapped (${_fmtDist(v.snap_distance_m ?? 0)})</span>`
    : v.snap_distance_m
      ? `<span style="color:#64748b">Raw GPS (${_fmtDist(v.snap_distance_m)} off-route)</span>`
      : '';
  const teleport = v.teleport_flagged
    ? `<br><span style="color:#dc2626">🚨 Position jump (${v.implied_speed_kmh} km/h)</span>`
    : '';

  const routeLabel = v.route_variant || v.route_id || '–';
  const headsignLine = v.branch
    ? `<br>Headsign: <span style="color:#64748b">${v.branch}</span>`
    : '';

  return `<div style="min-width:220px;font-size:.8rem;line-height:1.7">
    <strong style="font-size:.9rem">🚌 Vehicle ${v.vehicle_id}</strong>
    <br>Route: <b>${routeLabel}${v.direction ? ' ' + v.direction : ''}</b>
    ${headsignLine}
    ${v.trip_id ? `<br>Trip: <span style="color:#64748b">${v.trip_id}</span>` : ''}
    <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
    <span style="color:${statusColour}">${statusIcon} ${statusLabel}</span>
    ${nextStopLine}
    ${speedLine}
    ${v.bearing ? `<br>Heading: ${Math.round(v.bearing)}°` : ''}
    <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
    ${staleTxt}${snapTxt ? ' · ' + snapTxt : ''}
    ${teleport}
    <br><small style="color:#94a3b8">GPS fix: ${v.timestamp ? new Date(v.timestamp * 1000).toLocaleTimeString() : '–'}</small>
  </div>`;
}

// ── trails ────────────────────────────────────────────────────────
function updateTrail(v) {
  const id = v.vehicle_id;
  if (!_trails[id]) _trails[id] = [];
  _trails[id].push({ lat: v.latitude, lon: v.longitude, ts: v.timestamp });
  if (_trails[id].length > MAX_TRAIL) _trails[id].shift();
}

function drawTrail(vehicleId) {
  const trail = _trails[vehicleId];
  if (!trail || trail.length < 2) return;
  if (_trailPoly[vehicleId]) _map.removeLayer(_trailPoly[vehicleId]);

  const coords = trail.map(p => [p.lat, p.lon]);
  _trailPoly[vehicleId] = L.polyline(coords, {
    color: '#3b82f6', weight: 2, opacity: 0.5, dashArray: '4 3',
  }).addTo(_map);
}

// ── load all stops (when no route selected) ───────────────────────
async function loadAllStops() {
  try {
    const data = await apiFetch('/stops?limit=600');
    LG.stops.clearLayers();
    (data.data || []).forEach(stop => {
      if (!stop.stop_lat || !stop.stop_lon) return;
      const m = L.circleMarker([stop.stop_lat, stop.stop_lon], {
        radius: 4, fillColor: '#3b82f6', color: '#fff', weight: 1.5,
        fillOpacity: 0.7, opacity: 0.9,
      });
      m.bindPopup(buildStopPopup(stop));
      m.on('contextmenu', () =>
        openFlagModal(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon));
      m.addTo(LG.stops);
    });
  } catch (e) {
    console.warn('Stops load error:', e);
  }
}

// ── load flags ────────────────────────────────────────────────────
async function loadFlags() {
  try {
    const data = await apiFetch('/flags?status=open');
    LG.flags.clearLayers();
    (data.data || []).forEach(flag => {
      const m = L.circleMarker([flag.stop_lat, flag.stop_lon], {
        radius: 7, fillColor: '#f59e0b', color: '#fff', weight: 2,
        fillOpacity: 0.9, opacity: 1,
      });
      m.bindPopup(`<strong>🚩 ${flag.stop_name}</strong><br>
        Issue: ${flag.reason}<br>
        ${flag.comment ? 'Note: ' + flag.comment + '<br>' : ''}
        <small style="color:#64748b">Reported ${new Date(flag.created_at).toLocaleDateString()}</small>`);
      m.addTo(LG.flags);
    });
  } catch (e) {}
}

// ── load alerts on map ────────────────────────────────────────────
async function loadAlertsOnMap() {
  try {
    const data = await apiFetch('/alerts');
    LG.alerts.clearLayers();
    (data.data || []).forEach((alert, i) => {
      const lat = 43.86 + i * 0.015;
      const lon = -78.98;
      const m = L.circleMarker([lat, lon], {
        radius: 8, fillColor: alert.severity === 'SEVERE' ? '#dc2626' : '#d97706',
        color: '#fff', weight: 2, fillOpacity: 0.9,
      });
      m.bindPopup(`<strong>${alert.severity || 'Alert'}</strong><br>
        ${alert.header_text || 'Service alert'}<br>
        <small>${alert.description || ''}</small>`);
      m.addTo(LG.alerts);
    });
  } catch (e) {}
}

// ── context menu ──────────────────────────────────────────────────
function handleContextMenu(e) {
  let best = null, bestDist = 150;
  LG.stops.eachLayer(m => {
    const d = e.latlng.distanceTo(m.getLatLng());
    if (d < bestDist) { bestDist = d; best = m; }
  });
  if (best) {
    const latlng = best.getLatLng();
    openFlagModal('stop', 'Selected Stop', latlng.lat, latlng.lng);
  }
}

// ── layer visibility ──────────────────────────────────────────────
function syncLayerVisibility() {
  const tog = id => document.getElementById(id)?.checked;
  if (tog('togVehicles')) _map.addLayer(LG.vehicles);  else _map.removeLayer(LG.vehicles);
  if (tog('togEarly'))    _map.addLayer(LG.early);     else _map.removeLayer(LG.early);
  if (tog('togRoutes'))   _map.addLayer(LG.route);     else _map.removeLayer(LG.route);
  if (tog('togStops'))    _map.addLayer(LG.stops);     else _map.removeLayer(LG.stops);
  if (tog('togAlerts'))   _map.addLayer(LG.alerts);    else _map.removeLayer(LG.alerts);
  if (tog('togFlags'))    _map.addLayer(LG.flags);     else _map.removeLayer(LG.flags);
  if (tog('togSnapped'))  _map.addLayer(LG.raw);       else _map.removeLayer(LG.raw);
}

/**
 * ================================================================
 * PRESENTER MODE — MAP INTEGRATION
 * ================================================================
 */

const presenterVehicleVisibility = {
  activeRegion: null
};

function isVehicleInRegion(vehicle, bounds) {
  const [[southLat, westLon], [northLat, eastLon]] = bounds;
  return (
    vehicle.latitude  >= southLat &&
    vehicle.latitude  <= northLat &&
    vehicle.longitude >= westLon &&
    vehicle.longitude <= eastLon
  );
}

function applyRegionVehicleFilter(region) {
  presenterVehicleVisibility.activeRegion = region;

  if (!window.liveVehicleMarkers) {
    console.warn("Vehicle marker registry not found");
    return;
  }

  Object.values(window.liveVehicleMarkers).forEach(marker => {
    const vehicle = marker.__vehicleData;
    if (!vehicle) return;
    const visible = isVehicleInRegion(vehicle, region.bounds);
    marker.setOpacity(visible ? 1 : 0);
  });
}

function clearRegionVehicleFilter() {
  presenterVehicleVisibility.activeRegion = null;
  if (!window.liveVehicleMarkers) return;
  Object.values(window.liveVehicleMarkers).forEach(marker => marker.setOpacity(1));
}

function showRegion(region, options = {}) {
  const { animate = true, durationMs = 2000 } = options;

  if (!_map) {
    console.warn("Leaflet map not initialized");
    return;
  }

  _map.fitBounds(region.bounds, {
    padding: [40, 40],
    animate,
    duration: durationMs / 1000
  });

  applyRegionVehicleFilter(region);
  console.log(`[MAP] Presenter region applied: ${region.name}`);
  _currentRouteId = '';
}

window.presenterMapController = {
  showRegion,
  clearRegionVehicleFilter
};

// ── late bus summary panel ────────────────────────────────────────
function renderLateBusSummary(lateVehicles) {
  const panel = document.getElementById('lateBusSummary');
  const count = document.getElementById('lateBusCount');
  if (!panel || !count) return;

  count.textContent = lateVehicles.length;

  if (!lateVehicles.length) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';

  // Group by route
  const byRoute = {};
  lateVehicles.forEach(v => {
    const r = v.route_id || 'Unknown';
    if (!byRoute[r]) byRoute[r] = [];
    byRoute[r].push(v);
  });

  const listEl = document.getElementById('lateBusList');
  if (!listEl) return;

  listEl.innerHTML = Object.entries(byRoute)
    .sort((a, b) => {
      // Sort by worst delay first (delay_seconds may be null for some — treat as 0)
      const maxA = Math.max(...a[1].map(v => v.delay_seconds ?? 0));
      const maxB = Math.max(...b[1].map(v => v.delay_seconds ?? 0));
      return maxB - maxA;
    })
    .map(([routeId, buses]) => {
      const maxDelay = Math.max(...buses.map(v => v.delay_seconds ?? 0));
      const _fmtDur  = window.fmtDuration || (s => `${Math.round(s/60)} min`);
      const delayStr = _fmtDur(maxDelay);
      return `<div class="late-bus-row" onclick="filterToLateRoute('${routeId}')" title="Click to filter to route ${routeId}">
        <span class="late-route-pill">${routeId}</span>
        <span class="late-bus-info">${buses.length} bus${buses.length > 1 ? 'es' : ''} · up to +${delayStr}</span>
      </div>`;
    }).join('');
}

window.filterToLateRoute = function(routeId) {
  _showLateOnly  = true;
  _showEarlyOnly = false;
  const lateTog  = document.getElementById('togLateOnly');
  const earlyTog = document.getElementById('togEarlyOnly');
  if (lateTog)  lateTog.checked  = true;
  if (earlyTog) earlyTog.checked = false;
  const sel = document.getElementById('routeSelect');
  if (sel) { sel.value = routeId; sel.dispatchEvent(new Event('change')); }
};

// expose
window.initMap            = initMap;
window.refreshMapVehicles = refreshMapVehicles;
window.syncLayerVisibility = syncLayerVisibility;
window.getLiveMapVehicleIcon = vehicleIcon;
