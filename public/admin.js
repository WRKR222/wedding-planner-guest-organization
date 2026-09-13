// public/admin.js — a separate surface for the system owner: cross-wedding,
// cross-planner oversight (support & billing visibility). Deliberately not
// part of planner.js's nav — a planner's own dashboard only ever shows
// their own weddings; this is a different audience entirely, reachable
// only by signing in here with the one is_admin planner account.
(function () {
  const state = { token: localStorage.getItem('wrsvp:admin:token') || null };
  Api.setTokenGetter(() => state.token);
  const app = document.getElementById('app');

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d; }
  }
  function moduleBadges(w) {
    const mods = [
      ['Auto', w.automation_enabled], ['Couple site', w.couple_site_enabled],
      ['Seating', w.seating_enabled], ['Check-in', w.checkin_enabled],
    ];
    return mods.map(([label, on]) => `<span class="badge ${on ? 'badge-on' : ''}" style="margin-right:4px;">${label}</span>`).join('');
  }

  function signOut() {
    state.token = null;
    localStorage.removeItem('wrsvp:admin:token');
    renderLogin();
  }

  function renderLogin(message) {
    app.innerHTML = `
      <main class="landing">
        <div class="landing-card" style="max-width:400px;">
          <p class="eyebrow">System admin</p>
          <h1>Admin overview</h1>
          <p class="landing-copy">Cross-wedding, cross-planner oversight for support &amp; billing — not a planner's own dashboard. Sign in with the admin account.</p>
          <form id="admin-login-form">
            <div class="field"><label>Email</label><input name="email" type="email" required /></div>
            <div class="field"><label>Password</label><input name="password" type="password" required /></div>
            <div id="admin-error" style="color:var(--cue); font-size:0.82rem; margin-bottom:10px;">${message ? escapeHtml(message) : ''}</div>
            <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Sign in</button>
          </form>
          <p class="landing-note" style="margin-top:14px;"><a href="/planner.html">Looking for the planner dashboard instead?</a></p>
        </div>
      </main>`;
    document.getElementById('admin-login-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById('admin-error');
      errEl.textContent = '';
      try {
        const data = await Api.post('/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
        if (!data.planner.is_admin) { errEl.textContent = 'That account is not the system admin account.'; return; }
        state.token = data.token;
        localStorage.setItem('wrsvp:admin:token', state.token);
        renderOverview();
      } catch (err) { errEl.textContent = err.message; }
    };
  }

  async function renderOverview() {
    app.innerHTML = `<div class="main" style="max-width:1220px; margin:0 auto;"><p class="hint">Loading…</p></div>`;
    let rows;
    try {
      rows = await Api.get('/api/admin/weddings');
    } catch (e) {
      if (e.status === 401 || e.status === 403) { signOut(); return renderLogin(e.message); }
      app.innerHTML = `<div class="main"><div class="card">${escapeHtml(e.message)}</div></div>`;
      return;
    }
    app.innerHTML = `
      <div class="main" style="max-width:1220px; margin:0 auto;">
        <div class="topbar">
          <div><div class="breadcrumb">System admin</div><h1>All weddings, all planners</h1></div>
          <a href="#" id="admin-sign-out" class="btn btn-ghost">Sign out</a>
        </div>
        <p class="hint" style="margin-bottom:16px;">Support &amp; billing visibility across the platform — which modules each wedding runs, and message volume for cost tracking.</p>
        <div class="card card-flush">
          <div class="table-wrap"><table>
            <thead><tr><th>Couple</th><th>Planner</th><th>Modules</th><th>Guests</th><th>Messages sent</th><th>Status</th></tr></thead>
            <tbody>
              ${rows.map((w) => `<tr>
                <td><strong>${escapeHtml(w.couple_names)}</strong><div class="hint">${fmtDate(w.event_date)}</div></td>
                <td class="mono">${escapeHtml(w.planner_email)}</td>
                <td>${moduleBadges(w)}</td>
                <td>${w.guest_count}</td>
                <td>${w.message_count}</td>
                <td><span class="badge ${w.wedding_status === 'active' ? 'badge-on' : ''}">${w.wedding_status}</span></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
      </div>`;
    document.getElementById('admin-sign-out').onclick = (e) => { e.preventDefault(); signOut(); };
  }

  (function boot() { if (state.token) renderOverview(); else renderLogin(); })();
})();
