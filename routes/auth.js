// routes/auth.js
const { admin, anon } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');

function register(router) {
  router.post('/api/auth/signup', async (req, res, params, body) => {
    const email = (body.email || '').trim().toLowerCase();
    const name = (body.name || '').trim() || email.split('@')[0];
    if (!email || !body.password || body.password.length < 6) {
      return sendJSON(res, 400, { error: 'Email and a password (6+ chars) are required' });
    }
    // Created via the admin API with email_confirm:true so a fresh planner
    // can sign in immediately — this app owns onboarding, not Supabase's
    // default email-confirmation flow. (Point Supabase's SMTP settings at a
    // real provider and switch this to auth.signUp + email confirmation
    // if you want that flow instead.)
    const { data: created, error: createErr } = await admin().auth.admin.createUser({
      email, password: body.password, email_confirm: true,
    });
    if (createErr) return sendJSON(res, 409, { error: createErr.message });

    const { count } = await admin().from('planner_profiles').select('id', { count: 'exact', head: true });
    const isFirstPlanner = (count || 0) === 0;
    await admin().from('planner_profiles').insert({
      id: created.user.id, email, name, is_admin: isFirstPlanner, // first account on the project becomes the demo super-admin (FR37)
    });

    const { data: signIn, error: signInErr } = await anon().auth.signInWithPassword({ email, password: body.password });
    if (signInErr) return sendJSON(res, 500, { error: signInErr.message });
    sendJSON(res, 201, {
      token: signIn.session.access_token,
      planner: { id: created.user.id, email, name, is_admin: isFirstPlanner },
    });
  });

  router.post('/api/auth/login', async (req, res, params, body) => {
    const email = (body.email || '').trim().toLowerCase();
    const { data, error } = await anon().auth.signInWithPassword({ email, password: body.password || '' });
    if (error || !data.session) return sendJSON(res, 401, { error: 'Invalid email or password' });
    const { data: profile } = await admin().from('planner_profiles').select('*').eq('id', data.user.id).maybeSingle();
    if (!profile) return sendJSON(res, 401, { error: 'No planner profile for this account' });
    sendJSON(res, 200, {
      token: data.session.access_token,
      planner: { id: profile.id, email: profile.email, name: profile.name, is_admin: profile.is_admin },
    });
  });
}

module.exports = { register };
