// public/assistant.js — a small floating chat widget shared by the planner
// console and the couple companion site. Each page wires it up with its
// own wedding-id accessor and an onReply refresh hook; the widget itself
// only knows how to render bubbles and call POST /api/weddings/:id/assistant/chat
// (auth comes from whichever token Api.setTokenGetter is already using on
// that page, so the assistant is scoped exactly like the rest of the app).
function initAssistant(opts) {
  let history = [];
  let open = false;

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'assist-fab';
  fab.setAttribute('aria-label', 'Open assistant');
  fab.textContent = '💬';
  fab.style.display = 'none';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.className = 'assist-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="assist-header">
      <strong>${opts.title || 'Assistant'}</strong>
      <button type="button" class="assist-close" aria-label="Close">&times;</button>
    </div>
    <div class="assist-messages"></div>
    <form class="assist-form">
      <input type="text" class="assist-input" placeholder="${opts.placeholder || 'Ask me anything…'}" autocomplete="off" />
      <button type="submit" class="assist-send" aria-label="Send">&rarr;</button>
    </form>`;
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('.assist-messages');
  const inputEl = panel.querySelector('.assist-input');

  function addBubble(role, text) {
    const el = document.createElement('div');
    el.className = 'assist-bubble ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function togglePanel(show) {
    open = show !== undefined ? show : !open;
    panel.style.display = open ? 'flex' : 'none';
    if (open) inputEl.focus();
  }

  fab.onclick = () => togglePanel();
  panel.querySelector('.assist-close').onclick = () => togglePanel(false);

  panel.querySelector('.assist-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    addBubble('user', text);
    const pending = addBubble('assistant pending', 'Thinking…');
    try {
      const weddingId = opts.getWeddingId();
      const data = await Api.post(`/api/weddings/${weddingId}/assistant/chat`, { message: text, history });
      pending.remove();
      addBubble('assistant', data.reply);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: data.reply });
      if (history.length > 20) history = history.slice(-20);
      if (opts.onReply) opts.onReply();
    } catch (err) {
      pending.remove();
      // A 401 here means the session the page thinks is valid has expired
      // or been revoked server-side — the fix is signing in again, not a
      // retry, so hand off to the page instead of dead-ending in the chat.
      if (err.status === 401 && opts.onUnauthorized) {
        addBubble('assistant err', "You've been signed out — please sign in again.");
        togglePanel(false);
        opts.onUnauthorized();
        return;
      }
      addBubble('assistant err', err.message || 'Something went wrong.');
    }
  };

  return {
    show() { fab.style.display = 'grid'; },
    hide() { fab.style.display = 'none'; togglePanel(false); },
    open: () => togglePanel(true),
    close: () => togglePanel(false),
  };
}
