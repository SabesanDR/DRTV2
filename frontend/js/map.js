/* ═══════════════════════════════════════════════════════════
   map.js — DRT Operations Hub · Leaflet Map
═══════════════════════════════════════════════════════════ */
'use strict';

let _map         = null;
let _mapInited   = false;
let _mapInterval = null;

// Layer groups
const LG = {
  vehicles: null,
  route:    null,
  stops:    null,
  alerts:   null,
  flags:    null,
  raw:      null,   // raw GPS positions (optional overlay)
  trails:   null,
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(_map);

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

  ['togVehicles','togRoutes','togStops','togAlerts','togFlags','togSnapped'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', syncLayerVisibility);
  });

  // Right-click on map → flag nearest stop
  _map.on('contextmenu', handleContextMenu);

  // Start vehicle refresh
  refreshMapVehicles();
  _mapInterval = setInterval(refreshMapVehicles, 15_000);
}

// ── populate route dropdown ───────────────────────────────────────
async function populateRouteDropdown() {
  try {
    const data = await apiFetch('/routes');
    const sel  = document.getElementById('routeSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— All Routes —</option>';
    (data.data || []).forEach(r => {
      const opt = document.createElement('option');
      opt.value       = r.route_id;
      opt.textContent = (r.route_short_name ? `${r.route_short_name} – ` : '') +
                        (r.route_long_name || r.route_id);
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

  if (!routeId) {
    // show all vehicles
    refreshMapVehicles();
    return;
  }

  try {
    // 1. Route info
    const routeData = await apiFetch(`/routes/${routeId}`);
    updateRouteInfoBox(routeData);

    // 2. Draw shape
    const shapeData = await apiFetch(`/routes/${routeId}/shape`);
    drawRouteShape(shapeData, routeData);

    // 3. Load stops
    const stopsData = await apiFetch(`/routes/${routeId}/stops`);
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

    window.global_vehicles_cache = vehicles;

    LG.vehicles.clearLayers();
    LG.raw.clearLayers();

    vehicles.forEach(v => {
      if (!v.latitude || !v.longitude) return;

      // Trail
      updateTrail(v);
      drawTrail(v.vehicle_id);

      // Main marker
      const m = L.marker([v.latitude, v.longitude], {
        icon: vehicleIcon(v),
        zIndexOffset: v.is_stale ? 0 : 100,
      });
      m.bindPopup(buildVehiclePopup(v));
      m.addTo(LG.vehicles);

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
      const snapped = vehicles.filter(v => v.snapped).length;
      const stale   = vehicles.filter(v => v.is_stale).length;
      lc.innerHTML =
        `<b>${vehicles.length}</b> vehicles<br>` +
        `<span style="color:#16a34a">${snapped} snapped</span> · ` +
        `<span style="color:#d97706">${stale} stale</span>`;
    }

  } catch (e) {
    console.warn('Vehicle refresh error:', e);
  }
}

// ── vehicle icon ──────────────────────────────────────────────────
function vehicleIcon(v) {
  const delay = v.arrival_delay || 0;
  let bg = '#16a34a';
  if (delay > 300)      bg = '#dc2626';
  else if (delay > 60)  bg = '#d97706';

  const size   = 28;
  const stale  = v.is_stale;
  const border = stale ? '#94a3b8' : '#ffffff';
  const opacity = stale ? 0.55 : 1;
  const label  = v.route_id || '?';

  return L.divIcon({
    html: `<div class="v-icon ${stale ? 'v-icon--stale' : ''}"
      style="background:${bg};border-color:${border};width:${size}px;height:${size}px;opacity:${opacity};
             color:#fff;display:flex;align-items:center;justify-content:center;
             font-size:.6rem;font-weight:800;border-radius:50%;border:2px solid ${border};
             box-shadow:0 1px 4px rgba(0,0,0,.3)"
    >${label}</div>`,
    iconSize:   [size, size],
    iconAnchor: [size/2, size/2],
    className:  '',
  });
}

// ── vehicle popup ─────────────────────────────────────────────────
function buildVehiclePopup(v) {
  const delay    = v.arrival_delay || 0;
  const delayTxt = Math.abs(delay) < 60 ? '✅ On time'
    : delay > 0 ? `⚠️ +${Math.round(delay/60)} min late` : `🕐 ${Math.round(-delay/60)} min early`;
  const staleTxt = v.is_stale
    ? `<span style="color:#d97706">⚠️ Stale GPS (${v.age_seconds}s old)</span>`
    : '<span style="color:#16a34a">✓ Live GPS</span>';
  const snapTxt  = v.snapped
    ? `<span style="color:#2563eb">📍 Snapped (${v.snap_distance_m}m)</span>`
    : v.snap_distance_m ? `<span style="color:#64748b">Raw GPS (${v.snap_distance_m}m off-route)</span>` : '';
  const teleport = v.teleport_flagged
    ? `<br><span style="color:#dc2626">🚨 Jump detected (${v.implied_speed_kmh} km/h implied)</span>` : '';

  return `<div style="min-width:190px;font-size:.8rem;line-height:1.6">
    <strong style="font-size:.9rem">🚌 Vehicle ${v.vehicle_id}</strong>
    <br>Route: <b>${v.route_id || '–'}</b>
    ${v.trip_id ? `<br>Trip: ${v.trip_id}` : ''}
    <br>${delayTxt}
    ${v.speed != null ? `<br>Speed: ${v.speed} km/h` : ''}
    ${v.bearing ? `<br>Heading: ${Math.round(v.bearing)}°` : ''}
    <br>${staleTxt}
    ${snapTxt ? '<br>' + snapTxt : ''}
    ${teleport}
    <br><small style="color:#94a3b8">Updated: ${v.timestamp ? new Date(v.timestamp*1000).toLocaleTimeString() : '–'}</small>
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
  // Find nearest stop within 150m
  let best = null, bestDist = 150;
  LG.stops.eachLayer(m => {
    const d = e.latlng.distanceTo(m.getLatLng());
    if (d < bestDist) { bestDist = d; best = m; }
  });
  if (best) {
    const latlng = best.getLatLng();
    const pop    = best.getPopup()?.getContent() || '';
    // Try to extract stop info from popup
    openFlagModal('stop', 'Selected Stop', latlng.lat, latlng.lng);
  }
}

// ── layer visibility ──────────────────────────────────────────────
function syncLayerVisibility() {
  const tog = id => document.getElementById(id)?.checked;
  if (tog('togVehicles')) _map.addLayer(LG.vehicles);  else _map.removeLayer(LG.vehicles);
  if (tog('togRoutes'))   _map.addLayer(LG.route);     else _map.removeLayer(LG.route);
  if (tog('togStops'))    _map.addLayer(LG.stops);     else _map.removeLayer(LG.stops);
  if (tog('togAlerts'))   _map.addLayer(LG.alerts);    else _map.removeLayer(LG.alerts);
  if (tog('togFlags'))    _map.addLayer(LG.flags);     else _map.removeLayer(LG.flags);
  if (tog('togSnapped'))  _map.addLayer(LG.raw);       else _map.removeLayer(LG.raw);
}

// expose
window.initMap            = initMap;
window.refreshMapVehicles = refreshMapVehicles;
window.syncLayerVisibility = syncLayerVisibility;
