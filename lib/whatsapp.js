// lib/whatsapp.js
//
// Real client for Meta's WhatsApp Cloud API. Business-initiated messages
// (an invite or a reminder the guest didn't ask for) are only allowed as
// pre-approved TEMPLATE messages once you're outside the 24-hour "customer
// service window" — which for a wedding invite is always, since it's the
// first message. Free-form text only works replying to a guest who
// messaged you in the last 24 hours. See README-DEPLOY.md "WhatsApp
// automation" for how to create and get the two templates this file sends
// approved in Meta Business Manager before this will work.
const GRAPH_VERSION = 'v20.0';

function configured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function normalizePhone(phone) {
  // Cloud API wants digits only (country code + number), no +, spaces, or dashes.
  return String(phone).replace(/[^\d]/g, '');
}

// params is an ordered array matching the template's {{1}}, {{2}}, ... body
// variables exactly — Meta doesn't accept named placeholders.
async function sendTemplateMessage({ to, templateName, languageCode, params }) {
  if (!configured()) return { ok: false, error: 'WhatsApp is not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)' };
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || process.env.WHATSAPP_TEMPLATE_LANG || 'en_US' },
      components: [{ type: 'body', parameters: (params || []).map((p) => ({ type: 'text', text: String(p) })) }],
    },
  };

  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, error: `WhatsApp request failed: ${e.message}` };
  }

  if (!res.ok) {
    // Common causes: template not approved yet, wrong language code, phone
    // number not on an allowed test list (sandbox mode), or an expired token.
    return { ok: false, error: (data.error && data.error.message) || `WhatsApp send failed (${res.status})`, raw: data };
  }
  const messageId = data.messages && data.messages[0] && data.messages[0].id;
  return { ok: true, id: messageId, raw: data };
}

module.exports = { configured, sendTemplateMessage, normalizePhone };
