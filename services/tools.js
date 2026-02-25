'use strict';

const { db } = require('../db/database');

// Built-in tool schemas (OpenAI function-calling format)

const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Save a fact about the user to long-term memory. Use this whenever the user shares personal information, preferences, goals, or anything worth remembering across conversations.',
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'The fact to remember, written as a third-person statement (e.g. "The user prefers TypeScript over JavaScript").',
          },
        },
        required: ['fact'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_get',
      description: 'Search the user\'s memory for relevant stored facts. Use this to recall information about the user when context is needed.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or topic to search for in memory.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, news, recent events, or any factual question. Use this whenever the user asks about something that may have changed since your training data, or when you need up-to-date sources.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
          max_results: {
            type: 'integer',
            description: 'Number of results to return (1–10). Default is 5.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using DALL-E 3. Use this whenever the user asks to create, draw, generate, or visualise an image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A detailed description of the image to generate.',
          },
          size: {
            type: 'string',
            enum: ['1024x1024', '1792x1024', '1024x1792'],
            description: 'Image dimensions. Default is 1024x1024.',
          },
          quality: {
            type: 'string',
            enum: ['standard', 'hd'],
            description: 'Image quality. Default is standard.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
];

let _cachedOpenAI = null;
function getOpenAI(apiKey) {
  const OpenAI = require('openai');
  if (!_cachedOpenAI || _cachedOpenAI._apiKey !== apiKey) {
    _cachedOpenAI = new OpenAI({ apiKey });
    _cachedOpenAI._apiKey = apiKey;
  }
  return _cachedOpenAI;
}

async function handleBuiltinTool(name, args, context) {
  const { userId, tavilyKey, apiKey } = context;

  switch (name) {
    case 'memory_save': {
      const fact = (args.fact || '').trim();
      if (!fact) return 'Error: No fact provided.';
      // Dedup: skip if exact content already exists
      const dupe = db.prepare('SELECT id FROM memory WHERE user_id = ? AND lower(content) = lower(?)').get(userId, fact);
      if (dupe) return `✓ Already remembered: "${fact}"`;
      db.prepare('INSERT INTO memory(user_id, content) VALUES (?, ?)').run(userId, fact);
      return `✓ Saved to memory: "${fact}"`;
    }

    case 'memory_get': {
      const query = (args.query || '').trim().toLowerCase();
      const allFacts = db.prepare('SELECT content FROM memory WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
      const terms = query.split(/\s+/).filter(Boolean);
      const matched = terms.length > 0
        ? allFacts.filter(f => terms.some(t => f.content.toLowerCase().includes(t)))
        : allFacts;
      if (!matched.length) return query ? `No memories found matching "${args.query}".` : 'No memories stored yet.';
      return matched.map(f => `- ${f.content}`).join('\n');
    }

    case 'web_search': {
      if (!tavilyKey) return 'Web search is not configured. The user needs to add a Tavily API key in Settings → Model.';
      const query = (args.query || '').trim();
      if (!query) return 'Error: No query provided.';
      const maxResults = Math.min(Math.max(parseInt(args.max_results) || 5, 1), 10);

      try {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key:        tavilyKey,
            query,
            max_results:    maxResults,
            include_answer: true,
            search_depth:   'basic',
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const lines = [];
        if (data.answer) lines.push(`**Answer:** ${data.answer}\n`);
        if (data.results?.length) {
          lines.push('**Sources:**');
          for (const [i, r] of data.results.entries()) {
            lines.push(`[${i + 1}] **${r.title}**\n${r.url}\n${(r.content || '').slice(0, 400)}…`);
          }
        }
        return lines.join('\n\n') || 'No results found.';
      } catch (err) {
        return `Search failed: ${err.message}`;
      }
    }

    case 'generate_image': {
      const prompt = (args.prompt || '').trim();
      if (!prompt) return 'Error: No prompt provided.';
      if (!apiKey) return 'Image generation requires an OpenAI API key set in Settings.';
      try {
        const openai = getOpenAI(apiKey);
        const size    = ['1024x1024', '1792x1024', '1024x1792'].includes(args.size) ? args.size : '1024x1024';
        const quality = args.quality === 'hd' ? 'hd' : 'standard';
        const resp = await openai.images.generate({
          model:           'dall-e-3',
          prompt,
          n:               1,
          size,
          quality,
          response_format: 'b64_json',
        });
        const b64 = resp.data[0]?.b64_json;
        if (!b64) return 'Image generation returned no data.';
        const revisedPrompt = resp.data[0]?.revised_prompt || prompt;
        // Return a data URL — the AI should embed it as markdown: ![alt](url)
        return `IMAGE_GENERATED:data:image/png;base64,${b64}\nRevised prompt: ${revisedPrompt}`;
      } catch (err) {
        return `Image generation failed: ${err.message}`;
      }
    }

    default:
      return `Unknown built-in tool: ${name}`;
  }
}

// Run multiple Tavily searches in parallel (used by deep research mode)
async function runDeepResearch(queries, tavilyKey) {
  if (!tavilyKey) return 'Web search not configured. Add a Tavily API key in Settings.';

  const results = await Promise.allSettled(
    queries.map(q =>
      fetch('https://api.tavily.com/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          api_key:        tavilyKey,
          query:          q,
          max_results:    6,
          include_answer: true,
          search_depth:   'advanced',
        }),
        signal: AbortSignal.timeout(25000),
      }).then(r => r.json())
    )
  );

  const sections = [];
  for (const [i, res] of results.entries()) {
    if (res.status !== 'fulfilled') { sections.push(`[Search ${i + 1}: failed]`); continue; }
    const data = res.value;
    const sec = [`### Search: "${queries[i]}"`];
    if (data.answer) sec.push(`Summary: ${data.answer}`);
    for (const r of (data.results || []).slice(0, 4)) {
      sec.push(`• **${r.title}** (${r.url})\n  ${(r.content || '').slice(0, 350)}…`);
    }
    sections.push(sec.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

module.exports = { BUILTIN_TOOLS, handleBuiltinTool, runDeepResearch };
