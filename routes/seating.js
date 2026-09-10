// routes/seating.js
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');

function requireSeatingEnabled(res, wedding) {
  if (!wedding.seating_enabled) { sendJSON(res, 403, { error: 'The Seating module is not enabled for this wedding' }); return false; }
  return true;
}

function clampPct(v) { return Math.max(0, Math.min(100, Number(v))); }

function register(router) {
  router.get('/api/weddings/:id/seating', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const { wedding } = ctx;
    const [{ data: tables }, { data: assignments }, { data: guests }] = await Promise.all([
      db.from('tables').select('*').eq('wedding_id', wedding.id).order('table_number'),
      db.from('seat_assignments').select('*').eq('wedding_id', wedding.id),
      db.from('guests').select('id, full_name, status').eq('wedding_id', wedding.id).eq('is_deleted', false),
    ]);
    const guestById = {};
    (guests || []).forEach((g) => { guestById[g.id] = g; });
    const seated = (assignments || []).map((a) => ({ ...a, guest: guestById[a.guest_id] || null }));
    const seatedIds = new Set((assignments || []).map((a) => a.guest_id));
    const unseated = (guests || []).filter((g) => !seatedIds.has(g.id));

    sendJSON(res, 200, { seat_granularity: wedding.seat_granularity, seating_locked: wedding.seating_locked, tables: tables || [], assignments: seated, unseated });
  });

  router.post('/api/weddings/:id/tables', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    if (ctx.wedding.seating_locked) return sendJSON(res, 409, { error: 'Seating is locked' });
    const db = admin();
    const { count } = await db.from('tables').select('id', { count: 'exact', head: true }).eq('wedding_id', ctx.wedding.id);
    const insert = {
      wedding_id: ctx.wedding.id, table_number: Number(body.table_number) || (count || 0) + 1, seat_count: body.seat_count ? Number(body.seat_count) : null,
      shape: body.shape === 'rectangle' ? 'rectangle' : 'round',
      reserved_for: body.reserved_for ? String(body.reserved_for).trim() : null,
    };
    // Placed directly on the floor plan (e.g. dropped at a specific canvas
    // position) vs. created from the plain list view, which leaves it
    // unplaced until dragged onto the canvas.
    if (body.pos_x != null && body.pos_y != null) {
      insert.pos_x = clampPct(body.pos_x); insert.pos_y = clampPct(body.pos_y);
      insert.width = body.width ? Number(body.width) : (insert.shape === 'round' ? 10 : 14);
      insert.height = body.height ? Number(body.height) : 8;
    }
    const { data: table, error } = await db.from('tables').insert(insert).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 201, table);
  });

  // Repositioning on the floor plan, resizing, relabeling, reserving, or
  // editing seat count — everything about a table except its guests.
  router.patch('/api/weddings/:id/tables/:tableId', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    if (ctx.wedding.seating_locked) return sendJSON(res, 409, { error: 'Seating is locked' });
    const patch = {};
    if (body.table_number !== undefined) patch.table_number = Number(body.table_number);
    if (body.seat_count !== undefined) patch.seat_count = body.seat_count === null ? null : Number(body.seat_count);
    if (body.shape !== undefined) patch.shape = body.shape === 'rectangle' ? 'rectangle' : 'round';
    if (body.reserved_for !== undefined) patch.reserved_for = body.reserved_for ? String(body.reserved_for).trim() : null;
    if (body.pos_x !== undefined) patch.pos_x = body.pos_x === null ? null : clampPct(body.pos_x);
    if (body.pos_y !== undefined) patch.pos_y = body.pos_y === null ? null : clampPct(body.pos_y);
    if (body.width !== undefined) patch.width = body.width === null ? null : Number(body.width);
    if (body.height !== undefined) patch.height = body.height === null ? null : Number(body.height);
    const { data: table, error } = await admin().from('tables').update(patch).eq('id', params.tableId).eq('wedding_id', ctx.wedding.id).select().maybeSingle();
    if (error) return sendJSON(res, 500, { error: error.message });
    if (!table) return sendJSON(res, 404, { error: 'Table not found' });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, table);
  });

  router.del('/api/weddings/:id/tables/:tableId', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    if (ctx.wedding.seating_locked) return sendJSON(res, 409, { error: 'Seating is locked' });
    const db = admin();
    await db.from('seat_assignments').delete().eq('table_id', params.tableId);
    await db.from('tables').delete().eq('id', params.tableId).eq('wedding_id', ctx.wedding.id);
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { deleted: true });
  });

  // FR20: any guest, confirmed or not, can be placed. FR21: shape driven by
  // seat_granularity. FR22: editable up to lock.
  router.post('/api/weddings/:id/seating/assign', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const { wedding, actor } = ctx;
    if (!requireSeatingEnabled(res, wedding)) return;
    if (wedding.seating_locked) return sendJSON(res, 409, { error: 'Seating is locked — unlock it to make changes' });
    const db = admin();
    const { data: guest } = await db.from('guests').select('id, category').eq('id', body.guest_id).eq('wedding_id', wedding.id).eq('is_deleted', false).maybeSingle();
    if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
    let warning = null;
    if (wedding.seat_granularity !== 'seat_only' && body.table_id) {
      const { data: table } = await db.from('tables').select('id, table_number, reserved_for').eq('id', body.table_id).eq('wedding_id', wedding.id).maybeSingle();
      if (!table) return sendJSON(res, 404, { error: 'Table not found' });
      // A reserved table is a hint, not a hard rule (FR20 still applies —
      // any guest can go anywhere) — but the planner should know they're
      // about to seat someone outside the group a table was set aside for.
      if (table.reserved_for && guest.category && table.reserved_for.toLowerCase() !== String(guest.category).toLowerCase()) {
        warning = `Table ${table.table_number} is reserved for "${table.reserved_for}" — this guest is tagged "${guest.category}".`;
      }
    }
    const patch = { assigned_by: actor, assigned_at: new Date().toISOString() };
    if (wedding.seat_granularity !== 'seat_only') patch.table_id = body.table_id || null; else patch.table_id = null;
    if (wedding.seat_granularity !== 'table_only') patch.seat_number = body.seat_number != null ? Number(body.seat_number) : null; else patch.seat_number = null;

    const { data: assignment, error } = await db.from('seat_assignments')
      .upsert({ wedding_id: wedding.id, guest_id: guest.id, ...patch }, { onConflict: 'guest_id' })
      .select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    pingWedding(wedding.id);
    sendJSON(res, 200, { ...assignment, warning });
  });

  router.del('/api/weddings/:id/seating/:guestId', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    if (ctx.wedding.seating_locked) return sendJSON(res, 409, { error: 'Seating is locked' });
    await admin().from('seat_assignments').delete().eq('guest_id', params.guestId).eq('wedding_id', ctx.wedding.id);
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { removed: true });
  });

  // FR23.2 — lock/unlock. No ticket generation happens here (out of scope, per PRD).
  router.post('/api/weddings/:id/seating/lock', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    const locked = body.locked !== false;
    await admin().from('weddings').update({ seating_locked: locked }).eq('id', ctx.wedding.id);
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { seating_locked: locked });
  });
}

module.exports = { register };
