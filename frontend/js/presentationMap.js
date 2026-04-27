// frontend/js/presentationMap.js
'use strict';

let presentationMap = null;
let vehiclesLayer   = null;
let routesLayer     = null;
let garagesLayer    = null;

window.initPresentationMap = function () {
  if (presentationMap) return;
  const el = document.getElementById('presentationMap');
  if (!el) return;

  presentationMap = L.map(el, {
    center: [43.91, -78.95],
    zoom: 10,
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(presentationMap);

  routesLayer   = L.layerGroup().addTo(presentationMap);
  vehiclesLayer = L.layerGroup().addTo(presentationMap);
  garagesLayer  = L.layerGroup().addTo(presentationMap);

  setTimeout(() => presentationMap.invalidateSize(), 150);
  loadPresentationGarages();
};

// ── Smart formatters (mirror app.js — work even if app.js not loaded) ──

/** Seconds → "45s" | "3 min 12s" | "1 hr 4 min" */
function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return '–';
  sec = Math.round(Math.abs(sec));
  if (sec < 60) return `${sec}s`;
  const totalMin = Math.floor(sec / 60);
  const remSec   = sec % 60;
  if (totalMin < 60) return remSec > 0 ? `${totalMin} min ${remSec}s` : `${totalMin} min`;
  const hrs  = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hrs} hr ${mins} min` : `${hrs} hr`;
}

/** Metres → "450 m" | "1.5 km" */
function fmtDist(m) {
  if (m == null || isNaN(m)) return '–';
  m = Math.round(m);
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// ── DRT official thresholds ───────────────────────────────────────
const PM_EARLY_SEC = -29;
const PM_LATE_SEC  =  329;

// ── Vehicle icon ─────────────────────────────────────────────────
function presentationVehicleIcon(v) {
  const status = v.performance_status || 'unknown';
  const delay  = typeof v.delay_seconds === 'number' ? v.delay_seconds : null;

  let bg = '#16a34a'; // on_time — DRT green
  if      (status === 'early')   bg = '#2563eb'; // blue
  else if (status === 'late')    bg = '#dc2626'; // red
  else if (status === 'unknown') bg = '#64748b'; // grey
  else if (status === 'on_time' && delay !== null && delay > 180) bg = '#d97706'; // amber

  // Delay badge above the circle — only for late/early, using smart formatter
  let badge = '';
  if (delay !== null && (status === 'late' || status === 'early')) {
    const sign = delay > 0 ? '+' : '−';
    badge = `<div style="
      position:absolute;top:-16px;left:50%;transform:translateX(-50%);
      background:${bg};color:#fff;
      font-size:9px;font-weight:800;
      padding:1px 5px;border-radius:8px;
      border:1.5px solid #fff;white-space:nowrap;
      box-shadow:0 1px 3px rgba(0,0,0,.3)">${sign}${fmtDur(Math.abs(delay))}</div>`;
  }

  return L.divIcon({
    html: `<div style="position:relative;width:30px;height:30px;">
      ${badge}
      <div style="
        background:${bg};width:30px;height:30px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        color:#fff;font-size:11px;font-weight:800;
        border:2px solid #fff;
        box-shadow:0 1px 4px rgba(0,0,0,.35)">${v.route_id || '?'}</div>
    </div>`,
    iconSize:   [30, 30],
    iconAnchor: [15, 15],
    className:  '',
  });
}

// ── Map update ────────────────────────────────────────────────────
window.updatePresentationMap = function (vehicles, focusBounds, staticBounds) {
  if (!presentationMap || !vehiclesLayer) return;

  presentationMap.fitBounds(focusBounds, {
    padding: [60, 60], maxZoom: 14, animate: true,
  });

  vehiclesLayer.clearLayers();

  const regionVehicles = staticBounds
    ? vehicles.filter(v =>
        typeof v.latitude  === 'number' &&
        typeof v.longitude === 'number' &&
        v.latitude  >= staticBounds[0][0] && v.latitude  <= staticBounds[1][0] &&
        v.longitude >= staticBounds[0][1] && v.longitude <= staticBounds[1][1]
      )
    : vehicles;

  regionVehicles.forEach(v => {
    if (!v.latitude || !v.longitude) return;

    const marker = L.marker([v.latitude, v.longitude], {
      icon: presentationVehicleIcon(v),
    });

    // ── Popup ─────────────────────────────────────────────────
    const status = v.performance_status || 'unknown';
    const delay  = typeof v.delay_seconds === 'number' ? v.delay_seconds : null;

    let statusIcon  = '🟢';
    let statusLabel = 'On time';
    let statusColor = '#16a34a';

    if (status === 'late') {
      statusIcon  = '🔴'; statusColor = '#dc2626';
      statusLabel = delay !== null
        ? `Late — <b>+${fmtDur(delay)}</b> behind schedule`
        : 'Late';
    } else if (status === 'early') {
      statusIcon  = '🔵'; statusColor = '#2563eb';
      statusLabel = delay !== null
        ? `Early — <b>${fmtDur(Math.abs(delay))}</b> ahead of schedule`
        : 'Running early';
    } else if (status === 'on_time') {
      const secs = delay !== null ? ` (${delay > 0 ? '+' : ''}${delay}s)` : '';
      statusLabel = `On time${secs}`;
    } else {
      statusIcon  = '⚪'; statusColor = '#64748b';
      statusLabel = 'Calculating…';
    }

    // Next stop + ETA
    let nextStopLine = '';
    if (Array.isArray(v.next_stops) && v.next_stops.length) {
      const stopsHtml = v.next_stops.slice(0, 3).map((stop, idx) => {
        const distStr = stop.dist_m != null ? ` · ${fmtDist(stop.dist_m)}` : '';
        const etaStr  = stop.eta_seconds_away != null ? ` - ETA <b>${fmtDur(stop.eta_seconds_away)}</b>` : '';
        return `${idx + 1}. <b>${stop.stop_name}</b>${distStr}${etaStr}`;
      }).join('<br>');
      nextStopLine = `<br><small style="color:#475569">🚏 Upcoming:<br>${stopsHtml}</small>`;
    } else {
      const stopName = v.next_stop_name || v.matched_stop_name;
      if (!stopName) {
        nextStopLine = '';
      } else {
      const distM  = v.next_stop_dist_m ?? v.matched_stop_dist_m;
      const etaSec = v.eta_seconds_away;
      const distStr = distM  != null ? ` · ${fmtDist(distM)}` : '';
      const etaStr  = etaSec != null ? ` - ETA <b>${fmtDur(etaSec)}</b>` : '';
      nextStopLine  = `<br><small style="color:#475569">🚏 ${stopName}${distStr}${etaStr}</small>`;
      }
    }

    // Speed with source badge
    let speedLine = '';
    if (v.calculated_speed_kmh != null) {
      const src = v.speed_source === 'gps_delta'
        ? '<span style="color:#16a34a" title="Calculated from GPS fixes">GPS Δ</span>'
        : v.speed_source === 'gtfs_rt'
          ? '<span style="color:#2563eb" title="Reported by transponder">RT</span>'
          : '<span style="color:#94a3b8">est.</span>';
      speedLine = `<br><small style="color:#64748b">🚀 ${v.calculated_speed_kmh} km/h ${src}</small>`;
    }

    const staleLine = v.is_stale
      ? `<br><small style="color:#d97706">⚠️ Stale GPS (${fmtDur(v.age_seconds)} old)</small>`
      : '';

    marker.bindPopup(`
      <div style="min-width:195px;font-size:.82rem;line-height:1.7">
        <strong style="font-size:.9rem">🚌 Route ${v.route_id || '–'}</strong>
        <br>Vehicle: <b>${v.vehicle_id || '–'}</b>
        <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
        <span style="color:${statusColor}">${statusIcon} ${statusLabel}</span>
        ${nextStopLine}${speedLine}${staleLine}
        <br><small style="color:#94a3b8">GPS: ${v.timestamp
          ? new Date(v.timestamp * 1000).toLocaleTimeString() : '–'}</small>
      </div>
    `);

    marker.addTo(vehiclesLayer);
  });
};

// ── Route shapes ──────────────────────────────────────────────────
window.loadAllPresentationRoutes = async function () {
  if (!routesLayer) return;
  routesLayer.clearLayers();

  const res    = await fetch('/api/routes');
  const routes = (await res.json()).data || [];

  for (const r of routes) {
    try {
      const shapeRes  = await fetch(`/api/routes/${r.route_id}/shape`);
      const shapeData = await shapeRes.json();
      if (!shapeData.shapes) continue;
      const color = '#' + (r.route_color || '999999');
      shapeData.shapes.forEach(s => {
        const coords = s.coordinates.map(([lon, lat]) => [lat, lon]);
        L.polyline(coords, { color, weight: 2, opacity: 0.6, interactive: false })
         .addTo(routesLayer);
      });
    } catch (e) {
      console.warn('Route shape failed:', r.route_id);
    }
  }
};

// ── Load garages ──────────────────────────────────────────────────
window.loadPresentationGarages = async function () {
  if (!garagesLayer) return;
  garagesLayer.clearLayers();

  try {
    const res = await fetch('/api/garages');
    const garages = await res.json();
    (garages || []).forEach(garage => {
      if (!garage.lat || !garage.lon) return;
      const marker = L.marker([garage.lat, garage.lon], {
        icon: L.icon({
          iconUrl: 'data:image/svg+xml;utf8,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23dc2626"%3E%3Cpath d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/%3E%3C/svg%3E',
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      });
      marker.bindPopup(`<div style="min-width:180px">
        <strong>🏢 ${garage.name}</strong>
        <br><small style="color:#64748b">Garage</small>
        <br><small>${garage.address || 'No address'}</small>
      </div>`);
      marker.addTo(garagesLayer);
    });
  } catch (e) {
    console.warn('Garage loading error:', e);
  }
};
