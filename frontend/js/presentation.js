// frontend/js/presentation.js
'use strict';
console.log("✅ presentation.js loaded");

let currentIndex = 0;
let presentationRunning = false;

// Rolling delay history per municipality
const delayHistoryByRegion = {};
const DELAY_BUCKET_MS = 5 * 60 * 1000; // 5‑minute buckets
const MAX_HISTORY_MS  = 90 * 60 * 1000; // 90 minutes

function recordDelaySample(regionName, vehicles, bounds) {
  const now = Date.now();

  const localVehicles = vehicles.filter(v =>
    typeof v.delay_seconds === 'number' &&
    v.latitude  >= bounds[0][0] &&
    v.latitude  <= bounds[1][0] &&
    v.longitude >= bounds[0][1] &&
    v.longitude <= bounds[1][1]
  );

  if (!delayHistoryByRegion[regionName]) {
    delayHistoryByRegion[regionName] = [];
  }

  if (localVehicles.length === 0) return;

  const avgDelayMin =
    localVehicles.reduce((sum, v) => sum + v.delay_seconds, 0) /
    localVehicles.length / 60;

  delayHistoryByRegion[regionName].push({
    t: now,
    v: avgDelayMin
  });

  // Trim old data
  delayHistoryByRegion[regionName] =
    delayHistoryByRegion[regionName].filter(
      p => now - p.t <= MAX_HISTORY_MS
    );
}
/* ===============================================================
   Bounds safety (prevents Leaflet failures)
================================================================ */
function isValidBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return false;
  const [[sLat, sLng], [nLat, nLng]] = bounds;
  return (
    typeof sLat === 'number' &&
    typeof sLng === 'number' &&
    typeof nLat === 'number' &&
    typeof nLng === 'number' &&
    sLat < nLat &&
    sLng < nLng &&
    sLat > -90 && nLat < 90 &&
    sLng > -180 && nLng < 180
  );
}

/* ===============================================================
   Presentation regions (service‑focused, tight)
   NOTE: staticBounds = fallback when no vehicles are present
================================================================ */
const municipalities = [
  // GTA boundary service
  {
    name: "Scarborough",
    staticBounds: [[43.730, -79.380], [43.820, -79.160]]
  },

  {
    name: "Pickering",
    staticBounds: [[43.800, -79.120], [43.865, -78.985]]
  },
  {
    name: "Ajax",
    staticBounds: [[43.820, -79.070], [43.895, -78.940]]
  },

  // Whitby split
  {
    name: "Whitby",
    staticBounds: [[43.845, -78.960], [43.900, -78.915]]
  },
  {
    name: "Brooklin",
    staticBounds: [[43.900, -78.960], [43.945, -78.905]]
  },

  // Oshawa / Courtice split
  {
    name: "Oshawa",
    staticBounds: [[43.860, -78.915], [43.915, -78.870]]
  },
  {
    name: "Courtice",
    staticBounds: [[43.900, -78.885], [43.935, -78.800]]
  },

  // Clarington communities
  {
    name: "Bowmanville",
    staticBounds: [[43.880, -78.720], [43.935, -78.650]]
  },
  {
    name: "Newcastle",
    staticBounds: [[43.905, -78.620], [43.940, -78.560]]
  },
  {
    
name: "Orono",
  staticBounds: [
    [43.992, -78.637],
    [44.005, -78.605]
]
  },

  // North Durham
  {
    name: "Port Perry",
    staticBounds: [[44.090, -78.960], [44.125, -78.900]]
  },
  {
    
 name: "Uxbridge",
  staticBounds: [
    [44.090, -79.135],
    [44.115, -79.080]
  ]

  },
  {
   
name: "Beaverton",
  staticBounds: [
    [44.420, -79.165],
    [44.445, -79.135]
  ]

  },
  {
   
  name: "Sunderland",
  staticBounds: [
    [44.385, -79.075],
    [44.410, -79.045]
  ]

  },
  {
    name: "Brock (Rural)",
    staticBounds: [[44.200, -79.390], [44.340, -79.230]]
  }
];

// ✅ Keep only valid regions
const regions = municipalities.filter(r => {
  const ok = isValidBounds(r.staticBounds);
  if (!ok) console.warn('[PRESENTATION] Invalid bounds skipped:', r.name);
  return ok;
});

/* ===============================================================
   Vehicle cache
================================================================ */
async function ensureVehicleData(forceRefresh = false) {
  if (!forceRefresh && window.global_vehicles_cache && window.global_vehicles_cache.length > 0) {
    return window.global_vehicles_cache;
  }
  try {
    const res = await fetch('/api/vehicles');
    const json = await res.json();
    window.global_vehicles_cache = json.data || [];
  } catch (e) {
    console.warn('[PRESENTATION] Failed to refresh vehicle data:', e);
  }
  return window.global_vehicles_cache || [];
}

/* ===============================================================
   Compute TRUE focus bounds (vehicles first, fallback second)
================================================================ */
function getFocusBoundsForRegion(vehicles, staticBounds) {
  const matching = vehicles.filter(v =>
    v.latitude  >= staticBounds[0][0] &&
    v.latitude  <= staticBounds[1][0] &&
    v.longitude >= staticBounds[0][1] &&
    v.longitude <= staticBounds[1][1]
  );

  // If we have live vehicles, zoom to where service actually exists
  if (matching.length >= 2) {
    return L.latLngBounds(
      matching.map(v => [v.latitude, v.longitude])
    );
  }

  // Otherwise fall back to static bounds
  return staticBounds;
}

/* ===============================================================
   Entry point
================================================================ */
window.startPresentation = async function () {
  if (presentationRunning) return;
  presentationRunning = true;

  initPresentationMap();
  await ensureVehicleData();

  if (!window._presentationRoutesLoaded) {
    await loadAllPresentationRoutes();
    window._presentationRoutesLoaded = true;
  }

  showRegion();

  setInterval(() => {
    currentIndex = (currentIndex + 1) % regions.length;
    showRegion();
  }, 25000);
};

/* ===============================================================
   Show region (with fade + service‑based zoom)
================================================================ */
async function showRegion() {
  const region = regions[currentIndex];
  if (!region) return;

  const container = document.getElementById('presentation-content');
  if (container) container.classList.add('hidden');

  // Always refresh vehicle data each cycle so late/early counts stay current
  const vehicles = await ensureVehicleData(true);

  setTimeout(() => {
    document.getElementById("presentation-title").textContent = region.name;

// ✅ Record one delay sample for this region
recordDelaySample(
  region.name,
  vehicles,
  region.staticBounds
);

// ✅ Update chart for this municipality
updateDelayTrendChart(region.name);

const focusBounds = getFocusBoundsForRegion(
  vehicles,
  region.staticBounds
);

updatePresentationMap(vehicles, focusBounds, region.staticBounds);
updateMunicipalityKPIs(region.staticBounds, vehicles);

    if (container) container.classList.remove('hidden');
  }, 300);
}

/* ===============================================================
   Delay classification (shared semantics)
================================================================ */
function classifyDelayFromVehicle(v) {
  if (typeof v.delay_seconds !== 'number') return 'unknown';
  if (v.delay_seconds < -30) return 'early';
  if (v.delay_seconds <= 330) return 'ontime';
  return 'late';
}

/* ===============================================================
   KPI calculation (vehicles physically inside region)
================================================================ */
function updateMunicipalityKPIs(bounds, vehicles) {
  // Accept vehicles param directly so we always use fresh data
  const allVehicles = vehicles || window.global_vehicles_cache || [];

  const localVehicles = allVehicles.filter(v =>
    typeof v.latitude === 'number' && typeof v.longitude === 'number' &&
    v.latitude  >= bounds[0][0] &&
    v.latitude  <= bounds[1][0] &&
    v.longitude >= bounds[0][1] &&
    v.longitude <= bounds[1][1]
  );

  let early = 0, ontime = 0, late = 0;
  const lateVehicles = [];

  localVehicles.forEach(v => {
    const status = classifyDelayFromVehicle(v);
    if (status === 'early') early++;
    else if (status === 'ontime') ontime++;
    else if (status === 'late') { late++; lateVehicles.push(v); }
  });

  const total = localVehicles.length;
  const otp = total ? Math.round((ontime / total) * 100) : 0;

  document.getElementById('kpi-active').textContent = total;
  document.getElementById('kpi-early').textContent = early;
  document.getElementById('kpi-ontime').textContent = ontime;
  document.getElementById('kpi-late').textContent = late;
  document.getElementById('kpi-otp').textContent = `${otp}%`;

  // Show late bus detail list
  renderPresentationLateBuses(lateVehicles);
}

/* ===============================================================
   Late bus detail list for presentation panel
================================================================ */
function renderPresentationLateBuses(lateVehicles) {
  const el = document.getElementById('presentation-late-buses');
  if (!el) return;

  if (!lateVehicles.length) {
    el.innerHTML = '<div class="late-none">✅ No late buses in this area</div>';
    return;
  }

  // Group by route
  const byRoute = {};
  lateVehicles.forEach(v => {
    const r = v.route_id || 'Unknown';
    if (!byRoute[r]) byRoute[r] = [];
    byRoute[r].push(v);
  });

  el.innerHTML = `
    <div class="late-buses-title">🚨 Late Buses (${lateVehicles.length})</div>
    ${Object.entries(byRoute)
      .sort((a, b) => {
        const maxA = Math.max(...a[1].map(v => v.delay_seconds));
        const maxB = Math.max(...b[1].map(v => v.delay_seconds));
        return maxB - maxA;
      })
      .map(([routeId, buses]) => {
        const maxDelay = Math.max(...buses.map(v => v.delay_seconds));
        const delayMin = Math.round(maxDelay / 60);
        return `<div class="pres-late-row">
          <span class="pres-late-pill">${routeId}</span>
          <span class="pres-late-detail">${buses.length} bus${buses.length > 1 ? 'es' : ''}</span>
          <span class="pres-late-delay">+${delayMin} min</span>
        </div>`;
      }).join('')}
  `;
}

/* ===============================================================
   Delay Trend Chart (Avg Delay in Minutes)
================================================================ */

let delayTrendChart = null;

function updateDelayTrendChart(regionName) {
  const samples = delayHistoryByRegion[regionName] || [];
  const canvas = document.getElementById('delayTrendChart');
  if (!canvas) return;

  // Bucket samples into 5‑minute averages
  const buckets = {};
  samples.forEach(p => {
    const bucket =
      Math.floor(p.t / DELAY_BUCKET_MS) * DELAY_BUCKET_MS;
    buckets[bucket] ??= [];
    buckets[bucket].push(p.v);
  });

  const labels = [];
  const values = [];

  Object.keys(buckets).sort().forEach(ts => {
    const avg =
      buckets[ts].reduce((a, b) => a + b, 0) /
      buckets[ts].length;

    labels.push(
      new Date(+ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    );
    values.push(+avg.toFixed(1));
  });

  // Update existing chart
  if (delayTrendChart) {
    delayTrendChart.data.labels = labels;
    delayTrendChart.data.datasets[0].data = values;
    delayTrendChart.update();
    return;
  }

  // Create chart once
  delayTrendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Avg Delay (min)',
        data: values,
        borderColor: '#16a34a',
        backgroundColor: 'rgba(22,163,74,.15)',
        fill: true,
        tension: 0.35,
        pointRadius: 3
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx =>
              `${ctx.raw} min average delay`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: v => `${v} min`
          }
        },
        x: {
          ticks: { maxRotation: 0 }
        }
      }
    }
  });
}