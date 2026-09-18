// routes/checkin.js
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');
const { attachSeats } = require('./guests');

async function applyCheckin(db, wedding, guestId, arrived, actor) {
  const { data: guest, error } = await db.from('guests').update({
    checked_in_at: arrived ? new Date().toISOString() : null,
    checked_in_by: arrived ? actor : null,
  }).eq('id', guestId).eq('wedding_id', wedding.id).eq('is_deleted', false).select().maybeSingle();
  if (error) throw error;
  return guest;
}

function register(router) {
  router.get('/api/weddings/:id/checkin/list', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!ctx.wedding.checkin_enabled) return sendJSON(res, 403, { error: 'Check-In Mode is not enabled for this wedding' });
    const db = admin();
    const { data: guests } = await db.from('guests').select('*').eq('wedding_id', ctx.wedding.id).eq('is_deleted', false).order('full_name');
    sendJSON(res, 200, await attachSeats(db, ctx.wedding.id, guests || []));
  });

  // Single tap, timestamped, queued exactly like a guest-list
  // offline op so it works whether or not the door device is online.
  router.post('/api/weddings/:id/guests/:guestId/checkin', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!ctx.wedding.checkin_enabled) return sendJSON(res, 403, { error: 'Check-In Mode is not enabled for this wedding' });
    try {
      const guest = await applyCheckin(admin(), ctx.wedding, params.guestId, body.arrived !== false, ctx.actor);
      if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
      pingWedding(ctx.wedding.id);
      sendJSON(res, 200, { ...guest, seat: null });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
  });
}

module.exports = { register, applyCheckin };
