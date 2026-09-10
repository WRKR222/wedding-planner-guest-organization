// routes/venue.js
//
// The visual floor-plan layer that sits on top of the Seating module
// (routes/seating.js). A venue_layouts row holds the canvas size and an
// optional uploaded reference image; layout_markers hold non-seatable
// landmarks (Dance Floor, Head Table, Entrance, Stage, Bar) a planner
// places for orientation — matching a real hand-sketched venue diagram:
// numbered tables positioned around a labeled dance floor and entrance.
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');

function requireSeatingEnabled(res, wedding) {
  if (!wedding.seating_enabled) { sendJSON(res, 403, { error: 'The Seating module is not enabled for this wedding' }); return false; }
  return true;
}
function clampPct(v) { return Math.max(0, Math.min(100, Number(v))); }

async function ensureLayout(db, weddingId) {
  const { data: existing } = await db.from('venue_layouts').select('*').eq('wedding_id', weddingId).maybeSingle();
  if (existing) return existing;
  const { data: created } = await db.from('venue_layouts').insert({ wedding_id: weddingId }).select().single();
  return created;
}

function register(router) {
  // Full picture in one call: layout (canvas + background), landmark
  // markers, and tables-with-positions (tables already come back from
  // /seating, but the floor-plan view wants them alongside markers in a
  // single fetch to render one canvas without a waterfall of requests).
  router.get('/api/weddings/:id/venue-layout', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const [layout, { data: markers }, { data: tables }] = await Promise.all([
      ensureLayout(db, ctx.wedding.id),
      db.from('layout_markers').select('*').eq('wedding_id', ctx.wedding.id).order('created_at'),
      db.from('tables').select('*').eq('wedding_id', ctx.wedding.id).order('table_number'),
    ]);
    sendJSON(res, 200, { layout, markers: markers || [], tables: tables || [] });
  });

  router.patch('/api/weddings/:id/venue-layout', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    const db = admin();
    const layout = await ensureLayout(db, ctx.wedding.id);
    const patch = {};
    if (body.canvas_width) patch.canvas_width = Number(body.canvas_width);
    if (body.canvas_height) patch.canvas_height = Number(body.canvas_height);
    patch.updated_at = new Date().toISOString();
    const { data: updated, error } = await db.from('venue_layouts').update(patch).eq('id', layout.id).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, updated);
  });

  // Upload a reference image of the actual venue floor plan (or a photo of
  // a hand-sketched one) — stored in Supabase Storage's public
  // 'venue-layouts' bucket (schema.sql creates it), never inline in
  // Postgres. Body is JSON with base64 content, same pattern as guest-list
  // file import, since there's no multipart parser dependency here.
  router.post('/api/weddings/:id/venue-layout/background', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    const { filename, mime, content_base64 } = body;
    if (!content_base64) return sendJSON(res, 400, { error: 'content_base64 is required' });
    const db = admin();
    const layout = await ensureLayout(db, ctx.wedding.id);

    const ext = (filename || 'layout.jpg').split('.').pop().toLowerCase();
    const path = `${ctx.wedding.id}/${Date.now()}.${ext}`;
    const buffer = Buffer.from(content_base64, 'base64');
    const { error: uploadErr } = await db.storage.from('venue-layouts').upload(path, buffer, {
      contentType: mime || 'image/jpeg', upsert: true,
    });
    if (uploadErr) return sendJSON(res, 500, { error: `Upload failed: ${uploadErr.message}` });
    const { data: pub } = db.storage.from('venue-layouts').getPublicUrl(path);

    const { data: updated, error } = await db.from('venue_layouts')
      .update({ background_image_url: pub.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', layout.id).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, updated);
  });

  router.del('/api/weddings/:id/venue-layout/background', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    const db = admin();
    const layout = await ensureLayout(db, ctx.wedding.id);
    await db.from('venue_layouts').update({ background_image_url: null, updated_at: new Date().toISOString() }).eq('id', layout.id);
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { cleared: true });
  });

  router.post('/api/weddings/:id/layout-markers', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    if (!body.label || !String(body.label).trim()) return sendJSON(res, 400, { error: 'label is required' });
    const validIcons = ['dance_floor', 'head_table', 'entrance', 'stage', 'bar', 'custom'];
    const { data: marker, error } = await admin().from('layout_markers').insert({
      wedding_id: ctx.wedding.id, label: String(body.label).trim(),
      icon: validIcons.includes(body.icon) ? body.icon : 'custom',
      pos_x: clampPct(body.pos_x ?? 50), pos_y: clampPct(body.pos_y ?? 50),
      width: body.width ? Number(body.width) : 14, height: body.height ? Number(body.height) : 8,
    }).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 201, marker);
  });

  router.patch('/api/weddings/:id/layout-markers/:markerId', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    const patch = {};
    if (body.label !== undefined) patch.label = String(body.label).trim();
    if (body.pos_x !== undefined) patch.pos_x = clampPct(body.pos_x);
    if (body.pos_y !== undefined) patch.pos_y = clampPct(body.pos_y);
    if (body.width !== undefined) patch.width = Number(body.width);
    if (body.height !== undefined) patch.height = Number(body.height);
    const { data: marker, error } = await admin().from('layout_markers').update(patch).eq('id', params.markerId).eq('wedding_id', ctx.wedding.id).select().maybeSingle();
    if (error) return sendJSON(res, 500, { error: error.message });
    if (!marker) return sendJSON(res, 404, { error: 'Marker not found' });
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, marker);
  });

  router.del('/api/weddings/:id/layout-markers/:markerId', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!requireSeatingEnabled(res, ctx.wedding)) return;
    await admin().from('layout_markers').delete().eq('id', params.markerId).eq('wedding_id', ctx.wedding.id);
    pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { deleted: true });
  });
}

module.exports = { register };
