// frontend/js/presentation.js
'use strict';

let currentIndex = 0;

const municipalities = [
  { name: "Pickering", bounds: [[43.80, -79.10], [43.90, -78.90]] },
  { name: "Ajax", bounds: [[43.83, -79.05], [43.88, -78.95]] },
  { name: "Whitby", bounds: [[43.84, -78.98], [43.90, -78.92]] },
  { name: "Oshawa", bounds: [[43.85, -78.93], [43.95, -78.83]] },
  { name: "Uxbridge", bounds: [[44.07, -79.15], [44.15, -79.00]] },
  { name: "Brock", bounds: [[44.30, -79.20], [44.50, -78.90]] },
  { name: "Scugog", bounds: [[44.10, -79.25], [44.30, -78.95]] },
  { name: "Clarington", bounds: [[43.85, -78.90], [44.20, -78.30]] }
];

window.startPresentation = function () {
  initPresentationMap();
  showMunicipality();

  clearInterval(window.presentationInterval);
  window.presentationInterval = setInterval(() => {
    currentIndex = (currentIndex + 1) % municipalities.length;
    showMunicipality();
  }, 25000);
};

function showMunicipality() {
  const m = municipalities[currentIndex];

  document.getElementById("presentation-title").textContent = m.name;

  // Use the SAME vehicle data already fetched by Live Map
  const vehicles = window.global_vehicles_cache || [];

  const filtered = vehicles.filter(v =>
    v.latitude >= m.bounds[0][0] &&
    v.latitude <= m.bounds[1][0] &&
    v.longitude >= m.bounds[0][1] &&
    v.longitude <= m.bounds[1][1]
  );

  updatePresentationMap(filtered, m.bounds);
}