// lib/assistant.js — a chat assistant that can read and edit one wedding's
// guest list via Claude tool use. Shared by the planner console's and the
// couple companion site's chat widgets: both hit the same
// POST /api/weddings/:id/assistant/chat route (routes/assistant.js),
// scoped to whichever actor lib/access.js's resolveWeddingActor resolves
// (planner or couple session) — the assistant never sees or touches any
// other wedding.
const Anthropic = require('@anthropic-ai/sdk');
const { applyGuestCreate, applyGuestUpdate, applyGuestDelete, applyRsvp } = require('../routes/guests');
const { pingWedding } = require('./broadcast');

const MODEL = 'claude-opus-5';
const MAX_TOOL_ROUNDS = 6;
const STATUSES = ['invited', 'confirmed', 'unconfirmed', 'declined', 'no_response'];

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('The assistant is not set up yet — add ANTHROPIC_API_KEY in Netlify → Site configuration → Environment variables and redeploy.');
  }
  client = new Anthropic({ apiKey: key });
  return client;
}

const TOOLS = [
  {
    name: 'list_guests',
    description: "List guests on this wedding's guest list, optionally filtered by RSVP status, category, and/or a name search. Use this first to see who's on the list, get counts, or find a guest_id before updating/removing a guest or changing their RSVP.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'Only guests with this RSVP status' },
        category: { type: 'string', description: 'Only guests tagged with this category, e.g. family, friend, side_bride, side_groom' },
        search: { type: 'string', description: 'Only guests whose name contains this text (case-insensitive)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_guest',
    description: 'Add a new guest to the guest list.',
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        phone_number: { type: 'string', description: 'Optional' },
        category: { type: 'string', description: 'Optional, e.g. family, friend, side_bride, side_groom' },
      },
      required: ['full_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_guest',
    description: "Update an existing guest's name, phone number, and/or category. Get the guest_id from list_guests first.",
    input_schema: {
      type: 'object',
      properties: {
        guest_id: { type: 'string' },
        full_name: { type: 'string' },
        phone_number: { type: 'string' },
        category: { type: 'string' },
      },
      required: ['guest_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_guest',
    description: 'Remove a guest from the guest list. Get the guest_id from list_guests first. This cannot be undone from the chat, so confirm with the user first if the request is at all ambiguous (e.g. more than one guest matches a name).',
    input_schema: {
      type: 'object',
      properties: { guest_id: { type: 'string' } },
      required: ['guest_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_rsvp_status',
    description: "Change a guest's RSVP status. Get the guest_id from list_guests first.",
    input_schema: {
      type: 'object',
      properties: { guest_id: { type: 'string' }, status: { type: 'string', enum: STATUSES } },
      required: ['guest_id', 'status'],
      additionalProperties: false,
    },
  },
];

async function runTool(db, wedding, actor, name, input) {
  switch (name) {
    case 'list_guests': {
      let q = db.from('guests').select('id, full_name, phone_number, category, status').eq('wedding_id', wedding.id).eq('is_deleted', false);
      if (input.status) q = q.eq('status', input.status);
      if (input.category) q = q.eq('category', input.category);
      if (input.search) q = q.ilike('full_name', `%${input.search}%`);
      const { data, error } = await q.order('full_name');
      if (error) return { error: error.message };
      return { count: (data || []).length, guests: data || [] };
    }
    case 'add_guest': {
      if (!input.full_name || !String(input.full_name).trim()) return { error: 'full_name is required' };
      try {
        const guest = await applyGuestCreate(db, wedding, input);
        pingWedding(wedding.id);
        return { guest };
      } catch (e) { return { error: e.message }; }
    }
    case 'update_guest': {
      if (!input.guest_id) return { error: 'guest_id is required' };
      const guest = await applyGuestUpdate(db, wedding, input.guest_id, input);
      if (!guest) return { error: 'Guest not found' };
      pingWedding(wedding.id);
      return { guest };
    }
    case 'remove_guest': {
      if (!input.guest_id) return { error: 'guest_id is required' };
      const guest = await applyGuestDelete(db, wedding, input.guest_id);
      if (!guest) return { error: 'Guest not found' };
      pingWedding(wedding.id);
      return { removed: true, guest_id: input.guest_id };
    }
    case 'set_rsvp_status': {
      if (!STATUSES.includes(input.status)) return { error: 'Invalid status' };
      const guest = await applyRsvp(db, input.guest_id, input.status, actor);
      if (!guest) return { error: 'Guest not found' };
      pingWedding(wedding.id);
      return { guest };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function systemPrompt(wedding) {
  return `You are the guest-list assistant embedded in Callsheet, a wedding planning app, for ${wedding.couple_names}'s wedding. ` +
    'You can list/search guests, add a guest, update a guest\'s name/phone/category, remove a guest, and change a guest\'s RSVP status — always use the tools for these, never guess or make up guest data. ' +
    'Keep replies short and concrete (a sentence or two, or a brief list) since this is a small chat widget, not a document. ' +
    'When you take an action, say plainly what you did (e.g. "Added Jane Doe as a friend" or "Marked 3 guests as declined"). ' +
    'If a request is ambiguous — e.g. more than one guest matches a name — list the matches and ask which one before acting, rather than guessing. ' +
    'You cannot manage seating, tables, invites/reminders, or wedding settings yet — say so plainly if asked, instead of pretending to do it.';
}

// `history` is the prior turns as sent by the client: [{role, content}] with
// plain-text content only (no tool_use/tool_result blocks persisted across
// requests — each turn resolves its own tool calls server-side before
// replying, which keeps the wire format simple for a v1 chat widget).
async function runAssistant(db, wedding, actor, history, userMessage) {
  const anthropic = getClient();
  const messages = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
    { role: 'user', content: userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(wedding),
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return text || 'Done.';
    }

    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await runTool(db, wedding, actor, tu.name, tu.input || {});
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return "That took more steps than I could finish in one go — try asking again, maybe in smaller pieces.";
}

module.exports = { runAssistant };
