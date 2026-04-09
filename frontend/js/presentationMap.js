// frontend/js/presentationMap.js
'use strict';

let presentationMap = null;
let vehiclesLayer = null;
let routesLayer = null;

window.initPresentationMap = function () {
  if (presentationMap) return;

  const el = document.getElementById('presentationMap');
  if (!el) return;

  presentationMap = L.map(el, {
    center: [43.91, -78.95],
    zoom: 10,
    preferCanvas: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(presentationMap);

  routesLayer = L.layerGroup().addTo(presentationMap);
  vehiclesLayer = L.layerGroup().addTo(presentationMap);

  setTimeout(() => presentationMap.invalidateSize(), 150);
};

// ✅ Simple, safe vehicle icon (same look as Live Map core)
function presentationVehicleIcon(v) {
  const delay = typeof v.delay_seconds === 'number'
    ? v.delay_seconds
    : 0;

  let bg = '#16a34a'; // on‑time
  if (delay < -30) bg = '#2563eb';     // early
  else if (delay > 330) bg = '#dc2626'; // late

  const label = v.route_id || '?';

  return L.divIcon({
    html: `<div style="
      background:${bg};
      width:30px;
      height:30px;
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      color:#fff;
      font-size:11px;
      font-weight:800;
      border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.35)">
      ${label}
    </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    className: ''
  });
}

window.updatePresentationMap = function (vehicles, bounds) {
  if (!presentationMap || !vehiclesLayer) return;

  presentationMap.fitBounds(bounds, {
    padding: [60, 60],
    maxZoom: 14,
    animate: true
  });

  vehiclesLayer.clearLayers();

  vehicles.forEach(v => {
    if (!v.latitude || !v.longitude) return;

    L.marker(
      [v.latitude, v.longitude],
      { icon: presentationVehicleIcon(v) }
    ).addTo(vehiclesLayer);
  });
};

window.loadAllPresentationRoutes = async function () {
  if (!routesLayer) return;

  routesLayer.clearLayers();

  const res = await fetch('/api/routes');
  const routes = (await res.json()).data || [];

  for (const r of routes) {
    try {
      const shapeRes = await fetch(`/api/routes/${r.route_id}/shape`);
      const shapeData = await shapeRes.json();
      if (!shapeData.shapes) continue;

      const color = '#' + (r.route_color || '999999');

      shapeData.shapes.forEach(s => {
        const coords = s.coordinates.map(([lon, lat]) => [lat, lon]);
        L.polyline(coords, {
          color,
          weight: 2,
          opacity: 0.6,
          interactive: false
        }).addTo(routesLayer);
      });
    } catch (err) {
      console.warn('Route load failed:', r.route_id);
    }
  }
};
