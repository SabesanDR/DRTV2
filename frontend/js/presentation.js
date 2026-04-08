// frontend/js/presentation.js
'use strict';

let currentIndex = 0;

/*const municipalities = [
  { name: "Pickering", bounds: [[43.80, -79.10], [43.90, -78.90]] },
  { name: "Ajax", bounds: [[43.83, -79.05], [43.88, -78.95]] },
  { name: "Whitby", bounds: [[43.84, -78.98], [43.90, -78.92]] },
  { name: "Oshawa", bounds: [[43.85, -78.93], [43.95, -78.83]] },
  { name: "Uxbridge", bounds: [[44.07, -79.15], [44.15, -79.00]] },
  { name: "Brock", bounds: [[44.30, -79.20], [44.50, -78.90]] },
  { name: "Scugog", bounds: [[44.10, -79.25], [44.30, -78.95]] },
  { name: "Clarington", bounds: [[43.85, -78.90], [44.20, -78.30]] }
];*/
const municipalities = [
  {
    name: "Pickering",
    // Kingston Rd ↔ Bayly / Liverpool ↔ Brock
    bounds: [
      [43.794, -79.120], // SW
      [43.865, -78.970]  // NE
    ]
  },
  {
    name: "Ajax",
    // Fairall → Harwood → Bayly → Taunton
    bounds: [
      [43.820, -79.060],
      [43.905, -78.910]
    ]
  },
  {
    name: "Whitby",
    // Thickson / Brock / Dundas / Taunton corridor
    bounds: [
      [43.845, -78.980],
      [43.945, -78.890]
    ]
  },
  {
    name: "Oshawa",
    // Simcoe / Harmony / Taunton / Lake
    bounds: [
      [43.845, -78.930],
      [43.975, -78.830]
    ]
  },
  {
    name: "Clarington",
    // Courtice + Bowmanville core only
    bounds: [
      [43.880, -78.520],
      [44.080, -78.300]
    ]
  },
  {
    name: "Uxbridge",
    // Downtown + main corridors only
    bounds: [
      [44.080, -79.200],
      [44.165, -79.000]
    ]
  },
  {
    name: "Scugog",
    // Port Perry core (not entire township)
    bounds: [
      [44.150, -79.300],
      [44.250, -79.150]
    ]
  },
  {
    name: "Brock",
    // Beaverton / Sunderland / Cannington clusters
    bounds: [
      [44.220, -79.500],
      [44.450, -79.200]
    ]
  }
];

// Official DRT on‑time performance thresholds (seconds)
const PERFORMANCE_THRESHOLDS = {
  EARLY: -30,     // more than 30s early
  ONTIME_LOW: -30,
  ONTIME_HIGH: 330, // 5m 30s late
  LATE: 330
};

async function ensureVehicleData() {
  if (window.global_vehicles_cache && window.global_vehicles_cache.length > 0) {
    return window.global_vehicles_cache;
  }

  try {
    const res = await fetch('/api/vehicles');
    const json = await res.json();
    window.global_vehicles_cache = json.data || [];
    return window.global_vehicles_cache;
  } catch (e) {
    console.warn('Failed to load vehicles for presentation', e);
    return [];
  }
}


window.startPresentation = async function () {
  initPresentationMap();
  await ensureVehicleData();

  // 🔑 load routes only once
  if (!window._presentationRoutesLoaded) {
    await loadAllPresentationRoutes();
    window._presentationRoutesLoaded = true;
  }

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