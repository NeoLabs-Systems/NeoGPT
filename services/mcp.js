'use strict';

// Use built-in fetch (Node 18+)
const MCP_TIMEOUT_MS = 10_000;

// Private/loopback IP ranges to block (SSRF protection)
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc|fd|fe80)/i;

function validateMcpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) { throw new Error('Invalid MCP server URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP server URL must use http or https');
  }
  const host = parsed.hostname;
  if (PRIVATE_IP_RE.test(host) || host === 'localhost') {
    throw new Error('MCP server URL must not point to a private or loopback address');
  }
}

let _reqId = 1;
function nextId() { return _reqId++; }

async function mcpRequest(serverUrl, method, params = {}, auth = null) {
  validateMcpUrl(serverUrl);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id:      nextId(),
    method,
    params,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

  // Build auth header
  const headers = {
    'Content-Type': 'application/json',
    'Accept':        'application/json, text/event-stream',
  };
  const bearerToken = auth?.token;
  if (bearerToken && (auth.type === 'token' || auth.type === 'oauth')) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }

  try {
    const res = await fetch(serverUrl, {
      method:  'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`MCP server ${serverUrl} responded ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || '';

    // Some servers respond with SSE even for non-streaming requests
    if (contentType.includes('text/event-stream')) {
      return await readSSEResult(res);
    }

    const json = await res.json();
    if (json.error) throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Read first `result` event from an SSE stream */
async function readSSEResult(res) {
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
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.error) throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
          if (json.result !== undefined) {
            reader.cancel();
            return json.result;
          }
        } catch (e) {
          if (e.message.startsWith('MCP error')) throw e;
        }
      }
    }
  }
  throw new Error('MCP server closed without sending a result');
}

async function mcpInitialize(serverUrl, auth = null) {
  return mcpRequest(serverUrl, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities:    { tools: {} },
    clientInfo:      { name: 'NeoGPT', version: '1.0.0' },
  }, auth);
}

async function listTools(serverUrl, auth = null) {
  try {
    await mcpInitialize(serverUrl, auth);
    const result = await mcpRequest(serverUrl, 'tools/list', {}, auth);
    return result?.tools || [];
  } catch (err) {
    console.warn(`[MCP] listTools failed for ${serverUrl}:`, err.message);
    return [];
  }
}

async function callTool(serverUrl, toolName, args = {}, auth = null) {
  try {
    await mcpInitialize(serverUrl, auth);
    const result = await mcpRequest(serverUrl, 'tools/call', {
      name:      toolName,
      arguments: args,
    }, auth);
    return result?.content || [{ type: 'text', text: JSON.stringify(result) }];
  } catch (err) {
    console.warn(`[MCP] callTool "${toolName}" failed:`, err.message);
    return [{ type: 'text', text: `Tool error: ${err.message}` }];
  }
}

function mcpToolsToOpenAI(mcpTools, serverUrl) {
  return mcpTools.map(t => ({
    type:     'function',
    function: {
      name:        t.name,
      description: t.description || '',
      parameters:  t.inputSchema || { type: 'object', properties: {} },
    },
    _mcpServer: serverUrl,  // internal metadata
  }));
}

async function collectMCPTools(servers) {
  const openaiTools   = [];
  const toolServerMap = new Map();

  await Promise.allSettled(servers.map(async (srv) => {
    const auth = buildAuth(srv);
    const tools = await listTools(srv.url, auth);
    for (const t of tools) {
      if (!toolServerMap.has(t.name)) {          // first server wins on name collision
        toolServerMap.set(t.name, { url: srv.url, auth });
        openaiTools.push(...mcpToolsToOpenAI([t], srv.url));
      }
    }
  }));

  return { openaiTools, toolServerMap };
}

/** Build auth object from DB row */
function buildAuth(srv) {
  if (!srv.auth_type || srv.auth_type === 'none') return null;
  let data = {};
  try { data = srv.auth_data ? JSON.parse(srv.auth_data) : {}; } catch (_) {}
  const token = data.token || data.access_token || null;
  return { type: srv.auth_type, token };
}

module.exports = { listTools, callTool, collectMCPTools, buildAuth };
