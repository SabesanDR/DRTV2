/* ═══════════════════════════════════════════════════════════
   analytics.js — DRT Operations Hub · Charts & Analytics
═══════════════════════════════════════════════════════════ */
'use strict';

// Chart instances (kept for destroy on refresh)
const _charts = {};

// ── boot ─────────────────────────────────────────────────────────
// Called by app.js when analytics tab is activated
async function refreshAnalytics() {
  await Promise.allSettled([
    renderOnTimeChart(),
    renderDelayTrendChart(),
    renderFleetChart(),
    renderHeadwayChart(),
    renderDelayedStopsTable(),
    renderGTFSHealth(),
  ]);
}

// ── on-time performance bar chart ────────────────────────────────
async function renderOnTimeChart() {
  try {
    const data = await apiFetch('/analytics/on-time');
    const rows = (data.by_route || []).slice(0, 12);

    const labels = rows.map(r => r.route_short_name || r.route_id);
    const onTime = rows.map(r => r.on_time_percent);
    const delayed= rows.map(r => 100 - r.on_time_percent);

    buildChart('chartOnTime', 'bar', {
      labels,
      datasets: [
        { label: 'On Time %', data: onTime,  backgroundColor: '#16a34a', borderRadius: 3 },
        { label: 'Delayed %', data: delayed, backgroundColor: '#dc2626', borderRadius: 3 },
      ],
    }, {
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.raw}%`,
            afterBody: (items) => {
              const row = rows[items[0].dataIndex];
              return [`Avg delay: ${row.avg_delay_min} min`, `Trips: ${row.total_trips}`];
            },
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 9 } } },
        y: { stacked: true, max: 100, ticks: { callback: v => v + '%' } },
      },
    });
  } catch (e) { console.warn('On-time chart error:', e); }
}

// ── delay trend line chart ────────────────────────────────────────
async function renderDelayTrendChart() {
  try {
    const data = await apiFetch('/analytics/delay-trend');
    const buckets = data.buckets || [];

    buildChart('chartDelayTrend', 'line', {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'Avg Delay (min)',
        data:  buckets.map(b => b.avg_delay_min),
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,.1)',
        borderWidth: 2,
        tension: 0.35,
        fill: true,
        pointRadius: 3,
      }],
    }, {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.raw} min delay` } },
      },
      scales: {
        y: { ticks: { callback: v => v + ' min' } },
        x: { ticks: { font: { size: 9 }, maxRotation: 0 } },
      },
    });
  } catch (e) {
    // No history yet — show placeholder
    const canvas = document.getElementById('chartDelayTrend');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Collecting data (30 min rolling window)…', canvas.width/2, 100);
    }
  }
}

// ── fleet utilization doughnut ────────────────────────────────────
async function renderFleetChart() {
  try {
    const data = await apiFetch('/analytics/fleet');

    buildChart('chartFleet', 'doughnut', {
      labels: ['On Route (live)', 'Stale GPS', 'Unassigned'],
      datasets: [{
        data: [
          data.live_gps          - data.unassigned,
          data.stale_gps,
          data.unassigned,
        ],
        backgroundColor: ['#16a34a', '#d97706', '#94a3b8'],
        borderWidth: 2,
      }],
    }, {
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 9 }, boxWidth: 10 } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.raw}` } },
      },
      cutout: '60%',
    });

    // Fleet stats
    const el = document.getElementById('fleetStats');
    if (el) {
      el.innerHTML = [
        { label: 'Total',       val: data.total_vehicles },
        { label: 'On route',    val: data.active_on_route },
        { label: 'Snapped',     val: data.snapped_to_route },
        { label: 'Utilization', val: data.utilization_pct + '%' },
      ].map(({ label, val }) =>
        `<div class="fleet-stat"><strong>${val}</strong>${label}</div>`
      ).join('');
    }
  } catch (e) { console.warn('Fleet chart error:', e); }
}

// ── headway bar chart ─────────────────────────────────────────────
async function renderHeadwayChart() {
  try {
    const data = await apiFetch('/analytics/headway');
    const rows = (data.by_route || []).filter(r => r.avg_headway_min != null).slice(0, 10);

    buildChart('chartHeadway', 'bar', {
      labels: rows.map(r => r.route_short_name || r.route_id),
      datasets: [{
        label: 'Avg Headway (min)',
        data:  rows.map(r => r.avg_headway_min),
        backgroundColor: rows.map(r =>
          r.headway_regularity > 80 ? '#16a34a' :
          r.headway_regularity > 50 ? '#d97706' : '#dc2626'),
        borderRadius: 3,
      }],
    }, {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const r = rows[ctx.dataIndex];
              return [`Avg: ${r.avg_headway_min} min`,
                      `Regularity: ${r.headway_regularity ?? '–'}%`];
            },
          },
        },
      },
      scales: {
        x: { ticks: { callback: v => v + 'm' } },
        y: { ticks: { font: { size: 9 } } },
      },
    });
  } catch (e) { console.warn('Headway chart error:', e); }
}

// ── top delayed stops table ───────────────────────────────────────
async function renderDelayedStopsTable() {
  try {
    const data = await apiFetch('/analytics/stops');
    const rows = data.top_delayed || [];
    const tbody = document.querySelector('#delayedStopsTable tbody');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">No delay data yet</td></tr>';
      return;
    }

    tbody.innerHTML = rows.slice(0, 15).map(r => {
      const avgMin = r.avg_delay_min;
      const color  = avgMin > 5 ? 'color:#dc2626' : avgMin > 2 ? 'color:#d97706' : 'color:#16a34a';
      return `<tr>
        <td>${r.stop_name || r.stop_id}</td>
        <td style="${color}"><b>${r.avg_delay_min} min</b></td>
        <td>${Math.round(r.max_delay_sec / 60)} min</td>
        <td>${r.trip_count}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    const tbody = document.querySelector('#delayedStopsTable tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">No data yet</td></tr>';
  }
}

// ── GTFS health grid ──────────────────────────────────────────────
async function renderGTFSHealth() {
  try {
    const d = await apiFetch('/analytics/gtfs-health');
    const el = document.getElementById('gtfsHealthGrid');
    if (!el) return;

    const feeds  = d.feeds      || {};
    const cov    = d.coverage   || {};
    const acc    = d.accuracy   || {};
    const stat   = d.static     || {};

    const cards = [
      // Feed status
      { val: feeds.vehicles?.count ?? '–',    label: 'Live Vehicles',   sub: feedBadge(feeds.vehicles?.status),    cls: feedCls(feeds.vehicles?.status) },
      { val: feeds.tripUpdates?.count ?? '–', label: 'Trip Updates',    sub: feedBadge(feeds.tripUpdates?.status), cls: feedCls(feeds.tripUpdates?.status) },
      { val: feeds.alerts?.count ?? '–',      label: 'Active Alerts',   sub: feedBadge(feeds.alerts?.status),      cls: feedCls(feeds.alerts?.status) },
      // Coverage
      { val: (cov.trip_coverage_pct ?? '–') + '%',  label: 'Trip ID Coverage',   sub: `${cov.with_trip_id ?? 0}/${cov.vehicles_total ?? 0} vehicles`, cls: 'hg-card--info' },
      { val: (cov.gps_coverage_pct  ?? '–') + '%',  label: 'GPS Coverage',        sub: `${cov.with_gps ?? 0} w/ position`,    cls: 'hg-card--info' },
      { val: (acc.snapped_pct ?? '–') + '%',         label: 'Snapped to Route',   sub: `${acc.snapped_vehicles ?? 0} snapped`, cls: 'hg-card--info' },
      // Accuracy
      { val: (acc.stale_pct ?? '–') + '%',           label: 'Stale GPS',          sub: `${acc.stale_vehicles ?? 0} vehicles`,  cls: 'hg-card--delayed' },
      { val: acc.teleport_flagged ?? '–',             label: 'Teleport Flags',     sub: 'GPS jumps detected',                   cls: acc.teleport_flagged > 0 ? 'hg-card--delayed' : 'hg-card--live' },
      // Static
      { val: stat.routes ?? '–',  label: 'GTFS Routes',  sub: '', cls: 'hg-card--info' },
      { val: stat.stops  ?? '–',  label: 'GTFS Stops',   sub: '', cls: 'hg-card--info' },
      { val: stat.trips  ?? '–',  label: 'GTFS Trips',   sub: '', cls: 'hg-card--info' },
      { val: stat.shapes ?? '–',  label: 'Route Shapes', sub: '', cls: 'hg-card--info' },
    ];

    el.innerHTML = cards.map(c =>
      `<div class="hg-card ${c.cls}">
        <div class="hg-val">${c.val}</div>
        <div class="hg-label">${c.label}</div>
        ${c.sub ? `<div class="hg-sub">${c.sub}</div>` : ''}
      </div>`
    ).join('');
  } catch (e) { console.warn('GTFS health error:', e); }
}

function feedBadge(status) {
  if (!status) return '';
  const map = { live: '🟢 Live', delayed: '🟡 Delayed', stale: '🔴 Stale', unknown: '⚫ Unknown' };
  return map[status] || status;
}
function feedCls(status) {
  const map = { live: 'hg-card--live', delayed: 'hg-card--delayed', stale: 'hg-card--stale', unknown: '' };
  return map[status] || '';
}

// ── reports tab ───────────────────────────────────────────────────
async function refreshReports() {
  await Promise.allSettled([renderPerfSummaryChart(), renderBusiestStopsTable()]);
}

async function renderPerfSummaryChart() {
  try {
    const data = await apiFetch('/analytics/on-time');
    const rows = (data.by_route || []).slice(0, 10);

    buildChart('chartPerfSummary', 'bar', {
      labels: rows.map(r => r.route_short_name || r.route_id),
      datasets: [{
        label: 'Avg Delay (min)',
        data:  rows.map(r => r.avg_delay_min),
        backgroundColor: rows.map(r =>
          r.avg_delay_min > 5  ? '#dc2626' :
          r.avg_delay_min > 2  ? '#d97706' : '#16a34a'),
        borderRadius: 3,
      }],
    }, {
      plugins: { legend: { display: false } },
      scales: { y: { ticks: { callback: v => v + ' min' } } },
    });
  } catch (e) {}
}

async function renderBusiestStopsTable() {
  try {
    const data  = await apiFetch('/analytics/stops');
    const rows  = data.top_busiest || [];
    const tbody = document.querySelector('#busiestStopsTable tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="loading-cell">No data yet</td></tr>'; return;
    }
    tbody.innerHTML = rows.slice(0, 15).map(r =>
      `<tr><td>${r.stop_name || r.stop_id}</td><td>${r.trip_count}</td><td>${r.avg_delay_min} min</td></tr>`
    ).join('');
  } catch (e) {}
}

// ── export helpers ────────────────────────────────────────────────
async function exportCSV() {
  try {
    const data = await apiFetch('/analytics/on-time');
    const rows = data.by_route || [];
    const header = 'route_id,route_name,total_trips,on_time_pct,avg_delay_min\n';
    const body   = rows.map(r =>
      `${r.route_id},"${r.route_short_name}",${r.total_trips},${r.on_time_percent},${r.avg_delay_min}`
    ).join('\n');
    downloadFile('drt_delay_report.csv', 'text/csv', header + body);
  } catch (e) { alert('Export failed: ' + e.message); }
}

async function exportJSON() {
  try {
    const [onTime, fleet, health] = await Promise.all([
      apiFetch('/analytics/on-time'),
      apiFetch('/analytics/fleet'),
      apiFetch('/analytics/gtfs-health'),
    ]);
    downloadFile('drt_analytics.json', 'application/json',
      JSON.stringify({ onTime, fleet, health, exported: new Date().toISOString() }, null, 2));
  } catch (e) { alert('Export failed: ' + e.message); }
}

function downloadFile(name, type, content) {
  const a   = document.createElement('a');
  a.href    = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

// ── Chart.js factory ──────────────────────────────────────────────
function buildChart(canvasId, type, data, options = {}) {
  if (_charts[canvasId]) { _charts[canvasId].destroy(); delete _charts[canvasId]; }
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const defaults = {
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 400 },
    plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } },
    scales: {
      x: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } },
      y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } },
    },
  };

  // Deep merge
  const merged = deepMerge(defaults, options);

  _charts[canvasId] = new Chart(canvas, { type, data, options: merged });
  return _charts[canvasId];
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// expose
window.refreshAnalytics = refreshAnalytics;
window.refreshReports   = refreshReports;
window.exportCSV        = exportCSV;
window.exportJSON       = exportJSON;
