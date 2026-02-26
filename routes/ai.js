'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { db, getUserSettings, getUserMemory, getUserMCPServers } = require('../db/database');
const { streamChat, isProviderAvailable, extractMemories } = require('../services/ai');
const { BUILTIN_TOOLS, handleBuiltinTool, runDeepResearch } = require('../services/tools');
const { collectMCPTools, callTool } = require('../services/mcp');
const OpenAI = require('openai');

const router = express.Router();

// Rate-limit code execution: 30 runs per minute per user session
const execLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.session?.userId || req.ip || req.socket?.remoteAddress || 'unknown'),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { 
    trustProxy: true,
    xForwardedForHeader: false,
    ip: false
  },
  message: { error: 'Too many execution requests. Please slow down.' },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(settings, memoryFacts, mode) {
  const base = settings.system_prompt || 'You are a helpful, harmless, and honest AI assistant.';
  const instructions = (settings.custom_instructions || '').trim();
  const memEnabled = settings.memory_enabled !== '0';

  let prompt = base;

  // Mode-specific additions
  if (mode === 'deep_research') {
    prompt += '\n\nYou are in Deep Research mode. Comprehensive research has already been done for you and is provided below. Synthesize all sources into a thorough, well-structured answer. Cite sources inline as [1], [2], etc.';
  }

  // Tool instructions
  prompt += '\n\nYou have access to tools:\n' +
    '- memory_save: Save important facts about the user. Use this proactively whenever the user shares personal information.\n' +
    '- memory_get: Recall stored facts about the user.\n' +
    '- web_search: Search the web (requires Tavily API key in settings).\n' +
    '- generate_image: Generate an image from a text prompt using DALL-E. Use whenever the user asks you to create, draw, generate, or visualise an image.';

  if (instructions) {
    prompt += `\n\n## Custom Instructions:\n${instructions}`;
  }

  if (memEnabled && memoryFacts.length > 0) {
    const factList = memoryFacts.map(f => `- ${f.content}`).join('\n');
    prompt += `\n\n## What you remember about the user:\n${factList}\n\nUse this naturally when relevant.`;
  }

  return prompt;
}

async function autoTitle(convId, firstUserMessage, settings, apiKey) {
  const existing = db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId);
  if (existing?.title && existing.title !== 'New Chat') return;

  setTimeout(async () => {
    try {
      let title = '';
      await streamChat({
        provider:    settings.provider || 'openai',
        model:  'gpt-5-mini',
        apiKey,
        messages: [
          { role: 'system', content: 'Generate a very short title (max 6 words, no quotes, no punctuation) for the following message.' },
          { role: 'user',   content: firstUserMessage.slice(0, 500) },
        ],
        onChunk: (delta) => { title += delta; },
        onDone:  () => {
          title = title.trim().slice(0, 80) || 'New Chat';
          db.prepare('UPDATE conversations SET title = ?, updated_at = unixepoch() WHERE id = ?').run(title, convId);
        },
        onError: () => {},
      });
    } catch (_) {}
  }, 0);
}

// ─── POST /api/ai/chat  – streaming SSE ──────────────────────────────────────

router.post('/chat', async (req, res) => {
  const userId = req.session.userId;
  const { conversationId, message, mode: reqMode, attachments } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  // ── Conversation ──
  let conv;
  if (conversationId) {
    conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  } else {
    const result = db.prepare('INSERT INTO conversations(user_id, title) VALUES (?, ?)').run(userId, 'New Chat');
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
  }

  // ── Settings ──
  const settings   = getUserSettings(userId);
  const DEFAULTS   = { model: 'gpt-5-mini', provider: 'openai', temperature: '0.7', memory_enabled: '1', auto_memory: '1', chat_mode: 'normal' };
  const cfg        = { ...DEFAULTS, ...settings };
  const userApiKey = (cfg.openai_api_key || '').trim() || undefined;
  const tavilyKey  = (cfg.tavily_api_key || '').trim() || undefined;

  // mode: from request body (per-message override) or from settings
  const mode = reqMode || cfg.chat_mode || 'normal';

  if (!isProviderAvailable(cfg.provider, userApiKey)) {
    return res.status(503).json({ error: `No API key configured. Add one in Settings → Model.` });
  }

  const memory = getUserMemory(userId);

  // ── Collect tools ──
  // Built-in tools are always included
  let allTools = [...BUILTIN_TOOLS];

  // MCP tools on top
  const mcpServers = getUserMCPServers(userId);
  let mcpToolServerMap = new Map();
  if (mcpServers.length > 0) {
    try {
      const { openaiTools, toolServerMap } = await collectMCPTools(mcpServers);
      allTools = [...allTools, ...openaiTools];
      mcpToolServerMap = toolServerMap;
    } catch (err) {
      console.warn('[ai/chat] MCP error:', err.message);
    }
  }

  // Unified tool executor
  const toolContext = { userId, tavilyKey, apiKey: userApiKey };
  async function toolExecutor(name, args) {
    // Built-in tools take priority
    if (BUILTIN_TOOLS.some(t => t.function.name === name)) {
      const result = await handleBuiltinTool(name, args, toolContext);
      // Special handling: image generation returns a data URL that the frontend renders
      if (typeof result === 'string' && result.startsWith('IMAGE_GENERATED:')) {
        const lines = result.split('\n');
        const dataUrl = lines[0].slice('IMAGE_GENERATED:'.length);
        const revisedPrompt = (lines.find(l => l.startsWith('Revised prompt:')) || '').replace('Revised prompt: ', '');
        sse({ type: 'image_generated', data_url: dataUrl, revised_prompt: revisedPrompt });
        return `Image generated successfully.${revisedPrompt ? ' Revised prompt: ' + revisedPrompt : ''} Let the user know the image is shown above.`;
      }
      return result;
    }
    // MCP tools
    const serverInfo = mcpToolServerMap.get(name);
    if (serverInfo) {
      const contents = await callTool(serverInfo.url, name, args, serverInfo.auth);
      return contents.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    }
    return `Tool "${name}" not found`;
  }

  // ── History ──
  const history = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 60'
  ).all(conv.id).reverse();

  // Save user message
  db.prepare('INSERT INTO messages(conversation_id, role, content) VALUES (?, ?, ?)').run(conv.id, 'user', message.trim());
  db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conv.id);

  if (history.length === 0) autoTitle(conv.id, message, cfg, userApiKey);

  // ── SSE setup ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  sse({ type: 'conv_id', conversationId: conv.id });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  // ── Deep Research mode: multi-step search → reason → answer ──────────────
  let extraContext = '';
  if (mode === 'deep_research' && tavilyKey) {
    sse({ type: 'research_start' });
    try {
      const client = new OpenAI({ apiKey: userApiKey });

      // Step 1: Generate initial search queries
      const q1Resp = await client.chat.completions.create({
        model: 'gpt-5-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Generate 3-4 specific web search queries to thoroughly research this question. Return JSON: {"queries": ["q1","q2","q3"]}' },
          { role: 'user',   content: message.slice(0, 1000) },
        ],
      });
      const q1Parsed = JSON.parse(q1Resp.choices[0]?.message?.content || '{}');
      const initialQueries = Array.isArray(q1Parsed.queries) ? q1Parsed.queries.slice(0, 4) : [message];

      for (const q of initialQueries) sse({ type: 'research_query', query: q });

      // Step 2: Run initial searches in parallel
      const round1 = await runDeepResearch(initialQueries, tavilyKey);

      // Step 3: Reason about gaps, generate follow-up queries
      const gapResp = await client.chat.completions.create({
        model: 'gpt-5-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Given the original question and initial research results, identify what is still missing or unclear. Generate 1-2 targeted follow-up search queries to fill the gaps. If coverage is already sufficient, return an empty list. Return JSON: {"queries": []}' },
          { role: 'user',   content: `Question: ${message}\n\nInitial research:\n${round1.slice(0, 3000)}` },
        ],
      });
      const gapParsed = JSON.parse(gapResp.choices[0]?.message?.content || '{}');
      const followUpQueries = Array.isArray(gapParsed.queries) ? gapParsed.queries.slice(0, 2) : [];

      let round2 = '';
      if (followUpQueries.length > 0) {
        for (const q of followUpQueries) sse({ type: 'research_query', query: q });
        round2 = await runDeepResearch(followUpQueries, tavilyKey);
      }

      extraContext = round1 + (round2 ? '\n\n---\n\n' + round2 : '');
      sse({ type: 'research_done', queryCount: initialQueries.length + followUpQueries.length });
    } catch (err) {
      console.warn('[deep_research]', err.message);
    }
  }

  // ── Build message array ──
  const systemPrompt = buildSystemPrompt(cfg, memory, mode);
  const apiMessages  = [{ role: 'system', content: systemPrompt }];

  if (extraContext) {
    apiMessages.push({
      role:    'system',
      content: `## Web Research Results (use these to answer):\n\n${extraContext}`,
    });
  }

  for (const msg of history) apiMessages.push({ role: msg.role, content: msg.content });
  // current user message added below after attachment processing

  let fullResponse = '';

  // Build current user message content (text-only or multipart with images)
  let currentUserContent;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const parts = [{ type: 'text', text: message.trim() }];
    for (const att of attachments) {
      if (att.type === 'image') {
        parts.push({ type: 'image_url', image_url: { url: att.data, detail: 'auto' } });
      } else if (att.type === 'text') {
        // Append text file content inline
        parts[0].text += `\n\n[Attached file: ${att.name}]\n\`\`\`\n${att.data}\n\`\`\``;
      }
    }
    currentUserContent = parts;
  } else {
    currentUserContent = message.trim();
  }
  apiMessages.push({ role: 'user', content: currentUserContent });

  await streamChat({
    provider:        cfg.provider,
    model:           cfg.model,
    messages:        apiMessages,
    tools:           allTools,
    toolExecutor,
    apiKey:          userApiKey,
    signal:          ac.signal,
    reasoningEffort: mode === 'deep_research' ? 'high' : mode === 'thinking' ? 'high' : 'low',

    onChunk: (delta) => {
      fullResponse += delta;
      sse({ type: 'delta', content: delta });
    },

    onToolCall:   (name, args)   => sse({ type: 'tool_call',   name, args }),
    onToolResult: (name, result) => sse({ type: 'tool_result', name, result: result.slice(0, 600) }),

    onDone: () => {
      db.prepare('INSERT INTO messages(conversation_id, role, content) VALUES (?, ?, ?)').run(conv.id, 'assistant', fullResponse);
      db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conv.id);
      sse({ type: 'done' });
      res.end();

      // Background auto-memory extraction (passive, in addition to active memory_save tool)
      if (cfg.auto_memory !== '0' && fullResponse.trim()) {
        const allMsgs = [...apiMessages, { role: 'assistant', content: fullResponse }];
        extractMemories({ provider: cfg.provider, apiKey: userApiKey, messages: allMsgs, existingFacts: memory })
          .then(newFacts => {
            if (!newFacts.length) return;
            const ins = db.prepare('INSERT INTO memory(user_id, content) VALUES (?, ?)');
            for (const f of newFacts) ins.run(userId, f);
            console.log(`[memory] Auto-saved ${newFacts.length} fact(s) for user ${userId}`);
          }).catch(() => {});
      }
    },

    onError: (err) => {
      console.error('[ai/chat]', err);
      sse({ type: 'error', message: err.message || 'AI error' });
      res.end();
    },
  });
});

// ─── POST /api/ai/parse-pdf  – extract text from a base64-encoded PDF ────────

router.post('/parse-pdf', async (req, res) => {
  const { data } = req.body; // base64-encoded PDF
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'No PDF data' });
  try {
    const { PDFParse } = require('pdf-parse');
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'PDF too large (max 10 MB)' });
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    await parser.destroy();
    const text = (result.text || '').trim();
    if (!text) return res.json({ text: '(no extractable text found in PDF)', pages: result.total || 0 });
    res.json({ text: text.slice(0, 200000), pages: result.total || 0 });
  } catch (err) {
    res.status(500).json({ error: 'PDF parsing failed: ' + err.message });
  }
});

// ─── POST /api/ai/exec  – safe code execution ────────────────────────────────

router.post('/exec', execLimiter, (req, res) => {
  const { code, language } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'No code provided' });
  if (code.length > 50000) return res.status(400).json({ error: 'Code too large (max 50 KB)' });

  const lang = (language || '').toLowerCase().trim();

  if (lang === 'javascript' || lang === 'js' || lang === 'node') {
    const vm = require('vm');
    const logs = [];
    const mkLogger = prefix => (...a) => logs.push(
      (prefix ? prefix : '') + a.map(x => typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x)).join(' ')
    );
    const context = vm.createContext({
      console: { log: mkLogger(''), error: mkLogger('[err] '), warn: mkLogger('[warn] '), info: mkLogger('') },
      Math, JSON, Array, Object, String, Number, Boolean, Date,
      parseInt, parseFloat, isNaN, isFinite, Symbol, Map, Set, Promise,
    });
    try {
      const result = vm.runInContext(code, context, { timeout: 8000 });
      const out = logs.join('\n') || (result !== undefined ? String(result) : '');
      return res.json({ stdout: out || '(no output)', stderr: '', image_b64: null });
    } catch (err) {
      return res.json({ stdout: logs.join('\n'), stderr: err.message, image_b64: null });
    }
  }

  if (lang === 'python' || lang === 'py') {
    const { spawn } = require('child_process');
    const wrapper = [
      'import sys, io, base64 as _b64',
      '_plot_b64 = None',
      'try:',
      '    import matplotlib as _mpl',
      '    _mpl.use("Agg")',
      '    import matplotlib.pyplot as _plt',
      '    _orig_show = _plt.show',
      '    def _show(*a, **kw):',
      '        global _plot_b64',
      '        buf = io.BytesIO()',
      '        _plt.savefig(buf, format="png", bbox_inches="tight", dpi=130)',
      '        buf.seek(0)',
      '        _plot_b64 = _b64.b64encode(buf.read()).decode()',
      '        buf.close(); _plt.close("all")',
      '    _plt.show = _show',
      'except ImportError: pass',
      '',
      code,
      '',
      '# auto-capture any unclosed figure',
      'try:',
      '    import matplotlib.pyplot as _p2',
      '    if _p2.get_fignums() and not _plot_b64:',
      '        buf2 = io.BytesIO()',
      '        _p2.savefig(buf2, format="png", bbox_inches="tight", dpi=130)',
      '        buf2.seek(0)',
      '        _plot_b64 = _b64.b64encode(buf2.read()).decode()',
      '        buf2.close(); _p2.close("all")',
      'except: pass',
      'if _plot_b64:',
      '    print("__PLOT__:" + _plot_b64, file=sys.stderr)',
    ].join('\n');

    const proc = spawn('python3', ['-c', wrapper]);
    let stdout = '', stderr = '';
    const kill = () => { try { proc.kill('SIGKILL'); } catch (_) {} };
    const timer = setTimeout(kill, 12000);
    proc.stdout.on('data', d => { stdout += d; if (stdout.length > 500000) kill(); });
    proc.stderr.on('data', d => { stderr += d; if (stderr.length > 600000) kill(); });
    proc.on('close', () => {
      clearTimeout(timer);
      let image_b64 = null;
      const m = stderr.match(/__PLOT__:([A-Za-z0-9+/=]+)/);
      if (m) { image_b64 = m[1]; stderr = stderr.replace(/__PLOT__:[^\n]+\n?/, '').trim(); }
      res.json({ stdout: stdout.trim(), stderr: stderr.trim(), image_b64 });
    });
    proc.on('error', err => { clearTimeout(timer); res.json({ stdout: '', stderr: err.message, image_b64: null }); });
    return;
  }

  res.status(400).json({ error: `Unsupported language: ${lang}. Supported: python, javascript.` });
});

// ─── GET /api/ai/status ───────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const settings   = getUserSettings(req.session?.userId);
  const userApiKey = (settings?.openai_api_key || '').trim() || undefined;
  const tavilySet  = !!(settings?.tavily_api_key?.trim());
  res.json({ openai: isProviderAvailable('openai', userApiKey), web_search: tavilySet });
});


module.exports = router;
