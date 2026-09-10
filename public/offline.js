// public/offline.js
//
// Implements the client half of architecture §7: every guest-list write
// applies to a local cache immediately (optimistic), is queued, and is
// flushed to /guests/sync as a batch the moment the browser is online.
// Reads come from the local cache first (so the UI never blocks on a
// network round trip) and are refreshed by polling /guests/changes, which
// stands in for a live Supabase Realtime subscription (FR4.1/FR23.1 —
// "feels live", not literally a websocket, in this offline sandbox build).

function makeGuestStore(weddingId) {
  const cacheKey = `wrsvp:cache:${weddingId}`;
  const queueKey = `wrsvp:queue:${weddingId}`;
  const sinceKey = `wrsvp:since:${weddingId}`;

  let cache = loadJSON(cacheKey, []);
  let queue = loadJSON(queueKey, []);
  let listeners = [];
  let flushing = false;
  let pollTimer = null;

  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
  }
  function saveCache() { localStorage.setItem(cacheKey, JSON.stringify(cache)); }
  function saveQueue() { localStorage.setItem(queueKey, JSON.stringify(queue)); }

  function notify() { listeners.forEach((fn) => fn(cache.slice(), queue.length)); }
  function onChange(fn) { listeners.push(fn); }

  function upsertLocal(guest) {
    const i = cache.findIndex((g) => g.id === guest.id || (guest.client_generated_id && g.client_generated_id === guest.client_generated_id));
    if (i >= 0) cache[i] = { ...cache[i], ...guest };
    else cache.push(guest);
    saveCache();
  }
  function removeLocal(guestId) {
    cache = cache.filter((g) => g.id !== guestId);
    saveCache();
  }

  function tempId() { return 'local-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  function create(payload) {
    const client_generated_id = tempId();
    const optimistic = {
      id: client_generated_id, client_generated_id, wedding_id: weddingId,
      full_name: payload.full_name, phone_number: payload.phone_number || null,
      category: payload.category || null, is_plus_one: false, status: 'invited',
      seat: null, checked_in_at: null, updated_at: new Date().toISOString(),
      import_batch_id: payload.import_batch_id || null, __pending: true,
    };
    upsertLocal(optimistic);
    queue.push({ type: 'create', payload: { ...payload, client_generated_id } });
    saveQueue();
    notify();
    tryFlush();
    return optimistic;
  }

  function update(guestId, payload) {
    const g = cache.find((x) => x.id === guestId);
    if (g) upsertLocal({ ...g, ...payload, updated_at: new Date().toISOString(), __pending: true });
    queue.push({ type: 'update', guest_id: guestId, payload: { ...payload, client_updated_at: new Date().toISOString() } });
    saveQueue();
    notify();
    tryFlush();
  }

  function remove(guestId) {
    removeLocal(guestId);
    queue.push({ type: 'delete', guest_id: guestId });
    saveQueue();
    notify();
    tryFlush();
  }

  function rsvp(guestId, status, viaCall) {
    const g = cache.find((x) => x.id === guestId);
    if (g) upsertLocal({ ...g, status, updated_at: new Date().toISOString(), __pending: true });
    queue.push({ type: 'rsvp', guest_id: guestId, status, changed_by_call: !!viaCall });
    saveQueue();
    notify();
    tryFlush();
  }

  async function tryFlush() {
    if (flushing || !navigator.onLine || queue.length === 0) return;
    flushing = true;
    const batch = queue.slice();
    try {
      const result = await Api.post(`/api/weddings/${weddingId}/guests/sync`, { ops: batch });
      // reconcile: drop the flushed ops, remap any temp ids to real ones
      queue = queue.slice(batch.length);
      saveQueue();
      (result.results || []).forEach((r) => {
        if (r.ok && r.guest) {
          upsertLocal({ ...r.guest, __pending: false });
          if (r.client_generated_id && r.guest.id !== r.client_generated_id) {
            cache = cache.filter((g) => g.id !== r.client_generated_id || g.client_generated_id !== r.client_generated_id);
          }
        }
      });
      localStorage.setItem(sinceKey, result.server_time);
      notify();
    } catch (e) {
      // still offline or a transient failure — leave the queue intact, try again later
    } finally {
      flushing = false;
    }
  }

  async function refresh() {
    if (!navigator.onLine) return;
    try {
      const guests = await Api.get(`/api/weddings/${weddingId}/guests`);
      // Preserve any not-yet-flushed optimistic rows (still queued locally)
      const pendingLocalIds = new Set(queue.filter((o) => o.type === 'create').map((o) => o.payload.client_generated_id));
      const survivors = cache.filter((g) => g.client_generated_id && pendingLocalIds.has(g.client_generated_id));
      cache = [...guests, ...survivors.filter((s) => !guests.find((g) => g.client_generated_id === s.client_generated_id))];
      saveCache();
      localStorage.setItem(sinceKey, new Date().toISOString());
      notify();
    } catch (e) { /* leave cache as-is */ }
  }

  let realtimeChannel = null;

  // Realtime Broadcast (see lib/broadcast.js server-side, and
  // README-DEPLOY.md "Why Broadcast, not table subscriptions"). Every
  // guest/seating/checkin mutation pings a channel named after the
  // wedding; anyone else with that wedding open — planner or couple,
  // any device — refetches within about a second. Falls back to plain
  // polling if Supabase isn't configured (public/config.js empty) or the
  // socket drops, so the app still works before you've connected Supabase.
  function startRealtime(weddingId) {
    const cfg = window.APP_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || typeof window.supabase === 'undefined') return false;
    try {
      const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      realtimeChannel = client.channel(`wedding:${weddingId}`);
      realtimeChannel.on('broadcast', { event: 'changed' }, () => { tryFlush(); refresh(); }).subscribe();
      return true;
    } catch (e) {
      console.warn('Realtime unavailable, falling back to polling', e);
      return false;
    }
  }

  function startPolling(intervalMs = 4000) {
    stopPolling();
    refresh();
    const live = startRealtime(weddingId);
    // Broadcast is the fast path; this interval is the self-healing
    // fallback in case a broadcast is ever missed (backgrounded tab, brief
    // drop) — slower when Realtime is connected, faster if it isn't.
    pollTimer = setInterval(() => { tryFlush(); if (queue.length === 0) refresh(); }, live ? 15000 : intervalMs);
    window.addEventListener('online', () => { tryFlush(); refresh(); });
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (realtimeChannel) { try { realtimeChannel.unsubscribe(); } catch (e) {} realtimeChannel = null; }
  }

  function list() { return cache.slice().sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')); }
  function queueLength() { return queue.length; }

  return { create, update, remove, rsvp, onChange, startPolling, stopPolling, list, queueLength, refresh, tryFlush };
}

function offlineBannerController(el, pillEl, store) {
  function render() {
    const offline = !navigator.onLine;
    const pending = store.queueLength();
    el.classList.toggle('show', offline || pending > 0);
    if (offline) {
      el.querySelector('.msg').textContent = "You're offline — changes are saved and will sync automatically.";
    } else if (pending > 0) {
      el.querySelector('.msg').textContent = `Syncing ${pending} change${pending === 1 ? '' : 's'}…`;
    }
    if (pillEl) pillEl.textContent = offline ? 'offline · saved locally' : (pending ? `syncing ${pending}…` : 'synced');
  }
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  store.onChange(render);
  render();
  setInterval(render, 2000);
}
