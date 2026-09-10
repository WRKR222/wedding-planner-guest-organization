// lib/sms.js
//
// SMS fallback via Africa's Talking (matches the provider the original
// starter template's functions/reminder-cron.js used). To use a different
// provider (Twilio, Vonage, etc.), only this file needs to change —
// routes/invites.js just calls sendSms({ to, message }).
function configured() {
  return !!(process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME);
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

async function sendSms({ to, message }) {
  if (!configured()) return { ok: false, error: 'SMS is not configured (AFRICASTALKING_API_KEY / AFRICASTALKING_USERNAME missing)' };
  const username = process.env.AFRICASTALKING_USERNAME;
  const apiKey = process.env.AFRICASTALKING_API_KEY;
  const senderId = process.env.AFRICASTALKING_SENDER_ID || '';
  const isSandbox = username === 'sandbox';
  const base = isSandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';

  const params = new URLSearchParams();
  params.set('username', username);
  params.set('to', normalizePhone(to));
  params.set('message', message);
  if (senderId) params.set('from', senderId);

  let res, data;
  try {
    res = await fetch(`${base}/version1/messaging`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', apiKey },
      body: params.toString(),
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, error: `SMS request failed: ${e.message}` };
  }

  const recipient = data.SMSMessageData && data.SMSMessageData.Recipients && data.SMSMessageData.Recipients[0];
  if (!res.ok || !recipient || !/^Success/.test(recipient.status)) {
    return { ok: false, error: (recipient && recipient.status) || `SMS send failed (${res.status})`, raw: data };
  }
  return { ok: true, id: recipient.messageId, raw: data };
}

module.exports = { configured, sendSms, normalizePhone };
