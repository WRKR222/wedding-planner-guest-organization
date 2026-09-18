// lib/assistant.js — a chat assistant that can read and edit one wedding's
// data via Claude tool use. Shared by the planner console's and the couple
// companion site's chat widgets: both hit the same
// POST /api/weddings/:id/assistant/chat route (routes/assistant.js),
// scoped to whichever actor lib/access.js's resolveWeddingActor resolves
// (planner or couple session) — the assistant never sees or touches any
// other wedding.
//
// The couple's assistant is intentionally guest-list-only (add/edit/
// remove/RSVP), matching the same lower-trust boundary the rest of the
// couple site already has — a leaked couple passcode should never reach
// planner-level control (module toggles, sending real invites, wedding
// status, seating). The planner's assistant, by contrast, gets the full
// set: it's meant to act as the planner would, across everything the
// planner console itself can do.
const Anthropic = require('@anthropic-ai/sdk');
const { applyGuestCreate, applyGuestUpdate, applyGuestDelete, applyRsvp } = require('../routes/guests');
const { applyWeddingUpdate, applyModulesPatch, applyThemePatch, applyStatusChange, FONT_PAIRINGS, weddingSummary } = require('../routes/weddings');
const { applyCheckin } = require('../routes/checkin');
const { getSeatingOverview, applyCreateTable, applyAssignSeat } = require('../routes/seating');
const { sendOne } = require('../routes/invites');
const { accessCode } = require('./http');
const { pingWedding } = require('./broadcast');

const MODEL = 'claude-opus-5';
const MAX_TOOL_ROUNDS = 8;
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

// ------------------------------------------------------------- guest tools
// Available to both the planner and the couple site.
const GUEST_TOOLS = [
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

// ------------------------------------------------------------ planner tools
// Only ever offered to the planner actor — everything else the planner
// console itself can do: modules, branding, wedding details/status,
// check-in, seating, invites, and the couple-site passcode.
const FONT_PAIRING_KEYS = FONT_PAIRINGS.map((f) => f.key);
const PLANNER_TOOLS = [
  {
    name: 'get_wedding_overview',
    description: "Get this wedding's full current state: couple names, date, venue, RSVP cutoff, status (active/postponed/cancelled), which modules are on, seating settings, and guest/RSVP/seated/checked-in counts. Use this whenever you need current context instead of assuming.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_wedding_details',
    description: "Update the wedding's couple names, event date, venue, and/or RSVP cutoff. Only pass the fields that should change. This never notifies guests.",
    input_schema: {
      type: 'object',
      properties: {
        couple_names: { type: 'string' },
        event_date: { type: 'string', description: 'YYYY-MM-DD' },
        venue: { type: 'string' },
        rsvp_cutoff: { type: 'string', description: 'YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_wedding_status',
    description: "Set the wedding to active, postponed, or cancelled. Postponing/cancelling freezes automated sending and seating edits but keeps all data. This is a significant action — confirm with the planner before postponing or cancelling unless they were explicit about it.",
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'postponed', 'cancelled'] } },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_modules',
    description: 'Turn wedding modules on or off (automated invites/reminders, the couple companion site, seating, check-in), and/or change seating granularity or reminder settings. Only pass the fields that should change. Enabling a module never touches existing data.',
    input_schema: {
      type: 'object',
      properties: {
        automation_enabled: { type: 'boolean', description: 'Automated WhatsApp/SMS invites & reminders' },
        couple_site_enabled: { type: 'boolean', description: 'The couple companion site' },
        seating_enabled: { type: 'boolean' },
        checkin_enabled: { type: 'boolean' },
        seat_granularity: { type: 'string', enum: ['table_only', 'seat_only', 'table_and_seat'] },
        reminder_interval_days: { type: 'integer', description: 'Days between automated reminders' },
        max_reminders: { type: ['integer', 'null'], description: 'Cap on reminders per guest; null = unlimited until cutoff' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_branding',
    description: `Set the couple site's primary/accent colors and/or Google Font pairing. Valid font_pairing keys: ${FONT_PAIRING_KEYS.join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        primary: { type: 'string', description: 'Hex color, e.g. #3c4f3e' },
        accent: { type: 'string', description: 'Hex color, e.g. #b8935a' },
        font_pairing: { type: 'string', enum: FONT_PAIRING_KEYS },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'checkin_guest',
    description: "Mark a guest as arrived or not arrived at the event. Requires the Check-In module to be on. Get the guest_id from list_guests first.",
    input_schema: {
      type: 'object',
      properties: { guest_id: { type: 'string' }, arrived: { type: 'boolean', description: 'Defaults to true' } },
      required: ['guest_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_seating_overview',
    description: 'Get every table (with seat counts and reservations), every current seat assignment, and every unseated guest. Requires the Seating module to be on.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_table',
    description: 'Add a new table. Requires the Seating module to be on and seating not locked.',
    input_schema: {
      type: 'object',
      properties: {
        table_number: { type: 'integer', description: 'Optional — defaults to the next available number' },
        seat_count: { type: 'integer' },
        shape: { type: 'string', enum: ['round', 'rectangle'] },
        reserved_for: { type: 'string', description: 'Optional hint, e.g. "Family" or "Bride\'s side" — not enforced' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assign_seat',
    description: "Seat a guest at a table, with or without a specific seat number (some weddings track table only). Get the guest_id from list_guests and the table_id from get_seating_overview first. Requires Seating on and not locked.",
    input_schema: {
      type: 'object',
      properties: {
        guest_id: { type: 'string' },
        table_id: { type: 'string' },
        seat_number: { type: 'integer', description: 'Optional — omit to seat at the table without a specific seat' },
      },
      required: ['guest_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'unassign_seat',
    description: "Remove a guest's seat assignment, moving them back to unseated. Requires Seating on and not locked.",
    input_schema: { type: 'object', properties: { guest_id: { type: 'string' } }, required: ['guest_id'], additionalProperties: false },
  },
  {
    name: 'set_seating_lock',
    description: 'Lock or unlock seating. Locked seating cannot be edited by anyone until unlocked.',
    input_schema: { type: 'object', properties: { locked: { type: 'boolean' } }, required: ['locked'], additionalProperties: false },
  },
  {
    name: 'send_invite',
    description: "Send the invite message to one guest right now (real WhatsApp/SMS if configured, otherwise a demo simulation). Requires automated sending to be on and the wedding active. This sends a real message — confirm with the planner first unless they clearly asked for this exact guest.",
    input_schema: { type: 'object', properties: { guest_id: { type: 'string' } }, required: ['guest_id'], additionalProperties: false },
  },
  {
    name: 'send_all_invites',
    description: "Send the invite message to every guest who hasn't been sent one yet. This can message many people at once — always confirm with the planner before calling this, and tell them how many guests will be messaged if you know (use list_guests first).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_couple_access',
    description: "Get the couple companion site's link and passcode (or null if the module isn't on yet).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rotate_couple_access',
    description: "Generate a new passcode for the couple site, invalidating the old one. The Couple Companion Site module must already be on.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'revoke_couple_access',
    description: "Immediately revoke the couple's access to their companion site (their existing passcode stops working). This is disruptive — confirm with the planner first unless they clearly asked for this.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function runGuestTool(db, wedding, actor, name, input) {
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
      return null; // not a guest tool
  }
}

// `wedding` is mutated in place after any tool that changes the wedding
// row itself, so later tool calls in the same turn (e.g. "turn on
// check-in, then check in John") see the fresh state instead of what was
// loaded at the start of the request.
async function runPlannerTool(db, wedding, name, input) {
  switch (name) {
    case 'get_wedding_overview':
      return await weddingSummary(wedding);
    case 'update_wedding_details': {
      try {
        const updated = await applyWeddingUpdate(db, wedding, input);
        Object.assign(wedding, updated);
        return { wedding: await weddingSummary(updated) };
      } catch (e) { return { error: e.message }; }
    }
    case 'set_wedding_status': {
      try {
        const updated = await applyStatusChange(db, wedding, input.status);
        Object.assign(wedding, updated);
        return { wedding: await weddingSummary(updated) };
      } catch (e) { return { error: e.message }; }
    }
    case 'set_modules': {
      try {
        const updated = await applyModulesPatch(db, wedding, input);
        Object.assign(wedding, updated);
        return { wedding: await weddingSummary(updated) };
      } catch (e) { return { error: e.message }; }
    }
    case 'set_branding': {
      try {
        const updated = await applyThemePatch(db, wedding, input);
        Object.assign(wedding, updated);
        return { theme: updated.theme };
      } catch (e) { return { error: e.message }; }
    }
    case 'checkin_guest': {
      if (!wedding.checkin_enabled) return { error: 'The Check-In module is not enabled for this wedding' };
      if (!input.guest_id) return { error: 'guest_id is required' };
      try {
        const guest = await applyCheckin(db, wedding, input.guest_id, input.arrived !== false, 'planner');
        if (!guest) return { error: 'Guest not found' };
        pingWedding(wedding.id);
        return { guest };
      } catch (e) { return { error: e.message }; }
    }
    case 'get_seating_overview': {
      if (!wedding.seating_enabled) return { error: 'The Seating module is not enabled for this wedding' };
      return await getSeatingOverview(db, wedding);
    }
    case 'create_table': {
      if (!wedding.seating_enabled) return { error: 'The Seating module is not enabled for this wedding' };
      if (wedding.seating_locked) return { error: 'Seating is locked' };
      try {
        const table = await applyCreateTable(db, wedding, input);
        pingWedding(wedding.id);
        return { table };
      } catch (e) { return { error: e.message }; }
    }
    case 'assign_seat': {
      if (!wedding.seating_enabled) return { error: 'The Seating module is not enabled for this wedding' };
      if (wedding.seating_locked) return { error: 'Seating is locked — unlock it to make changes' };
      if (!input.guest_id) return { error: 'guest_id is required' };
      try {
        const result = await applyAssignSeat(db, wedding, 'planner', input);
        pingWedding(wedding.id);
        return result;
      } catch (e) { return { error: e.message }; }
    }
    case 'unassign_seat': {
      if (!wedding.seating_enabled) return { error: 'The Seating module is not enabled for this wedding' };
      if (wedding.seating_locked) return { error: 'Seating is locked' };
      if (!input.guest_id) return { error: 'guest_id is required' };
      await db.from('seat_assignments').delete().eq('guest_id', input.guest_id).eq('wedding_id', wedding.id);
      pingWedding(wedding.id);
      return { removed: true };
    }
    case 'set_seating_lock': {
      if (!wedding.seating_enabled) return { error: 'The Seating module is not enabled for this wedding' };
      const locked = !!input.locked;
      await db.from('weddings').update({ seating_locked: locked }).eq('id', wedding.id);
      wedding.seating_locked = locked;
      pingWedding(wedding.id);
      return { seating_locked: locked };
    }
    case 'send_invite': {
      if (!input.guest_id) return { error: 'guest_id is required' };
      const { data: guest } = await db.from('guests').select('*').eq('id', input.guest_id).eq('wedding_id', wedding.id).eq('is_deleted', false).maybeSingle();
      if (!guest) return { error: 'Guest not found' };
      const result = await sendOne(db, wedding, guest, 'invite');
      if (!result.skipped) pingWedding(wedding.id);
      return result;
    }
    case 'send_all_invites': {
      if (!wedding.automation_enabled) return { error: 'Automated sending is not enabled for this wedding' };
      const { data: pending } = await db.from('guests').select('*').eq('wedding_id', wedding.id).eq('is_deleted', false).is('invite_sent_at', null);
      const results = [];
      for (const g of pending || []) results.push({ guest_id: g.id, name: g.full_name, ...(await sendOne(db, wedding, g, 'invite')) });
      if (results.some((r) => r.ok)) pingWedding(wedding.id);
      return {
        sent: results.filter((r) => r.ok).length, skipped: results.filter((r) => r.skipped).length,
        failed: results.filter((r) => !r.ok && !r.skipped).length,
      };
    }
    case 'get_couple_access': {
      const { data: access } = await db.from('couple_site_access').select('*').eq('wedding_id', wedding.id).maybeSingle();
      if (!access) return { access: null };
      return { access: { slug: wedding.couple_site_slug, access_code: access.access_code, revoked: access.revoked, last_used_at: access.last_used_at } };
    }
    case 'rotate_couple_access': {
      const { data: existing } = await db.from('couple_site_access').select('*').eq('wedding_id', wedding.id).maybeSingle();
      if (!existing) return { error: 'Enable the Couple Companion Site module first' };
      const code = accessCode();
      await db.from('couple_site_access').update({ access_code: code, revoked: false }).eq('wedding_id', wedding.id);
      return { slug: wedding.couple_site_slug, access_code: code, revoked: false };
    }
    case 'revoke_couple_access': {
      await db.from('couple_site_access').update({ revoked: true }).eq('wedding_id', wedding.id);
      return { revoked: true };
    }
    default:
      return null; // not a planner tool
  }
}

function systemPrompt(wedding, actor) {
  if (actor !== 'planner') {
    return `You are the guest-list assistant embedded in Callsheet, a wedding planning app, for ${wedding.couple_names}'s wedding. ` +
      'You can list/search guests, add a guest, update a guest\'s name/phone/category, remove a guest, and change a guest\'s RSVP status — always use the tools for these, never guess or make up guest data. ' +
      'Keep replies short and concrete (a sentence or two, or a brief list) since this is a small chat widget, not a document. ' +
      'When you take an action, say plainly what you did (e.g. "Added Jane Doe as a friend" or "Marked 3 guests as declined"). ' +
      'If a request is ambiguous — e.g. more than one guest matches a name — list the matches and ask which one before acting, rather than guessing. ' +
      'You cannot manage seating, tables, invites/reminders, or wedding settings from here — say so plainly if asked, instead of pretending to do it.';
  }
  return `You are the assistant embedded in Callsheet, a wedding planning app, helping the planner run ${wedding.couple_names}'s wedding. ` +
    'You act with the same authority as the planner themselves — you can manage the guest list (add/edit/remove/RSVP), turn wedding modules on or off, edit wedding details and branding, change the wedding\'s status, check guests in, manage tables and seating assignments, send real invite messages, and manage the couple site\'s passcode. ' +
    'Always use the tools instead of guessing or making up data — call get_wedding_overview first if you need current context (module states, counts, dates) rather than assuming. ' +
    'Keep replies short and concrete (a sentence or two, or a brief list) since this is a small chat widget, not a document; when you take an action, say plainly what you did. ' +
    'Use judgment about what needs confirmation first: routine guest-list edits and questions, go ahead and do them. Anything consequential and hard to undo from chat — sending real invite messages (especially to many guests at once), cancelling or postponing the wedding, revoking the couple\'s site access — confirm with the planner first unless their request already made the specific action and scope clear. ' +
    'If a request is ambiguous (e.g. more than one guest matches a name, or a module the action needs is currently off), say so and ask or offer to turn it on, rather than guessing.';
}

// `history` is the prior turns as sent by the client: [{role, content}] with
// plain-text content only (no tool_use/tool_result blocks persisted across
// requests — each turn resolves its own tool calls server-side before
// replying, which keeps the wire format simple for a v1 chat widget).
async function runAssistant(db, wedding, actor, history, userMessage) {
  const anthropic = getClient();
  const tools = actor === 'planner' ? [...GUEST_TOOLS, ...PLANNER_TOOLS] : GUEST_TOOLS;
  const messages = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
    { role: 'user', content: userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1536,
      system: systemPrompt(wedding, actor),
      tools,
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
      let result = await runGuestTool(db, wedding, actor, tu.name, tu.input || {});
      if (result === null) {
        result = actor === 'planner' ? await runPlannerTool(db, wedding, tu.name, tu.input || {}) : { error: 'That action is not available here.' };
      }
      if (result === null) result = { error: `Unknown tool: ${tu.name}` };
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return "That took more steps than I could finish in one go — try asking again, maybe in smaller pieces.";
}

module.exports = { runAssistant };
