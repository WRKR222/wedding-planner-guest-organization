// routes/import.js
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');
const { parseFreeText, parseCSV } = require('../lib/import-parse');

function detectSourceType(filename, mime) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  if (['xlsx', 'xls'].includes(ext)) return 'xlsx';
  if (['docx', 'doc'].includes(ext)) return 'docx';
  if (ext === 'pdf') return 'pdf_text';
  if (['jpg', 'jpeg', 'png', 'heic', 'heif'].includes(ext) || (mime || '').startsWith('image/')) return 'image';
  return 'txt';
}

function markNeedsExternalService(batch, label) {
  batch.status = 'failed';
  batch.parsed_rows = [];
  batch.error_message =
    `Automatic reading of ${label} files needs a document/vision extraction service in production ` +
    `(see architecture doc §8 — open question #9: which OCR/vision provider). This deployment doesn't ` +
    `call out to one yet, so nothing was silently guessed. Paste the names as text instead, or export ` +
    `the list to CSV/TXT and upload that.`;
}

function register(router) {
  router.post('/api/weddings/:id/import/paste', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const text = body.text || '';
    if (!text.trim()) return sendJSON(res, 400, { error: 'Paste some guest names first' });
    const looksLikeCSV = text.split('\n')[0].split(',').length >= 2 && text.includes(',');
    const rows = looksLikeCSV ? parseCSV(text) : parseFreeText(text);
    const { data: batch, error } = await admin().from('guest_import_batches').insert({
      wedding_id: ctx.wedding.id, source_type: looksLikeCSV ? 'csv' : 'txt',
      original_filename: 'Pasted text', status: 'ready_for_review', parsed_rows: rows, uploaded_by: ctx.actor,
    }).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    sendJSON(res, 201, batch);
  });

  router.post('/api/weddings/:id/import/upload', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const { filename, mime, content_base64 } = body;
    if (!filename || !content_base64) return sendJSON(res, 400, { error: 'filename and content_base64 are required' });
    const sourceType = detectSourceType(filename, mime);
    const draft = { wedding_id: ctx.wedding.id, source_type: sourceType, original_filename: filename, status: 'processing', uploaded_by: ctx.actor };

    try {
      if (sourceType === 'csv' || sourceType === 'txt') {
        const text = Buffer.from(content_base64, 'base64').toString('utf8');
        draft.parsed_rows = sourceType === 'csv' ? parseCSV(text) : parseFreeText(text);
        draft.status = 'ready_for_review';
      } else if (sourceType === 'pdf_text') {
        const raw = Buffer.from(content_base64, 'base64').toString('latin1');
        const printable = (raw.match(/[ -~]{4,}/g) || []).join('\n');
        const candidateLines = parseFreeText(printable).filter((r) => /^[A-Za-z][A-Za-z .'\-]{2,40}$/.test(r.name));
        if (candidateLines.length >= 1) {
          draft.parsed_rows = candidateLines.map((r) => ({ ...r, confidence: Math.min(r.confidence, 0.5) }));
          draft.status = 'ready_for_review';
        } else {
          markNeedsExternalService(draft, 'pdf (scanned)');
        }
      } else {
        markNeedsExternalService(draft, sourceType);
      }
    } catch (e) {
      draft.status = 'failed';
      draft.error_message = e.message;
    }

    const { data: batch, error } = await admin().from('guest_import_batches').insert(draft).select().single();
    if (error) return sendJSON(res, 500, { error: error.message });
    sendJSON(res, 201, batch);
  });

  router.get('/api/weddings/:id/import/:batchId', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const { data: batch } = await admin().from('guest_import_batches').select('*').eq('id', params.batchId).eq('wedding_id', ctx.wedding.id).maybeSingle();
    if (!batch) return sendJSON(res, 404, { error: 'Batch not found' });
    sendJSON(res, 200, batch);
  });

  router.get('/api/weddings/:id/import', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const { data: batches } = await admin().from('guest_import_batches').select('*').eq('wedding_id', ctx.wedding.id).order('created_at', { ascending: false });
    sendJSON(res, 200, batches || []);
  });

  // FR1.3/FR1.5: planner-reviewed rows become real guest records, tagged
  // with import_batch_id.
  router.post('/api/weddings/:id/import/:batchId/confirm', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const { data: batch } = await db.from('guest_import_batches').select('*').eq('id', params.batchId).eq('wedding_id', ctx.wedding.id).maybeSingle();
    if (!batch) return sendJSON(res, 404, { error: 'Batch not found' });
    const rows = Array.isArray(body.rows) ? body.rows : (batch.parsed_rows || []);
    const toInsert = rows
      .filter((r) => r.include !== false && r.name && r.name.trim())
      .map((r) => ({
        wedding_id: ctx.wedding.id, full_name: r.name.trim(), phone_number: r.phone ? String(r.phone).trim() : null,
        category: r.category || null, import_batch_id: batch.id,
      }));
    let created = [];
    if (toInsert.length) {
      const { data, error } = await db.from('guests').insert(toInsert).select();
      if (error) return sendJSON(res, 500, { error: error.message });
      created = data || [];
    }
    await db.from('guest_import_batches').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', batch.id);
    if (created.length) pingWedding(ctx.wedding.id);
    sendJSON(res, 200, { created_count: created.length, guests: created.map((g) => ({ ...g, seat: null })) });
  });

  router.post('/api/weddings/:id/import/:batchId/discard', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    await admin().from('guest_import_batches').update({ status: 'discarded' }).eq('id', params.batchId).eq('wedding_id', ctx.wedding.id);
    sendJSON(res, 200, { discarded: true });
  });
}

module.exports = { register };
