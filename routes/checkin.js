// routes/checkin.js
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');
const { attachSeats } = require('./guests');

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
    const arrived = body.arrived !== false;
    const db = admin();
    const { data: guest, error } = await db.from('guests').update({
      checked_in_at: arrived ? new Date().toISOString() : null,
      checked_in_by: arrived ? ctx.actor : null,
    }).eq('id', params.guestId).eq('wedding_id', ctx.wedding.id).eq('is_deleted', false).select().maybeSingle();
    if (error) return sendJSON(res, 500, { error: error.message });
    if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { ...guest, seat: null });
  });
}

module.exports = { register };
