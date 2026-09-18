// routes/weddings.js
const { admin } = require('../lib/supabase');
const { sendJSON, accessCode, slugify } = require('../lib/http');
const { requirePlanner, plannerOwnsWedding } = require('../lib/auth');

const FONT_PAIRINGS = [
  { key: 'alexbrush_plusjakarta', label: 'Alex Brush + Plus Jakarta Sans', heading: "'Alex Brush', cursive", body: "'Plus Jakarta Sans', sans-serif" },
  { key: 'playfair_lato', label: 'Playfair Display + Lato', heading: "'Playfair Display', serif", body: "'Lato', sans-serif" },
  { key: 'cormorant_karla', label: 'Cormorant Garamond + Karla', heading: "'Cormorant Garamond', serif", body: "'Karla', sans-serif" },
  { key: 'italiana_montserrat', label: 'Italiana + Montserrat', heading: "'Italiana', serif", body: "'Montserrat', sans-serif" },
  { key: 'marcellus_jost', label: 'Marcellus + Jost', heading: "'Marcellus', serif", body: "'Jost', sans-serif" },
  { key: 'ebgaramond_worksans', label: 'EB Garamond + Work Sans', heading: "'EB Garamond', serif", body: "'Work Sans', sans-serif" },
]; // Curated Google Fonts only, never free-text font entry. First entry is the default pairing.

async function weddingSummary(w) {
  const db = admin();
  const { data: guests } = await db.from('guests').select('id,status').eq('wedding_id', w.id).eq('is_deleted', false);
  const g = guests || [];
  const { count: seatedCount } = await db.from('seat_assignments').select('id', { count: 'exact', head: true }).eq('wedding_id', w.id);
  return {
    ...w,
    guest_count: g.length,
    confirmed_count: g.filter((x) => x.status === 'confirmed').length,
    seated_count: seatedCount || 0,
    checked_in_count: g.filter((x) => x.checked_in_at).length,
  };
}

async function requireAuthed(req, res) {
  const planner = await requirePlanner(req);
  if (!planner) { sendJSON(res, 401, { error: 'Sign in required' }); return null; }
  return planner;
}

async function requireWeddingAccess(req, res, params) {
  const planner = await requireAuthed(req, res);
  if (!planner) return null;
  const { data: wedding } = await admin().from('weddings').select('*').eq('id', params.id).maybeSingle();
  if (!wedding || !(await plannerOwnsWedding(planner.id, wedding.id))) {
    sendJSON(res, 404, { error: 'Wedding not found' });
    return null;
  }
  return { planner, wedding };
}

async function applyWeddingUpdate(db, wedding, body) {
  const patch = {};
  for (const field of ['couple_names', 'event_date', 'venue', 'rsvp_cutoff']) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  const { data, error } = await db.from('weddings').update(patch).eq('id', wedding.id).select().single();
  if (error) throw error;
  return data;
}

async function applyModulesPatch(db, wedding, body) {
  const patch = {};
  for (const f of ['automation_enabled', 'couple_site_enabled', 'seating_enabled', 'checkin_enabled']) {
    if (body[f] !== undefined) patch[f] = !!body[f];
  }
  if (body.seat_granularity && ['table_only', 'seat_only', 'table_and_seat'].includes(body.seat_granularity)) {
    patch.seat_granularity = body.seat_granularity;
  }
  if (body.reminder_interval_days !== undefined) patch.reminder_interval_days = Number(body.reminder_interval_days) || 21;
  if (body.max_reminders !== undefined) patch.max_reminders = body.max_reminders === null || body.max_reminders === '' ? null : Number(body.max_reminders);

  let updatedWedding = { ...wedding, ...patch };

  // First time the couple site is turned on, provision access —
  // reuse the existing code if it already exists.
  if (patch.couple_site_enabled) {
    const { data: existing } = await db.from('couple_site_access').select('*').eq('wedding_id', wedding.id).maybeSingle();
    if (!existing) {
      if (!updatedWedding.couple_site_slug) {
        const base = slugify(updatedWedding.couple_names) || 'wedding';
        patch.couple_site_slug = `${base}-${wedding.id.slice(0, 6)}`;
      }
      await db.from('couple_site_access').insert({ wedding_id: wedding.id, access_code: accessCode() });
    } else if (existing.revoked) {
      await db.from('couple_site_access').update({ revoked: false }).eq('wedding_id', wedding.id);
    }
  }

  const { data, error } = await db.from('weddings').update(patch).eq('id', wedding.id).select().single();
  if (error) throw error;
  return data;
}

async function applyThemePatch(db, wedding, body) {
  const pairingKeys = FONT_PAIRINGS.map((f) => f.key);
  const currentTheme = wedding.theme || {};
  const font_pairing = pairingKeys.includes(body.font_pairing) ? body.font_pairing : currentTheme.font_pairing || 'alexbrush_plusjakarta';
  const hex = /^#[0-9a-fA-F]{6}$/;
  const theme = {
    primary: hex.test(body.primary) ? body.primary : currentTheme.primary || '#3c4f3e',
    accent: hex.test(body.accent) ? body.accent : currentTheme.accent || '#b8935a',
    font_pairing,
  };
  const { data, error } = await db.from('weddings').update({ theme }).eq('id', wedding.id).select().single();
  if (error) throw error;
  return data;
}

async function applyStatusChange(db, wedding, status) {
  if (!['active', 'postponed', 'cancelled'].includes(status)) throw new Error('wedding_status must be active, postponed, or cancelled');
  const { data, error } = await db.from('weddings').update({ wedding_status: status }).eq('id', wedding.id).select().single();
  if (error) throw error;
  return data;
}

function register(router) {
  router.get('/api/font-pairings', (req, res) => sendJSON(res, 200, FONT_PAIRINGS));

  router.get('/api/weddings', async (req, res) => {
    const planner = await requireAuthed(req, res);
    if (!planner) return;
    const { data: memberships } = await admin().from('wedding_members').select('wedding_id').eq('user_id', planner.id);
    const ids = (memberships || []).map((m) => m.wedding_id);
    if (!ids.length) return sendJSON(res, 200, []);
    const { data: weddings } = await admin().from('weddings').select('*').in('id', ids).order('event_date');
    const withSummary = await Promise.all((weddings || []).map(weddingSummary));
    sendJSON(res, 200, withSummary);
  });

  // Cross-wedding, cross-planner oversight — support & billing visibility
  // for the system owner, not something a regular planner's own dashboard
  // shows (that's just their weddings, via GET /api/weddings above). Served
  // from a separate admin.html surface, never linked from the planner nav.
  router.get('/api/admin/weddings', async (req, res) => {
    const planner = await requireAuthed(req, res);
    if (!planner) return;
    if (!planner.is_admin) return sendJSON(res, 403, { error: 'Admin access only' });
    const db = admin();
    const { data: weddings } = await db.from('weddings').select('*').order('event_date');
    const rows = await Promise.all((weddings || []).map(async (w) => {
      const { data: member } = await db.from('wedding_members').select('user_id').eq('wedding_id', w.id).maybeSingle();
      let ownerEmail = 'unknown';
      if (member) {
        const { data: profile } = await db.from('planner_profiles').select('email').eq('id', member.user_id).maybeSingle();
        if (profile) ownerEmail = profile.email;
      }
      const { data: guests } = await db.from('guests').select('id').eq('wedding_id', w.id);
      const guestIds = (guests || []).map((g) => g.id);
      let messageCount = 0;
      if (guestIds.length) {
        const { count } = await db.from('message_log').select('id', { count: 'exact', head: true }).in('guest_id', guestIds);
        messageCount = count || 0;
      }
      const summary = await weddingSummary(w);
      return { ...summary, planner_email: ownerEmail, message_count: messageCount };
    }));
    sendJSON(res, 200, rows);
  });

  // Create a wedding. Guest List module is always-on (not a flag). Only
  // couple_names and event_date are required up front — a couple often
  // doesn't know their RSVP cutoff yet, so it defaults to the event date
  // itself as a placeholder the planner can tighten up later from Settings.
  router.post('/api/weddings', async (req, res, params, body) => {
    const planner = await requireAuthed(req, res);
    if (!planner) return;
    if (!body.couple_names || !body.event_date) {
      return sendJSON(res, 400, { error: 'couple_names and event_date are required' });
    }
    const db = admin();
    const { data: wedding, error } = await db.from('weddings').insert({
      couple_names: body.couple_names, event_date: body.event_date,
      venue: body.venue || null, rsvp_cutoff: body.rsvp_cutoff || body.event_date,
    }).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    await db.from('wedding_members').insert({ wedding_id: wedding.id, user_id: planner.id, role: 'owner' });
    sendJSON(res, 201, await weddingSummary(wedding));
  });

  router.get('/api/weddings/:id', async (req, res, params) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    sendJSON(res, 200, await weddingSummary(ctx.wedding));
  });

  // Event detail edits never auto-notify guests
  router.patch('/api/weddings/:id', async (req, res, params, body) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    try {
      const wedding = await applyWeddingUpdate(admin(), ctx.wedding, body);
      sendJSON(res, 200, await weddingSummary(wedding));
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
  });

  // Module toggles. Enabling a module never touches existing data.
  router.patch('/api/weddings/:id/modules', async (req, res, params, body) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    try {
      const wedding = await applyModulesPatch(admin(), ctx.wedding, body);
      sendJSON(res, 200, await weddingSummary(wedding));
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
  });

  // Bespoke branding: curated colors + a Google Font pairing only
  router.patch('/api/weddings/:id/theme', async (req, res, params, body) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    try {
      const wedding = await applyThemePatch(admin(), ctx.wedding, body);
      sendJSON(res, 200, await weddingSummary(wedding));
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
  });

  // Postpone/cancel/reactivate. Freezes automation + seating writes; keeps history.
  router.patch('/api/weddings/:id/status', async (req, res, params, body) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    try {
      const wedding = await applyStatusChange(admin(), ctx.wedding, body.wedding_status);
      sendJSON(res, 200, await weddingSummary(wedding));
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
  });

  // Couple-site credential management — planner-only.
  router.get('/api/weddings/:id/couple-access', async (req, res, params) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    const { data: access } = await admin().from('couple_site_access').select('*').eq('wedding_id', ctx.wedding.id).maybeSingle();
    sendJSON(res, 200, access ? {
      slug: ctx.wedding.couple_site_slug, access_code: access.access_code,
      revoked: access.revoked, last_used_at: access.last_used_at,
    } : null);
  });

  router.post('/api/weddings/:id/couple-access/rotate', async (req, res, params) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    const db = admin();
    const { data: existing } = await db.from('couple_site_access').select('*').eq('wedding_id', ctx.wedding.id).maybeSingle();
    if (!existing) return sendJSON(res, 400, { error: 'Enable the Couple Companion Site module first' });
    const code = accessCode();
    await db.from('couple_site_access').update({ access_code: code, revoked: false }).eq('wedding_id', ctx.wedding.id);
    sendJSON(res, 200, { slug: ctx.wedding.couple_site_slug, access_code: code, revoked: false });
  });

  router.post('/api/weddings/:id/couple-access/revoke', async (req, res, params) => {
    const ctx = await requireWeddingAccess(req, res, params);
    if (!ctx) return;
    await admin().from('couple_site_access').update({ revoked: true }).eq('wedding_id', ctx.wedding.id);
    sendJSON(res, 200, { revoked: true });
  });
}

module.exports = {
  register, weddingSummary, requireWeddingAccess, FONT_PAIRINGS,
  applyWeddingUpdate, applyModulesPatch, applyThemePatch, applyStatusChange,
};
