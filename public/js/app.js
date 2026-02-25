/* =========================================================
   GPTNeo – Main App
   Pure vanilla JS · no frameworks
   ========================================================= */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  conversations: [],     // list from API
  currentConvId: null,   // active conversation id
  streaming: false,      // is AI currently typing?
  settings: {},          // loaded from /api/settings
  models: {},            // loaded from /api/settings/models
  abortController: null, // for cancelling stream
  deferredInstall: null, // PWA install prompt
  user: null,
  activeMode: 'normal',  // 'normal' | 'thinking' | 'deep_research'
  attachments: [],       // pending file attachments
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const convList       = $('conv-list');
const messagesEl     = $('messages');
const welcomeEl      = $('welcome');
const typingEl       = $('typing-indicator');
const msgInput       = $('msg-input');
const btnSend        = $('btn-send');
const btnStop        = $('btn-stop');
const btnStt         = $('btn-stt');
const btnNewChat     = $('btn-new-chat');
const btnNewChatMob  = $('btn-new-chat-mobile');
const btnSettings    = $('btn-settings');
const btnMemory      = $('btn-memory'); // may be null (removed from sidebar)
const btnLogout      = $('btn-logout');
const btnInstall     = $('btn-install');
const btnAttach      = $('btn-attach');
const fileInput      = $('file-input');
const attachPreview  = $('attachment-preview');
const modelBadge     = $('model-badge');
const chatTitleText  = $('chat-title-text');
const mobileTitle    = $('mobile-title');
const chatHeader     = $('chat-header');
const sidebar        = $('sidebar');
const sidebarBackdrop= $('sidebar-backdrop');
const searchInput    = $('search-input');
const toastEl        = $('toast');

// ─── Markdown renderer ────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderMarkdown(text) {
  if (!text) return '';

  // Extract code blocks first (protect from inline processing)
  // If streaming, close any incomplete code fence so partial blocks render as code
  const fenceCount = (text.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) text += '\n```';

  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code });
    return `\x00CODE${idx}\x00`;
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // Headings
  text = text.replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>');
  text = text.replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>');
  text = text.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold + italic + strikethrough + underline + highlight
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/==(.+?)==/g, '<mark>$1</mark>');
  text = text.replace(/__(.+?)__/g, '<u>$1</u>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');

  // Images (must come before general links to avoid conflict)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const escapedSrc = src; // data URLs pass through, external src allowed
    return `<img class="md-img" src="${escapedSrc}" alt="${escapeHtml(alt)}" loading="lazy">`;
  });

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Horizontal rule
  text = text.replace(/^---+$/gm, '<hr>');

  // Blockquotes
  text = text.replace(/^(>+)\s(.+)$/gm, (_, level, content) => {
    return `<blockquote>${content}</blockquote>`;
  });

  // Tables
  text = text.replace(/((?:^[|].+[|]\n)+)/gm, (tableText) => {
    const rows = tableText.trim().split('\n');
    if (rows.length < 2) return tableText;
    let html = '<table>';
    rows.forEach((row, i) => {
      if (/^[|:\- ]+$/.test(row)) return; // separator row
      const cells = row.split('|').filter((_, j, a) => j > 0 && j < a.length - 1);
      const tag = i === 0 ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    html += '</table>';
    return html;
  });

  // Unordered lists
  text = text.replace(/((?:^[ \t]*[-*+]\s.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*+]\s/, '').trim()}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  text = text.replace(/((?:^[ \t]*\d+\.\s.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\.\s/, '').trim()}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Paragraphs: wrap non-HTML lines in <p>
  const lines = text.split('\n');
  const paragraphed = [];
  let inP = false;
  const blockTags = /^<(h[1-6]|ul|ol|li|table|tr|th|td|hr|blockquote|pre|div)/;

  for (const line of lines) {
    const isBlock = blockTags.test(line.trim()) || line.trim() === '';
    if (isBlock) {
      if (inP) { paragraphed.push('</p>'); inP = false; }
      paragraphed.push(line);
    } else {
      if (!inP) { paragraphed.push('<p>'); inP = true; }
      paragraphed.push(line);
    }
  }
  if (inP) paragraphed.push('</p>');
  text = paragraphed.join('\n');

  // Restore code blocks
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
    const { lang, code } = codeBlocks[parseInt(idx)];
    const escaped = escapeHtml(code);
    const langLabel = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : '<div class="code-lang">code</div>';
    const dataLang  = escapeHtml(lang || 'text');
    const isRunnable = ['python', 'py'].includes(lang.toLowerCase());
    const runBtn = isRunnable ? `<button class="run-btn" onclick="runCode(this)">▶ Run</button>` : '';
    return `<pre data-lang="${dataLang}"><div class="code-block-header">${langLabel}<div class="code-block-btns">${runBtn}<button class="copy-btn" onclick="copyCode(this)">Copy</button></div></div><code>${escaped}</code></pre>`;
  });

  return text;
}

// Run code helper
window.runCode = async function(btn) {
  const pre = btn.closest('pre');
  const code = pre.querySelector('code').textContent;
  const lang = pre.dataset.lang || 'text';

  // Remove previous output if any
  const existing = pre.nextElementSibling;
  if (existing && existing.classList.contains('code-output')) existing.remove();

  const origText = btn.textContent;
  btn.textContent = 'Running…';
  btn.disabled = true;

  const outEl = document.createElement('div');
  outEl.className = 'code-output';
  pre.after(outEl);

  try {
    const res = await fetch('/api/ai/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: lang }),
    });
    const data = await res.json();
    let html = '';
    if (data.stdout) html += `<pre class="code-output-text">${escapeHtml(data.stdout)}</pre>`;
    if (data.stderr) html += `<pre class="code-output-error">${escapeHtml(data.stderr)}</pre>`;
    if (data.image_b64) html += `<img class="code-output-img" src="data:image/png;base64,${data.image_b64}" alt="Output plot">`;
    if (!html) html = '<pre class="code-output-text">(no output)</pre>';
    outEl.innerHTML = html;
  } catch (err) {
    outEl.innerHTML = `<pre class="code-output-error">${escapeHtml(err.message)}</pre>`;
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
};

// Copy code helper (called from inline onclick)
window.copyCode = function(btn) {
  const pre = btn.closest('pre');
  const code = pre.querySelector('code');
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
};

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2500) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(path, options);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Conversation sidebar ─────────────────────────────────────────────────────

async function loadConversations() {
  try {
    state.conversations = await api('GET', '/api/chats');
  } catch (_) {}
  renderConvList(searchInput.value);
}

function groupConvsByTime(convs) {
  const now = Date.now() / 1000;
  const day  = 86400;
  const groups = { Today: [], Yesterday: [], 'Previous 7 days': [], 'Previous 30 days': [], Older: [] };

  for (const c of convs) {
    const age = now - c.updated_at;
    if (age < day)            groups['Today'].push(c);
    else if (age < 2 * day)   groups['Yesterday'].push(c);
    else if (age < 7 * day)   groups['Previous 7 days'].push(c);
    else if (age < 30 * day)  groups['Previous 30 days'].push(c);
    else                      groups['Older'].push(c);
  }
  return groups;
}

function renderConvList(filter = '') {
  const q = filter.toLowerCase();
  const filtered = q
    ? state.conversations.filter(c => c.title.toLowerCase().includes(q))
    : state.conversations;

  const groups = groupConvsByTime(filtered);
  convList.innerHTML = '';

  for (const [label, convs] of Object.entries(groups)) {
    if (!convs.length) continue;
    const labelEl = document.createElement('div');
    labelEl.className = 'conv-group-label';
    labelEl.textContent = label;
    convList.appendChild(labelEl);

    for (const c of convs) {
      const item = document.createElement('div');
      item.className = 'conv-item' + (c.id === state.currentConvId ? ' active' : '');
      item.dataset.id = c.id;
      item.innerHTML = `
        <span class="conv-item-title">${escapeHtml(c.title)}</span>
        <button class="conv-item-del" data-id="${c.id}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.conv-item-del')) return;
        selectConversation(c.id);
        closeSidebar();
      });
      item.querySelector('.conv-item-del').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(c.id);
      });
      convList.appendChild(item);
    }
  }

  if (!filtered.length) {
    convList.innerHTML = '<div style="padding:16px 10px;font-size:13px;color:var(--text-3)">' +
      (q ? 'No chats found.' : 'No conversations yet.<br>Start a new chat!') + '</div>';
  }
}

async function selectConversation(id) {
  if (state.streaming) return;
  state.currentConvId = id;

  // Mark active
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', +el.dataset.id === id);
  });

  try {
    const conv = await api('GET', `/api/chats/${id}`);
    setTitle(conv.title);
    renderMessages(conv.messages);
    updateHeaderVisibility(true);
  } catch (err) {
    showToast('Failed to load conversation');
  }
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  try {
    await api('DELETE', `/api/chats/${id}`);
    state.conversations = state.conversations.filter(c => c.id !== id);
    if (state.currentConvId === id) {
      state.currentConvId = null;
      messagesEl.innerHTML = '';
      showWelcome(true);
      updateHeaderVisibility(false);
      setTitle('New Chat');
    }
    renderConvList(searchInput.value);
    showToast('Conversation deleted');
  } catch (err) {
    showToast('Failed to delete');
  }
}

function newChat() {
  if (state.streaming) return;
  state.currentConvId = null;
  messagesEl.innerHTML = '';
  showWelcome(true);
  updateHeaderVisibility(false);
  setTitle('New Chat');
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  msgInput.focus();
}

// ─── Messages rendering ───────────────────────────────────────────────────────

function showWelcome(yes) {
  welcomeEl.classList.toggle('hidden', !yes);
  messagesEl.classList.toggle('hidden', yes);
}

function updateHeaderVisibility(hasConv) {
  chatHeader.classList.toggle('hidden', !hasConv);
}

function setTitle(title) {
  if (chatTitleText) chatTitleText.textContent = title;
  if (mobileTitle) mobileTitle.textContent = title || 'GPTNeo';
  document.title = title ? `${title} – GPTNeo` : 'GPTNeo';
}

function renderMessages(messages) {
  showWelcome(messages.length === 0);
  messagesEl.innerHTML = '';
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    appendMessage(msg.role, msg.content, false, msg.id);
  }
  scrollToBottom();
}

function appendMessage(role, content, streaming = false, msgId = null, attachments = null) {
  showWelcome(false);

  const row = document.createElement('div');
  row.className = 'message-row';
  if (msgId) row.dataset.msgId = msgId;

  const initial = (state.user?.username || 'U').charAt(0).toUpperCase();

  if (role === 'assistant') {
    row.innerHTML = `
      <div class="message assistant">
        <div class="msg-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
        </div>
        <div>
          <div class="msg-content">${streaming ? '<div class="msg-typing-dots"><span></span><span></span><span></span></div>' : renderMarkdown(content)}</div>
          <div class="msg-actions">
            <button class="msg-action-btn copy-msg-btn" title="Copy message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  } else {
    // Build attachment HTML
    let attHtml = '';
    if (attachments && attachments.length > 0) {
      attHtml = '<div class="msg-attachments">';
      for (const att of attachments) {
        if (att.type === 'image') {
          attHtml += `<img class="msg-att-img" src="${escapeHtml(att.data)}" alt="${escapeHtml(att.name)}" title="${escapeHtml(att.name)}">`;
        } else {
          attHtml += `<span class="msg-att-file">${escapeHtml(att.name)}</span>`;
        }
      }
      attHtml += '</div>';
    }
    row.innerHTML = `
      <div class="message user">
        <div class="msg-avatar">${escapeHtml(initial)}</div>
        <div class="user-msg-wrap">
          ${attHtml}
          <div class="msg-bubble">${escapeHtml(content)}</div>
          <button class="msg-edit-btn" title="Edit &amp; resend">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
        </div>
      </div>
    `;

    const editBtn = row.querySelector('.msg-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => startEditMessage(row, content, msgId));
    }
  }

  // Copy handler for assistant messages
  const copyBtn = row.querySelector('.copy-msg-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => showToast('Copied to clipboard'));
    });
  }

  messagesEl.appendChild(row);
  return row;
}

function scrollToBottom(force = false) {
  const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  if (force || dist < 120) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// Poll the server for auto-generated title after a new conversation's first message
async function pollTitleUpdate(convId) {
  await new Promise(r => setTimeout(r, 1000));
  try {
    const convs = await api('GET', '/api/chats');
    const updated = convs.find(c => c.id === convId);
    if (!updated || updated.title === 'New Chat') return;

    // Update local state
    const existing = state.conversations.find(c => c.id === convId);
    if (existing) existing.title = updated.title;
    else state.conversations = convs;

    // Update header if still on this conv
    if (state.currentConvId === convId) setTitle(updated.title);

    // Animate the sidebar item title
    const item = convList.querySelector(`.conv-item[data-id="${convId}"]`);
    if (!item) { renderConvList(searchInput.value); return; }
    const titleEl = item.querySelector('.conv-item-title');
    if (!titleEl || titleEl.textContent === updated.title) return;

    titleEl.classList.add('title-updating');
    setTimeout(() => {
      titleEl.textContent = updated.title;
      titleEl.classList.remove('title-updating');
      titleEl.classList.add('title-updated');
      setTimeout(() => titleEl.classList.remove('title-updated'), 500);
    }, 200);
  } catch (_) {}
}

function startEditMessage(row, originalContent, msgId) {
  const userMsgWrap = row.querySelector('.user-msg-wrap');
  if (!userMsgWrap) return;
  userMsgWrap.innerHTML = `
    <div class="msg-edit-wrap">
      <textarea class="msg-edit-textarea">${escapeHtml(originalContent)}</textarea>
      <div class="msg-edit-actions">
        <button class="btn-send msg-edit-save">Send</button>
        <button class="msg-edit-cancel">Cancel</button>
      </div>
    </div>`;
  const ta = userMsgWrap.querySelector('.msg-edit-textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  userMsgWrap.querySelector('.msg-edit-cancel').addEventListener('click', () => {
    userMsgWrap.innerHTML = `<div class="msg-bubble">${escapeHtml(originalContent)}</div>
      <button class="msg-edit-btn" title="Edit &amp; resend"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button>`;
    userMsgWrap.querySelector('.msg-edit-btn').addEventListener('click', () => startEditMessage(row, originalContent, msgId));
  });
  userMsgWrap.querySelector('.msg-edit-save').addEventListener('click', async () => {
    const newContent = ta.value.trim();
    if (!newContent || state.streaming) return;
    if (msgId && state.currentConvId) {
      await api('PATCH', `/api/chats/${state.currentConvId}/messages/${msgId}`, { content: newContent }).catch(() => {});
      // Remove this message and all subsequent messages from the DOM
      let node = row.nextSibling;
      while (node) { const next = node.nextSibling; node.remove(); node = next; }
      row.remove();
    }
    sendMessage(newContent);
  });
}



async function sendMessage(prefillText) {
  const text = prefillText || msgInput.value.trim();
  if (!text || state.streaming) return;

  // Reset input — clear BEFORE measuring height to avoid 2-line flash
  if (!prefillText) {
    msgInput.value = '';
    msgInput.style.height = '24px';
  }
  autoResizeInput();
  btnSend.disabled = true;

  // Capture and clear attachments before sending
  const sentAttachments = state.attachments.length > 0 ? [...state.attachments] : null;
  clearAttachments();

  // Show user message
  appendMessage('user', text, false, null, sentAttachments);
  scrollToBottom(true);

  // Show streaming state
  state.streaming = true;
  btnSend.style.display = 'none';
  btnStop.style.display = 'flex';

  // Append AI bubble for streaming
  const aiRow = appendMessage('assistant', '', true);
  const aiContent = aiRow.querySelector('.msg-content');
  let streamBuffer = '';

  state.abortController = new AbortController();

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: state.currentConvId,
        message: text,
        mode: state.activeMode,
        attachments: sentAttachments,
      }),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'AI request failed');
    }

    // Keep typing indicator until first content arrives
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const json = JSON.parse(line.slice(6));

          if (json.type === 'conv_id') {
            // New conversation was created
            if (!state.currentConvId) {
              state.currentConvId = json.conversationId;
              // Reload sidebar
              loadConversations();
            }
            updateHeaderVisibility(true);
          }

          if (json.type === 'delta') {
            streamBuffer += json.content;
            aiContent.innerHTML = renderMarkdown(streamBuffer);
            scrollToBottom();
          }

          if (json.type === 'tool_call') {
            const ind = document.createElement('div');
            ind.className = 'tool-indicator';
            ind.dataset.tool = json.name;
            ind.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tool-spinner"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg> Using tool <strong>${escapeHtml(json.name)}</strong>…`;
            aiRow.querySelector('.msg-content').before(ind);
            scrollToBottom();
          }

          if (json.type === 'tool_result') {
            const ind = aiRow.querySelector(`.tool-indicator[data-tool="${CSS.escape(json.name)}"]`);
            if (ind) {
              ind.classList.add('done');
              ind.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> <strong>${escapeHtml(json.name)}</strong> done`;
            }
          }

          if (json.type === 'image_generated') {
            // Display the generated image in the message above the text content
            const imgEl = document.createElement('img');
            imgEl.className = 'md-img generated-img';
            imgEl.src = json.data_url;
            imgEl.alt = json.revised_prompt || 'Generated image';
            imgEl.title = json.revised_prompt || 'Generated image';
            imgEl.loading = 'lazy';
            aiContent.before(imgEl);
            scrollToBottom();
          }

          if (json.type === 'research_start') {
            const prog = document.createElement('div');
            prog.className = 'research-progress';
            prog.id = 'research-progress';
            prog.innerHTML = `<div class="research-progress-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tool-spinner"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0"/></svg> Deep Research in progress…</div>`;
            aiRow.querySelector('.msg-content').before(prog);
            scrollToBottom();
          }

          if (json.type === 'research_query') {
            const prog = document.getElementById('research-progress');
            if (prog) {
              const item = document.createElement('div');
              item.className = 'research-query-item';
              item.textContent = json.query;
              prog.appendChild(item);
              scrollToBottom();
            }
          }

          if (json.type === 'research_done') {
            const prog = document.getElementById('research-progress');
            if (prog) {
              prog.classList.add('research-done');
              const title = prog.querySelector('.research-progress-title');
              if (title) title.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Researched ${json.queryCount} quer${json.queryCount === 1 ? 'y' : 'ies'}`;
            }
          }

          if (json.type === 'done') {
            // Final render
            aiContent.innerHTML = renderMarkdown(streamBuffer);
            // Fix copy button with final streamed content
            const _finalCopyBtn = aiRow.querySelector('.copy-msg-btn');
            if (_finalCopyBtn) {
              _finalCopyBtn.replaceWith(_finalCopyBtn.cloneNode(true));
              aiRow.querySelector('.copy-msg-btn').addEventListener('click', () => {
                navigator.clipboard.writeText(streamBuffer).then(() => showToast('Copied to clipboard'));
              });
            }
            // Reload sidebar
            loadConversations();
            // Poll for auto-generated title (runs async server-side)
            const _pollId = state.currentConvId;
            if (_pollId) pollTitleUpdate(_pollId);
            scrollToBottom(true);
          }

          if (json.type === 'error') {
            aiContent.innerHTML = `<span style="color:var(--red)">${escapeHtml(json.message || 'Error')}</span>`;
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      aiContent.innerHTML = `<span style="color:var(--red)">${escapeHtml(err.message || 'Request failed')}</span>`;
    } else {
      if (!streamBuffer) aiContent.innerHTML = '<em style="color:var(--text-3)">Stopped.</em>';
    }
  } finally {
    state.streaming = false;
    state.abortController = null;
    btnStop.style.display = 'none';
    btnSend.style.display = 'flex';
    btnSend.disabled = !msgInput.value.trim();
    msgInput.focus();
  }
}

function stopStreaming() {
  if (state.abortController) {
    state.abortController.abort();
  }
}

// Image lightbox (covers both user attachment thumbnails and AI-generated/markdown images)
messagesEl.addEventListener('click', (e) => {
  const img = e.target.closest('.msg-att-img, .md-img, .generated-img');
  if (!img) return;
  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox-overlay';
  overlay.innerHTML = `<img src="${img.src}" alt="${img.alt}">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
});

// ─── Input auto-resize ────────────────────────────────────────────────────────
function autoResizeInput() {
  msgInput.style.height = 'auto';
  const maxH = 200;
  msgInput.style.height = Math.min(msgInput.scrollHeight, maxH) + 'px';
}

msgInput.addEventListener('input', () => {
  autoResizeInput();
  updateSendState();
});

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!btnSend.disabled) sendMessage();
  }
});

btnSend.addEventListener('click', () => sendMessage());
btnStop.addEventListener('click', stopStreaming);

// ─── Speech to Text ───────────────────────────────────────────────────────────

let recognition = null;
let isRecording = false;

function initSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btnStt.title = 'Speech recognition not supported in this browser';
    btnStt.style.opacity = '0.3';
    btnStt.style.cursor = 'not-allowed';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  let lastFinalTranscript = '';

  recognition.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (final) {
      lastFinalTranscript += final;
      msgInput.value = lastFinalTranscript + interim;
    } else {
      msgInput.value = lastFinalTranscript + interim;
    }
    autoResizeInput();
    btnSend.disabled = !msgInput.value.trim();
  };

  recognition.onerror = (e) => {
    console.warn('[STT]', e.error);
    stopRecording();
  };

  recognition.onend = () => {
    if (isRecording) recognition.start(); // restart for continuous
  };
}

function startRecording() {
  if (!recognition) return;
  isRecording = true;
  btnStt.classList.add('recording');
  btnStt.title = 'Stop listening';
  recognition.start();
}

function stopRecording() {
  if (!recognition) return;
  isRecording = false;
  btnStt.classList.remove('recording');
  btnStt.title = 'Speech to text';
  recognition.onend = null;
  recognition.stop();
  // Re-add onend for future use
  recognition.onend = () => {};
}

btnStt.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const [settings, modelsData] = await Promise.all([
      api('GET', '/api/settings'),
      api('GET', '/api/settings/models'),
    ]);
    state.settings = settings;
    state.models   = modelsData;
    updateModelBadge();
  } catch (_) {}
}

function updateModelBadge() {
  modelBadge.textContent = state.settings.model || 'gpt-4o';
}

function openSettings() {
  // Populate model dropdown
  const provider = state.settings.provider || 'openai';
  const modelSel = $('set-model');
  const provSel  = $('set-provider');
  const models   = state.models[provider] || [];

  provSel.value = provider;
  modelSel.innerHTML = models.map(m =>
    `<option value="${m.id}" ${m.id === state.settings.model ? 'selected' : ''}>${m.name} (${(m.context/1000).toFixed(0)}K ctx)</option>`
  ).join('');

  $('set-stream').checked     = state.settings.stream_enabled !== '0';
  $('set-system-prompt').value         = state.settings.system_prompt || '';
  $('set-custom-instructions').value   = state.settings.custom_instructions || '';
  $('set-memory-enabled').checked      = state.settings.memory_enabled !== '0';
  $('set-auto-memory').checked         = state.settings.auto_memory !== '0';

  // API key indicator
  const keyStatus = $('api-key-status');
  $('set-openai-api-key').value = '';
  keyStatus.textContent = state.settings.openai_api_key_set ? '\u2022\u2022\u2022\u2022\u2022 key is set' : 'no key set — using server key';
  keyStatus.className = 'api-key-status ' + (state.settings.openai_api_key_set ? 'set' : 'unset');

  // Tavily API key indicator
  const tavilyStatus = $('tavily-key-status');
  if (tavilyStatus) {
    $('set-tavily-api-key').value = '';
    tavilyStatus.textContent = state.settings.tavily_api_key_set ? '\u2022\u2022\u2022\u2022\u2022 key is set' : 'not set';
    tavilyStatus.className = 'api-key-status ' + (state.settings.tavily_api_key_set ? 'set' : 'unset');
  }

  $('settings-modal').style.display = 'flex';

  // Set first tab active
  switchModalTab('settings', 'model');

  // Load MCP servers and Memory in background
  loadMCPServers();
  renderMemoryList();
}

function closeSettings() {
  $('settings-modal').style.display = 'none';
}

async function saveSettings() {
  const apiKeyVal = $('set-openai-api-key').value.trim();
  const updates = {
    provider:            $('set-provider').value,
    model:               $('set-model').value,
    stream_enabled:      $('set-stream').checked ? '1' : '0',
    system_prompt:       $('set-system-prompt').value,
    custom_instructions: $('set-custom-instructions').value,
    memory_enabled:      $('set-memory-enabled').checked ? '1' : '0',
    auto_memory:         $('set-auto-memory').checked ? '1' : '0',
  };
  // Only include API key if user typed one
  if (apiKeyVal) updates.openai_api_key = apiKeyVal;
  const tavilyVal = $('set-tavily-api-key') ? $('set-tavily-api-key').value.trim() : '';
  if (tavilyVal) updates.tavily_api_key = tavilyVal;

  try {
    state.settings = await api('PATCH', '/api/settings', updates);
    updateModelBadge();
    closeSettings();
    showToast('Settings saved');
  } catch (err) {
    showToast('Failed to save settings');
  }
}

// Populate models on provider change
$('set-provider').addEventListener('change', () => {
  const provider = $('set-provider').value;
  const modelSel = $('set-model');
  const models   = state.models[provider] || [];
  modelSel.innerHTML = models.map(m =>
    `<option value="${m.id}">${m.name} (${(m.context/1000).toFixed(0)}K ctx)</option>`
  ).join('');
});

// Temperature slider - removed (GPT-5 doesn't support custom temperature)

// Settings buttons
btnSettings.addEventListener('click', openSettings);

// Mode selector
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.activeMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});
$('close-settings').addEventListener('click', closeSettings);
$('cancel-settings').addEventListener('click', closeSettings);
$('save-settings').addEventListener('click', saveSettings);
modelBadge.addEventListener('click', openSettings);

// ─── MCP Servers ──────────────────────────────────────────────────────────────

async function loadMCPServers() {
  const list = $('mcp-server-list');
  if (!list) return;
  list.innerHTML = '<div class="mcp-loading">Loading…</div>';
  try {
    const servers = await api('GET', '/api/mcp');
    renderMCPServers(servers);
  } catch (_) {
    list.innerHTML = '<div class="mcp-loading">Failed to load servers.</div>';
  }
}

function renderMCPServers(servers) {
  const list = $('mcp-server-list');
  if (!list) return;
  if (!servers.length) {
    list.innerHTML = '<div class="mcp-loading">No MCP servers configured yet.</div>';
    return;
  }

  function authBadge(s) {
    if (!s.auth_type || s.auth_type === 'none') return '<span class="mcp-auth-badge none">No auth</span>';
    if (s.auth_type === 'token') return `<span class="mcp-auth-badge token">${s.auth_token_set ? '🔑 Token' : '⚠ Token (missing)'}</span>`;
    if (s.auth_type === 'oauth') return `<span class="mcp-auth-badge oauth">${s.oauth?.connected ? '✓ OAuth' : '⚠ OAuth (not connected)'}</span>`;
    return '';
  }

  function connectBtn(s) {
    if (s.auth_type !== 'oauth') return '';
    const connected = s.oauth?.connected;
    return `<button class="mcp-connect-btn ${connected ? 'connected' : ''}" data-id="${s.id}">${connected ? 'Reconnect' : 'Connect'}</button>`;
  }

  list.innerHTML = servers.map(s => `
    <div class="mcp-server-item" data-id="${s.id}">
      <div class="mcp-server-info">
        <span class="mcp-server-name">${escapeHtml(s.name)} ${authBadge(s)}</span>
        <span class="mcp-server-url">${escapeHtml(s.url)}</span>
      </div>
      <div class="mcp-server-actions">
        ${connectBtn(s)}
        <label class="toggle" title="${s.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" class="mcp-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
          <span class="toggle-knob"></span>
        </label>
        <button class="mcp-test-btn icon-btn" data-id="${s.id}" title="Test connection">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
        <button class="mcp-del-btn icon-btn" data-id="${s.id}" title="Remove server">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.mcp-toggle').forEach(chk => {
    chk.addEventListener('change', async () => {
      await api('PATCH', `/api/mcp/${chk.dataset.id}`, { enabled: chk.checked });
    });
  });

  list.querySelectorAll('.mcp-test-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api('GET', `/api/mcp/${btn.dataset.id}/tools`);
        showToast(`Connected! ${res.toolCount} tool${res.toolCount !== 1 ? 's' : ''} available.`, 3500);
      } catch (err) {
        showToast(`Connection failed: ${err.message}`, 4000);
      } finally {
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll('.mcp-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this MCP server?')) return;
      await api('DELETE', `/api/mcp/${btn.dataset.id}`);
      loadMCPServers();
      showToast('Server removed');
    });
  });

  // OAuth connect buttons
  list.querySelectorAll('.mcp-connect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = window.open(`/api/mcp/${btn.dataset.id}/oauth/start`, 'oauth', 'width=600,height=700');
      const handler = (e) => {
        if (e.data?.type === 'oauth_success') { loadMCPServers(); showToast('OAuth connected!'); window.removeEventListener('message', handler); }
        if (e.data?.type === 'oauth_error')   { showToast(`OAuth failed: ${e.data.error}`); window.removeEventListener('message', handler); }
      };
      window.addEventListener('message', handler);
    });
  });
}

// Auth type toggle
$('mcp-add-auth-type').addEventListener('change', () => {
  const val = $('mcp-add-auth-type').value;
  $('mcp-token-field').style.display  = val === 'token' ? 'block' : 'none';
  $('mcp-oauth-fields').style.display = val === 'oauth' ? 'flex' : 'none';
});
// Use flex for oauth grid
$('mcp-oauth-fields').style.display = 'none';



$('btn-mcp-add').addEventListener('click', async () => {
  const name      = $('mcp-add-name').value.trim();
  const url       = $('mcp-add-url').value.trim();
  const auth_type = $('mcp-add-auth-type').value;
  if (!name || !url) { showToast('Name and URL are required'); return; }

  const body = { name, url, auth_type };
  if (auth_type === 'token') {
    body.auth_token = $('mcp-add-auth-token').value.trim();
  }
  if (auth_type === 'oauth') {
    body.oauth = {
      auth_url:      $('mcp-oauth-auth-url').value.trim(),
      token_url:     $('mcp-oauth-token-url').value.trim(),
      client_id:     $('mcp-oauth-client-id').value.trim(),
      client_secret: $('mcp-oauth-client-secret').value.trim(),
      scope:         $('mcp-oauth-scope').value.trim(),
    };
  }
  try {
    await api('POST', '/api/mcp', body);
    $('mcp-add-name').value = '';
    $('mcp-add-url').value  = '';
    $('mcp-add-auth-token').value = '';
    $('mcp-add-auth-type').value  = 'none';
    $('mcp-token-field').style.display  = 'none';
    $('mcp-oauth-fields').style.display = 'none';
    loadMCPServers();
    showToast('MCP server added');
  } catch (err) {
    showToast(err.message || 'Failed to add server');
  }
});

// ─── Memory (now inside Settings) ───────────────────────────────────────────

async function openMemory() {
  openSettings();
  // Switch to memory tab after modal opens
  setTimeout(() => switchModalTab('settings', 'memory'), 20);
}

async function renderMemoryList() {
  const list = $('memory-list');
  if (!list) return;
  list.innerHTML = '<div class="memory-empty">Loading…</div>';
  try {
    const facts = await api('GET', '/api/memory');
    if (!facts.length) {
      list.innerHTML = '<div class="memory-empty">No memories yet. Add facts above.</div>';
      return;
    }
    list.innerHTML = facts.map(f => `
      <div class="memory-item" data-id="${f.id}">
        <span class="memory-item-text">${escapeHtml(f.content)}</span>
        <button class="memory-item-del" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      </div>
    `).join('');

    list.querySelectorAll('.memory-item-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.memory-item').dataset.id;
        await api('DELETE', `/api/memory/${id}`);
        renderMemoryList();
      });
    });
  } catch (_) {
    list.innerHTML = '<div class="memory-empty">Failed to load memory.</div>';
  }
}

$('btn-memory-add').addEventListener('click', async () => {
  const input = $('memory-add-input');
  const val = input.value.trim();
  if (!val) return;
  try {
    await api('POST', '/api/memory', { content: val });
    input.value = '';
    renderMemoryList();
    showToast('Memory added');
  } catch (err) {
    showToast('Failed to add memory');
  }
});

$('memory-add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-memory-add').click();
});

$('btn-memory-clear').addEventListener('click', async () => {
  if (!confirm('Clear all memory? This cannot be undone.')) return;
  await api('DELETE', '/api/memory');
  renderMemoryList();
  showToast('Memory cleared');
});

if (btnMemory) btnMemory.addEventListener('click', openMemory);

// ─── Rename ───────────────────────────────────────────────────────────────────

function openRenameModal() {
  if (!state.currentConvId) return;
  const input = $('rename-input');
  input.value = chatTitleText.textContent || '';
  $('rename-modal').style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeRenameModal() {
  $('rename-modal').style.display = 'none';
}

async function confirmRename() {
  const title = $('rename-input').value.trim();
  if (!title || !state.currentConvId) return;
  try {
    await api('PATCH', `/api/chats/${state.currentConvId}`, { title });
    setTitle(title);
    state.conversations = state.conversations.map(c =>
      c.id === state.currentConvId ? { ...c, title } : c
    );
    renderConvList(searchInput.value);
    closeRenameModal();
    showToast('Renamed');
  } catch (err) {
    showToast('Failed to rename');
  }
}

$('btn-rename').addEventListener('click', openRenameModal);
$('close-rename').addEventListener('click', closeRenameModal);
$('cancel-rename').addEventListener('click', closeRenameModal);
$('confirm-rename').addEventListener('click', confirmRename);
$('rename-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmRename(); });

// ─── Delete current chat ──────────────────────────────────────────────────────

$('btn-delete-chat').addEventListener('click', () => {
  if (state.currentConvId) deleteConversation(state.currentConvId);
});

// ─── Modal tab switching ──────────────────────────────────────────────────────

function switchModalTab(modalId, tab) {
  const modal = $(modalId === 'settings' ? 'settings-modal' : modalId);
  if (!modal) return;
  modal.querySelectorAll('.modal-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  modal.querySelectorAll('.modal-content').forEach(pane => {
    pane.classList.toggle('hidden', pane.id !== `tab-${tab}`);
  });
}

document.querySelectorAll('.modal-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    modal.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
    modal.querySelectorAll('.modal-content').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const tab = modal.querySelector(`#tab-${btn.dataset.tab}`);
    if (tab) tab.classList.remove('hidden');
  });
});

// Click outside modal to close
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.style.display = 'none';
    }
  });
});

// ─── File / Image Attachments ──────────────────────────────────────────────────

const IMAGE_TYPES = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/bmp'];
const PDF_TYPE    = 'application/pdf';
const MAX_IMAGE_B64_BYTES = 10 * 1024 * 1024; // 10 MB raw

function clearAttachments() {
  state.attachments = [];
  if (attachPreview) attachPreview.innerHTML = '';
  // Reset file input so same files can be re-selected
  if (fileInput) fileInput.value = '';
  updateSendState();
}

function updateSendState() {
  btnSend.disabled = !msgInput.value.trim() && state.attachments.length === 0;
}

function renderAttachmentPreview() {
  if (!attachPreview) return;
  attachPreview.innerHTML = '';
  if (state.attachments.length === 0) return;

  for (let i = 0; i < state.attachments.length; i++) {
    const att = state.attachments[i];
    const item = document.createElement('div');
    item.className = 'att-item';

    if (att.type === 'image') {
      item.innerHTML = `
        <div class="att-thumb" style="background-image:url(${att.data})" title="${escapeHtml(att.name)}"></div>
        <span class="att-name">${escapeHtml(att.name)}</span>
        <button class="att-remove" data-idx="${i}" title="Remove">×</button>
      `;
    } else if (att.mimeType === 'application/pdf') {
      item.innerHTML = `
        <div class="att-file-icon att-pdf-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </div>
        <span class="att-name">${escapeHtml(att.name)}${att.pages ? ` <em style="color:var(--text-3);font-size:11px">(${att.pages}p)</em>` : ''}</span>
        <button class="att-remove" data-idx="${i}" title="Remove">×</button>
      `;
    } else {
      item.innerHTML = `
        <div class="att-file-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <span class="att-name">${escapeHtml(att.name)}</span>
        <button class="att-remove" data-idx="${i}" title="Remove">×</button>
      `;
    }
    attachPreview.appendChild(item);
  }

  attachPreview.querySelectorAll('.att-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.attachments.splice(+btn.dataset.idx, 1);
      renderAttachmentPreview();
      updateSendState();
    });
  });
}

async function handleFiles(files) {
  for (const file of Array.from(files)) {
    if (IMAGE_TYPES.includes(file.type)) {
      if (file.size > MAX_IMAGE_B64_BYTES) { showToast(`${file.name} is too large (max 10 MB)`); continue; }
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      state.attachments.push({ type: 'image', name: file.name, data, mimeType: file.type });
    } else if (file.type === PDF_TYPE || file.name.toLowerCase().endsWith('.pdf')) {
      if (file.size > 30 * 1024 * 1024) { showToast(`${file.name} is too large for PDF (max 30 MB)`); continue; }
      showToast(`Extracting text from ${file.name}…`, 4000);
      try {
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const bytes = new Uint8Array(r.result);
            const chunk = 8192;
            let bin = '';
            for (let i = 0; i < bytes.length; i += chunk)
              bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
            resolve(btoa(bin));
          };
          r.onerror = reject;
          r.readAsArrayBuffer(file);
        });
        const res  = await fetch('/api/ai/parse-pdf', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ data: b64 }),
        });
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json.error || 'Parse failed');
        state.attachments.push({ type: 'text', name: file.name, data: json.text, mimeType: 'application/pdf', pages: json.pages });
        showToast(`${file.name} – ${json.pages} page${json.pages !== 1 ? 's' : ''} extracted`);
      } catch (err) {
        showToast(`Could not read ${file.name}: ${err.message}`);
      }
    } else {
      // Treat as text file
      if (file.size > 500 * 1024) { showToast(`${file.name} is too large for text (max 500 KB)`); continue; }
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsText(file);
      });
      state.attachments.push({ type: 'text', name: file.name, data, mimeType: file.type || 'text/plain' });
    }
  }
  renderAttachmentPreview();
  updateSendState();
}

if (btnAttach) {
  btnAttach.addEventListener('click', () => fileInput && fileInput.click());
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
  });
}

// Drag & drop onto the input area
$('main').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
$('main').addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

// Paste images from clipboard
msgInput.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
  if (imageItems.length) {
    e.preventDefault();
    handleFiles(imageItems.map(it => it.getAsFile()));
  }
});

// ─── Sidebar (mobile) ─────────────────────────────────────────────────────────

function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('open');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

$('btn-sidebar-toggle').addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
sidebarBackdrop.addEventListener('click', closeSidebar);

// ─── New chat buttons ─────────────────────────────────────────────────────────

btnNewChat.addEventListener('click', newChat);
if (btnNewChatMob) btnNewChatMob.addEventListener('click', () => { newChat(); closeSidebar(); });

// ─── Logout ───────────────────────────────────────────────────────────────────

btnLogout.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ─── Search ───────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  renderConvList(searchInput.value);
});

// ─── Welcome chips ────────────────────────────────────────────────────────────

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    msgInput.value = chip.dataset.prompt;
    autoResizeInput();
    btnSend.disabled = false;
    msgInput.focus();
  });
});

// ─── PWA Install ──────────────────────────────────────────────────────────────

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // prevent auto-banner
  state.deferredInstall = e;
  if (btnInstall) btnInstall.style.display = 'flex';
});

btnInstall.addEventListener('click', async () => {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt();
  const { outcome } = await state.deferredInstall.userChoice;
  if (outcome === 'accepted') {
    btnInstall.style.display = 'none';
    showToast('GPTNeo installed!');
  }
  state.deferredInstall = null;
});

window.addEventListener('appinstalled', () => {
  btnInstall.style.display = 'none';
  state.deferredInstall = null;
});

// ─── Service worker registration ──────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('[SW] Registration failed:', err);
  });
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Escape: close modals
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(o => o.style.display = 'none');
    closeSidebar();
  }
  // Ctrl/Cmd+K: new chat
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    newChat();
    msgInput.focus();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    state.user = await api('GET', '/api/auth/me');
  } catch (_) {}

  await Promise.all([
    loadConversations(),
    loadSettings(),
  ]);

  initSTT();
  msgInput.focus();
}

init();
