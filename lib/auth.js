// lib/auth.js
const { admin, anon } = require('./supabase');

const COUPLE_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function getBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : null;
}

// Verifies a planner's Supabase Auth JWT and loads their profile row
// (display name, is_admin — fields auth.users doesn't carry).
async function requirePlanner(req) {
  const tok = getBearer(req);
  if (!tok) return null;
  const { data, error } = await anon().auth.getUser(tok);
  if (error || !data || !data.user) return null;
  const { data: profile } = await admin().from('planner_profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile) return null;
  return { id: data.user.id, email: profile.email, name: profile.name, is_admin: profile.is_admin };
}

async function plannerOwnsWedding(plannerId, weddingId) {
  const { data } = await admin().from('wedding_members').select('id').eq('wedding_id', weddingId).eq('user_id', plannerId).maybeSingle();
  return !!data;
}

// Couple-site session — a deliberately separate, lower-trust credential.
// Resolves to exactly one wedding_id and can never be escalated to planner
// access or any other wedding's data.
async function requireCoupleSession(req) {
  const tok = getBearer(req);
  if (!tok) return null;
  const { data: session } = await admin().from('couple_sessions').select('*').eq('token', tok).maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const { data: wedding } = await admin().from('weddings').select('*').eq('id', session.wedding_id).maybeSingle();
  if (!wedding || !wedding.couple_site_enabled) return null; // disabling revokes access
  const { data: access } = await admin().from('couple_site_access').select('*').eq('wedding_id', wedding.id).maybeSingle();
  if (!access || access.revoked) return null; // revoking kills access immediately
  return { wedding, session };
}

module.exports = { requirePlanner, requireCoupleSession, plannerOwnsWedding, getBearer, COUPLE_SESSION_TTL_MS };
