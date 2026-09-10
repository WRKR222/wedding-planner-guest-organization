// netlify/functions/whatsapp-webhook.js
//
// Register this exact URL as your webhook callback in Meta's App Dashboard
// → WhatsApp → Configuration:
//
//   https://<your-site>.netlify.app/webhooks/whatsapp
//   (netlify.toml redirects that to /.netlify/functions/whatsapp-webhook)
//
// Subscribe to the "messages" webhook field. See README-DEPLOY.md
// "WhatsApp automation" for the full setup walkthrough.
const { admin } = require('../../lib/supabase');
const { pingWedding } = require('../../lib/broadcast');

function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }

// Matches an inbound sender's phone number against a stored guest phone,
// comparing the last 9 digits so formatting differences (+254 vs 0, spaces,
// dashes) don't cause a false miss.
function findGuestByPhone(guests, fromDigits) {
  const tail = fromDigits.slice(-9);
  return (guests || []).find((g) => g.phone_number && digitsOnly(g.phone_number).endsWith(tail));
}

exports.handler = async (event) => {
  // --- Meta's one-time verification handshake, sent as a GET when you
  // first save the webhook URL in the App Dashboard. ---
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'Verification failed — check WHATSAPP_VERIFY_TOKEN matches what you entered in Meta App Dashboard.' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 200, body: 'ignored (bad json)' }; }

  const db = admin();
  const changes = (payload.entry || []).flatMap((e) => e.changes || []);
  const pinged = new Set();

  for (const change of changes) {
    const value = change.value || {};

    // --- Delivery/read/failed receipts for messages we sent (updates the
    // message_log row so the planner's "Invites & messages" log reflects
    // real delivery status, not just "sent"). ---
    for (const status of value.statuses || []) {
      if (!status.id) continue;
      await db.from('message_log').update({ status: status.status }).eq('provider_message_id', status.id);
    }

    // --- Inbound messages from guests. Only "YES"/"NO" (and close
    // variants) are auto-applied to RSVP status, matching what the invite
    // template explicitly asks for ("Reply YES/NO"). Anything else is
    // logged so the planner sees a guest replied, without guessing at
    // free-form text. ---
    for (const msg of value.messages || []) {
      const fromDigits = digitsOnly(msg.from);
      const text = ((msg.text && msg.text.body) || '').trim().toLowerCase();
      if (!fromDigits) continue;

      const { data: guests } = await db.from('guests').select('*').eq('is_deleted', false);
      const guest = findGuestByPhone(guests, fromDigits);
      if (!guest) continue; // message from a number we don't have on any guest list

      let newStatus = null;
      if (/^y(es)?!?$/.test(text)) newStatus = 'confirmed';
      else if (/^n(o)?!?$/.test(text)) newStatus = 'declined';

      if (newStatus) {
        await db.from('guests').update({ status: newStatus }).eq('id', guest.id);
        await db.from('rsvp_status_history').insert({
          guest_id: guest.id, old_status: guest.status, new_status: newStatus, changed_by: 'guest_whatsapp',
        });
        pinged.add(guest.wedding_id);
      } else {
        // Not a recognized RSVP reply — log that the guest said something,
        // for the planner to follow up on manually.
        await db.from('message_log').insert({
          guest_id: guest.id, message_type: 'guest_reply', channel: 'whatsapp', status: 'received', provider_message_id: msg.id || null,
        });
        pinged.add(guest.wedding_id);
      }
    }
  }

  pinged.forEach((weddingId) => pingWedding(weddingId));

  // Meta requires a 200 response quickly, or it will retry/disable the webhook.
  return { statusCode: 200, body: 'ok' };
};
