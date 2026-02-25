'use strict';

/**
 * GPTNeo AI Service
 * ─────────────────
 * Provider abstraction layer. Currently supports OpenAI (GPT-5 family).
 *
 * Adding a new provider:
 *   1. Add its models to routes/settings.js → /api/settings/models
 *   2. Add a streamProviderName() adapter below
 *   3. Add a case branch in streamChat()
 *   4. Add isProviderAvailable() branch
 *
 * All adapters implement:
 *   streamChat(opts)  – see JSDoc on the exported function
 */

const OpenAI = require('openai');

// ─── Client factory ────────────────────────────────────────────────────────────

/**
 * Create an OpenAI client.
 * Uses opts.apiKey if provided, falls back to OPENAI_API_KEY env var.
 */
function makeOpenAIClient(apiKey) {
  if (!apiKey) throw new Error('No OpenAI API key set. Add yours in Settings → Model → OpenAI API Key.');
  return new OpenAI({ apiKey });
}

// ─── OpenAI adapter ───────────────────────────────────────────────────────────

/**
 * OpenAI streaming + tool-call loop.
 *
 * Emits events via callbacks:
 *   onChunk(delta)             – text token
 *   onToolCall(name, args)     – tool about to be executed
 *   onToolResult(name, result) – tool result
 *   onDone(fullText)           – final text
 *   onError(err)
 *
 * @param {object}   opts
 * @param {function} [opts.toolExecutor]  – async (name, args) => resultString
 *                                          handles both built-in + MCP tools
 */
async function streamOpenAI({
  messages, model, temperature, tools, toolExecutor, apiKey, signal,
  reasoningEffort,
  onChunk, onToolCall, onToolResult, onDone, onError,
}) {
  const client  = makeOpenAIClient(apiKey);
  const hasTools = tools && tools.length > 0;
  const msgsCopy = [...messages];
  let fullResponse = '';

  try {
    for (let round = 0; round < 10; round++) {
      const params = {
        model,
        messages: msgsCopy,
        stream:   true,
      };

      // Temperature: omit for reasoning models (o-series) and GPT-5 family (only supports default=1)
      if (!/^o[0-9]/.test(model) && !/^gpt-5/.test(model)) {
        params.temperature = parseFloat(temperature) || 0.7;
      }
      // reasoning_effort for o-series and GPT-5 (both support it; GPT-5 defaults to medium)
      if ((/^o[0-9]/.test(model) || /^gpt-5/.test(model)) && reasoningEffort) {
        params.reasoning_effort = reasoningEffort;
      }

      if (hasTools) {
        params.tools       = tools.map(t => ({ type: t.type, function: t.function }));
        params.tool_choice = 'auto';
      }

      const stream = await client.chat.completions.create(params, { signal });

      let chunkText    = '';
      let finishReason = null;
      const toolCallsAcc = {};  // index → { id, name, args }

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const textDelta = choice.delta?.content || '';
        if (textDelta) {
          chunkText    += textDelta;
          fullResponse += textDelta;
          onChunk(textDelta);
        }

        const tcDeltas = choice.delta?.tool_calls;
        if (tcDeltas) {
          for (const tc of tcDeltas) {
            const idx = tc.index;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', name: '', args: '' };
            if (tc.id)                  toolCallsAcc[idx].id   += tc.id;
            if (tc.function?.name)      toolCallsAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      if (finishReason !== 'tool_calls' || !hasTools || !toolExecutor) {
        onDone(fullResponse);
        return;
      }

      // ── Execute tool calls ──────────────────────────────────────────────
      const toolCallList = Object.values(toolCallsAcc);

      msgsCopy.push({
        role:       'assistant',
        content:    chunkText || null,
        tool_calls: toolCallList.map(tc => ({
          id:       tc.id,
          type:     'function',
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      for (const tc of toolCallList) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(tc.args || '{}'); } catch (_) {}

        if (onToolCall) onToolCall(tc.name, parsedArgs);

        let resultText = 'Tool execution failed';
        try {
          resultText = await toolExecutor(tc.name, parsedArgs);
        } catch (err) {
          resultText = `Error: ${err.message}`;
        }

        if (onToolResult) onToolResult(tc.name, resultText);

        msgsCopy.push({
          role:         'tool',
          tool_call_id: tc.id,
          content:      resultText,
        });
      }
    }

    onDone(fullResponse);
  } catch (err) {
    if (err.name !== 'AbortError') onError(err);
    else onDone(fullResponse);
  }
}

// ─── Auto memory extraction ───────────────────────────────────────────────────

/**
 * Extract memorable personal facts about the user from a conversation.
 * Returns an array of new fact strings (never duplicates existing ones).
 *
 * Fire-and-forget: call without await in production.
 */
async function extractMemories({ provider, apiKey, messages, existingFacts = [] }) {
  if (provider !== 'openai') return [];

  const client = makeOpenAIClient(apiKey);

  const knownList = existingFacts.length
    ? existingFacts.map(f => `- ${f.content}`).join('\n')
    : '(none)';

  const conversation = messages
    .filter(m => ['user', 'assistant'].includes(m.role))
    .slice(-10)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  if (!conversation.trim()) return [];

  const systemPrompt =
`You are a memory extraction assistant. Extract useful long-term personal facts about the USER from the conversation below.

Good to extract: name, location, occupation, company, ongoing projects, goals, preferences, hobbies, technical stack, relationships.
Do NOT extract: general knowledge, temporary info, anything the assistant said, or info already in the known facts list.

Already known (do not repeat):
${knownList}

Return ONLY a valid JSON object: {"facts": ["fact 1", "fact 2", ...]}
Return {"facts": []} if nothing new is worth remembering. Max 15 words per fact, max 5 facts per turn.`;

  try {
    const response = await client.chat.completions.create({
      model:           'gpt-5-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Conversation:\n${conversation}` },
      ],
    });

    const raw = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const facts = parsed.facts || parsed.memories || parsed;
    return Array.isArray(facts) ? facts.filter(s => typeof s === 'string' && s.trim()) : [];
  } catch (err) {
    console.warn('[AI] extractMemories failed:', err.message);
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Stream a chat completion (with tool-call loop support).
 *
 * @param {object}      opts
 * @param {string}      opts.provider
 * @param {string}      opts.model
 * @param {string|number} opts.temperature
 * @param {Array}       opts.messages
 * @param {Array}       [opts.tools]          – combined built-in + MCP tool defs (OpenAI format)
 * @param {function}    [opts.toolExecutor]   – async (name, args) => resultString
 * @param {string}      [opts.reasoningEffort]– 'low'|'medium'|'high' for o-series
 * @param {string}      [opts.apiKey]         – user's API key
 * @param {AbortSignal} [opts.signal]
 * @param {function}    opts.onChunk
 * @param {function}    [opts.onToolCall]     – (name, args)
 * @param {function}    [opts.onToolResult]   – (name, result)
 * @param {function}    opts.onDone
 * @param {function}    opts.onError
 */
async function streamChat(opts) {
  const { provider = 'openai' } = opts;
  switch (provider) {
    case 'openai': return streamOpenAI(opts);
    default: opts.onError(new Error(`Unknown provider: ${provider}`));
  }
}

/** Check if a provider is usable — requires a per-user API key. */
function isProviderAvailable(provider, userApiKey) {
  switch (provider) {
    case 'openai': return !!userApiKey;
    default:       return false;
  }
}

module.exports = { streamChat, isProviderAvailable, extractMemories };
