// whatsapp-webhook.js — Netlify Function
// Receives inbound webhook events from Meta/BSP when a guest taps the
// "✅ Confirm attendance" quick-reply button. Matches architecture doc §5.
//
// Configure this function's URL as the webhook callback in the Meta
// Business/BSP dashboard, and set WHATSAPP_VERIFY_TOKEN for the
// GET handshake Meta performs when you register the webhook.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  // Meta's webhook verification handshake (one-time, on setup)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (
      params['hub.mode'] === 'subscribe' &&
      params['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN
    ) {
      return { statusCode: 200, body: params['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Verification failed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // Structure varies slightly by BSP — this follows Meta Cloud API's
    // shape. Adjust the path if using Twilio/360dialog/Gupshup.
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return { statusCode: 200, body: 'No message payload — ignored' };

    const fromPhone = normalizePhone(message.from);
    const isConfirmTap =
      message.type === 'button' &&
      /confirm/i.test(message.button?.text || '');

    if (!isConfirmTap) return { statusCode: 200, body: 'Not a confirm tap — ignored' };

    const { data: guest } = await supabase
      .from('guests')
      .select('id, status, phone_number')
      .ilike('phone_number', `%${fromPhone.slice(-9)}`) // last 9 digits, tolerant of +254/0 formats
      .maybeSingle();

    if (!guest) return { statusCode: 200, body: 'No matching guest — ignored' };

    const oldStatus = guest.status;
    await supabase.from('guests').update({ status: 'confirmed' }).eq('id', guest.id);
    await supabase.from('rsvp_status_history').insert({
      guest_id: guest.id,
      old_status: oldStatus,
      new_status: 'confirmed',
      changed_by: 'guest_whatsapp',
    });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

// Kenyan numbers arrive in +254/0/254 formats — normalize to a
// comparable form. Enforce a single canonical format at input time too.
function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '');
}
