/**
 * ================================================================
 * GTFS Historical Data Export Panel — DRT Operations Hub
 * ================================================================
 * Renders inside #export-panel-container using the same CSS
 * classes and design tokens as the rest of the app:
 *   .card, .card-hdr, .card-body, .kpi-card, .kpi-value,
 *   .kpi-label, .kpi-sub, .data-table, .btn, .btn-primary,
 *   .btn-secondary, .badge, .pill, --drt-green, --c-muted, etc.
 *
 * Data sources:
 *   Static GTFS  → maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip
 *                  opendata.durham.ca — "GTFS Static Schedule" dataset
 *   GTFS-RT Vehicles → drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions
 *   GTFS-RT Trips    → drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates
 *   GTFS-RT Alerts   → maps.durham.ca/OpenDataGTFS/alerts.pb
 *   All published under the Region of Durham Open Data Licence.
 * ================================================================
 */

(function () {
  'use strict';

  /* ── helpers ─────────────────────────────────────────────────── */

  function fmt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-CA', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  function fmtNum(n) {
    return (n != null) ? Number(n).toLocaleString() : '0';
  }

  async function fetchStatus() {
    try {
      const r = await fetch('/api/export/status');
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  function buildUrl(endpoint) {
    const from    = document.getElementById('exp-from')?.value?.trim();
    const to      = document.getElementById('exp-to')?.value?.trim();
    const routeId = document.getElementById('exp-route')?.value?.trim();
    const params  = new URLSearchParams();
    if (from)    params.set('from', from);
    if (to)      params.set('to', to);
    if (routeId) params.set('route_id', routeId);
    return '/api/export/' + endpoint + '?' + params.toString();
  }

  function triggerDownload(endpoint) {
    const a = document.createElement('a');
    a.href = buildUrl(endpoint);
    a.download = 'drt_' + endpoint + '_' + Date.now() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Downloading ' + endpoint + '.csv…');
  }

  function showToast(msg) {
    var t = document.getElementById('exp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'exp-toast';
      t.style.cssText = [
        'position:fixed;bottom:24px;right:24px;z-index:9999;',
        'background:var(--drt-green,#2E7D32);color:#fff;',
        'padding:8px 18px;border-radius:var(--radius,6px);',
        'font-size:.78rem;font-weight:600;',
        'box-shadow:var(--shadow-md,0 4px 12px rgba(0,0,0,.18));',
        'transition:opacity .35s;pointer-events:none;'
      ].join('');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.style.opacity = '0'; }, 3000);
  }

  /* ── KPI cards ───────────────────────────────────────────────── */

  function kpiCard(label, value, sub, modifier) {
    return '<div class="kpi-card' + (modifier ? ' kpi-card--' + modifier : '') + '">' +
      '<div class="kpi-label">' + label + '</div>' +
      '<div class="kpi-value">' + value + '</div>' +
      '<div class="kpi-sub">'  + sub   + '</div>' +
      '</div>';
  }

  function renderKpis(status) {
    if (!status) {
      return '<p class="empty-state">Could not reach export API — ensure the server is running.</p>';
    }
    var vh = status.vehicle_snapshots;
    var dh = status.delay_snapshots;
    var sp = status.stop_performance;

    return '<div class="kpi-row" style="margin-bottom:.75rem;">' +
      kpiCard('Vehicle Snapshots',  fmtNum(vh.count),
        vh.oldest ? fmt(vh.oldest) + ' → ' + fmt(vh.newest) : 'No data yet', 'good') +
      kpiCard('Delay Records',      fmtNum(dh.count),
        dh.oldest ? fmt(dh.oldest) + ' → ' + fmt(dh.newest) : 'No data yet', '') +
      kpiCard('Stop Observations',  fmtNum(sp.count),
        sp.oldest ? fmt(sp.oldest) + ' → ' + fmt(sp.newest) : 'No data yet', 'good') +
      kpiCard('Retention Window',   status.retention_hours + 'h',
        'Set HISTORY_RETENTION_HOURS in .env', '') +
      '</div>' +
      '<p style="font-size:.72rem;color:var(--c-muted);margin:0 0 .75rem;">' +
        'Data accumulates every 30 s while the server is running. ' +
        'Records older than the retention window are automatically pruned.' +
      '</p>';
  }

  /* ── export datasets definition ──────────────────────────────── */

  var EXPORTS = [
    {
      id: 'vehicle-positions',
      label: '🚌 Vehicle Positions',
      desc: 'GPS snapshots every 30 s — position, bearing, speed, delay status, snap distance.',
      cols: 'timestamp_iso · vehicle_id · route_id · trip_id · latitude · longitude · bearing · speed_kmh · occupancy_status · performance_status · delay_seconds · snapped · snap_distance_m',
    },
    {
      id: 'trip-delays',
      label: '⏱ Trip Delays',
      desc: 'Per-trip delay records with route name, headsign, stop, and scheduled vs actual arrival.',
      cols: 'timestamp_iso · trip_id · route_id · route_short_name · headsign · stop_id · stop_name · arrival_delay_sec · departure_delay_sec · performance_status · scheduled_arrival_iso · actual_arrival_iso',
    },
    {
      id: 'stop-performance',
      label: '🚏 Stop Performance',
      desc: 'Per-stop arrival observations — best for joining with private data on stop_id or coordinates.',
      cols: 'timestamp_iso · stop_id · stop_name · stop_lat · stop_lon · route_id · route_short_name · trip_id · scheduled_arrival_iso · actual_arrival_iso · delay_seconds · performance_status',
    },
    {
      id: 'summary',
      label: '📊 Route Summary',
      desc: 'Aggregated per-route stats: on-time %, avg/min/max delay, total observation count.',
      cols: 'route_id · route_short_name · route_long_name · total_observations · on_time_count · late_count · early_count · on_time_pct · avg_delay_sec · max_delay_sec · min_delay_sec · period_start_iso · period_end_iso',
    },
  ];

  function exportTableHtml() {
    var rows = EXPORTS.map(function(e) {
      return '<tr>' +
        '<td>' +
          '<strong style="font-size:.82rem;">' + e.label + '</strong>' +
          '<div style="font-size:.7rem;color:var(--c-muted);margin-top:2px;">' + e.desc + '</div>' +
        '</td>' +
        '<td style="font-size:.68rem;color:var(--c-muted);line-height:1.7;">' + e.cols + '</td>' +
        '<td style="white-space:nowrap;vertical-align:middle;">' +
          '<button class="btn btn-primary" style="margin-right:4px;font-size:.72rem;" ' +
            'onclick="window._drtExport(\'' + e.id + '\')">⬇ CSV</button>' +
          '<a href="/api/export/' + e.id + '?format=json" target="_blank" ' +
            'class="btn btn-secondary" style="text-decoration:none;display:inline-block;font-size:.72rem;">{ } JSON</a>' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<table class="data-table">' +
      '<thead><tr>' +
        '<th>Dataset</th>' +
        '<th>Columns included</th>' +
        '<th>Download</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  /* ── data source attribution ─────────────────────────────────── */

  function sourceCardHtml() {
    var feeds = [
      ['GTFS Static Schedule',       'Static',               'maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip',                    'https://opendata.durham.ca/datasets/931bc536b42e4b3aa72270dab4133c90'],
      ['GTFS-RT Vehicle Positions',  'Real-time (protobuf)', 'drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',    'https://opendata.durham.ca/documents/99e80514e42742d39238d31e2d158ada'],
      ['GTFS-RT Trip Updates',       'Real-time (protobuf)', 'drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates',         'https://opendata.durham.ca/documents/4109d5e77a444aaf91f8a47c6efabf3b'],
      ['GTFS-RT Alerts',             'Real-time (protobuf)', 'maps.durham.ca/OpenDataGTFS/alerts.pb',                             'https://opendata.durham.ca'],
    ];

    var rows = feeds.map(function(f) {
      return '<tr>' +
        '<td><strong>' + f[0] + '</strong></td>' +
        '<td style="font-size:.72rem;color:var(--c-muted);">' + f[1] + '</td>' +
        '<td style="font-size:.68rem;color:var(--c-muted);">' + f[2] + '</td>' +
        '<td><a href="' + f[3] + '" target="_blank" ' +
          'style="color:var(--drt-green,#2E7D32);font-size:.72rem;">Durham Open Data ↗</a></td>' +
      '</tr>';
    }).join('');

    return '<div class="card" style="margin-top:.75rem;border-left-color:var(--drt-grey-medium,#4F4F4F);">' +
      '<div class="card-hdr">' +
        '<h2>📡 Data Sources</h2>' +
        '<span class="pill pill--live" style="font-size:.65rem;">Region of Durham Open Data Licence</span>' +
      '</div>' +
      '<div class="card-body" style="padding:.5rem 0 0;">' +
        '<table class="data-table">' +
          '<thead><tr><th>Feed</th><th>Type</th><th>Endpoint</th><th>Open Data Listing</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '<p style="font-size:.7rem;color:var(--c-muted);padding:.75rem 1rem .5rem;">' +
          'All feeds are published by the <strong>Regional Municipality of Durham</strong> under the ' +
          '<a href="https://www.durham.ca/en/regional-government/resources/Documents/OpenDataLicenceAgreement.pdf" ' +
            'target="_blank" style="color:var(--drt-green,#2E7D32);">Durham Open Data Licence</a>. ' +
          'The static GTFS file is pre-processed into <code>data/gtfs_json/</code> on server startup. ' +
          'The three GTFS-RT feeds are polled every 30 s at runtime and the snapshots accumulated here.' +
        '</p>' +
      '</div>' +
    '</div>';
  }

  /* ── full panel HTML ─────────────────────────────────────────── */

  function buildPanel() {
    return (
      // ── KPI summary card ─────────────────────────────────────
      '<div class="card" style="margin-bottom:.75rem;">' +
        '<div class="card-hdr">' +
          '<h2>📥 Historical Data Export</h2>' +
          '<button class="btn btn-secondary" style="font-size:.72rem;padding:.25rem .65rem;" ' +
            'onclick="window._drtExportRefresh()">↻ Refresh Stats</button>' +
        '</div>' +
        '<div class="card-body">' +
          '<div id="exp-kpi-area"><div class="loading-spinner"></div></div>' +
        '</div>' +
      '</div>' +

      // ── Filter card ──────────────────────────────────────────
      '<div class="card" style="margin-bottom:.75rem;">' +
        '<div class="card-hdr"><h2>🔍 Filters</h2></div>' +
        '<div class="card-body">' +
          '<div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end;">' +
            '<div class="form-row">' +
              '<label>From (ISO 8601 or blank)</label>' +
              '<input id="exp-from" class="sidebar-input" type="text" ' +
                'placeholder="e.g. 2025-04-12T08:00:00" style="width:220px;">' +
            '</div>' +
            '<div class="form-row">' +
              '<label>To (ISO 8601 or blank)</label>' +
              '<input id="exp-to" class="sidebar-input" type="text" ' +
                'placeholder="e.g. 2025-04-12T18:00:00" style="width:220px;">' +
            '</div>' +
            '<div class="form-row">' +
              '<label>Route ID (blank = all)</label>' +
              '<input id="exp-route" class="sidebar-input" type="text" ' +
                'placeholder="e.g. 900" style="width:110px;">' +
            '</div>' +
          '</div>' +
          '<p style="font-size:.7rem;color:var(--c-muted);margin-top:.5rem;">' +
            'Filters apply to all CSV and JSON downloads below.' +
          '</p>' +
        '</div>' +
      '</div>' +

      // ── Download table card ──────────────────────────────────
      '<div class="card" style="margin-bottom:.75rem;">' +
        '<div class="card-hdr">' +
          '<h2>⬇ Available Exports</h2>' +
          '<span style="font-size:.7rem;color:var(--c-muted);">UTF-8 · column headers included</span>' +
        '</div>' +
        '<div class="card-body" style="padding:.5rem 0 0;">' +
          exportTableHtml() +
        '</div>' +
      '</div>' +

      // ── Source attribution card ──────────────────────────────
      sourceCardHtml()
    );
  }

  /* ── public API ──────────────────────────────────────────────── */

  window._drtExport = function(endpoint) {
    triggerDownload(endpoint);
  };

  window._drtExportRefresh = async function() {
    var el = document.getElementById('exp-kpi-area');
    if (el) el.innerHTML = '<div class="loading-spinner"></div>';
    var status = await fetchStatus();
    if (el) el.innerHTML = renderKpis(status);
  };

  window.initExportPanel = async function(containerId) {
    var container = document.getElementById(containerId || 'export-panel-container');
    if (!container) {
      console.warn('[export.js] Container not found:', containerId);
      return;
    }
    container.innerHTML = buildPanel();
    var status = await fetchStatus();
    var el = document.getElementById('exp-kpi-area');
    if (el) el.innerHTML = renderKpis(status);
  };

})();
