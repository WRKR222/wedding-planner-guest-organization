// reminder-cron.js — Netlify Scheduled Function
// Runs daily. Finds guests due a reminder and re-sends the invite via
// the same WhatsApp -> SMS fallback logic. Matches architecture doc §6.
//
// netlify.toml should include:
//   [[functions]]
//   name = "reminder-cron"
//   schedule = "0 8 * * *"   # daily at 08:00

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async () => {
  const { data: weddings } = await supabase.from('weddings').select('*');
  let remindersSent = 0;

  for (const wedding of weddings || []) {
    if (new Date(wedding.rsvp_cutoff) < new Date()) continue; // FR15: stop after cutoff

    const intervalMs = wedding.reminder_interval_days * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - intervalMs;

    const { data: due } = await supabase
      .from('guests')
      .select('*')
      .eq('wedding_id', wedding.id)
      .in('status', ['invited', 'no_response'])
      .or(
        `last_reminder_at.lt.${new Date(cutoffTime).toISOString()},` +
        `and(last_reminder_at.is.null,invite_sent_at.lt.${new Date(cutoffTime).toISOString()})`
      );

    for (const guest of due || []) {
      // Reuses the same send logic as invite-send.js — in production,
      // factor sendWhatsApp/sendSms into a shared module and import here.
      await fetch(`${process.env.URL}/.netlify/functions/invite-send`, {
        method: 'POST',
        body: JSON.stringify({ guestId: guest.id }),
      });
      await supabase
        .from('guests')
        .update({ last_reminder_at: new Date().toISOString(), status: 'no_response' })
        .eq('id', guest.id);
      remindersSent++;
    }
  }

  return { statusCode: 200, body: JSON.stringify({ remindersSent }) };
};
