/* ═══════════════════════════════════════════════════════════
   rawMap.js — DRT Operations Hub · Raw GPS Map
   Purpose: Ground-truth view (unsnapped, unprocessed)
═══════════════════════════════════════════════════════════ */
'use strict';

let rawMap           = null;
let rawVehiclesLayer = null;
let _rawMapInited    = false;
let _rawRefreshTimer = null;

/* ── init ──────────────────────────────────────────────── */
window.initRawMap = function () {
    console.log('[RawMap] initRawMap called');
  if (_rawMapInited) return;
  _rawMapInited = true;

  const el = document.getElementById('rawMap');
  if (!el) {
    console.warn('[RawMap] rawMap element not found');
    return;
  }

  // Check if container is visible (has width)
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) {
    console.log('[RawMap] Container not visible yet, deferring initialization');
    // Try again in a moment when tab might be visible
    setTimeout(() => initRawMap(), 500);
    return;
  }

  rawMap = L.map(el, {
    center: [43.91, -78.95],
    zoom: 11,
    preferCanvas: true,
  });

  // Make globally accessible
  window.rawMap = rawMap;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(rawMap);

  rawVehiclesLayer = L.layerGroup().addTo(rawMap);

  // Force size update in case container dimensions change
  setTimeout(() => {
    if (rawMap) rawMap.invalidateSize();
  }, 100);

  // Initial load + refresh interval
  refreshRawMapVehicles();
  _rawRefreshTimer = setInterval(refreshRawMapVehicles, 20_000);

  // Fix sizing if embedded in tabs
  setTimeout(() => {
    if (rawMap) {
      rawMap.invalidateSize();
      console.log('[RawMap] Map initialized and sized');
    }
  }, 150);
};

/* ── Raw vehicle icon (intentionally simple) ───────────── */
function rawVehicleIcon(v) {
  return L.divIcon({
    className: 'raw-vehicle-marker',
    html: `
      <div style="
        width:18px;
        height:18px;
        background:#64748b;
        border-radius:50%;
        border:2px solid #ffffff;
        box-shadow:0 1px 4px rgba(0,0,0,.35);
        display:flex;
        align-items:center;
        justify-content:center;
        color:#fff;
        font-size:9px;
        font-weight:700;
      ">
        ${v.route_id || '?'}
      </div>
    `,
    iconSize:   [18, 18],
    iconAnchor: [9, 9],
  });
}

/* ── Refresh raw vehicles ─────────────────────────────── */
async function refreshRawMapVehicles() {
  if (!rawMap || !rawVehiclesLayer) return;

  try {
    const res = await fetch('/api/vehicles');
    const json = await res.json();
    const vehicles = json.data || [];

    rawVehiclesLayer.clearLayers();

    let bounds = [];

    vehicles.forEach(v => {
      if (typeof v.raw_latitude !== 'number' ||
          typeof v.raw_longitude !== 'number') {
        return;
      }

      const lat = v.raw_latitude;
      const lon = v.raw_longitude;

      bounds.push([lat, lon]);

      const marker = L.marker([lat, lon], {
        icon: rawVehicleIcon(v),
        zIndexOffset: 100,
      });

      marker.bindPopup(buildRawVehiclePopup(v));
      marker.addTo(rawVehiclesLayer);
    });

    // Fit once on first draw only
    if (bounds.length && !rawMap._hasFit) {
      rawMap.fitBounds(bounds, { padding: [40, 40] });
      rawMap._hasFit = true;
    }

  } catch (e) {
    console.warn('[RawMap] Vehicle refresh failed:', e);
  }
}

/* ── Popup (raw, transparent, factual) ────────────────── */
function buildRawVehiclePopup(v) {
  const spd =
    v.calculated_speed_kmh != null
      ? `${v.calculated_speed_kmh} km/h`
      : v.speed != null
        ? `${v.speed} km/h`
        : '–';

  return `
    <div style="min-width:210px;font-size:.8rem;line-height:1.6">
      <strong style="font-size:.9rem">🚌 Vehicle ${v.vehicle_id || '–'}</strong>
      <br>Route: <b>${v.route_id || '–'}</b>
      ${v.branch ? ` (${v.branch})` : ''}
      ${v.direction ? ` ${v.direction}` : ''}
      <br>Trip: <span style="color:#64748b">${v.trip_id || '–'}</span>

      <hr style="margin:.35rem 0;border:none;border-top:1px solid #e2e8f0">

      📍 Raw GPS
      <br>
      <small style="color:#475569">
        Lat: ${v.raw_latitude?.toFixed(6)}<br>
        Lon: ${v.raw_longitude?.toFixed(6)}
      </small>

      <br><br>
      🚀 Speed: <b>${spd}</b>

      <br><br>
      <small style="color:#94a3b8">
        Timestamp: ${
          v.timestamp
            ? new Date(v.timestamp * 1000).toLocaleTimeString()
            : '–'
        }
      </small>
    </div>
  `;
}

/* ── Cleanup (optional) ───────────────────────────────── */
window.destroyRawMap = function () {
  if (_rawRefreshTimer) clearInterval(_rawRefreshTimer);
  _rawRefreshTimer = null;
  _rawMapInited = false;

  if (rawMap) {
    rawMap.remove();
    rawMap = null;
    window.rawMap = null;
  }
};