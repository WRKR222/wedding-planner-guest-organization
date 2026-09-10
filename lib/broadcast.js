// lib/broadcast.js
//
// After any guest/seating/checkin mutation, ping a Realtime Broadcast
// channel named after the wedding so both the planner dashboard and the
// couple site — wherever they're open, on whatever device — refetch within
// about a second (FR4.1/FR23.1: "feels live"). Broadcast channels don't
// require table replication or RLS policies, just Realtime enabled on the
// project (on by default) — see README-DEPLOY.md for the security note on
// why this is the right tool here instead of postgres_changes.
const { admin } = require('./supabase');

async function pingWedding(weddingId, event = 'changed') {
  try {
    const channel = admin().channel(`wedding:${weddingId}`);
    await channel.send({ type: 'broadcast', event, payload: { at: new Date().toISOString() } });
    admin().removeChannel(channel);
  } catch (e) {
    // Non-fatal — the client's own polling fallback (offline.js) will pick
    // up the change on its next cycle even if a broadcast is missed.
    console.error('broadcast ping failed', e.message);
  }
}

module.exports = { pingWedding };
