// routes/couple.js
const { admin } = require('../lib/supabase');
const { sendJSON, token } = require('../lib/http');
const { COUPLE_SESSION_TTL_MS } = require('../lib/auth');
const { FONT_PAIRINGS } = require('./weddings');

function register(router) {
  // Public — pre-login branding only. Deliberately returns NO guest data,
  // just enough to paint the passcode screen in the couple's colors.
  router.get('/api/couple/:slug/theme', async (req, res, params) => {
    const { data: wedding } = await admin().from('weddings').select('*').eq('couple_site_slug', params.slug).maybeSingle();
    if (!wedding || !wedding.couple_site_enabled) return sendJSON(res, 404, { error: 'Not found' });
    const pairing = FONT_PAIRINGS.find((f) => f.key === (wedding.theme && wedding.theme.font_pairing)) || FONT_PAIRINGS[0];
    sendJSON(res, 200, {
      couple_names: wedding.couple_names, event_date: wedding.event_date, venue: wedding.venue,
      theme: wedding.theme, font_pairing: pairing, wedding_status: wedding.wedding_status,
    });
  });

  router.post('/api/couple/:slug/login', async (req, res, params, body) => {
    const db = admin();
    const { data: wedding } = await db.from('weddings').select('*').eq('couple_site_slug', params.slug).maybeSingle();
    if (!wedding || !wedding.couple_site_enabled) return sendJSON(res, 404, { error: 'This companion site is not available' });
    const { data: access } = await db.from('couple_site_access').select('*').eq('wedding_id', wedding.id).maybeSingle();
    if (!access || access.revoked) return sendJSON(res, 403, { error: "Access has been revoked. Ask your planner for a new passcode." });
    if ((body.passcode || '').trim().toUpperCase() !== access.access_code) {
      return sendJSON(res, 401, { error: 'Incorrect passcode' });
    }
    await db.from('couple_site_access').update({ last_used_at: new Date().toISOString() }).eq('wedding_id', wedding.id);
    const tok = token();
    await db.from('couple_sessions').insert({ token: tok, wedding_id: wedding.id, expires_at: new Date(Date.now() + COUPLE_SESSION_TTL_MS).toISOString() });
    sendJSON(res, 200, {
      token: tok,
      wedding: {
        id: wedding.id, couple_names: wedding.couple_names, event_date: wedding.event_date, venue: wedding.venue,
        rsvp_cutoff: wedding.rsvp_cutoff, seating_enabled: wedding.seating_enabled, seat_granularity: wedding.seat_granularity,
        seating_locked: wedding.seating_locked, wedding_status: wedding.wedding_status, theme: wedding.theme,
      },
    });
  });
}

module.exports = { register };
