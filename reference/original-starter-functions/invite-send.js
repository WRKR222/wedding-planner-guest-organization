// invite-send.js — Netlify Function
// Sends the confirm-attendance invite to a guest: WhatsApp first, SMS fallback.
// This is a starting scaffold — wire in real credentials via environment
// variables before deploying (never hardcode keys in the repo).
//
// Env vars expected:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   WHATSAPP_PROVIDER_TOKEN, WHATSAPP_PHONE_NUMBER_ID   (Meta Cloud API / BSP)
//   AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  try {
    const { guestId } = JSON.parse(event.body || '{}');
    if (!guestId) return { statusCode: 400, body: 'guestId is required' };

    const { data: guest, error } = await supabase
      .from('guests')
      .select('*, weddings(*)')
      .eq('id', guestId)
      .single();
    if (error || !guest) return { statusCode: 404, body: 'Guest not found' };

    const wedding = guest.weddings;
    const message = renderTemplate(wedding.invite_template, {
      guest_name: guest.full_name,
      couple_names: wedding.couple_names,
      date: wedding.event_date,
      venue: wedding.venue,
      deadline: wedding.rsvp_cutoff,
    });

    let channel = 'whatsapp';
    let sendResult = await sendWhatsApp(guest.phone_number, message);

    if (!sendResult.ok) {
      channel = 'sms';
      sendResult = await sendSms(guest.phone_number,
        `${message} To confirm, please call the couple directly.`);
    }

    await supabase.from('guests').update({
      status: 'invited',
      invite_channel: channel,
      invite_sent_at: new Date().toISOString(),
    }).eq('id', guestId);

    await supabase.from('message_log').insert({
      guest_id: guestId,
      message_type: 'invite',
      channel,
      status: sendResult.ok ? 'sent' : 'failed',
      provider_message_id: sendResult.id || null,
    });

    return { statusCode: 200, body: JSON.stringify({ channel, ok: sendResult.ok }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

function renderTemplate(tpl, vars) {
  return (tpl || '').replace(/{(\w+)}/g, (_, k) => vars[k] ?? '');
}

async function sendWhatsApp(phone, message) {
  // TODO: call Meta Cloud API / BSP (360dialog, Twilio) with an
  // interactive quick-reply template ("✅ Confirm attendance").
  // Return { ok:false } on any non-2xx or "undelivered" webhook status
  // so the caller falls back to SMS, per FR6.
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_PROVIDER_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text', // swap for an approved interactive template in production
          text: { body: message },
        }),
      }
    );
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, id: data.messages?.[0]?.id };
  } catch {
    return { ok: false };
  }
}

async function sendSms(phone, message) {
  try {
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: process.env.AFRICASTALKING_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        username: process.env.AFRICASTALKING_USERNAME,
        to: phone,
        message,
      }),
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, id: data.SMSMessageData?.Recipients?.[0]?.messageId };
  } catch {
    return { ok: false };
  }
}
