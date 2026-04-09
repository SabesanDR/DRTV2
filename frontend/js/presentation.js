// frontend/js/presentation.js
'use strict';
console.log("✅ presentation.js loaded");


let currentIndex = 0;
let presentationRunning = false;

const municipalities = [
  {
    name: "Pickering",
    bounds: [[43.794, -79.120], [43.865, -78.970]]
  },
  {
    name: "Ajax",
    bounds: [[43.810, -79.070], [43.895, -78.925]]
  },
  {
    name: "Whitby",
    bounds: [[43.845, -78.980], [43.945, -78.890]]
  },
  {
    name: "Oshawa",
    bounds: [[43.845, -78.930], [43.975, -78.830]]
  },
  {
    name: "Clarington",
    bounds: [[43.885, -78.520], [44.095, -78.300]]
  },
  {
    name: "Uxbridge",
    bounds: [[44.090, -79.160], [44.135, -79.085]]
  },
  {
    name: "Scugog",
    bounds: [[44.095, -79.215], [44.170, -79.115]]
  },
  {
    name: "Brock",
    bounds: [[44.225, -79.415], [44.465, -79.185]]
  }
];

async function ensureVehicleData() {
  if (window.global_vehicles_cache && window.global_vehicles_cache.length > 0) {
    return window.global_vehicles_cache;
  }
  const res = await fetch('/api/vehicles');
  const json = await res.json();
  window.global_vehicles_cache = json.data || [];
  return window.global_vehicles_cache;
}

window.startPresentation = async function () {
  if (presentationRunning) return;
  presentationRunning = true;

  initPresentationMap();
  await ensureVehicleData();

  if (!window._presentationRoutesLoaded) {
    await loadAllPresentationRoutes();
    window._presentationRoutesLoaded = true;
  }

  showMunicipality();

  setInterval(() => {
    currentIndex = (currentIndex + 1) % municipalities.length;
    showMunicipality();
  }, 25000);
};


function showMunicipality() {
  const m = municipalities[currentIndex];

  // Update the title
  document.getElementById("presentation-title").textContent = m.name;

  // ✅ USE ALL VEHICLES — NO FILTERING
  const vehicles = window.global_vehicles_cache || [];

  // ✅ Just move the camera
  updatePresentationMap(vehicles, m.bounds);

  
 // ✅ KPI overlay is municipality-specific
  updateMunicipalityKPIs(m.bounds);


}

function classifyDelay(delaySec) {
  if (delaySec < -30) return 'early';
  if (delaySec <= 330) return 'ontime';
  return 'late';
}

function updateMunicipalityKPIs(municipalityBounds) {
  const vehicles = window.global_vehicles_cache || [];

  // Vehicles physically inside the focus municipality
  const localVehicles = vehicles.filter(v =>
    v.latitude  >= municipalityBounds[0][0] &&
    v.latitude  <= municipalityBounds[1][0] &&
    v.longitude >= municipalityBounds[0][1] &&
    v.longitude <= municipalityBounds[1][1]
  );

  let early = 0, ontime = 0, late = 0;

  localVehicles.forEach(v => {
    const status = classifyDelay(v.arrival_delay || 0);
    if (status === 'early') early++;
    else if (status === 'ontime') ontime++;
    else late++;
  });

  const total = localVehicles.length;
  const otp = total > 0 ? Math.round((ontime / total) * 100) : 0;

  // Update DOM
  document.getElementById('kpi-active').textContent = total;
  document.getElementById('kpi-early').textContent = early;
  document.getElementById('kpi-ontime').textContent = ontime;
  document.getElementById('kpi-late').textContent = late;
  document.getElementById('kpi-otp').textContent = `${otp}%`;
}

