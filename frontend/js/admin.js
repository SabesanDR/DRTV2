/* ═══════════════════════════════════════════════════════════
   admin.js — DRT Operations Hub · Admin Panel
═══════════════════════════════════════════════════════════ */
'use strict';

const ADMIN_PWD = 'admin123';   // change in production

function adminLogin() {
  const pwd = document.getElementById('adminPwd')?.value;
  if (pwd === ADMIN_PWD) {
    document.getElementById('adminLoginCard').style.display = 'none';
    document.getElementById('adminContent').style.display  = '';
    loadFlaggedStops();
  } else {
    alert('Incorrect password.');
  }
}

async function loadFlaggedStops() {
  const status = document.getElementById('flagStatusFilter')?.value || '';
  const tbody  = document.querySelector('#flagsTable tbody');
  if (!tbody) return;

  try {
    const url  = status ? `/flags?status=${status}` : '/flags';
    const data = await apiFetch(url);
    const flags = data.data || [];

    if (!flags.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">No flags found</td></tr>';
    } else {
      tbody.innerHTML = flags.map(f => `
        <tr>
          <td><b>${f.stop_name || f.stop_id}</b><br>
              <small style="color:#64748b">${f.stop_id}</small></td>
          <td>${formatReason(f.reason)}</td>
          <td style="max-width:180px;font-size:.75rem">${f.comment || '–'}</td>
          <td><span class="health-status ${f.status === 'open' ? 'hs--warn' : 'hs--ok'}">
            ${f.status}</span></td>
          <td style="font-size:.75rem;white-space:nowrap">
            ${new Date(f.created_at).toLocaleDateString()}</td>
          <td>
            ${f.status === 'open'
              ? `<button class="action-btn action-btn--resolve"
                   onclick="resolveFlag(${f.flag_id})">✓ Resolve</button>`
              : `<span style="color:#94a3b8;font-size:.7rem">
                   ${f.resolved_at ? new Date(f.resolved_at).toLocaleDateString() : 'Resolved'}
                 </span>`}
          </td>
        </tr>`).join('');
    }

    // Summary
    renderFlagSummary(flags);
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Error loading flags</td></tr>';
  }
}

async function resolveFlag(flagId) {
  if (!confirm('Mark this flag as resolved?')) return;
  try {
    await apiFetch(`/flags/${flagId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    loadFlaggedStops();
  } catch (e) {
    alert('Failed to update: ' + e.message);
  }
}

function renderFlagSummary(flags) {
  const el = document.getElementById('flagSummary');
  if (!el) return;

  const open     = flags.filter(f => f.status === 'open').length;
  const resolved = flags.filter(f => f.status === 'resolved').length;
  const reasons  = {};
  flags.forEach(f => { reasons[f.reason] = (reasons[f.reason] || 0) + 1; });

  el.innerHTML = [
    `<span class="flag-sum-pill">Total: <b>${flags.length}</b></span>`,
    `<span class="flag-sum-pill" style="color:#d97706">Open: <b>${open}</b></span>`,
    `<span class="flag-sum-pill" style="color:#16a34a">Resolved: <b>${resolved}</b></span>`,
    ...Object.entries(reasons).map(([r, n]) =>
      `<span class="flag-sum-pill">${formatReason(r)}: <b>${n}</b></span>`),
  ].join('');
}

function formatReason(reason) {
  if (!reason) return '–';
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// expose to app.js and HTML
window.adminLogin      = adminLogin;
window.loadFlaggedStops = loadFlaggedStops;
window.resolveFlag     = resolveFlag;
window.refreshFlags    = loadFlaggedStops;
