/* ═══════════════════════════════════════════════════════════
   map.js — DRT Operations Hub · Leaflet Map
═══════════════════════════════════════════════════════════ */
'use strict';
// Presenter Mode — live vehicle marker registry
window.liveVehicleMarkers = {};

let _map         = null;
let _mapInited   = false;
let _mapInterval = null;
let _showLateOnly = false;

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
  
  document.getElementById('togLateOnly')?.addEventListener('change', e => {
  _showLateOnly = e.target.checked;
  refreshMapVehicles();
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


// Official DRT on‑time performance thresholds (seconds)
const PERFORMANCE_THRESHOLDS = {
  EARLY: -30,     // more than 30s early
  ONTIME_LOW: -30,
  ONTIME_HIGH: 330, // 5m 30s late
  LATE: 330
};
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
    let visibleVehicles = vehicles;

// 🚨 Late-only filter
if (_showLateOnly) {
  visibleVehicles = vehicles.filter(v =>
    typeof v.delay_seconds === 'number' &&
    v.delay_seconds > PERFORMANCE_THRESHOLDS.LATE
  );
}

    window.global_vehicles_cache = vehicles;

    LG.vehicles.clearLayers();
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
      lc.innerHTML =
        `<b>${visibleVehicles.length}</b> ${_showLateOnly ? 'late' : ''} vehicles<br>` +
          `<span style="color:#16a34a">${snapped} snapped</span> · ` +
          `<span style="color:#d97706">${stale} stale</span>`;

    }
        
const lateVehicles = vehicles.filter(
  v => typeof v.delay_seconds === 'number' &&
       v.delay_seconds > PERFORMANCE_THRESHOLDS.LATE
);

// Update late bus summary panel in sidebar
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
  const delay = typeof v.delay_seconds === 'number'
    ? v.delay_seconds
    : 0;

  const isLate = delay > PERFORMANCE_THRESHOLDS.LATE;
  let bg = '#16a34a'; // on‑time

  if (delay < PERFORMANCE_THRESHOLDS.EARLY) {
    bg = '#2563eb'; // early (blue)
  } else if (delay > PERFORMANCE_THRESHOLDS.LATE) {
    bg = '#dc2626'; // late (red)
  } else if (delay > PERFORMANCE_THRESHOLDS.ONTIME_HIGH - 150) {
    bg = '#d97706'; // approaching late / minor delay (orange)
  }

  // rest of the function stays exactly the same
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
  const delay = typeof v.delay_seconds === 'number'
  ? v.delay_seconds
  : null;

  let delayTxt = '✅ On time';

  if (delay != null) {
    if (delay < PERFORMANCE_THRESHOLDS.EARLY) {
      delayTxt = `🟦 ${Math.abs(delay)} sec early`;
    } 
    else if (delay > PERFORMANCE_THRESHOLDS.LATE) {
      delayTxt = `🚨 <b>LATE</b> (${Math.round(delay / 60)} min)`;
    }
  }
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

/**
 * ================================================================
 * PRESENTER MODE — MAP INTEGRATION
 * ================================================================
 *
 * This block integrates Presenter Mode with the existing map.
 * It exposes a small, controlled interface that allows:
 *
 *   - Zooming the map to a specific region
 *   - Filtering vehicles by region boundaries
 *   - Showing only relevant routes during presentation
 *
 * IMPORTANT:
 * -----------
 * This code does NOT alter normal map behavior unless
 * Presenter Mode is actively invoking it.
 *
 * ================================================================
 */

/**
 * Cache of all live vehicle markers.
 * We reuse existing markers rather than rebuilding them.
 */
const presenterVehicleVisibility = {
  activeRegion: null
};

/**
 * Determines whether a vehicle lies within a region bounding box.
 *
 * @param {Object} vehicle - Live vehicle object
 * @param {Array} bounds  - [[southLat, westLon], [northLat, eastLon]]
 * @returns {boolean}
 */
function isVehicleInRegion(vehicle, bounds) {
  const [[southLat, westLon], [northLat, eastLon]] = bounds;

  return (
    vehicle.latitude  >= southLat &&
    vehicle.latitude  <= northLat &&
    vehicle.longitude >= westLon &&
    vehicle.longitude <= eastLon
  );
}

/**
 * Apply region-based visibility filtering to vehicles.
 *
 * Vehicles inside the region:
 *   ✅ Visible
 * Vehicles outside the region:
 *   ❌ Hidden (not removed, just hidden)
 */
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

    if (visible) {
      marker.setOpacity(1);
    } else {
      marker.setOpacity(0);
    }
  });
}

/**
 * Restore normal vehicle visibility (exit Presenter Mode).
 */
function clearRegionVehicleFilter() {
  presenterVehicleVisibility.activeRegion = null;

  if (!window.liveVehicleMarkers) return;

  Object.values(window.liveVehicleMarkers).forEach(marker => {
    marker.setOpacity(1);
  });
}

/**
 * Zoom the map to a region and apply filtering.
 *
 * This is the PRIMARY entry point used by presenter.js
 */
function showRegion(region, options = {}) {
  const {
    animate = true,
    durationMs = 2000
  } = options;

 if (!_map) {
  console.warn("Leaflet map not initialized");
  return;
}

// Zoom map to region
_map.fitBounds(region.bounds, {
  padding: [40, 40],
  animate,
  duration: durationMs / 1000
});

  // Apply vehicle filtering
  applyRegionVehicleFilter(region);

  console.log(
    `[MAP] Presenter region applied: ${region.name}`
  );
  _currentRouteId = '';
}

/**
 * Expose the Presenter Mode controller for presenter.js
 *
 * We intentionally keep this interface minimal.
 */
window.presenterMapController = {
  showRegion,
  clearRegionVehicleFilter
};

/**
 * ================================================================
 * END PRESENTER MODE MAP INTEGRATION
 * ================================================================
 */


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
      // Sort by worst delay first
      const maxA = Math.max(...a[1].map(v => v.delay_seconds));
      const maxB = Math.max(...b[1].map(v => v.delay_seconds));
      return maxB - maxA;
    })
    .map(([routeId, buses]) => {
      const maxDelay = Math.max(...buses.map(v => v.delay_seconds));
      const delayMin = Math.round(maxDelay / 60);
      return `<div class="late-bus-row" onclick="filterToLateRoute('${routeId}')" title="Click to filter to route ${routeId}">
        <span class="late-route-pill">${routeId}</span>
        <span class="late-bus-info">${buses.length} bus${buses.length > 1 ? 'es' : ''} · up to +${delayMin} min</span>
      </div>`;
    }).join('');
}

window.filterToLateRoute = function(routeId) {
  _showLateOnly = true;
  const tog = document.getElementById('togLateOnly');
  if (tog) tog.checked = true;
  const sel = document.getElementById('routeSelect');
  if (sel) { sel.value = routeId; sel.dispatchEvent(new Event('change')); }
};

// expose
window.initMap            = initMap;
window.refreshMapVehicles = refreshMapVehicles;
window.syncLayerVisibility = syncLayerVisibility;
window.getLiveMapVehicleIcon = vehicleIcon;

