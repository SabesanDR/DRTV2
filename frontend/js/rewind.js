/* ═══════════════════════════════════════════════════════════
   rewind.js — DRT Operations Hub · Route Rewind
   ──────────────────────────────────────────────────────────
   Lets operators scrub back through the last 2 hours of
   vehicle positions for any route, using the rolling buffer
   that historyStore builds from every 30-second RT poll.

   Architecture:
   • /api/rewind/window  → check how much history is available
   • /api/rewind/snapshots?route_id=905&step=30 → slider ticks
   • /api/rewind/at?route_id=905&ts=<ms> → vehicle positions
     at a specific moment (matched within ±20 s)

   All fetched ranges are cached in-memory (Map keyed by ts
   bucket) so scrubbing back and forth is instant after the
   first pass.
═══════════════════════════════════════════════════════════ */
'use strict';

// ── State ─────────────────────────────────────────────────
let _rwMap          = null;
let _rwInited       = false;
let _rwVehicleLayer = null;
let _rwRouteLayer   = null;
let _rwStopLayer    = null;
let _rwStreetLayer  = null;
let _rwSatLayer     = null;
let _rwUseSat       = false;

let _rwRouteId      = '';       // currently selected route
let _rwWindow       = null;     // { earliest, latest } ms
let _rwBuckets      = [];       // [{ts, vehicle_count}] from /snapshots
let _rwCurrentTs    = null;     // ms, current slider position
let _rwIsPlaying    = false;
let _rwPlayTimer    = null;
let _rwPlaySpeed    = 1;        // 1× = real time, 4× = 4s sim / 1s real
const PLAY_TICK_MS  = 200;      // UI refresh interval while playing
const SIM_STEP_MS   = 30_000;   // simulated time advance per tick at 1×

// Cache: ts-bucket (rounded to 30s) → GeoJSON FeatureCollection
const _rwCache      = new Map();

// Debounce timer for slider drag
let _rwSeekTimer    = null;

/* ── Initialise ──────────────────────────────────────────── */
window.initRewind = async function () {
  if (_rwInited) { _rwCheckWindow(); return; }

  const el = document.getElementById('rewindMap');
  if (!el) return;

  // Defer if tab not yet painted
  if (el.getBoundingClientRect().width === 0) {
    setTimeout(window.initRewind, 300);
    return;
  }

  _rwInited = true;

  _rwMap = L.map(el, { center: [43.91, -78.95], zoom: 11, preferCanvas: true });
  window.rewindMap = _rwMap;

  _rwStreetLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxZoom: 19 }
  ).addTo(_rwMap);

  _rwSatLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri', maxZoom: 19 }
  );

  _rwRouteLayer   = L.layerGroup().addTo(_rwMap);
  _rwStopLayer    = L.layerGroup().addTo(_rwMap);
  _rwVehicleLayer = L.layerGroup().addTo(_rwMap);

  // Wire controls
  document.getElementById('rwRouteSelect')
    ?.addEventListener('change', e => _rwSelectRoute(e.target.value));

  document.getElementById('rwPlayBtn')
    ?.addEventListener('click', _rwTogglePlay);

  document.getElementById('rwSlider')?.addEventListener('input', e => {
    _rwPause();
    const idx = parseInt(e.target.value, 10);
    if (_rwBuckets[idx]) {
      _rwCurrentTs = _rwBuckets[idx].ts;
      _rwUpdateTimestampDisplay();
    }
    // Debounce the actual map update
    clearTimeout(_rwSeekTimer);
    _rwSeekTimer = setTimeout(() => _rwSeekTo(_rwCurrentTs), 120);
  });

  document.getElementById('rwSpeedSelect')
    ?.addEventListener('change', e => { _rwPlaySpeed = parseFloat(e.target.value); });

  document.getElementById('rwJumpLive')
    ?.addEventListener('click', () => {
      _rwPause();
      if (_rwWindow) _rwSeekTo(_rwWindow.latest);
    });

  document.getElementById('rwSatBtn')
    ?.addEventListener('click', _rwToggleSatellite);

  // Populate route dropdown from live API
  await _rwLoadRoutes();
  await _rwCheckWindow();

  setTimeout(() => _rwMap?.invalidateSize(), 150);
};

/* ── Load routes into dropdown ───────────────────────────── */
async function _rwLoadRoutes() {
  try {
    const res    = await fetch('/api/routes');
    const json   = await res.json();
    const routes = (json.data || []).sort((a, b) => {
      const an = parseInt(a.route_short_name || a.route_id) || 9999;
      const bn = parseInt(b.route_short_name || b.route_id) || 9999;
      return an - bn;
    });

    const sel = document.getElementById('rwRouteSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— All routes —</option>';
    routes.forEach(r => {
      const o = document.createElement('option');
      o.value       = r.route_id;
      o.textContent = (r.route_short_name ? r.route_short_name + ' — ' : '') +
                      (r.route_long_name || r.route_id);
      sel.appendChild(o);
    });
  } catch (e) {
    console.warn('[Rewind] Could not load routes:', e);
  }
}

/* ── Check history window availability ────────────────────── */
async function _rwCheckWindow() {
  try {
    const res  = await fetch('/api/rewind/window');
    const json = await res.json();

    const msgEl = document.getElementById('rwWindowMsg');
    if (!json.available) {
      if (msgEl) msgEl.textContent = '⏳ No history yet — server accumulates data every 30 s. Check back in a few minutes.';
      _rwSetControlsEnabled(false);
      return;
    }

    _rwWindow = { earliest: json.earliest, latest: json.latest };
    _rwSetControlsEnabled(true);

    const durMin = Math.round((json.latest - json.earliest) / 60_000);
    if (msgEl) msgEl.textContent =
      `${durMin} min of history · ${json.count.toLocaleString()} position records`;

    // If a route is already selected, load its timeline
    if (_rwRouteId) await _rwSelectRoute(_rwRouteId);
    else await _rwLoadTimeline();

  } catch (e) {
    console.warn('[Rewind] window check failed:', e);
    const msgEl = document.getElementById('rwWindowMsg');
    if (msgEl) msgEl.textContent = '⚠️ Could not reach /api/rewind — ensure server is running.';
    _rwSetControlsEnabled(false);
  }
}

/* ── Route selection ─────────────────────────────────────── */
async function _rwSelectRoute(routeId) {
  _rwPause();
  _rwRouteId = routeId;
  _rwCache.clear();

  // Draw route shape
  _rwRouteLayer.clearLayers();
  _rwStopLayer.clearLayers();

  if (routeId) {
    // Fetch shape
    try {
      const [shapeRes, stopsRes] = await Promise.allSettled([
        fetch(`/api/routes/${routeId}/shape`),
        fetch(`/api/routes/${routeId}/stops`),
      ]);

      if (shapeRes.status === 'fulfilled' && shapeRes.value.ok) {
        const sd = await shapeRes.value.json();
        if (sd.shapes?.length) {
          sd.shapes.forEach((shape, i) => {
            const coords = shape.coordinates.map(([lon, lat]) => [lat, lon]);
            L.polyline(coords, {
              color:     '#2563eb',
              weight:    i === 0 ? 4 : 2,
              opacity:   i === 0 ? 0.8 : 0.45,
              dashArray: i === 0 ? null : '6 4',
            }).addTo(_rwRouteLayer);
          });
          if (sd.bbox) {
            _rwMap.fitBounds([
              [sd.bbox.minLat, sd.bbox.minLon],
              [sd.bbox.maxLat, sd.bbox.maxLon],
            ], { padding: [30, 30] });
          }
        }
      }

      if (stopsRes.status === 'fulfilled' && stopsRes.value.ok) {
        const stopData = await stopsRes.value.json();
        (stopData.data || []).forEach(stop => {
          if (!stop.stop_lat || !stop.stop_lon) return;
          L.circleMarker([stop.stop_lat, stop.stop_lon], {
            radius: 4, fillColor: '#fff', color: '#1e293b',
            weight: 1.5, fillOpacity: 1, opacity: 1,
          })
          .bindTooltip(stop.stop_name || stop.stop_id)
          .addTo(_rwStopLayer);
        });
      }
    } catch (e) {
      console.warn('[Rewind] shape/stops fetch failed:', e);
    }
  }

  await _rwLoadTimeline();
}

/* ── Load timeline buckets + init slider ─────────────────── */
async function _rwLoadTimeline() {
  if (!_rwWindow) return;

  try {
    const params = new URLSearchParams({
      route_id: _rwRouteId,
      from:     _rwWindow.earliest,
      to:       _rwWindow.latest,
      step:     30,
    });
    const res  = await fetch(`/api/rewind/snapshots?${params}`);
    const json = await res.json();

    _rwBuckets = json.buckets || [];

    const slider   = document.getElementById('rwSlider');
    const noDataEl = document.getElementById('rwNoData');

    if (!_rwBuckets.length) {
      if (slider)   slider.max = 0;
      if (noDataEl) noDataEl.style.display = '';
      return;
    }
    if (noDataEl) noDataEl.style.display = 'none';

    if (slider) {
      slider.min   = 0;
      slider.max   = _rwBuckets.length - 1;
      slider.value = _rwBuckets.length - 1;
    }

    // Update start/end time labels
    const toTime = ms => new Date(ms).toLocaleTimeString('en-CA', {
      timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const startEl = document.getElementById('rwStartLabel');
    const endEl   = document.getElementById('rwEndLabel');
    if (startEl) startEl.textContent = toTime(_rwBuckets[0].ts);
    if (endEl)   endEl.textContent   = toTime(_rwBuckets[_rwBuckets.length - 1].ts);

    // Draw tick density bar
    _rwDrawDensityBar(_rwBuckets);

    // Seek to latest by default
    _rwCurrentTs = _rwBuckets[_rwBuckets.length - 1].ts;
    _rwUpdateTimestampDisplay();
    await _rwSeekTo(_rwCurrentTs);

  } catch (e) {
    console.warn('[Rewind] timeline load failed:', e);
  }
}

/* ── Draw a density bar above the slider ─────────────────── */
function _rwDrawDensityBar(buckets) {
  const canvas = document.getElementById('rwDensityBar');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.width  = canvas.offsetWidth  || 800;
  const H   = canvas.height = canvas.offsetHeight || 20;
  ctx.clearRect(0, 0, W, H);

  if (!buckets.length) return;
  const maxCount = Math.max(...buckets.map(b => b.vehicle_count), 1);

  buckets.forEach((b, i) => {
    const x      = Math.round((i / (buckets.length - 1 || 1)) * (W - 1));
    const h      = Math.max(2, Math.round((b.vehicle_count / maxCount) * H));
    const pct    = b.vehicle_count / maxCount;
    // Colour gradient: few = blue-grey, many = DRT green
    const r = Math.round(37  + (0   - 37)  * pct);
    const g = Math.round(99  + (113 - 99)  * pct);
    const bv= Math.round(235 + (43  - 235) * pct);
    ctx.fillStyle = `rgb(${r},${g},${bv})`;
    ctx.fillRect(x, H - h, 1, h);
  });
}

/* ── Seek to timestamp ───────────────────────────────────── */
async function _rwSeekTo(targetMs) {
  if (!targetMs) return;
  _rwCurrentTs = targetMs;
  _rwUpdateTimestampDisplay();
  _rwSyncSlider();

  // Bucket key for cache (round to nearest 30s)
  const bucketKey = Math.round(targetMs / 30_000) * 30_000;

  let fc = _rwCache.get(bucketKey);
  if (!fc) {
    try {
      const params = new URLSearchParams({ route_id: _rwRouteId, ts: targetMs });
      const res    = await fetch(`/api/rewind/at?${params}`);
      fc = await res.json();
      _rwCache.set(bucketKey, fc);
    } catch (e) {
      console.warn('[Rewind] seek fetch failed:', e);
      return;
    }
  }

  _rwRenderVehicles(fc);
  _rwUpdateStatusBar(fc);
}

/* ── Render vehicles at a timestamp ─────────────────────── */
function _rwRenderVehicles(fc) {
  _rwVehicleLayer.clearLayers();
  if (!fc?.features?.length) return;

  fc.features.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    const p          = f.properties;

    const bg = p.perf_status === 'late'    ? '#dc2626'
             : p.perf_status === 'early'   ? '#2563eb'
             : p.perf_status === 'on_time' ? '#16a34a'
             : '#64748b';

    const bearing  = p.bearing ?? null;
    let arrowHtml  = '';
    if (bearing != null && bearing > 0) {
      const r    = (bearing - 90) * Math.PI / 180;
      const off  = 17;
      const tip  = { x: 50 + Math.cos(r) * (off + 7), y: 50 + Math.sin(r) * (off + 7) };
      const bL   = { x: 50 + Math.cos(r - 0.5) * off, y: 50 + Math.sin(r - 0.5) * off };
      const bR   = { x: 50 + Math.cos(r + 0.5) * off, y: 50 + Math.sin(r + 0.5) * off };
      arrowHtml  = `<svg viewBox="0 0 100 100" style="position:absolute;inset:-14px;width:56px;height:56px;pointer-events:none;overflow:visible">
        <polygon points="${tip.x},${tip.y} ${bL.x},${bL.y} ${bR.x},${bR.y}" fill="${bg}" stroke="#fff" stroke-width="2" opacity=".9"/>
      </svg>`;
    }

    const icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:28px;height:28px">
        ${arrowHtml}
        <div style="background:${bg};width:28px;height:28px;border-radius:50%;
          border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);
          display:flex;align-items:center;justify-content:center;
          color:#fff;font-size:9px;font-weight:800;position:relative;z-index:1">
          ${p.route_id || '?'}
        </div>
      </div>`,
      iconSize:   [28, 28],
      iconAnchor: [14, 14],
    });

    const ageStr = p.age_ms < 1000
      ? 'exact'
      : `±${Math.round(p.age_ms / 1000)}s`;

    const delayStr = typeof p.delay_sec === 'number'
      ? (Math.abs(p.delay_sec) < 30 ? 'On time'
         : p.delay_sec > 0 ? `+${_fmtDurRw(p.delay_sec)} late`
         : `${_fmtDurRw(Math.abs(p.delay_sec))} early`)
      : 'Unknown';

    const statusColour = p.perf_status === 'late' ? '#dc2626'
      : p.perf_status === 'early' ? '#2563eb' : '#16a34a';

    L.marker([lat, lon], { icon })
      .bindPopup(`<div style="min-width:180px;font-size:.8rem;line-height:1.7">
        <strong>🚌 Vehicle ${p.vehicle_id}</strong>
        <br>Route: <b>${p.route_id || '–'}</b>
        ${p.trip_id ? `<br>Trip: <span style="color:#64748b;font-size:.74rem">${p.trip_id}</span>` : ''}
        <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
        <span style="color:${statusColour}">${delayStr}</span>
        ${p.speed_kmh != null ? `<br>Speed: ${p.speed_kmh} km/h` : ''}
        ${p.bearing != null ? `<br>Heading: ${Math.round(p.bearing)}°` : ''}
        <hr style="margin:.3rem 0;border:none;border-top:1px solid #e2e8f0">
        <small style="color:#94a3b8">Position from: ${new Date(p.ts).toLocaleTimeString()} (${ageStr})</small>
      </div>`)
      .addTo(_rwVehicleLayer);
  });
}

/* ── Status bar update ───────────────────────────────────── */
function _rwUpdateStatusBar(fc) {
  const count   = fc?.features?.length || 0;
  const late    = fc?.features?.filter(f => f.properties.perf_status === 'late').length  || 0;
  const early   = fc?.features?.filter(f => f.properties.perf_status === 'early').length || 0;
  const onTime  = fc?.features?.filter(f => f.properties.perf_status === 'on_time').length || 0;

  const el = document.getElementById('rwStatusBar');
  if (!el) return;
  el.innerHTML = count === 0
    ? '<span style="color:#94a3b8">No vehicles at this time</span>'
    : `<b>${count}</b> vehicle${count > 1 ? 's' : ''}` +
      (onTime ? ` · <span style="color:#16a34a">🟢 ${onTime} on time</span>` : '') +
      (late   ? ` · <span style="color:#dc2626">🔴 ${late} late</span>` : '') +
      (early  ? ` · <span style="color:#2563eb">🔵 ${early} early</span>` : '');
}

/* ── Playback ────────────────────────────────────────────── */
function _rwTogglePlay() {
  _rwIsPlaying ? _rwPause() : _rwPlay();
}

function _rwPlay() {
  if (!_rwBuckets.length) return;
  _rwIsPlaying = true;
  const btn = document.getElementById('rwPlayBtn');
  if (btn) { btn.textContent = '⏸'; btn.title = 'Pause'; }

  // If at the end, restart from beginning
  const lastTs = _rwBuckets[_rwBuckets.length - 1].ts;
  if (_rwCurrentTs >= lastTs) {
    _rwCurrentTs = _rwBuckets[0].ts;
  }

  _rwPlayTimer = setInterval(async () => {
    if (!_rwIsPlaying) return;
    const step = SIM_STEP_MS * _rwPlaySpeed;
    _rwCurrentTs += step;

    if (_rwCurrentTs >= lastTs) {
      _rwCurrentTs = lastTs;
      _rwPause();
    }

    _rwSyncSlider();
    _rwUpdateTimestampDisplay();
    await _rwSeekTo(_rwCurrentTs);
  }, PLAY_TICK_MS);
}

function _rwPause() {
  _rwIsPlaying = false;
  if (_rwPlayTimer) { clearInterval(_rwPlayTimer); _rwPlayTimer = null; }
  const btn = document.getElementById('rwPlayBtn');
  if (btn) { btn.textContent = '▶'; btn.title = 'Play'; }
}

/* ── Sync slider position to _rwCurrentTs ────────────────── */
function _rwSyncSlider() {
  const slider = document.getElementById('rwSlider');
  if (!slider || !_rwBuckets.length) return;

  // Find nearest bucket index
  let closest = 0, closestDiff = Infinity;
  _rwBuckets.forEach((b, i) => {
    const d = Math.abs(b.ts - _rwCurrentTs);
    if (d < closestDiff) { closestDiff = d; closest = i; }
  });
  slider.value = closest;
}

/* ── Timestamp display ───────────────────────────────────── */
function _rwUpdateTimestampDisplay() {
  const el = document.getElementById('rwTimestamp');
  if (!el || !_rwCurrentTs) return;
  const d = new Date(_rwCurrentTs);
  el.textContent = d.toLocaleString('en-CA', {
    timeZone:    'America/Toronto',
    weekday:     'short',
    month:       'short',
    day:         'numeric',
    hour:        '2-digit',
    minute:      '2-digit',
    second:      '2-digit',
    hour12:      false,
  });
}

/* ── Enable/disable controls ─────────────────────────────── */
function _rwSetControlsEnabled(on) {
  ['rwPlayBtn', 'rwSlider', 'rwJumpLive', 'rwSpeedSelect', 'rwRouteSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

/* ── Satellite toggle ────────────────────────────────────── */
function _rwToggleSatellite() {
  _rwUseSat = !_rwUseSat;
  const btn = document.getElementById('rwSatBtn');
  if (_rwUseSat) {
    _rwMap.removeLayer(_rwStreetLayer);
    _rwSatLayer.addTo(_rwMap);
    if (btn) btn.textContent = '🗺️ Street';
  } else {
    _rwMap.removeLayer(_rwSatLayer);
    _rwStreetLayer.addTo(_rwMap);
    if (btn) btn.textContent = '🛰️ Satellite';
  }
}

/* ── Mini duration formatter ─────────────────────────────── */
function _fmtDurRw(sec) {
  if (!sec) return '0s';
  sec = Math.round(Math.abs(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60), mn = m % 60;
  return mn > 0 ? `${h}h ${mn}m` : `${h}h`;
}

/* ── Expose ──────────────────────────────────────────────── */
window.initRewind   = window.initRewind;
window.rewindGoTo   = _rwSelectRoute;