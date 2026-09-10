// netlify/functions/cron-reminders.js
//
// Scheduled via netlify.toml ([functions."cron-reminders"] schedule = ...)
// — the production replacement for functions/reminder-cron.js's original
// cron trigger. Runs the same sweep the planner can also trigger manually
// from Invites & messages → "Run reminder sweep" (routes/invites.js).
const { runReminderSweep } = require('../../lib/reminder-sweep');

exports.handler = async () => {
  const result = await runReminderSweep();
  console.log('reminder sweep', result);
  return { statusCode: 200, body: JSON.stringify(result) };
};
