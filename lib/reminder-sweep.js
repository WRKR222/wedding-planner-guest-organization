// lib/reminder-sweep.js
const { admin } = require('./supabase');
const { pingWedding } = require('./broadcast');

async function runReminderSweep() {
  const { sendOne } = require('../routes/invites'); // lazy require avoids a circular import at module load
  const db = admin();
  const now = new Date();
  const { data: weddings } = await db.from('weddings').select('*').eq('automation_enabled', true).eq('wedding_status', 'active');
  let sent = 0, checked = 0;
  for (const wedding of weddings || []) {
    if (new Date(wedding.rsvp_cutoff) < now) continue;
    const { data: candidates } = await db.from('guests').select('*').eq('wedding_id', wedding.id).eq('is_deleted', false)
      .in('status', ['invited', 'no_response']).not('invite_sent_at', 'is', null);
    for (const g of candidates || []) {
      checked++;
      if (wedding.max_reminders != null && g.reminder_count >= wedding.max_reminders) continue;
      const lastAction = g.last_reminder_at || g.invite_sent_at;
      const dueAt = new Date(lastAction).getTime() + wedding.reminder_interval_days * 24 * 60 * 60 * 1000;
      if (Date.now() >= dueAt) {
        const r = await sendOne(db, wedding, g, 'reminder');
        if (r.ok) { sent++; pingWedding(wedding.id); }
      }
    }
  }
  return { checked, sent, ran_at: new Date().toISOString() };
}

module.exports = { runReminderSweep };
