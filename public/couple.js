// public/couple.js
(function () {
  const slug = location.pathname.replace(/^\/couple\//, '').replace(/\/$/, '');
  const tokenKey = `wrsvp:couple:token:${slug}`;
  const weddingKey = `wrsvp:couple:wedding:${slug}`;

  const state = {
    slug,
    token: localStorage.getItem(tokenKey) || null,
    wedding: loadJSON(weddingKey, null),
    themeInfo: null,
    tab: 'guests',
    store: null,
    guestSearch: '',
    statusFilter: 'all',
    categoryFilter: 'all',
  };

  Api.setTokenGetter(() => state.token);

  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pillClass(status) { return ['confirmed', 'unconfirmed', 'declined'].includes(status) ? status : 'muted'; }
  // A slim hand-drawn-style checkmark instead of a blunt Unicode glyph —
  // sits inside the existing wax-seal circle for a confirmed guest.
  function sealCheck() {
    return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.7l3 3 6-7" stroke="#f5f1e6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  const GOOGLE_FONT_PARAM = {
    alexbrush_plusjakarta: 'Alex+Brush&family=Plus+Jakarta+Sans:wght@300;400;500;600',
    playfair_lato: 'Playfair+Display:wght@500;600&family=Lato:wght@400;700',
    cormorant_karla: 'Cormorant+Garamond:wght@500;600&family=Karla:wght@400;700',
    italiana_montserrat: 'Italiana&family=Montserrat:wght@400;600',
    marcellus_jost: 'Marcellus&family=Jost:wght@400;600',
    ebgaramond_worksans: 'EB+Garamond:wght@500;600&family=Work+Sans:wght@400;600',
  };

  function applyTheme(theme, pairing) {
    const root = document.documentElement;
    root.style.setProperty('--c-primary', theme.primary);
    root.style.setProperty('--c-accent', theme.accent);
    root.style.setProperty('--c-heading-font', pairing.heading);
    root.style.setProperty('--c-body-font', pairing.body);
    const param = GOOGLE_FONT_PARAM[theme.font_pairing] || GOOGLE_FONT_PARAM.alexbrush_plusjakarta;
    if (!document.getElementById('couple-font-link')) {
      const link = document.createElement('link');
      link.id = 'couple-font-link';
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${param}&display=swap`;
      document.head.appendChild(link);
    }
  }

  const app = document.getElementById('app');

  async function boot() {
    if (!slug) { app.innerHTML = `<div class="c-gate"><div class="c-gate-card"><h2 class="c-h2">No wedding link</h2><p>Ask your planner for your companion site link.</p></div></div>`; return; }
    let theme;
    try { theme = await Api.get(`/api/couple/${slug}/theme`); }
    catch (e) {
      app.innerHTML = `<div class="c-gate"><div class="c-gate-card"><h2 class="c-h2">This link isn't available</h2><p>${escapeHtml(e.message)}</p></div></div>`;
      return;
    }
    state.themeInfo = theme;
    applyTheme(theme.theme, theme.font_pairing);

    if (state.token && state.wedding) return renderApp();
    return renderGate(theme);
  }

  function renderGate(theme) {
    app.innerHTML = `
      <div class="c-gate">
        <div class="c-gate-card">
          <p class="c-label">Companion site</p>
          <h1 class="c-h1">${escapeHtml(theme.couple_names)}</h1>
          <div class="c-header"><div class="c-divider"></div></div>
          <p>${new Date(theme.event_date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}${theme.venue ? ' · ' + escapeHtml(theme.venue) : ''}</p>
          <form id="gate-form" style="margin-top:18px; text-align:left;">
            <div class="c-field"><label class="c-label">Passcode</label><input class="c-input" name="passcode" autocapitalize="characters" placeholder="AMBER-2026" required /></div>
            <div id="gate-error" style="color:var(--c-cue); font-size:0.82rem; margin-bottom:10px;"></div>
            <button class="c-btn" type="submit">Continue</button>
          </form>
          <p class="c-guest-meta" style="margin-top:14px;">Your planner gave you this passcode — it only unlocks this one wedding.</p>
        </div>
      </div>`;
    document.getElementById('gate-form').onsubmit = async (e) => {
      e.preventDefault();
      const passcode = new FormData(e.target).get('passcode');
      const errEl = document.getElementById('gate-error');
      try {
        const data = await Api.post(`/api/couple/${slug}/login`, { passcode });
        state.token = data.token; state.wedding = data.wedding;
        localStorage.setItem(tokenKey, state.token);
        localStorage.setItem(weddingKey, JSON.stringify(state.wedding));
        renderApp();
      } catch (err) { errEl.textContent = err.message; }
    };
  }

  function ensureStore() {
    if (!state.store) {
      state.store = makeGuestStore(state.wedding.id);
      state.store.onChange(() => { if (state.tab === 'guests') drawGuests(); });
      state.store.startPolling(4000);
    }
    return state.store;
  }

  function renderApp() {
    const w = state.wedding;
    const showSeating = w.seating_enabled;
    app.innerHTML = `
      <div class="c-shell">
        <div class="c-header">
          <p class="c-kicker">You're managing</p>
          <h1 class="c-h1">${escapeHtml(w.couple_names)}</h1>
          <p class="c-guest-meta">${new Date(w.event_date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}${w.venue ? ' · ' + escapeHtml(w.venue) : ''}</p>
          <div class="c-divider"></div>
        </div>
        <div id="c-offline" class="c-offline"><span class="dot"></span><span class="msg"></span></div>
        ${w.wedding_status !== 'active' ? `<div class="c-card" style="border-color:var(--c-warn); background:var(--c-warn-soft);"><strong>This wedding is marked ${w.wedding_status}.</strong></div>` : ''}
        <div class="c-tabs">
          <div class="c-tab ${state.tab === 'guests' ? 'active' : ''}" data-ctab="guests">Guest list</div>
          ${showSeating ? `<div class="c-tab ${state.tab === 'seating' ? 'active' : ''}" data-ctab="seating">Seating</div>` : ''}
        </div>
        <div id="c-body"></div>
      </div>
      <div class="c-fab-add" id="c-fab" style="display:${state.tab === 'guests' ? 'block' : 'none'};">
        <button class="c-btn" id="c-add-btn">+ Add a guest</button>
      </div>
    `;
    const store = ensureStore();
    offlineBannerController(document.getElementById('c-offline'), null, store);
    app.querySelectorAll('[data-ctab]').forEach((el) => el.onclick = () => {
      state.tab = el.dataset.ctab;
      app.querySelectorAll('[data-ctab]').forEach((t) => t.classList.toggle('active', t === el));
      document.getElementById('c-fab').style.display = state.tab === 'guests' ? 'block' : 'none';
      drawBody();
    });
    document.getElementById('c-add-btn').onclick = () => openAddGuest(store);
    drawBody();
    ensureAssistant().show();
  }

  // ---------------------------------------------------------- assistant
  let assistant = null;
  function ensureAssistant() {
    if (!assistant) {
      assistant = initAssistant({
        title: `${state.wedding.couple_names}'s Assistant`,
        placeholder: 'Add a guest, check RSVPs…',
        getWeddingId: () => state.wedding.id,
        onReply: () => {
          ensureStore().refresh();
          if (state.tab === 'guests') drawGuests();
        },
      });
    }
    return assistant;
  }

  function drawBody() {
    if (state.tab === 'guests') return drawGuests();
    if (state.tab === 'seating') return drawSeating();
  }

  const STATUS_FILTERS = [
    ['all', 'All'], ['confirmed', 'Confirmed'], ['unconfirmed', 'Unconfirmed'],
    ['declined', 'Declined'], ['no_response', 'No response'], ['invited', 'Invited'],
  ];

  function drawGuests() {
    const body = document.getElementById('c-body');
    if (!body) return;
    const store = ensureStore();
    const allGuests = store.list();

    // Preserve the search box's focus/caret across re-renders — every
    // keystroke redraws this whole card, and a naive innerHTML swap would
    // otherwise drop focus after the first character typed.
    const prevSearchEl = document.getElementById('guest-search');
    const hadFocus = document.activeElement === prevSearchEl;
    const caret = hadFocus ? prevSearchEl.selectionStart : null;

    const categories = Array.from(new Set(allGuests.map((g) => g.category).filter(Boolean))).sort();
    const q = state.guestSearch.trim().toLowerCase();
    const guests = allGuests.filter((g) => {
      if (q && !g.full_name.toLowerCase().includes(q)) return false;
      if (state.statusFilter !== 'all' && g.status !== state.statusFilter) return false;
      if (state.categoryFilter !== 'all' && (g.category || '') !== state.categoryFilter) return false;
      return true;
    });

    const counts = { total: allGuests.length, confirmed: 0, unconfirmed: 0, declined: 0, no_response: 0, invited: 0 };
    allGuests.forEach((g) => { if (counts[g.status] !== undefined) counts[g.status]++; });

    body.innerHTML = `
      <div class="c-card">
        <div class="c-toolbar">
          <div class="c-search-row">
            <input class="c-input" id="guest-search" placeholder="Search guests by name…" value="${escapeHtml(state.guestSearch)}" />
          </div>
          <div class="c-filter-row">
            ${STATUS_FILTERS.map(([key, label]) => `<span class="c-chip ${state.statusFilter === key ? 'active' : ''}" data-status-filter="${key}">${label}</span>`).join('')}
          </div>
          ${categories.length ? `<div class="c-filter-row">
            <span class="c-chip ${state.categoryFilter === 'all' ? 'active' : ''}" data-category-filter="all">All categories</span>
            ${categories.map((c) => `<span class="c-chip ${state.categoryFilter === c ? 'active' : ''}" data-category-filter="${escapeHtml(c)}">${escapeHtml(c.replace(/_/g, ' '))}</span>`).join('')}
          </div>` : ''}
          <div class="c-count-row">
            <span><strong>${counts.total}</strong> total</span>
            <span><strong>${counts.confirmed}</strong> confirmed</span>
            <span><strong>${counts.unconfirmed}</strong> unconfirmed</span>
            <span><strong>${counts.declined}</strong> declined</span>
            <span><strong>${counts.no_response}</strong> no response</span>
          </div>
        </div>
        ${guests.length === 0
          ? `<div class="c-empty">${allGuests.length === 0 ? 'No guests yet — add the first one below.' : 'No guests match this search/filter.'}</div>`
          : guests.map((g) => `
          <div class="c-guest-row">
            <div class="c-guest-name-wrap">
              ${g.status === 'confirmed' ? `<span class="c-seal" title="Confirmed">${sealCheck()}</span>` : '<span class="c-seal-empty" title="' + g.status.replace('_', ' ') + '"></span>'}
              <div>
                <div class="c-guest-name">${escapeHtml(g.full_name)} ${g.__pending ? '<span class="c-guest-meta">· saving…</span>' : ''}</div>
                <div class="c-guest-meta">${g.category ? escapeHtml(g.category.replace(/_/g, ' ')) + ' · ' : ''}${g.phone_number ? escapeHtml(g.phone_number) : 'No phone on file'}${g.seat ? ` · Table ${g.seat.table_number ?? '—'}` : ''}</div>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <select data-crsvp="${g.id}" class="c-input" style="width:auto; padding:6px 9px; font-size:0.8rem;">
                ${['invited', 'confirmed', 'unconfirmed', 'declined', 'no_response'].map((s) => `<option value="${s}" ${g.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
              </select>
              <button class="c-btn c-btn-sm" style="background:transparent; color:var(--c-cue); border:1px solid var(--c-border-strong);" data-cdel="${g.id}">Remove</button>
            </div>
          </div>`).join('')}
      </div>`;
    body.querySelectorAll('[data-crsvp]').forEach((el) => el.onchange = () => { store.rsvp(el.dataset.crsvp, el.value); toast('Updated'); });
    body.querySelectorAll('[data-cdel]').forEach((el) => el.onclick = () => { if (confirm('Remove this guest?')) { store.remove(el.dataset.cdel); toast('Removed'); } });
    body.querySelectorAll('[data-status-filter]').forEach((el) => el.onclick = () => { state.statusFilter = el.dataset.statusFilter; drawGuests(); });
    body.querySelectorAll('[data-category-filter]').forEach((el) => el.onclick = () => { state.categoryFilter = el.dataset.categoryFilter; drawGuests(); });
    const searchEl = document.getElementById('guest-search');
    searchEl.oninput = () => { state.guestSearch = searchEl.value; drawGuests(); };
    if (hadFocus) { searchEl.focus(); searchEl.setSelectionRange(caret, caret); }
  }

  function closeCoupleModal() {
    document.querySelectorAll('.c-modal-backdrop').forEach((m) => m.remove());
    document.removeEventListener('keydown', closeCoupleModalOnEscape);
  }
  function closeCoupleModalOnEscape(e) { if (e.key === 'Escape') closeCoupleModal(); }

  function openAddGuest(store) {
    const backdrop = document.createElement('div');
    backdrop.className = 'c-modal-backdrop';
    backdrop.innerHTML = `
      <div class="c-modal">
        <button type="button" class="c-modal-close" aria-label="Close">&times;</button>
        <h2 class="c-h2">Add a guest</h2>
        <form id="c-add-form">
          <div class="c-field"><label class="c-label">Full name</label><input class="c-input" name="full_name" required /></div>
          <div class="c-field"><label class="c-label">Phone (optional)</label><input class="c-input" name="phone_number" placeholder="+254 7XX XXX XXX" /></div>
          <div class="c-field"><label class="c-label">Category (optional)</label><input class="c-input" name="category" placeholder="family / friend / side_bride…" /></div>
          <button class="c-btn" type="submit">Add guest</button>
          <button class="c-btn secondary" type="button" id="c-cancel" style="margin-top:8px;">Cancel</button>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', closeCoupleModalOnEscape);
    backdrop.onclick = (e) => { if (e.target === backdrop) closeCoupleModal(); };
    backdrop.querySelector('.c-modal-close').onclick = () => closeCoupleModal();
    backdrop.querySelector('#c-cancel').onclick = () => closeCoupleModal();
    backdrop.querySelector('#c-add-form').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = { full_name: fd.get('full_name'), phone_number: fd.get('phone_number') || null, category: fd.get('category') || null };
      store.create(payload);
      toast('Guest added');
      closeCoupleModal();
    };
  }

  async function drawSeating() {
    const body = document.getElementById('c-body');
    if (!body) return;
    body.innerHTML = `<p class="c-guest-meta">Loading seating…</p>`;
    let data, venue;
    try {
      [data, venue] = await Promise.all([
        Api.get(`/api/weddings/${state.wedding.id}/seating`),
        Api.get(`/api/weddings/${state.wedding.id}/venue-layout`).catch(() => null),
      ]);
    } catch (e) { body.innerHTML = `<div class="c-card">${escapeHtml(e.message)}</div>`; return; }

    const hasFloorPlan = venue && (venue.markers.length || venue.tables.some((t) => t.pos_x != null));
    const occupancy = {};
    data.assignments.forEach((a) => { if (a.table_id) occupancy[a.table_id] = (occupancy[a.table_id] || 0) + 1; });

    body.innerHTML = `
      ${data.seating_locked ? `<div class="c-card"><strong>Seating is locked.</strong> Ask your planner to unlock it if you need to make changes.</div>` : ''}
      ${hasFloorPlan ? `
      <div class="c-card" style="padding:0; overflow:hidden;">
        <div class="c-floorplan-canvas" style="aspect-ratio:${venue.layout.canvas_width}/${venue.layout.canvas_height}; ${venue.layout.background_image_url ? `background-image:url('${venue.layout.background_image_url}');` : ''}">
          ${venue.markers.map((m) => `<div class="c-fp-landmark" style="left:${m.pos_x}%; top:${m.pos_y}%; width:${m.width}%; height:${m.height}%;"><span>${escapeHtml(m.label)}</span></div>`).join('')}
          ${venue.tables.filter((t) => t.pos_x != null).map((t) => `<div class="c-fp-table ${t.shape === 'rectangle' ? 'rectangle' : 'round'}" style="left:${t.pos_x}%; top:${t.pos_y}%; width:${t.shape === 'rectangle' ? (t.width || 14) : (t.width || 10)}%; height:${t.shape === 'rectangle' ? (t.height || 8) : (t.width || 10)}%;"><span>${t.table_number}</span></div>`).join('')}
        </div>
      </div>
      <p class="c-guest-meta" style="text-align:center; margin:-6px 0 14px;">A view of the venue — see the list below for who's seated where.</p>
      ` : ''}
      ${data.tables.length ? `<div class="c-tables-grid">${data.tables.map((t) => {
        const assigned = data.assignments.filter((a) => a.table_id === t.id);
        return `<div class="c-card c-seat-table">
          <div class="c-card-header"><strong>Table ${t.table_number}${t.reserved_for ? ` <span class="c-pill unconfirmed" style="margin-left:6px;">${escapeHtml(t.reserved_for)}</span>` : ''}</strong><span class="c-guest-meta">${assigned.length}${t.seat_count ? '/' + t.seat_count : ''}</span></div>
          ${assigned.length ? assigned.map((a) => `<div class="c-seat-slot"><span>${a.seat_number ? 'Seat ' + a.seat_number + ' — ' : ''}${escapeHtml(a.guest ? a.guest.full_name : '—')}</span>${a.guest && a.guest.status === 'confirmed' ? `<span class="c-seal" title="Confirmed">${sealCheck()}</span>` : `<span class="c-pill ${a.guest ? pillClass(a.guest.status) : 'muted'}">${a.guest ? a.guest.status.replace('_', ' ') : ''}</span>`}</div>`).join('') : '<p class="c-guest-meta">No one seated here yet.</p>'}
        </div>`;
      }).join('')}</div>` : '<div class="c-empty">Your planner hasn\'t added tables yet.</div>'}
      ${data.unseated.length ? `<div class="c-card"><strong>Not yet seated (${data.unseated.length})</strong><div style="margin-top:8px;">${data.unseated.map((g) => `<div class="c-seat-slot"><span>${escapeHtml(g.full_name)}</span>${g.status === 'confirmed' ? `<span class="c-seal" title="Confirmed">${sealCheck()}</span>` : `<span class="c-pill ${pillClass(g.status)}">${g.status.replace('_', ' ')}</span>`}</div>`).join('')}</div></div>` : ''}
    `;
  }

  boot();
})();
