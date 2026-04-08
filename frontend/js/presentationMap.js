// frontend/js/presentationMap.js
'use strict';

let presentationMap = null;
let presentationLayers = {
  vehicles: null
};

window.initPresentationMap = function () {
  if (presentationMap) return;

  presentationMap = L.map('presentationMap', {
    center: [43.91, -78.95],
    zoom: 10,
    preferCanvas: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(presentationMap);

  presentationLayers.vehicles = L.layerGroup().addTo(presentationMap);
};

window.updatePresentationMap = function (vehicles, bounds) {
  if (!presentationMap) return;

  presentationMap.fitBounds(bounds, { padding: [40, 40] });

  presentationLayers.vehicles.clearLayers();

  vehicles.forEach(v => {
    if (!v.latitude || !v.longitude) return;

    L.circleMarker([v.latitude, v.longitude], {
      radius: 6,
      fillColor: '#16a34a',
      color: '#ffffff',
      weight: 1,
      fillOpacity: 0.9
    }).addTo(presentationLayers.vehicles);
  });
};
