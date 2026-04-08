/* ═══════════════════════════════════════════════════════════
   app.js — DRT Operations Hub · Main Controller
═══════════════════════════════════════════════════════════ */

'use strict';
const API = '';   // same-origin; empty string = relative URLs
let currentTab = 'dashboard';
let dashTimer  = null;

// ── boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  refreshDashboard();
  dashTimer = setInterval(refreshDashboard, 30_000);
  setInterval(checkHealth, 45_000);
  checkHealth();

  // Route search filter
  document.getElementById('routeSearch')
    ?.addEventListener('input', e => filterRoutesList(e.target.value));
});

// ── tab navigation ────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.id === `tab-${name}`));

  if (name === 'map')       { initMap();       refreshMapVehicles(); }
  if (name === 'analytics') { refreshAnalytics(); }
  if (name === 'reports')   { refreshReports(); }
}

// ── helpers ───────────────────────────────────────────────────────
async function apiFetch(path, opts) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(`${API}/api${path}`, { signal: ctrl.signal, ...opts });
    clearTimeout(tid);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

function fmtDelay(sec) {
  if (sec == null || isNaN(sec)) return '–';
  const m = Math.round(sec / 60);
  if (m === 0) return 'On time';
  return (m > 0 ? '+' : '') + m + ' min';
}
function fmtAge(sec) {
  if (sec == null) return '–';
  if (sec < 60) return sec + 's ago';
  return Math.floor(sec / 60) + 'm ago';
}

// ── dashboard ─────────────────────────────────────────────────────
async function refreshDashboard() {
  try {
    const [overview, routes, alerts] = await Promise.all([
      apiFetch('/analytics/overview').catch(() => null),
      apiFetch('/routes').catch(() => null),
      apiFetch('/alerts').catch(() => null),
    ]);

    if (overview) renderKPIs(overview);
    if (routes)   renderRoutesList(routes.data || []);
    if (alerts)   renderAlerts(alerts.data || []);
    if (overview) renderQuality(overview);

    document.getElementById('lastRefresh').textContent =
      'Last refresh: ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn('Dashboard refresh error:', e);
  }
}

function renderKPIs(d) {
  setText('kpi-vehicles',    d.vehicles ?? '–');
  setText('kpi-vehicles-sub', `${d.dataQuality?.staleVehicles ?? 0} stale`);
  setText('kpi-routes',      d.activeRoutes ?? '–');
  setText('kpi-total-routes', d.totalRoutes ?? '–');
  setText('kpi-ontime',      d.onTimePercent != null ? d.onTimePercent + '%' : '–');
  setText('kpi-ontime-sub',  d.feedLatency?.vehicles_age_sec != null
    ? fmtAge(d.feedLatency.vehicles_age_sec) : '');
  setText('kpi-delayed',     d.delayedTrips ?? '–');
  setText('kpi-avg-delay',   d.avgDelayMinutes != null ? d.avgDelayMinutes : '–');
  setText('kpi-alerts',      d.alerts ?? '0');
  setText('kpi-snapped',     d.dataQuality?.snappedPercent != null
    ? d.dataQuality.snappedPercent + '%' : '–');

  const dot = document.querySelector('.status-dot');
  if (dot) { dot.className = 'status-dot live'; }
  setText('statusText', `${d.vehicles ?? 0} vehicles`);
}

function renderQuality(d) {
  const dq = d.dataQuality || {};
  const total = d.vehicles || 1;

  setBar('qb-gps',  dq.vehiclesWithGPS, total);
  setBar('qb-snap', dq.snappedVehicles, total);
  setBar('qb-live', total - (dq.staleVehicles || 0), total);
  setBar('qb-tele', dq.teleportFlagged || 0, total, true);

  setText('qv-gps',  (dq.vehiclesWithGPS ?? 0) + '/' + total);
  setText('qv-snap', (dq.snappedVehicles ?? 0) + '/' + total);
  setText('qv-live', (total - (dq.staleVehicles || 0)) + '/' + total);
  setText('qv-tele', (dq.teleportFlagged ?? 0) + '');

  // Feed tags
  const fl = d.feedLatency || {};
  const tags = [
    { label: 'Vehicles', age: fl.vehicles_age_sec },
    { label: 'Trips',    age: fl.tripUpdates_age_sec },
    { label: 'Alerts',   age: fl.alerts_age_sec },
  ];
  const feedStatusEl = document.getElementById('feedStatusList');
  if (feedStatusEl) {
    feedStatusEl.innerHTML = tags.map(({ label, age }) => {
      const cls = age == null ? 'unknown' : age < 60 ? 'live' : age < 300 ? 'delayed' : 'stale';
      const txt = age == null ? '–' : fmtAge(age);
      return `<span class="feed-tag feed-tag--${cls}">${label}: ${txt}</span>`;
    }).join('');
  }

  // Health list
  const hl = document.getElementById('healthList');
  if (hl) {
    const rows = [
      { label: 'Vehicle Positions Feed', age: fl.vehicles_age_sec },
      { label: 'Trip Updates Feed',      age: fl.tripUpdates_age_sec },
      { label: 'Service Alerts Feed',    age: fl.alerts_age_sec },
    ];
    hl.innerHTML = rows.map(({ label, age }) => {
      const cls = age == null ? 'hs--error' : age < 60 ? 'hs--ok' : age < 300 ? 'hs--warn' : 'hs--error';
      const txt = age == null ? 'Offline' : age < 60 ? `Live (${fmtAge(age)})` : fmtAge(age);
      return `<div class="health-row">
        <span>${label}</span>
        <span class="health-status ${cls}">${txt}</span>
      </div>`;
    }).join('');
  }
}

function setBar(id, val, total, invert = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = total > 0 ? Math.round((val || 0) / total * 100) : 0;
  el.style.width = (invert ? Math.min(pct * 3, 100) : pct) + '%';
}

// ── routes list ───────────────────────────────────────────────────
let _allRoutes = [];
function renderRoutesList(routes) {
  _allRoutes = routes;
  filterRoutesList(document.getElementById('routeSearch')?.value || '');
}

function filterRoutesList(q) {
  const el = document.getElementById('routesList');
  if (!el) return;
  const filtered = q
    ? _allRoutes.filter(r =>
        (r.route_short_name || '').toLowerCase().includes(q.toLowerCase()) ||
        (r.route_long_name  || '').toLowerCase().includes(q.toLowerCase()))
    : _allRoutes;

  if (!filtered.length) {
    el.innerHTML = '<div class="empty-state">No routes found</div>'; return;
  }

  const vehicles = window._liveVehicles || [];
  el.innerHTML = filtered.slice(0, 40).map(r => {
    const color = '#' + (r.route_color || '0070C0');
    const vCount = vehicles.filter(v => v.route_id === r.route_id).length;
    return `<div class="route-row" onclick="goToRoute('${r.route_id}')">
      <span class="route-pill" style="background:${color}">${r.route_short_name || r.route_id}</span>
      <span class="route-name">${r.route_long_name || ''}</span>
      <span class="route-count">${vCount > 0 ? vCount + ' 🚌' : ''}</span>
    </div>`;
  }).join('');
}

function goToRoute(routeId) {
  switchTab('map');
  setTimeout(() => {
    const sel = document.getElementById('routeSelect');
    if (sel) { sel.value = routeId; sel.dispatchEvent(new Event('change')); }
  }, 200);
}

// ── alerts ────────────────────────────────────────────────────────
function renderAlerts(alerts) {
  const el  = document.getElementById('alertsList');
  const bdg = document.getElementById('alertBadge');
  if (bdg) bdg.textContent = alerts.length;
  if (bdg) bdg.style.display = alerts.length ? '' : 'none';

  // Update feed pill
  const pill = document.getElementById('pill-alerts');
  if (pill) {
    pill.textContent = `Alerts ${alerts.length}`;
    pill.className = alerts.length ? 'pill pill--delayed' : 'pill pill--live';
  }

  if (!el) return;
  if (!alerts.length) {
    el.innerHTML = '<div class="empty-state">No active service alerts</div>'; return;
  }
  el.innerHTML = alerts.map(a => {
    const sev = a.severity || 'INFO';
    return `<div class="alert-item">
      <span class="alert-sev sev--${sev}">${sev}</span>
      <div class="alert-text">
        <strong>${a.header_text || 'Service Alert'}</strong>
        <small>${a.description || ''}</small>
      </div>
    </div>`;
  }).join('');
}

// ── health check ──────────────────────────────────────────────────
async function checkHealth() {
  try {
    const h = await apiFetch('/health');
    const pill = document.getElementById('pill-vehicles');
    if (pill) {
      pill.textContent = `Vehicles ${h.realtime?.vehicles ?? 0}`;
      pill.className   = 'pill pill--live';
    }
    const tripPill = document.getElementById('pill-trips');
    if (tripPill) {
      tripPill.textContent = `Trips ${h.realtime?.tripUpdates ?? 0}`;
      tripPill.className   = 'pill pill--live';
    }
    window._liveVehicles = global_vehicles_cache || [];
  } catch (e) {
    const dot = document.querySelector('.status-dot');
    if (dot) dot.className = 'status-dot error';
    setText('statusText', 'Offline');
  }
}

// ── flag modal ────────────────────────────────────────────────────
let _flagContext = {};

function openFlagModal(stopId, stopName, lat, lon) {
  _flagContext = { stopId, stopName, lat, lon };
  document.getElementById('fStopId').value   = stopId;
  document.getElementById('fStopName').value = stopName;
  document.getElementById('fReason').value   = '';
  document.getElementById('fComment').value  = '';
  document.getElementById('flagModal').style.display = 'flex';
}
function closeFlagModal() {
  document.getElementById('flagModal').style.display = 'none';
}
async function submitFlag() {
  const reason = document.getElementById('fReason').value;
  if (!reason) { alert('Please select an issue type.'); return; }
  try {
    await apiFetch('/flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stop_id:  _flagContext.stopId,
        stop_name: _flagContext.stopName,
        stop_lat: _flagContext.lat,
        stop_lon: _flagContext.lon,
        reason,
        comment:  document.getElementById('fComment').value,
        created_by: 'web-user',
      }),
    });
    closeFlagModal();
    alert('✓ Issue reported successfully.');
    if (typeof refreshFlags === 'function') refreshFlags();
  } catch (e) {
    alert('Failed to submit: ' + e.message);
  }
}

// ── utility ───────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// expose for map.js
window.openFlagModal  = openFlagModal;
window.closeFlagModal = closeFlagModal;
window.submitFlag     = submitFlag;
window.fmtDelay       = fmtDelay;
window.apiFetch       = apiFetch;
window.goToRoute      = goToRoute;
window.global_vehicles_cache = [];
