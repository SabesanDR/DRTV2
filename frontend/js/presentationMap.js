// frontend/js/presentationMap.js
'use strict';

let presentationMap = null;
let presentationLayers = {
  routes: null,
  vehicles: null
};

window.initPresentationMap = function () {
  if (presentationMap) return;

  const container = document.getElementById('presentationMap');
  if (!container) {
    console.warn("presentationMap container not found");
    return;
  }

  presentationMap = L.map(container, {
    center: [43.91, -78.95],
    zoom: 10,
    preferCanvas: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(presentationMap);

  presentationLayers.routes   = L.layerGroup().addTo(presentationMap);
  presentationLayers.vehicles = L.layerGroup().addTo(presentationMap);

  // 🔑 CRITICAL FIX: force Leaflet to reflow after tab becomes visible
  setTimeout(() => {
    presentationMap.invalidateSize();
  }, 150);
};

function presentationVehicleIcon(v) {
  const delay = v.arrival_delay || 0;

  // Match Live Map colors
  let bg = '#16a34a';        // green (on time)
  if (delay > 300)      bg = '#dc2626'; // red (>5 min late)
  else if (delay > 60)  bg = '#d97706'; // orange (1–5 min late)

  const label = v.route_id || v.vehicle_id || '?';
  const size = 30;

  return L.divIcon({
    html: `
      <div style="
        background:${bg};
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        color:#fff;
        font-size:11px;
        font-weight:800;
        border:2px solid #ffffff;
        box-shadow:0 1px 4px rgba(0,0,0,.35);
      ">
        ${label}
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    className: ''
  });
}

async function loadAllPresentationRoutes() {
  presentationLayers.routes.clearLayers();

  const res = await fetch('/api/routes');
  const routes = (await res.json()).data || [];

  for (const r of routes) {
    try {
      const shapeRes = await fetch(`/api/routes/${r.route_id}/shape`);
      const shapeData = await shapeRes.json();

      if (!shapeData.shapes) continue;

      const color = '#' + (r.route_color || '999999');

      shapeData.shapes.forEach((s, idx) => {
        const coords = s.coordinates.map(([lon, lat]) => [lat, lon]);

        L.polyline(coords, {
          color,
          weight: 2,
          opacity: 0.35,         // 🔑 muted for background
          interactive: false,
        }).addTo(presentationLayers.routes);
      });
    } catch (e) {
      console.warn('Route shape load failed', r.route_id);
    }
  }
}


window.updatePresentationMap = function (vehicles, bounds) {
  if (!presentationMap) return;

 presentationMap.fitBounds(bounds, {
  padding: [40, 40],
  maxZoom: 14,
  animate: true
});

  presentationLayers.vehicles.clearLayers();

  vehicles.forEach(v => {
    if (!v.latitude || !v.longitude) return;

    const marker = L.marker(
      [v.latitude, v.longitude],
      { icon: presentationVehicleIcon(v) }
    );

    presentationLayers.vehicles.addLayer(marker);
  });
};
