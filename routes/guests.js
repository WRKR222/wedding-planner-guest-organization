// routes/guests.js — the one module every wedding uses (PRD §3).
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');

async function attachSeats(db, weddingId, guests) {
  const { data: seats } = await db.from('seat_assignments').select('guest_id, seat_number, table_id, tables(table_number)').eq('wedding_id', weddingId);
  const byGuest = {};
  (seats || []).forEach((s) => { byGuest[s.guest_id] = { table_number: s.tables ? s.tables.table_number : null, seat_number: s.seat_number }; });
  return guests.map((g) => ({ ...g, seat: byGuest[g.id] || null }));
}

async function applyGuestCreate(db, wedding, body) {
  if (body.client_generated_id) {
    const { data: existing } = await db.from('guests').select('*').eq('wedding_id', wedding.id).eq('client_generated_id', body.client_generated_id).maybeSingle();
    if (existing) return existing;
  }
  const { data: guest, error } = await db.from('guests').insert({
    wedding_id: wedding.id,
    full_name: (body.full_name || '').trim(),
    phone_number: body.phone_number ? String(body.phone_number).trim() : null, // nullable
    category: body.category || null,
    is_plus_one: !!body.is_plus_one,
    linked_guest_id: body.linked_guest_id || null,
    import_batch_id: body.import_batch_id || null,
    client_generated_id: body.client_generated_id || null,
  }).select().single();
  if (error) throw error;
  return guest;
}

async function applyGuestUpdate(db, wedding, guestId, body) {
  const patch = {};
  for (const f of ['full_name', 'phone_number', 'category', 'is_plus_one', 'linked_guest_id']) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  const { data: guest, error } = await db.from('guests').update(patch)
    .eq('id', guestId).eq('wedding_id', wedding.id).eq('is_deleted', false).select().maybeSingle();
  if (error) throw error;
  return guest;
}

async function applyGuestDelete(db, wedding, guestId) {
  const { data: guest, error } = await db.from('guests').update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', guestId).eq('wedding_id', wedding.id).select().maybeSingle();
  if (error) throw error;
  if (guest) await db.from('seat_assignments').delete().eq('guest_id', guestId);
  return guest;
}

async function applyRsvp(db, guestId, status, changedBy) {
  const { data: current } = await db.from('guests').select('status').eq('id', guestId).eq('is_deleted', false).maybeSingle();
  if (!current) return null;
  const { data: guest, error } = await db.from('guests').update({ status }).eq('id', guestId).select().single();
  if (error) throw error;
  await db.from('rsvp_status_history').insert({ guest_id: guestId, old_status: current.status, new_status: status, changed_by: changedBy });
  return guest;
}

function register(router) {
  router.get('/api/weddings/:id/guests', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const { data: guests } = await db.from('guests').select('*').eq('wedding_id', ctx.wedding.id).eq('is_deleted', false).order('full_name');
    sendJSON(res, 200, await attachSeats(db, ctx.wedding.id, guests || []));
  });

  // Polling fallback behind the Realtime broadcast (see lib/broadcast.js) —
  // used if a broadcast is ever missed (tab was backgrounded, brief network
  // blip), so the guest list still self-heals within a few seconds.
  router.get('/api/weddings/:id/guests/changes', async (req, res, params, body, query) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const since = query.since || new Date(0).toISOString();
    const { data: changed } = await db.from('guests').select('*').eq('wedding_id', ctx.wedding.id).gt('updated_at', since).order('updated_at');
    sendJSON(res, 200, { server_time: new Date().toISOString(), changed: await attachSeats(db, ctx.wedding.id, changed || []) });
  });

  router.post('/api/weddings/:id/guests', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!body.full_name || !body.full_name.trim()) return sendJSON(res, 400, { error: 'full_name is required' });
    try {
      const guest = await applyGuestCreate(admin(), ctx.wedding, body);
      pingWedding(ctx.wedding.id);
      sendJSON(res, 201, { ...guest, seat: null });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
  });

  router.patch('/api/weddings/:id/guests/:guestId', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const guest = await applyGuestUpdate(admin(), ctx.wedding, params.guestId, body);
    if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { ...guest, seat: null });
  });

  router.del('/api/weddings/:id/guests/:guestId', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const guest = await applyGuestDelete(admin(), ctx.wedding, params.guestId);
    if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { deleted: true });
  });

  // Manual confirm/unconfirm — phone-call confirmations and
  // every confirmation for manual-only weddings.
  router.post('/api/weddings/:id/guests/:guestId/rsvp', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!['confirmed', 'unconfirmed', 'invited', 'declined', 'no_response'].includes(body.status)) {
      return sendJSON(res, 400, { error: 'Invalid status' });
    }
    const changedBy = body.changed_by_call ? (ctx.actor === 'planner' ? 'planner_phone_call' : 'couple_phone_call') : ctx.actor;
    const guest = await applyRsvp(admin(), params.guestId, body.status, changedBy);
    if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { ...guest, seat: null });
  });

  router.get('/api/weddings/:id/guests/:guestId/history', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const { data: history } = await admin().from('rsvp_status_history').select('*').eq('guest_id', params.guestId).order('changed_at', { ascending: false });
    sendJSON(res, 200, history || []);
  });

  // Offline-queue flush (architecture §7). Applies a batch of queued
  // operations idempotently, in order, in one round trip.
  router.post('/api/weddings/:id/guests/sync', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const ops = Array.isArray(body.ops) ? body.ops : [];
    const results = [];
    let anyChange = false;
    for (const op of ops) {
      try {
        if (op.type === 'create') {
          const guest = await applyGuestCreate(db, ctx.wedding, op.payload || {});
          results.push({ client_generated_id: op.payload && op.payload.client_generated_id, ok: true, guest: { ...guest, seat: null } });
          anyChange = true;
        } else if (op.type === 'update') {
          const guest = await applyGuestUpdate(db, ctx.wedding, op.guest_id, op.payload || {});
          results.push({ guest_id: op.guest_id, ok: !!guest, guest: guest ? { ...guest, seat: null } : null });
          anyChange = anyChange || !!guest;
        } else if (op.type === 'delete') {
          const guest = await applyGuestDelete(db, ctx.wedding, op.guest_id);
          results.push({ guest_id: op.guest_id, ok: !!guest });
          anyChange = anyChange || !!guest;
        } else if (op.type === 'rsvp') {
          const changedBy = op.changed_by_call ? (ctx.actor === 'planner' ? 'planner_phone_call' : 'couple_phone_call') : ctx.actor;
          const guest = await applyRsvp(db, op.guest_id, op.status, changedBy);
          results.push({ guest_id: op.guest_id, ok: !!guest, guest: guest ? { ...guest, seat: null } : null });
          anyChange = anyChange || !!guest;
        } else {
          results.push({ ok: false, error: 'Unknown op type' });
        }
      } catch (e) {
        results.push({ ok: false, error: e.message });
      }
    }
    if (anyChange) pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { server_time: new Date().toISOString(), results });
  });
}

module.exports = { register, attachSeats, applyGuestCreate, applyGuestUpdate, applyGuestDelete, applyRsvp };
