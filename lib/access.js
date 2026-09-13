// lib/access.js
const { admin } = require('./supabase');
const { sendJSON } = require('./http');
const { requirePlanner, requireCoupleSession, plannerOwnsWedding } = require('./auth');

// Resolves who is calling (planner or couple-site) and confirms they're
// scoped to THIS wedding only. Returns { wedding, actor, plannerId? }
// or null after already sending an error response.
async function resolveWeddingActor(req, res, weddingId) {
  const { data: wedding } = await admin().from('weddings').select('*').eq('id', weddingId).maybeSingle();
  if (!wedding) { sendJSON(res, 404, { error: 'Wedding not found' }); return null; }

  const planner = await requirePlanner(req);
  if (planner) {
    if (!(await plannerOwnsWedding(planner.id, wedding.id))) {
      sendJSON(res, 404, { error: 'Wedding not found' });
      return null;
    }
    return { wedding, actor: 'planner', plannerId: planner.id };
  }

  const couple = await requireCoupleSession(req);
  if (couple && couple.wedding.id === weddingId) {
    return { wedding, actor: 'couple_site' };
  }

  sendJSON(res, 401, { error: 'Sign in required' });
  return null;
}

module.exports = { resolveWeddingActor };
