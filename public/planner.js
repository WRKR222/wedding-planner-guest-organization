// public/planner.js
(function () {
  const state = {
    token: localStorage.getItem('wrsvp:planner:token') || null,
    planner: loadJSON('wrsvp:planner:info', null),
    weddings: [],
    weddingId: null,
    wedding: null,
    tab: 'overview',
    stores: {}, // weddingId -> guestStore
    guests: [],
    importBatch: null,
    fontPairings: [],
  };

  Api.setTokenGetter(() => state.token);

  const ICON_GRID = '<svg class="nav-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="11.5" y="11.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>';

  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }
  function saveAuth() {
    if (state.token) localStorage.setItem('wrsvp:planner:token', state.token);
    else localStorage.removeItem('wrsvp:planner:token');
    localStorage.setItem('wrsvp:planner:info', JSON.stringify(state.planner));
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d; }
  }
  function daysUntil(d) {
    const diff = Math.ceil((new Date(d + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
    return diff;
  }
  // the one pulsing "cue light" in the app — reserved for weddings inside
  // a two-week production window, never used decoratively elsewhere.
  function cueOrCountdown(eventDate, status) {
    const d = daysUntil(eventDate);
    if (status !== 'active') return `<span class="hint">(${d}d)</span>`;
    if (d <= 14 && d >= 0) return `<span class="cue-light"><span class="bulb"></span>${d === 0 ? 'today' : d + 'd out'}</span>`;
    return `<span class="hint">(${d}d)</span>`;
  }

  const app = document.getElementById('app');

  // ---------------------------------------------------------------- render
  async function render() {
    if (!state.token) return renderAuth();
    if (!state.weddingId) return renderDashboard();
    return renderWeddingDetail();
  }

  // ------------------------------------------------------------ auth view
  function renderAuth() {
    app.innerHTML = `
      <main class="landing">
        <div class="landing-card" style="max-width:400px;">
          <p class="eyebrow">Planner sign in</p>
          <h1 id="auth-title">Welcome back</h1>
          <p class="landing-copy">Manage every wedding on your books — guest lists, seating, and each couple's own companion site — from one place.</p>
          <form id="auth-form">
            <div class="field" id="name-field" style="display:none;">
              <label>Your name</label>
              <input name="name" placeholder="Amina Wanjiku" />
            </div>
            <div class="field">
              <label>Email</label>
              <input name="email" type="email" required placeholder="you@planningco.com" value="planner@demo.test" />
            </div>
            <div class="field">
              <label>Password</label>
              <input name="password" type="password" required minlength="6" value="demo1234" />
            </div>
            <div id="auth-error" style="color:var(--cue); font-size:0.82rem; margin-bottom:10px;"></div>
            <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Sign in</button>
          </form>
          <p class="landing-note" style="margin-top:14px;">
            <a href="#" id="auth-switch">Need an account? Create one</a>
          </p>
          <p class="landing-note">Demo account: <code>planner@demo.test</code> / <code>demo1234</code></p>
        </div>
      </main>`;
    let mode = 'login';
    document.getElementById('auth-switch').onclick = (e) => {
      e.preventDefault();
      mode = mode === 'login' ? 'signup' : 'login';
      document.getElementById('auth-title').textContent = mode === 'login' ? 'Welcome back' : 'Create your planner account';
      document.getElementById('name-field').style.display = mode === 'signup' ? 'block' : 'none';
      document.getElementById('auth-switch').textContent = mode === 'login' ? 'Need an account? Create one' : 'Already have an account? Sign in';
    };
    document.getElementById('auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const email = fd.get('email'), password = fd.get('password');
      const errEl = document.getElementById('auth-error');
      errEl.innerHTML = '';
      try {
        const data = await Api.post(`/api/auth/${mode}`, { email, password, name: fd.get('name') });
        state.token = data.token; state.planner = data.planner; saveAuth();
        await loadWeddings();
        render();
      } catch (err) {
        // On a fresh deploy nobody has run scripts/seed-demo.js yet, so the
        // demo credentials on this form don't exist as a real account —
        // offer to create them on the spot instead of just saying "invalid".
        const isDemoAttempt = mode === 'login' && email === 'planner@demo.test' && password === 'demo1234';
        if (isDemoAttempt) {
          errEl.innerHTML = `${escapeHtml(err.message)} — this looks like a fresh deployment with no demo data yet. <a href="#" id="seed-demo-link">Set up the demo account now</a>`;
          document.getElementById('seed-demo-link').onclick = async (ev) => {
            ev.preventDefault();
            errEl.textContent = 'Setting up demo data…';
            try {
              await Api.post('/api/auth/seed-demo', {});
              document.getElementById('auth-form').requestSubmit();
            } catch (seedErr) { errEl.textContent = seedErr.message; }
          };
        } else {
          errEl.textContent = err.message;
        }
      }
    };
  }

  function signOut() {
    state.token = null; state.planner = null; state.weddingId = null; saveAuth();
    render();
  }

  // ------------------------------------------------------------- app shell
  function shell(innerHTML, activeNav) {
    app.innerHTML = `
      <div class="app-shell">
        <nav class="sidebar">
          <div class="brand">Callsheet<small>Day-of ops, every wedding</small></div>
          <div class="nav-tab ${activeNav === 'weddings' ? 'active' : ''}" data-nav="weddings">${ICON_GRID} Weddings</div>
          <div class="sidebar-footer">
            <div>Signed in as<br /><strong style="color:var(--ink)">${escapeHtml(state.planner.name)}</strong><br />
            <a href="#" id="sign-out" style="color:var(--muted)">Sign out</a></div>
          </div>
        </nav>
        <div class="main">${innerHTML}</div>
      </div>`;
    app.querySelectorAll('[data-nav]').forEach((el) => el.onclick = () => {
      state.weddingId = null;
      state.tab = 'overview';
      render();
    });
    document.getElementById('sign-out').onclick = (e) => { e.preventDefault(); signOut(); };
  }

  // ------------------------------------------------------------ dashboard
  async function loadWeddings() {
    try { state.weddings = await Api.get('/api/weddings'); }
    catch (e) { if (e.status === 401) return signOut(); toast(e.message, 'err'); }
  }

  async function renderDashboard() {
    await loadWeddings();
    const rows = state.weddings.map((w) => `
      <tr data-open="${w.id}" style="cursor:pointer;">
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="width:10px;height:10px;border-radius:3px;background:${w.theme.primary};display:inline-block;flex-shrink:0;"></span>
            <div>
              <div style="font-weight:600;">${escapeHtml(w.couple_names)}</div>
              <div class="hint">${escapeHtml(w.venue || 'Venue TBD')}</div>
            </div>
          </div>
        </td>
        <td>${fmtDate(w.event_date)} ${cueOrCountdown(w.event_date, w.wedding_status)}</td>
        <td>${moduleBadges(w)}</td>
        <td>${w.guest_count}</td>
        <td>${w.confirmed_count}</td>
        <td><span class="badge ${w.wedding_status === 'active' ? 'badge-on' : ''}">${w.wedding_status}</span></td>
      </tr>`).join('');

    shell(`
      <div class="topbar">
        <div><div class="breadcrumb">Planner dashboard</div><h1>Your weddings</h1></div>
        <button class="btn btn-primary" id="new-wedding-btn">+ New wedding</button>
      </div>
      ${state.weddings.length === 0 ? `
        <div class="card empty-state">
          <h3>No weddings yet</h3>
          <p>Create your first wedding to start tracking guests, RSVPs, and seating.</p>
          <button class="btn btn-primary" id="new-wedding-btn-2">+ New wedding</button>
        </div>` : `
        <div class="card card-flush">
          <div class="table-wrap"><table>
            <thead><tr><th>Couple</th><th>Date</th><th>Modules</th><th>Guests</th><th>Confirmed</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>`}
    `, 'weddings');

    app.querySelectorAll('[data-open]').forEach((row) => row.onclick = () => openWedding(row.dataset.open));
    const btn = document.getElementById('new-wedding-btn'); if (btn) btn.onclick = openNewWeddingModal;
    const btn2 = document.getElementById('new-wedding-btn-2'); if (btn2) btn2.onclick = openNewWeddingModal;
  }

  function moduleBadges(w) {
    const mods = [
      ['Auto', w.automation_enabled], ['Couple site', w.couple_site_enabled],
      ['Seating', w.seating_enabled], ['Check-in', w.checkin_enabled],
    ];
    return mods.map(([label, on]) => `<span class="badge ${on ? 'badge-on' : ''}" style="margin-right:4px;">${label}</span>`).join('');
  }

  function openNewWeddingModal() {
    showModal(`
      <h2>New wedding</h2>
      <p class="hint">Guest List tracking is on by default for every wedding — turn on the other modules from the wedding's Settings tab once it's created.</p>
      <form id="new-wedding-form">
        <div class="field"><label>Couple names</label><input name="couple_names" required placeholder="Zawadi & Kevin" /></div>
        <div class="field-row">
          <div class="field"><label>Event date</label><input name="event_date" type="date" required /></div>
          <div class="field">
            <label>RSVP cutoff <span class="hint">(optional)</span></label>
            <input name="rsvp_cutoff" type="date" />
            <p class="hint">Don't know yet? Leave it blank — you can set it later from this wedding's Settings tab.</p>
          </div>
        </div>
        <div class="field"><label>Venue <span class="hint">(optional)</span></label><input name="venue" placeholder="Hillside Gardens, Karen" /></div>
        <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Create wedding</button>
      </form>
    `);
    document.getElementById('new-wedding-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const w = await Api.post('/api/weddings', Object.fromEntries(fd.entries()));
        closeModal();
        toast('Wedding created');
        await loadWeddings();
        openWedding(w.id);
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  // -------------------------------------------------------- wedding detail
  async function openWedding(id) {
    state.weddingId = id;
    state.tab = 'overview';
    try { state.wedding = await Api.get(`/api/weddings/${id}`); }
    catch (e) { toast(e.message, 'err'); state.weddingId = null; }
    render();
  }

  function ensureStore(weddingId) {
    if (!state.stores[weddingId]) {
      const store = makeGuestStore(weddingId);
      store.onChange((guests) => { if (state.weddingId === weddingId) { state.guests = guests; if (['overview', 'guests', 'checkin'].includes(state.tab)) rerenderTabBody(); } });
      store.startPolling(4000);
      state.stores[weddingId] = store;
    }
    return state.stores[weddingId];
  }

  async function renderWeddingDetail() {
    const w = state.wedding;
    if (!w) return renderDashboard();
    const store = ensureStore(w.id);
    state.guests = store.list();
    if (state.guests.length === 0 && navigator.onLine) { await store.refresh(); state.guests = store.list(); }

    const tabs = [
      ['overview', 'Overview'],
      ['guests', 'Guest list'],
      ['import', 'Import list'],
      w.seating_enabled ? ['seating', 'Seating'] : null,
      w.checkin_enabled ? ['checkin', 'Check-in'] : null,
      w.automation_enabled ? ['messages', 'Invites & messages'] : null,
      w.couple_site_enabled ? ['companion', 'Couple site'] : null,
      ['settings', 'Settings & modules'],
    ].filter(Boolean);

    shell(`
      <div class="breadcrumb"><a href="#" id="back-to-weddings" style="color:var(--muted)">&larr; All weddings</a></div>
      <div class="topbar">
        <div><h1>${escapeHtml(w.couple_names)}</h1><p class="hint" style="margin:0;">${fmtDate(w.event_date)} · ${escapeHtml(w.venue || 'Venue TBD')} · <span class="badge ${w.wedding_status === 'active' ? 'badge-on' : ''}">${w.wedding_status}</span></p></div>
        <div id="offline-banner" class="offline-banner" style="margin:0; display:none;"><span class="dot"></span><span class="msg"></span></div>
      </div>
      <div class="subtabs">${tabs.map(([k, label]) => `<div class="subtab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${label}</div>`).join('')}</div>
      <div id="tab-body"></div>
    `, 'weddings');

    document.getElementById('back-to-weddings').onclick = (e) => { e.preventDefault(); state.weddingId = null; render(); };
    app.querySelectorAll('[data-tab]').forEach((el) => el.onclick = () => { state.tab = el.dataset.tab; rerenderTabBody(); app.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab)); });

    const banner = document.getElementById('offline-banner');
    offlineBannerController(banner, null, store);

    rerenderTabBody();
  }

  function rerenderTabBody() {
    const body = document.getElementById('tab-body');
    if (!body) return;
    const w = state.wedding;
    if (state.tab === 'overview') return renderOverview(body, w);
    if (state.tab === 'guests') return renderGuests(body, w);
    if (state.tab === 'import') return renderImport(body, w);
    if (state.tab === 'seating') return renderSeating(body, w);
    if (state.tab === 'checkin') return renderCheckin(body, w);
    if (state.tab === 'messages') return renderMessages(body, w);
    if (state.tab === 'companion') return renderCompanion(body, w);
    if (state.tab === 'settings') return renderSettings(body, w);
  }

  // ---------------------------------------------------------------- overview
  function renderOverview(body, w) {
    const guests = state.guests;
    const confirmed = guests.filter((g) => g.status === 'confirmed').length;
    const unconfirmed = guests.filter((g) => g.status === 'unconfirmed').length;
    const declined = guests.filter((g) => g.status === 'declined').length;
    const noResponse = guests.filter((g) => g.status === 'no_response').length;
    const seated = guests.filter((g) => g.seat).length;
    const checkedIn = guests.filter((g) => g.checked_in_at).length;
    body.innerHTML = `
      <div class="stat-grid" style="margin-bottom:18px;">
        <div class="stat stat-total"><span class="num">${guests.length}</span><span class="lbl">Total guests</span></div>
        <div class="stat stat-confirmed"><span class="num">${confirmed}</span><span class="lbl">Confirmed</span></div>
        <div class="stat stat-unconfirmed"><span class="num">${unconfirmed}</span><span class="lbl">Unconfirmed</span></div>
        <div class="stat stat-declined"><span class="num">${declined}</span><span class="lbl">Declined</span></div>
        <div class="stat"><span class="num">${noResponse}</span><span class="lbl">No response</span></div>
        ${w.seating_enabled ? `<div class="stat stat-seated"><span class="num">${seated}</span><span class="lbl">Seated</span></div>` : ''}
        ${w.checkin_enabled ? `<div class="stat stat-checkedin"><span class="num">${checkedIn}</span><span class="lbl">Checked in</span></div>` : ''}
      </div>
      <div class="card">
        <h3>Modules active for this wedding</h3>
        <p class="hint">Turned on based on your conversation with the couple — nothing here is one-size-fits-all.</p>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;">${moduleBadges(w)}</div>
      </div>
      ${w.wedding_status !== 'active' ? `<div class="card" style="border-color: var(--amber-dim); background: var(--amber-dim);"><strong style="color:var(--amber)">This wedding is ${w.wedding_status}.</strong><p style="margin:6px 0 0; color: var(--amber)">Automated sending and seating changes are frozen. All data is preserved. Reactivate it from Settings.</p></div>` : ''}
    `;
  }

  // ------------------------------------------------------------- guest list
  function statusStamp(status) {
    const labels = { confirmed: 'Confirmed', unconfirmed: 'Provisional', declined: 'Declined', no_response: 'No response', invited: 'Awaiting' };
    return `<span class="tick tick-${status}">${labels[status] || status}</span>`;
  }

  function renderGuests(body, w) {
    const store = ensureStore(w.id);
    const guests = state.guests;
    body.innerHTML = `
      <div class="card-header">
        <div><h2 style="margin:0;">Guest list</h2><p class="hint" style="margin:2px 0 0;">Works offline — adds, edits, and RSVP changes sync automatically.</p></div>
        <button class="btn btn-primary" id="add-guest-btn">+ Add guest</button>
      </div>
      <div class="card card-flush">
        ${guests.length === 0 ? `<div class="empty-state"><h3>No guests yet</h3><p>Add one, or use "Import list" to bring in a spreadsheet, document, or photo.</p></div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Phone</th><th>Category</th><th>Status</th>${w.seating_enabled ? '<th>Seat</th>' : ''}${w.checkin_enabled ? '<th>Arrived</th>' : ''}<th></th></tr></thead>
          <tbody>
            ${guests.map((g) => `
              <tr data-guest="${g.id}">
                <td>${escapeHtml(g.full_name)} ${g.__pending ? '<span class="hint">(syncing…)</span>' : ''}</td>
                <td class="mono">${g.phone_number ? escapeHtml(g.phone_number) : '<span class="hint">no phone</span>'}</td>
                <td>${g.category ? escapeHtml(g.category) : '—'}</td>
                <td>
                  <select class="rsvp-select" data-guest-rsvp="${g.id}" style="width:auto; padding:4px 6px; font-size:0.78rem;">
                    ${['invited', 'confirmed', 'unconfirmed', 'declined', 'no_response'].map((s) => `<option value="${s}" ${g.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
                  </select>
                </td>
                ${w.seating_enabled ? `<td class="hint">${g.seat ? `T${g.seat.table_number ?? '—'}${g.seat.seat_number ? ' · S' + g.seat.seat_number : ''}` : 'Unseated'}</td>` : ''}
                ${w.checkin_enabled ? `<td>${g.checked_in_at ? '<span class="tick tick-confirmed">Arrived</span>' : '<span class="hint">—</span>'}</td>` : ''}
                <td style="text-align:right; white-space:nowrap;">
                  ${w.automation_enabled ? `<button class="btn btn-ghost btn-sm" data-send-invite="${g.id}">Send invite</button>` : ''}
                  <button class="btn btn-ghost btn-sm" data-edit-guest="${g.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm" data-del-guest="${g.id}" style="color:var(--cue)">Remove</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table></div>`}
      </div>
    `;
    document.getElementById('add-guest-btn').onclick = () => openGuestModal(store);
    body.querySelectorAll('[data-edit-guest]').forEach((el) => el.onclick = () => openGuestModal(store, guests.find((g) => g.id === el.dataset.editGuest)));
    body.querySelectorAll('[data-del-guest]').forEach((el) => el.onclick = () => {
      if (confirm('Remove this guest? This can be tracked in history but removed from the active list.')) { store.remove(el.dataset.delGuest); toast('Guest removed'); }
    });
    body.querySelectorAll('[data-guest-rsvp]').forEach((el) => el.onchange = () => { store.rsvp(el.dataset.guestRsvp, el.value); toast('RSVP updated'); });
    body.querySelectorAll('[data-send-invite]').forEach((el) => el.onclick = async () => {
      try {
        const r = await Api.post(`/api/weddings/${w.id}/guests/${el.dataset.sendInvite}/invite/send`, {});
        if (r.result.skipped) toast(`Not sent: ${r.result.reason.replace(/_/g, ' ')}`, 'err');
        else toast(`Invite sent via ${r.result.channel}`, r.result.ok ? 'ok' : 'err');
        store.refresh();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  function openGuestModal(store, guest) {
    showModal(`
      <h2>${guest ? 'Edit guest' : 'Add guest'}</h2>
      <form id="guest-form">
        <div class="field"><label>Full name</label><input name="full_name" required value="${guest ? escapeAttr(guest.full_name) : ''}" /></div>
        <div class="field"><label>Phone number <span class="hint">(optional — a names-only list is fully valid)</span></label><input name="phone_number" value="${guest && guest.phone_number ? escapeAttr(guest.phone_number) : ''}" placeholder="+254 7XX XXX XXX" /></div>
        <div class="field"><label>Category</label><input name="category" value="${guest && guest.category ? escapeAttr(guest.category) : ''}" placeholder="family / friend / side_bride…" /></div>
        <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">${guest ? 'Save changes' : 'Add guest'}</button>
      </form>
    `);
    document.getElementById('guest-form').onsubmit = (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target).entries());
      if (!payload.phone_number) payload.phone_number = null;
      if (guest) store.update(guest.id, payload); else store.create(payload);
      closeModal();
      toast(guest ? 'Guest updated' : 'Guest added');
    };
  }

  // -------------------------------------------------------------- import
  async function renderImport(body, w) {
    body.innerHTML = `
      <div class="card">
        <h2>Import a guest list</h2>
        <p class="hint">Type or paste names, upload a CSV/TXT file, or upload a document/photo. Nothing is added to the guest list until you review and confirm it below.</p>
        <div class="field">
          <label>Paste a list — one guest per line, or "Name, phone, category"</label>
          <textarea id="paste-text" rows="6" placeholder="Wanjiru Kamau, +254712000021, family
David Otieno
Grace Mwangi, +254712000043"></textarea>
        </div>
        <button class="btn btn-primary" id="parse-paste-btn">Preview import</button>
        <div class="hint" style="margin:14px 0 6px;">— or —</div>
        <div class="import-drop" id="drop-zone">
          <strong>Click to choose a file</strong>
          <p class="hint" style="margin:6px 0 0;">.txt or .csv parse automatically. .xlsx/.docx/.pdf/photo uploads are accepted, but need a document/vision extraction service this offline demo doesn't call out to — see the note if you try one.</p>
          <input type="file" id="file-input" style="display:none;" accept=".txt,.csv,.xlsx,.xls,.docx,.doc,.pdf,.jpg,.jpeg,.png,.heic" />
        </div>
      </div>
      <div id="import-preview"></div>
    `;
    document.getElementById('parse-paste-btn').onclick = async () => {
      const text = document.getElementById('paste-text').value;
      if (!text.trim()) return toast('Paste some names first', 'err');
      try {
        const batch = await Api.post(`/api/weddings/${w.id}/import/paste`, { text });
        state.importBatch = batch;
        renderImportPreview(w, batch);
      } catch (err) { toast(err.message, 'err'); }
    };
    document.getElementById('drop-zone').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        try {
          const batch = await Api.post(`/api/weddings/${w.id}/import/upload`, { filename: file.name, mime: file.type, content_base64: base64 });
          state.importBatch = batch;
          renderImportPreview(w, batch);
        } catch (err) { toast(err.message, 'err'); }
      };
      reader.readAsDataURL(file);
    };
  }

  function renderImportPreview(w, batch) {
    const el = document.getElementById('import-preview');
    if (!el) return;
    if (batch.status === 'failed') {
      el.innerHTML = `<div class="card" style="border-color:var(--cue-soft);"><h3 style="color:var(--cue)">Couldn't extract this file automatically</h3><p>${escapeHtml(batch.error_message)}</p></div>`;
      return;
    }
    const rows = batch.parsed_rows || [];
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Review before adding (${rows.length} row${rows.length === 1 ? '' : 's'})</h3><span class="hint">Low-confidence rows are flagged — check those first</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Include</th><th>Name</th><th>Phone</th><th>Category</th><th>Source line</th></tr></thead>
          <tbody id="preview-rows">
            ${rows.map((r, i) => `
              <tr class="${r.confidence < 0.6 ? 'confidence-low' : ''}" data-row="${i}">
                <td><input type="checkbox" data-inc="${i}" ${r.include !== false ? 'checked' : ''} /></td>
                <td><input data-field="name" data-idx="${i}" value="${escapeAttr(r.name || '')}" style="padding:5px 7px;" /></td>
                <td><input data-field="phone" data-idx="${i}" value="${escapeAttr(r.phone || '')}" style="padding:5px 7px;" /></td>
                <td><input data-field="category" data-idx="${i}" value="${escapeAttr(r.category || '')}" style="padding:5px 7px;" /></td>
                <td class="hint">${escapeHtml(r.raw_source_line || '')} ${r.confidence < 0.6 ? '<span class="confidence-low">· uncertain</span>' : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
        <div style="display:flex; gap:10px; margin-top:14px;">
          <button class="btn btn-primary" id="confirm-import-btn">Confirm & add to guest list</button>
          <button class="btn btn-ghost" id="discard-import-btn">Discard batch</button>
        </div>
      </div>`;
    const rowsData = rows.map((r) => ({ ...r }));
    el.querySelectorAll('[data-field]').forEach((inp) => inp.oninput = () => { rowsData[inp.dataset.idx][inp.dataset.field] = inp.value; });
    el.querySelectorAll('[data-inc]').forEach((cb) => cb.onchange = () => { rowsData[cb.dataset.inc].include = cb.checked; });
    document.getElementById('confirm-import-btn').onclick = async () => {
      try {
        const r = await Api.post(`/api/weddings/${w.id}/import/${batch.id}/confirm`, { rows: rowsData });
        toast(`Added ${r.created_count} guest${r.created_count === 1 ? '' : 's'}`);
        el.innerHTML = '';
        ensureStore(w.id).refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
    document.getElementById('discard-import-btn').onclick = async () => {
      await Api.post(`/api/weddings/${w.id}/import/${batch.id}/discard`, {});
      el.innerHTML = '';
    };
  }

  // ------------------------------------------------------------- seating
  async function renderSeating(body, w) {
    if (w.seat_granularity === 'seat_only') { renderSeatingList(body, w); return; } // no tables in this mode — floor plan doesn't apply
    const view = state.seatingSubview || 'list';
    body.innerHTML = `
      <div class="c-tabs-like" style="display:inline-flex; border:1px solid var(--border); border-radius:999px; padding:3px; margin-bottom:16px; background:var(--surface);">
        <button class="btn btn-sm ${view === 'list' ? 'btn-primary' : 'btn-ghost'}" id="sv-list" style="border-radius:999px;">List view</button>
        <button class="btn btn-sm ${view === 'floorplan' ? 'btn-primary' : 'btn-ghost'}" id="sv-floorplan" style="border-radius:999px;">Floor plan</button>
      </div>
      <div id="seating-subview"></div>
    `;
    document.getElementById('sv-list').onclick = () => { state.seatingSubview = 'list'; renderSeating(body, w); };
    document.getElementById('sv-floorplan').onclick = () => { state.seatingSubview = 'floorplan'; renderSeating(body, w); };
    const container = document.getElementById('seating-subview');
    if (view === 'floorplan') renderFloorPlan(container, w);
    else renderSeatingList(container, w);
  }

  async function renderSeatingList(body, w) {
    body.innerHTML = `<div class="hint">Loading seating layout…</div>`;
    let data;
    try { data = await Api.get(`/api/weddings/${w.id}/seating`); }
    catch (e) { body.innerHTML = `<div class="card">${escapeHtml(e.message)}</div>`; return; }

    body.innerHTML = `
      <div class="card-header">
        <div><h2 style="margin:0;">Seating — ${data.seat_granularity.replace(/_/g, ' ')}</h2><p class="hint" style="margin:2px 0 0;">${data.seating_locked ? 'Locked — unlock to make changes.' : 'Drag any guest onto a table, confirmed or not.'}</p></div>
        <div style="display:flex; gap:8px;">
          <button class="btn" id="add-table-btn" ${data.seating_locked ? 'disabled' : ''}>+ Add table</button>
          <button class="btn ${data.seating_locked ? 'btn-primary' : 'btn-danger'}" id="lock-btn">${data.seating_locked ? 'Unlock seating' : 'Lock seating'}</button>
        </div>
      </div>
      <div class="seating-layout">
        <div class="tables-grid" id="tables-grid">
          ${data.tables.map((t) => renderTableCard(t, data, data.seat_granularity)).join('') || '<p class="hint">No tables yet — add one to start seating guests.</p>'}
        </div>
        <div class="unseated-pool">
          <h3 style="margin-bottom:10px;">Unseated (${data.unseated.length})</h3>
          ${data.unseated.map((g) => poolGuestHtml(g)).join('') || '<p class="hint">Everyone is seated.</p>'}
        </div>
      </div>
    `;

    document.getElementById('add-table-btn').onclick = async () => {
      await Api.post(`/api/weddings/${w.id}/tables`, { table_number: data.tables.length + 1, seat_count: 8 });
      renderSeatingList(body, w);
    };
    document.getElementById('lock-btn').onclick = async () => {
      await Api.post(`/api/weddings/${w.id}/seating/lock`, { locked: !data.seating_locked });
      toast(data.seating_locked ? 'Seating unlocked' : 'Seating locked');
      renderSeatingList(body, w);
    };

    // drag & drop wiring
    body.querySelectorAll('[data-drag-guest]').forEach((el) => {
      el.ondragstart = (e) => e.dataTransfer.setData('text/guest', el.dataset.dragGuest);
    });
    body.querySelectorAll('[data-drop-table]').forEach((el) => {
      el.ondragover = (e) => e.preventDefault();
      el.ondrop = async (e) => {
        e.preventDefault();
        if (data.seating_locked) return;
        const guestId = e.dataTransfer.getData('text/guest');
        try {
          const r = await Api.post(`/api/weddings/${w.id}/seating/assign`, { guest_id: guestId, table_id: el.dataset.dropTable || null, seat_number: el.dataset.seatNumber ? Number(el.dataset.seatNumber) : null });
          if (r.warning) toast(r.warning, 'err');
          renderSeatingList(body, w);
        } catch (err) { toast(err.message, 'err'); }
      };
    });
    body.querySelectorAll('[data-unseat]').forEach((el) => el.onclick = async () => {
      if (data.seating_locked) return;
      await Api.del(`/api/weddings/${w.id}/seating/${el.dataset.unseat}`);
      renderSeatingList(body, w);
    });
  }

  function renderTableCard(t, data, granularity) {
    const assigned = data.assignments.filter((a) => a.table_id === t.id);
    const seatSlots = granularity === 'table_only' ? [] : Array.from({ length: t.seat_count || 8 }, (_, i) => i + 1);
    // In table-and-seat weddings, a guest can still be placed at a table
    // without a specific seat number — e.g. an overflow/standing group, or
    // a table the planner hasn't gotten around to seat-by-seat yet.
    const tableOnlyGuests = granularity === 'table_and_seat' ? assigned.filter((a) => a.seat_number == null) : [];
    const unassignedRow = (a) => `<div class="seat-slot filled">${escapeHtml(a.guest ? a.guest.full_name : '—')} ${statusChip(a.guest)} <span class="hint">· no seat assigned</span><span data-unseat="${a.guest_id}" style="cursor:pointer;color:var(--cue)">&times;</span></div>`;
    return `
      <div class="seat-table">
        <h4>Table ${t.table_number} <span class="hint">${assigned.length}${t.seat_count ? '/' + t.seat_count : ''}</span></h4>
        ${granularity === 'table_only' ? `
          <div data-drop-table="${t.id}" style="min-height:40px;">
            ${assigned.map((a) => `<div class="seat-slot filled">${escapeHtml(a.guest ? a.guest.full_name : '—')} ${statusChip(a.guest)}<span data-unseat="${a.guest_id}" style="cursor:pointer;color:var(--cue)">&times;</span></div>`).join('')}
            <div class="seat-slot" data-drop-table="${t.id}"><span class="empty-lbl">Drop a guest here</span></div>
          </div>
        ` : `
          <div style="min-height:40px;">
            ${tableOnlyGuests.map(unassignedRow).join('')}
            <div class="seat-slot" data-drop-table="${t.id}"><span class="empty-lbl">Assign to this table only — no specific seat</span></div>
            ${seatSlots.map((sn) => {
              const a = assigned.find((x) => x.seat_number === sn);
              return `<div class="seat-slot ${a ? 'filled' : ''}" data-drop-table="${t.id}" data-seat-number="${sn}">
                <span>Seat ${sn}: ${a ? escapeHtml(a.guest ? a.guest.full_name : '—') + statusChip(a.guest) : '<span class="empty-lbl">empty</span>'}</span>
                ${a ? `<span data-unseat="${a.guest_id}" style="cursor:pointer;color:var(--cue)">&times;</span>` : ''}
              </div>`;
            }).join('')}
          </div>
        `}
      </div>`;
  }

  function statusChip(guest) {
    if (!guest) return '';
    return guest.status === 'confirmed' ? '' : ` <span class="hint">(${guest.status.replace('_', ' ')})</span>`;
  }
  function poolGuestHtml(g) {
    return `<div class="pool-guest" draggable="true" data-drag-guest="${g.id}"><span>${escapeHtml(g.full_name)}</span>${statusStamp(g.status)}</div>`;
  }

  // -------------------------------------------------------- floor plan
  // A spatial view of the actual room — tables and landmarks (dance floor,
  // head table, entrance) positioned the way a planner would sketch them
  // on paper, optionally over an uploaded photo/scan of the real venue
  // layout. pos_x/pos_y/width/height are all percentages of the canvas, so
  // the layout holds up at any screen size without per-device math.
  const MARKER_ICONS = {
    dance_floor: '\u{1F483}', head_table: '\u{2764}\u{FE0F}', entrance: '\u{1F6AA}', stage: '\u{1F3A4}', bar: '\u{1F378}', custom: '\u{1F4CD}',
  };

  async function renderFloorPlan(body, w) {
    body.innerHTML = `<div class="hint">Loading floor plan…</div>`;
    let venue, seating;
    try {
      [venue, seating] = await Promise.all([
        Api.get(`/api/weddings/${w.id}/venue-layout`),
        Api.get(`/api/weddings/${w.id}/seating`),
      ]);
    } catch (e) { body.innerHTML = `<div class="card">${escapeHtml(e.message)}</div>`; return; }

    const locked = seating.seating_locked;
    const placedTables = venue.tables.filter((t) => t.pos_x != null);
    const unplacedTables = venue.tables.filter((t) => t.pos_x == null);
    const occupancy = {};
    seating.assignments.forEach((a) => { if (a.table_id) occupancy[a.table_id] = (occupancy[a.table_id] || 0) + 1; });

    body.innerHTML = `
      <div class="card-header">
        <div><h2 style="margin:0;">Floor plan</h2><p class="hint" style="margin:2px 0 0;">${locked ? 'Locked — unlock to rearrange.' : 'Drag tables and landmarks into place. Click a table to seat guests.'}</p></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn" id="fp-upload-btn" ${locked ? 'disabled' : ''}>${venue.layout.background_image_url ? 'Replace' : 'Upload'} venue layout</button>
          ${venue.layout.background_image_url ? `<button class="btn btn-ghost" id="fp-clear-bg-btn" ${locked ? 'disabled' : ''}>Remove image</button>` : ''}
          <button class="btn" id="fp-add-marker-btn" ${locked ? 'disabled' : ''}>+ Add landmark</button>
          <button class="btn" id="fp-add-table-btn" ${locked ? 'disabled' : ''}>+ Add table</button>
          <button class="btn ${locked ? 'btn-primary' : 'btn-danger'}" id="fp-lock-btn">${locked ? 'Unlock seating' : 'Lock seating'}</button>
        </div>
        <input type="file" id="fp-file-input" accept="image/*" style="display:none;" />
      </div>

      <div class="floorplan-shell">
        <div class="floorplan-canvas" id="fp-canvas" style="aspect-ratio:${venue.layout.canvas_width}/${venue.layout.canvas_height}; ${venue.layout.background_image_url ? `background-image:url('${venue.layout.background_image_url}');` : ''}">
          ${venue.markers.map((m) => fpMarkerHtml(m)).join('')}
          ${placedTables.map((t) => fpTableHtml(t, occupancy[t.id] || 0)).join('')}
          ${venue.markers.length === 0 && placedTables.length === 0 ? '<div class="fp-empty-hint">Empty canvas — add a table or landmark, or upload your venue\'s own layout to trace over.</div>' : ''}
        </div>
        ${unplacedTables.length ? `
        <div class="unseated-pool" style="margin-top:14px;">
          <h3 style="margin-bottom:8px;">Not yet placed on the plan (${unplacedTables.length})</h3>
          <p class="hint" style="margin-top:0;">Drag onto the canvas above to position.</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${unplacedTables.map((t) => `<div class="pool-guest" draggable="true" data-drag-table="${t.id}" style="cursor:grab;">Table ${t.table_number}${t.reserved_for ? ` · ${escapeHtml(t.reserved_for)}` : ''}</div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    `;

    // --- toolbar actions ---
    document.getElementById('fp-lock-btn').onclick = async () => {
      await Api.post(`/api/weddings/${w.id}/seating/lock`, { locked: !locked });
      toast(locked ? 'Seating unlocked' : 'Seating locked');
      renderFloorPlan(body, w);
    };
    document.getElementById('fp-upload-btn').onclick = () => document.getElementById('fp-file-input').click();
    document.getElementById('fp-file-input').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await Api.post(`/api/weddings/${w.id}/venue-layout/background`, { filename: file.name, mime: file.type, content_base64: reader.result.split(',')[1] });
          toast('Venue layout uploaded');
          renderFloorPlan(body, w);
        } catch (err) { toast(err.message, 'err'); }
      };
      reader.readAsDataURL(file);
    };
    const clearBg = document.getElementById('fp-clear-bg-btn');
    if (clearBg) clearBg.onclick = async () => { await Api.del(`/api/weddings/${w.id}/venue-layout/background`); renderFloorPlan(body, w); };

    document.getElementById('fp-add-table-btn').onclick = () => openTableEditModal(w, null, () => renderFloorPlan(body, w));
    document.getElementById('fp-add-marker-btn').onclick = () => openMarkerModal(w, () => renderFloorPlan(body, w));

    // --- reposition existing tables/markers by drag (pointer-based; a
    // click with no movement opens the edit/assign modal instead) ---
    const canvas = document.getElementById('fp-canvas');
    body.querySelectorAll('.fp-table').forEach((el) => {
      const table = venue.tables.find((t) => t.id === el.dataset.tableId);
      wireFloorPlanDrag(el, canvas, locked, async (x, y) => {
        await Api.patch(`/api/weddings/${w.id}/tables/${table.id}`, { pos_x: x, pos_y: y });
      }, () => openTableEditModal(w, table, () => renderFloorPlan(body, w), occupancy[table.id] || 0));
    });
    body.querySelectorAll('.fp-landmark').forEach((el) => {
      wireFloorPlanDrag(el, canvas, locked, async (x, y) => {
        await Api.patch(`/api/weddings/${w.id}/layout-markers/${el.dataset.markerId}`, { pos_x: x, pos_y: y });
      }, async () => {
        if (locked) return;
        if (confirm(`Remove "${el.dataset.markerLabel}" from the floor plan?`)) {
          await Api.del(`/api/weddings/${w.id}/layout-markers/${el.dataset.markerId}`);
          renderFloorPlan(body, w);
        }
      });
    });

    // --- guests dragged from the unseated pool onto a table marker ---
    body.querySelectorAll('[data-drag-guest]').forEach((el) => { el.ondragstart = (e) => e.dataTransfer.setData('text/guest', el.dataset.dragGuest); });
    body.querySelectorAll('.fp-table').forEach((el) => {
      el.ondragover = (e) => e.preventDefault();
      el.ondrop = async (e) => {
        e.preventDefault();
        if (locked) return;
        const guestId = e.dataTransfer.getData('text/guest');
        if (!guestId) return;
        try {
          const r = await Api.post(`/api/weddings/${w.id}/seating/assign`, { guest_id: guestId, table_id: el.dataset.tableId });
          if (r.warning) toast(r.warning, 'err'); else toast('Guest seated');
          renderFloorPlan(body, w);
        } catch (err) { toast(err.message, 'err'); }
      };
    });

    // --- unplaced tables dragged onto the canvas for first-time placement ---
    body.querySelectorAll('[data-drag-table]').forEach((el) => { el.ondragstart = (e) => e.dataTransfer.setData('text/table', el.dataset.dragTable); });
    canvas.ondragover = (e) => e.preventDefault();
    canvas.ondrop = async (e) => {
      e.preventDefault();
      const tableId = e.dataTransfer.getData('text/table');
      if (!tableId || locked) return;
      const rect = canvas.getBoundingClientRect();
      const x = clampPct(((e.clientX - rect.left) / rect.width) * 100);
      const y = clampPct(((e.clientY - rect.top) / rect.height) * 100);
      await Api.patch(`/api/weddings/${w.id}/tables/${tableId}`, { pos_x: x, pos_y: y });
      renderFloorPlan(body, w);
    };

    // unseated guest pool below the canvas, same as list view
    if (!document.getElementById('fp-unseated')) {
      const pool = document.createElement('div');
      pool.className = 'unseated-pool';
      pool.id = 'fp-unseated';
      pool.style.marginTop = '14px';
      pool.innerHTML = `<h3 style="margin-bottom:10px;">Unseated (${seating.unseated.length})</h3>${seating.unseated.map((g) => poolGuestHtml(g)).join('') || '<p class="hint">Everyone is seated.</p>'}`;
      body.appendChild(pool);
      pool.querySelectorAll('[data-drag-guest]').forEach((el) => { el.ondragstart = (e) => e.dataTransfer.setData('text/guest', el.dataset.dragGuest); });
    }
  }

  function clampPct(v) { return Math.max(0, Math.min(100, v)); }

  function fpTableHtml(t, occCount) {
    const full = t.seat_count && occCount >= t.seat_count;
    const cls = ['fp-table', t.shape === 'rectangle' ? 'rectangle' : 'round', t.reserved_for ? 'reserved' : '', full ? 'full' : ''].filter(Boolean).join(' ');
    const w = t.shape === 'rectangle' ? (t.width || 14) : (t.width || 10);
    const h = t.shape === 'rectangle' ? (t.height || 8) : (t.width || 10);
    return `<div class="${cls}" data-table-id="${t.id}" style="left:${t.pos_x}%; top:${t.pos_y}%; width:${w}%; height:${h}%;">
      <span class="fp-table-num">${t.table_number}</span>
      <span class="fp-table-occ">${occCount}${t.seat_count ? '/' + t.seat_count : ''}</span>
      ${t.reserved_for ? `<span class="fp-table-reserved">${escapeHtml(t.reserved_for)}</span>` : ''}
    </div>`;
  }
  function fpMarkerHtml(m) {
    return `<div class="fp-landmark" data-marker-id="${m.id}" data-marker-label="${escapeAttr(m.label)}" style="left:${m.pos_x}%; top:${m.pos_y}%; width:${m.width}%; height:${m.height}%;">
      <span>${MARKER_ICONS[m.icon] || MARKER_ICONS.custom}</span><span>${escapeHtml(m.label)}</span>
    </div>`;
  }

  // Pointer-based drag that distinguishes a click (opens onClick) from an
  // actual drag (calls onDrop with the new percentage position) — so a
  // single element can both be repositioned and be clickable.
  function wireFloorPlanDrag(el, canvas, locked, onDrop, onClick) {
    el.addEventListener('pointerdown', (e) => {
      if (locked) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      let moved = false, x = parseFloat(el.style.left), y = parseFloat(el.style.top);
      function onMove(ev) {
        const dx = Math.abs(ev.clientX - e.clientX), dy = Math.abs(ev.clientY - e.clientY);
        if (dx > 3 || dy > 3) moved = true;
        if (!moved) return;
        x = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
        y = clampPct(((ev.clientY - rect.top) / rect.height) * 100);
        el.style.left = x + '%'; el.style.top = y + '%';
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (moved) onDrop(x, y); else if (onClick) onClick();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
    });
  }

  function openMarkerModal(w, onDone) {
    showModal(`
      <h2>Add a landmark</h2>
      <p class="hint">Dance floor, head table, entrance — anything that helps you see the room at a glance. Drag it into place after adding.</p>
      <form id="marker-form">
        <div class="field"><label>Type</label>
          <select name="icon">
            <option value="dance_floor">Dance floor</option>
            <option value="head_table">Head table</option>
            <option value="entrance">Entrance</option>
            <option value="stage">Stage</option>
            <option value="bar">Bar</option>
            <option value="custom">Other</option>
          </select>
        </div>
        <div class="field"><label>Label</label><input name="label" placeholder="Dance Floor" required /></div>
        <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Add to floor plan</button>
      </form>
    `);
    document.getElementById('marker-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post(`/api/weddings/${w.id}/layout-markers`, { label: fd.get('label'), icon: fd.get('icon'), pos_x: 50, pos_y: 50 });
        closeModal();
        toast('Added — drag it into place');
        onDone();
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  // Used for both creating a new table (table = null) and editing/seating
  // an existing one — reuses the same per-seat card markup as list view so
  // table_and_seat weddings get the identical seat-by-seat picker here.
  async function openTableEditModal(w, table, onDone, occCount) {
    let seatingData = null;
    if (table) {
      try { seatingData = await Api.get(`/api/weddings/${w.id}/seating`); } catch (e) { /* fall back to create-only fields */ }
    }
    showModal(`
      <h2>${table ? `Table ${table.table_number}` : 'Add a table'}</h2>
      <form id="table-form">
        <div class="field-row">
          <div class="field"><label>Table number</label><input name="table_number" type="number" min="1" value="${table ? table.table_number : ''}" /></div>
          <div class="field"><label>Seat count</label><input name="seat_count" type="number" min="1" value="${table && table.seat_count ? table.seat_count : 8}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Shape</label>
            <select name="shape">
              <option value="round" ${!table || table.shape === 'round' ? 'selected' : ''}>Round</option>
              <option value="rectangle" ${table && table.shape === 'rectangle' ? 'selected' : ''}>Rectangular</option>
            </select>
          </div>
          <div class="field"><label>Reserved for <span class="hint">(optional)</span></label><input name="reserved_for" placeholder="Family, VIP…" value="${table && table.reserved_for ? escapeAttr(table.reserved_for) : ''}" /></div>
        </div>
        <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">${table ? 'Save changes' : 'Add table'}</button>
        ${table ? '<button type="button" class="btn btn-danger" id="delete-table-btn" style="width:100%; justify-content:center; margin-top:8px;">Delete table</button>' : ''}
      </form>
      ${table && seatingData ? `<div style="margin-top:18px; border-top:1px solid var(--border); padding-top:16px;"><h3 style="margin-bottom:10px;">Seat guests</h3>${renderTableCard(table, seatingData, w.seat_granularity)}</div>` : ''}
    `);
    document.getElementById('table-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = { table_number: fd.get('table_number'), seat_count: fd.get('seat_count'), shape: fd.get('shape'), reserved_for: fd.get('reserved_for') || null };
      try {
        if (table) await Api.patch(`/api/weddings/${w.id}/tables/${table.id}`, payload);
        else await Api.post(`/api/weddings/${w.id}/tables`, { ...payload, pos_x: 50, pos_y: 50 });
        closeModal();
        toast(table ? 'Table updated' : 'Table added — drag it into place');
        onDone();
      } catch (err) { toast(err.message, 'err'); }
    };
    const delBtn = document.getElementById('delete-table-btn');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm(`Delete Table ${table.table_number}? Any seated guests will move back to Unseated.`)) return;
      await Api.del(`/api/weddings/${w.id}/tables/${table.id}`);
      closeModal();
      onDone();
    };
    // wire the reused seat-card's own drop/unseat handlers inside the modal
    if (table && seatingData) {
      document.querySelectorAll('.modal [data-drop-table]').forEach((el) => {
        el.ondragover = (e) => e.preventDefault();
        el.ondrop = async (e) => {
          e.preventDefault();
          const guestId = e.dataTransfer.getData('text/guest');
          if (!guestId) return;
          const r = await Api.post(`/api/weddings/${w.id}/seating/assign`, { guest_id: guestId, table_id: el.dataset.dropTable, seat_number: el.dataset.seatNumber ? Number(el.dataset.seatNumber) : null });
          if (r.warning) toast(r.warning, 'err');
          closeModal(); onDone();
        };
      });
      document.querySelectorAll('.modal [data-unseat]').forEach((el) => el.onclick = async () => {
        await Api.del(`/api/weddings/${w.id}/seating/${el.dataset.unseat}`);
        closeModal(); onDone();
      });
    }
  }

  // ------------------------------------------------------------- checkin
  async function renderCheckin(body, w) {
    const store = ensureStore(w.id);
    let guests = state.guests;
    body.innerHTML = `
      <input class="checkin-search" id="checkin-search" placeholder="Search by name…" />
      <div class="card" id="checkin-list"></div>
    `;
    function draw(filter) {
      const list = document.getElementById('checkin-list');
      const f = (filter || '').toLowerCase();
      const filtered = guests.filter((g) => g.full_name.toLowerCase().includes(f));
      list.innerHTML = filtered.map((g) => `
        <div class="checkin-row">
          <div>
            <div style="font-weight:600;">${escapeHtml(g.full_name)}</div>
            <div class="hint">${g.seat ? `Table ${g.seat.table_number ?? '—'}${g.seat.seat_number ? ' · Seat ' + g.seat.seat_number : ''}` : 'Unseated'} · ${g.status.replace('_', ' ')}</div>
          </div>
          <div class="arrived-tick ${g.checked_in_at ? 'done' : ''}" data-tick="${g.id}">${g.checked_in_at ? '✓' : ''}</div>
        </div>`).join('') || '<p class="hint" style="padding:20px;">No matches.</p>';
      list.querySelectorAll('[data-tick]').forEach((el) => el.onclick = async () => {
        const g = guests.find((x) => x.id === el.dataset.tick);
        try {
          await Api.post(`/api/weddings/${w.id}/guests/${g.id}/checkin`, { arrived: !g.checked_in_at });
          g.checked_in_at = g.checked_in_at ? null : new Date().toISOString();
          draw(document.getElementById('checkin-search').value);
        } catch (err) { toast(err.message, 'err'); }
      });
    }
    document.getElementById('checkin-search').oninput = (e) => draw(e.target.value);
    draw('');
  }

  // ------------------------------------------------------------- messages
  async function renderMessages(body, w) {
    body.innerHTML = `<div class="hint">Loading…</div>`;
    const [messages, tpl] = await Promise.all([
      Api.get(`/api/weddings/${w.id}/messages`),
      Api.get(`/api/weddings/${w.id}/invite-template`),
    ]);
    const pending = state.guests.filter((g) => !g.invite_sent_at && g.phone_number).length;
    const liveMode = tpl.whatsapp_live || tpl.sms_live;
    body.innerHTML = `
      <div class="offline-banner show" style="background:${liveMode ? 'var(--confirm-dim)' : 'var(--brass-dim)'}; color:${liveMode ? 'var(--confirm)' : 'var(--brass)'}; border-color:${liveMode ? 'var(--confirm)' : 'var(--brass)'};">
        <span class="dot" style="background:${liveMode ? 'var(--confirm)' : 'var(--brass)'};"></span>
        <span class="msg">${liveMode
          ? `Live sending: WhatsApp ${tpl.whatsapp_live ? 'connected' : 'not connected'}, SMS ${tpl.sms_live ? 'connected' : 'not connected'}.`
          : 'Demo mode — WhatsApp/SMS credentials aren\'t set, so sends are simulated. See README-DEPLOY.md "WhatsApp automation".'}</span>
      </div>
      <div class="card">
        <div class="card-header"><h3>Invite template</h3></div>
        <textarea id="tpl-text" rows="4">${escapeHtml(tpl.invite_template)}</textarea>
        <p class="hint">Variables: {guest_name} {couple_names} {date} {venue} {deadline}. Every message always also appends a phone-call fallback line. ${tpl.whatsapp_live ? 'Live WhatsApp sends use the approved template text from Meta Business Manager, not this field — this text is used for the SMS fallback.' : ''}</p>
        <button class="btn" id="save-tpl-btn">Save template</button>
      </div>
      <div class="card-header">
        <h3>Send invites</h3>
        <button class="btn btn-primary" id="send-all-btn">Send to ${pending} guest${pending === 1 ? '' : 's'} awaiting invite</button>
      </div>
      <div class="card card-flush">
        <div class="table-wrap"><table>
          <thead><tr><th>Guest</th><th>Type</th><th>Channel</th><th>Status</th><th>When</th></tr></thead>
          <tbody>${messages.length ? messages.map((m) => `<tr><td>${escapeHtml(m.guest_name)}</td><td>${m.message_type.replace('_', ' ')}</td><td>${m.channel}</td><td><span class="badge ${m.status === 'sent' || m.status === 'delivered' || m.status === 'read' ? 'badge-on' : ''}">${m.status}</span></td><td class="hint">${new Date(m.sent_at).toLocaleString()}</td></tr>`).join('') : '<tr><td colspan="5" class="hint" style="padding:16px;">No messages sent yet.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>Run reminder check now</h3>
        <p class="hint">Normally runs on a schedule (every ${w.reminder_interval_days} days per non-responder, up to ${w.max_reminders ?? 'unlimited'} reminders) — trigger it manually to see it work.</p>
        <button class="btn" id="run-cron-btn">Run reminder sweep</button>
      </div>
    `;
    document.getElementById('save-tpl-btn').onclick = async () => {
      await Api.patch(`/api/weddings/${w.id}/invite-template`, { invite_template: document.getElementById('tpl-text').value });
      toast('Template saved');
    };
    document.getElementById('send-all-btn').onclick = async () => {
      const r = await Api.post(`/api/weddings/${w.id}/invites/send-all`, {});
      toast(`Sent ${r.sent}, skipped ${r.skipped}, failed ${r.failed}`);
      ensureStore(w.id).refresh();
      renderMessages(body, w);
    };
    document.getElementById('run-cron-btn').onclick = async () => {
      const r = await Api.post('/api/cron/reminders', {});
      toast(`Reminder sweep: checked ${r.checked}, sent ${r.sent}`);
      renderMessages(body, w);
    };
  }

  // ------------------------------------------------------------ companion
  async function renderCompanion(body, w) {
    const access = await Api.get(`/api/weddings/${w.id}/couple-access`);
    const pairings = state.fontPairings.length ? state.fontPairings : (state.fontPairings = await Api.get('/api/font-pairings'));
    const link = `${location.origin}/couple/${w.couple_site_slug}`;
    body.innerHTML = `
      <div class="card">
        <h3>Share with the couple</h3>
        <p class="hint">A passcode specific to this wedding only — never a global code, never the planner login.</p>
        <div class="field"><label>Companion site link</label><input readonly value="${link}" onclick="this.select()" /></div>
        <div class="field"><label>Passcode</label><input readonly class="mono" value="${access ? access.access_code : ''}" onclick="this.select()" /></div>
        ${access && access.revoked ? '<p style="color:var(--cue)">Access is currently revoked.</p>' : ''}
        <div style="display:flex; gap:8px;">
          <button class="btn" id="rotate-btn">Rotate passcode</button>
          <button class="btn btn-danger" id="revoke-btn">Revoke access</button>
        </div>
      </div>
      <div class="card">
        <h3>Branding</h3>
        <p class="hint">Google Fonts only, from a curated elegant pairing list — never free text.</p>
        <div class="field-row">
          <div class="field"><label>Primary color</label><input type="color" id="primary-color" value="${w.theme.primary}" /></div>
          <div class="field"><label>Accent color</label><input type="color" id="accent-color" value="${w.theme.accent}" /></div>
        </div>
        <div class="field">
          <label>Font pairing</label>
          <select id="font-pairing">${pairings.map((p) => `<option value="${p.key}" ${w.theme.font_pairing === p.key ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
        </div>
        <button class="btn btn-primary" id="save-theme-btn">Save branding</button>
      </div>
    `;
    document.getElementById('rotate-btn').onclick = async () => { await Api.post(`/api/weddings/${w.id}/couple-access/rotate`, {}); toast('Passcode rotated'); renderCompanion(body, w); };
    document.getElementById('revoke-btn').onclick = async () => {
      if (!confirm('Revoke the couple\'s access? Their data stays intact — you can re-issue a new code any time.')) return;
      await Api.post(`/api/weddings/${w.id}/couple-access/revoke`, {}); toast('Access revoked'); renderCompanion(body, w);
    };
    document.getElementById('save-theme-btn').onclick = async () => {
      const body2 = { primary: document.getElementById('primary-color').value, accent: document.getElementById('accent-color').value, font_pairing: document.getElementById('font-pairing').value };
      state.wedding = await Api.patch(`/api/weddings/${w.id}/theme`, body2);
      toast('Branding saved');
    };
  }

  // ------------------------------------------------------------- settings
  function renderSettings(body, w) {
    body.innerHTML = `
      <div class="card">
        <h3>Modules</h3>
        <p class="hint">Turning a module on or off never deletes any data.</p>
        <div style="display:flex; flex-direction:column; gap:14px; margin-top:10px;">
          ${moduleToggle('automation_enabled', 'Automated invite & reminder sending', 'WhatsApp → SMS fallback, always with a phone-call fallback line.', w)}
          ${moduleToggle('couple_site_enabled', 'Couple companion site', 'A bespoke-branded mini-site the couple can log into with a passcode.', w)}
          ${moduleToggle('seating_enabled', 'Seating & table arrangement', 'Visual table/seat layout builder.', w)}
          ${moduleToggle('checkin_enabled', 'Event-day check-in mode', 'Read-optimized, offline-capable door checklist.', w)}
        </div>
        ${w.seating_enabled ? `
        <div class="field" style="margin-top:16px;">
          <label>Seat granularity</label>
          <select id="granularity-select">
            <option value="table_and_seat" ${w.seat_granularity === 'table_and_seat' ? 'selected' : ''}>Table and seat</option>
            <option value="table_only" ${w.seat_granularity === 'table_only' ? 'selected' : ''}>Table only</option>
            <option value="seat_only" ${w.seat_granularity === 'seat_only' ? 'selected' : ''}>Seat only (no tables)</option>
          </select>
        </div>` : ''}
        ${w.automation_enabled ? `
        <div class="field-row" style="margin-top:16px;">
          <div class="field"><label>Reminder interval (days)</label><input id="reminder-interval" type="number" min="1" value="${w.reminder_interval_days}" /></div>
          <div class="field"><label>Max reminders (blank = unlimited)</label><input id="max-reminders" type="number" min="0" value="${w.max_reminders ?? ''}" /></div>
        </div>` : ''}
      </div>
      <div class="card">
        <h3>Event details</h3>
        <form id="details-form">
          <div class="field"><label>Couple names</label><input name="couple_names" value="${escapeAttr(w.couple_names)}" /></div>
          <div class="field-row">
            <div class="field"><label>Event date</label><input name="event_date" type="date" value="${w.event_date}" /></div>
            <div class="field"><label>RSVP cutoff</label><input name="rsvp_cutoff" type="date" value="${w.rsvp_cutoff}" /></div>
          </div>
          <div class="field"><label>Venue</label><input name="venue" value="${escapeAttr(w.venue || '')}" /></div>
          <p class="hint">Changing these never auto-notifies guests — that's always a separate, explicit action.</p>
          <button class="btn btn-primary" type="submit">Save details</button>
        </form>
      </div>
      <div class="card" style="border-color: ${w.wedding_status === 'active' ? 'var(--border)' : 'var(--cue-soft)'};">
        <h3>Wedding status</h3>
        <p class="hint">Postponing or cancelling freezes automated sending and seating edits, but keeps every record.</p>
        <div style="display:flex; gap:8px;">
          <button class="btn ${w.wedding_status === 'active' ? 'btn-primary' : ''}" data-status="active">Active</button>
          <button class="btn ${w.wedding_status === 'postponed' ? 'btn-primary' : ''}" data-status="postponed">Postponed</button>
          <button class="btn ${w.wedding_status === 'cancelled' ? 'btn-danger' : ''}" data-status="cancelled">Cancelled</button>
        </div>
      </div>
    `;
    body.querySelectorAll('[data-module]').forEach((el) => el.onchange = async () => {
      const patch = { [el.dataset.module]: el.checked };
      state.wedding = await Api.patch(`/api/weddings/${w.id}/modules`, patch);
      toast('Modules updated');
      renderWeddingDetail();
    });
    const g = document.getElementById('granularity-select'); if (g) g.onchange = async () => { state.wedding = await Api.patch(`/api/weddings/${w.id}/modules`, { seat_granularity: g.value }); toast('Saved'); };
    const ri = document.getElementById('reminder-interval'); if (ri) ri.onchange = async () => { await Api.patch(`/api/weddings/${w.id}/modules`, { reminder_interval_days: ri.value }); toast('Saved'); };
    const mr = document.getElementById('max-reminders'); if (mr) mr.onchange = async () => { await Api.patch(`/api/weddings/${w.id}/modules`, { max_reminders: mr.value === '' ? null : mr.value }); toast('Saved'); };
    document.getElementById('details-form').onsubmit = async (e) => {
      e.preventDefault();
      state.wedding = await Api.patch(`/api/weddings/${w.id}`, Object.fromEntries(new FormData(e.target).entries()));
      toast('Details saved');
      renderWeddingDetail();
    };
    body.querySelectorAll('[data-status]').forEach((el) => el.onclick = async () => {
      state.wedding = await Api.patch(`/api/weddings/${w.id}/status`, { wedding_status: el.dataset.status });
      toast('Status updated');
      renderWeddingDetail();
    });
  }

  function moduleToggle(key, label, sub, w) {
    return `<label class="toggle">
      <input type="checkbox" data-module="${key}" ${w[key] ? 'checked' : ''} />
      <span class="track"></span>
      <span><span class="toggle-label">${label}</span><br /><span class="toggle-sub">${sub}</span></span>
    </label>`;
  }

  // ------------------------------------------------------------ modal/util
  function showModal(html) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal"><button type="button" class="modal-close" aria-label="Close">&times;</button>${html}</div>`;
    backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
    backdrop.querySelector('.modal-close').onclick = () => closeModal();
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', closeModalOnEscape);
  }
  function closeModalOnEscape(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
    document.removeEventListener('keydown', closeModalOnEscape);
  }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  // -------------------------------------------------------------- boot
  (async function boot() {
    if (state.token) await loadWeddings();
    render();
  })();
})();
