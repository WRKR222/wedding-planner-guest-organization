// routes/assistant.js — the guest-list chat assistant. One route serves
// both the planner console's and the couple companion site's chat widgets;
// resolveWeddingActor scopes every call to the caller's own wedding,
// whether they're a planner or a couple session.
const { admin } = require('../lib/supabase');
const { sendJSON } = require('../lib/http');
const { resolveWeddingActor } = require('../lib/access');
const { runAssistant } = require('../lib/assistant');

function register(router) {
  router.post('/api/weddings/:id/assistant/chat', async (req, res, params, body) => {
    const ctx = await resolveWeddingActor(req, res, params.id);
    if (!ctx) return;
    const message = (body.message || '').trim();
    if (!message) return sendJSON(res, 400, { error: 'message is required' });
    // Cap how much prior conversation the client can make us resend to
    // Claude on every turn — recent context is enough for a chat widget.
    const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
    try {
      const reply = await runAssistant(admin(), ctx.wedding, ctx.actor, history, message);
      sendJSON(res, 200, { reply });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
  });
}

module.exports = { register };
