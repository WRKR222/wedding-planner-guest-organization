// routes/invites.js
//
// Real WhatsApp Cloud API + Africa's Talking SMS integration (lib/whatsapp.js,
// lib/sms.js), with a fallback simulator when neither is configured with
// credentials — so the demo keeps working out of the box, and flips to real
// sending automatically the moment you set the environment variables in
// README-DEPLOY.md "WhatsApp automation". Nothing else in this file changes
// between demo and live modes.
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { pingWedding } = require('../lib/broadcast');
const whatsapp = require('../lib/whatsapp');
const sms = require('../lib/sms');

const CONTACT_PHONE = process.env.PLANNER_FALLBACK_PHONE || '+254 700 000 000';
const INVITE_TEMPLATE_NAME = process.env.WHATSAPP_INVITE_TEMPLATE_NAME || 'wedding_invite';
const REMINDER_TEMPLATE_NAME = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || 'wedding_reminder';

function renderTemplate(tpl, vars) {
  return (tpl || '').replace(/{(\w+)}/g, (_, k) => vars[k] ?? '');
}

// Demo fallback only — used when WHATSAPP_TOKEN / AFRICASTALKING_API_KEY
// aren't set, so the app is still fully clickable before you connect real
// providers. Deterministic "failure" on numbers ending in specific digits
// makes the WhatsApp -> SMS -> failed fallback chain actually demonstrable.
function simulateWhatsApp(phone) {
  if (!phone) return { ok: false };
  const last = phone.replace(/\D/g, '').slice(-1);
  return { ok: !['0', '1'].includes(last), id: 'sim-wa-' + Math.random().toString(36).slice(2, 10) };
}
function simulateSms(phone) {
  if (!phone) return { ok: false };
  const last = phone.replace(/\D/g, '').slice(-1);
  return { ok: last !== '1', id: 'sim-sms-' + Math.random().toString(36).slice(2, 10) };
}

async function sendOne(db, wedding, guest, messageType) {
  if (!wedding.automation_enabled) return { skipped: true, reason: 'automation_disabled' };
  if (wedding.wedding_status !== 'active') return { skipped: true, reason: 'wedding_not_active' };
  if (!guest.phone_number) return { skipped: true, reason: 'no_phone_number' };

  const vars = {
    guest_name: guest.full_name, couple_names: wedding.couple_names, date: wedding.event_date,
    venue: wedding.venue || 'the venue', deadline: wedding.rsvp_cutoff, contact_phone: CONTACT_PHONE,
  };

  let channel = 'whatsapp';
  let result;

  if (whatsapp.configured()) {
    // Business-initiated message outside any 24h session window -> must be
    // an approved template. See README-DEPLOY.md for the exact template
    // body text to submit in Meta Business Manager before this will send.
    const templateName = messageType === 'invite' ? INVITE_TEMPLATE_NAME : REMINDER_TEMPLATE_NAME;
    const params = messageType === 'invite'
      ? [vars.guest_name, vars.couple_names, vars.date, vars.venue, vars.deadline, vars.contact_phone]
      : [vars.guest_name, vars.couple_names, vars.date, vars.contact_phone];
    result = await whatsapp.sendTemplateMessage({ to: guest.phone_number, templateName, params });
  } else {
    result = simulateWhatsApp(guest.phone_number);
  }

  if (!result.ok) {
    channel = 'sms';
    const text = renderTemplate(wedding.invite_template, vars) + ` You can also call ${CONTACT_PHONE} to confirm by phone.`;
    result = sms.configured() ? await sms.sendSms({ to: guest.phone_number, message: text }) : simulateSms(guest.phone_number);
  }

  await db.from('message_log').insert({
    guest_id: guest.id, message_type: messageType, channel,
    status: result.ok ? 'sent' : 'failed', provider_message_id: result.id || null,
  });

  const patch = {};
  if (result.ok) {
    patch.invite_channel = channel;
    if (messageType === 'invite') patch.invite_sent_at = new Date().toISOString();
    else { patch.last_reminder_at = new Date().toISOString(); patch.reminder_count = (guest.reminder_count || 0) + 1; }
    await db.from('guests').update(patch).eq('id', guest.id);
  }
  return { skipped: false, ok: result.ok, channel, error: result.error };
}

function register(router) {
  router.get('/api/weddings/:id/invite-template', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    sendJSON(res, 200, {
      invite_template: ctx.wedding.invite_template, contact_phone: CONTACT_PHONE,
      whatsapp_live: whatsapp.configured(), sms_live: sms.configured(),
    });
  });

  router.patch('/api/weddings/:id/invite-template', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (ctx.actor !== 'planner') return sendJSON(res, 403, { error: 'Only the planner can edit the invite template' });
    await admin().from('weddings').update({ invite_template: body.invite_template }).eq('id', ctx.wedding.id);
    sendJSON(res, 200, { invite_template: body.invite_template });
  });

  router.post('/api/weddings/:id/guests/:guestId/invite/send', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const { data: guest } = await db.from('guests').select('*').eq('id', params.guestId).eq('wedding_id', ctx.wedding.id).eq('is_deleted', false).maybeSingle();
    if (!guest) return sendJSON(res, 404, { error: 'Guest not found' });
    const result = await sendOne(db, ctx.wedding, guest, 'invite');
    if (!result.skipped) pingWedding(ctx.wedding.id);
    const { data: fresh } = await db.from('guests').select('*').eq('id', guest.id).single();
    sendJSON(res, 200, { result, guest: { ...fresh, seat: null } });
  });

  router.post('/api/weddings/:id/invites/send-all', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    if (!ctx.wedding.automation_enabled) return sendJSON(res, 403, { error: 'Automated sending is not enabled for this wedding' });
    const db = admin();
    const { data: pending } = await db.from('guests').select('*').eq('wedding_id', ctx.wedding.id).eq('is_deleted', false).is('invite_sent_at', null);
    const results = [];
    for (const g of pending || []) results.push({ guest_id: g.id, name: g.full_name, ...(await sendOne(db, ctx.wedding, g, 'invite')) });
    if (results.some((r) => r.ok)) pingWedding(ctx.wedding.id);
    sendJSON(res, 200, {
      sent: results.filter((r) => r.ok).length, skipped: results.filter((r) => r.skipped).length,
      failed: results.filter((r) => !r.ok && !r.skipped).length, results,
    });
  });

  // Stand-in for reminder-cron.js's scheduled sweep — see netlify/functions/
  // cron-reminders.js for the Netlify Scheduled Function wrapper that calls
  // this same shared logic automatically instead of needing a manual click.
  router.post('/api/cron/reminders', async (req, res) => {
    const { runReminderSweep } = require('../lib/reminder-sweep');
    sendJSON(res, 200, await runReminderSweep());
  });

  // Messaging cost/volume log per wedding.
  router.get('/api/weddings/:id/messages', async (req, res, params) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const db = admin();
    const { data: guests } = await db.from('guests').select('id, full_name').eq('wedding_id', ctx.wedding.id);
    const nameById = {};
    (guests || []).forEach((g) => { nameById[g.id] = g.full_name; });
    const ids = (guests || []).map((g) => g.id);
    if (!ids.length) return sendJSON(res, 200, []);
    const { data: messages } = await db.from('message_log').select('*').in('guest_id', ids).order('sent_at', { ascending: false });
    sendJSON(res, 200, (messages || []).map((m) => ({ ...m, guest_name: nameById[m.guest_id] || 'Unknown' })));
  });
}

module.exports = { register, sendOne };
