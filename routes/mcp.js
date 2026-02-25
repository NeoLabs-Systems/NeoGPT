'use strict';

const express  = require('express');
const { db }   = require('../db/database');
const { listTools } = require('../services/mcp');

const router = express.Router();

// ─── GET /api/mcp  – list all MCP servers for current user ────────────────────

router.get('/', (req, res) => {
  const servers = db.prepare(
    'SELECT id, name, url, enabled, created_at FROM mcp_servers WHERE user_id = ? ORDER BY created_at ASC'
  ).all(req.session.userId);
  res.json(servers);
});

// ─── POST /api/mcp  – add a new MCP server ────────────────────────────────────

router.post('/', (req, res) => {
  const { name, url } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!url?.trim())  return res.status(400).json({ error: 'url is required' });

  // Basic URL validation
  try { new URL(url); } catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }

  const result = db.prepare(
    'INSERT INTO mcp_servers(user_id, name, url) VALUES (?, ?, ?)'
  ).run(req.session.userId, name.trim().slice(0, 120), url.trim());

  const server = db.prepare('SELECT id, name, url, enabled, created_at FROM mcp_servers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(server);
});

// ─── PATCH /api/mcp/:id  – update name / url / enabled ───────────────────────

router.patch('/:id', (req, res) => {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!server) return res.status(404).json({ error: 'Not found' });

  const { name, url, enabled } = req.body || {};
  const updates = {};

  if (name  !== undefined)  updates.name    = String(name).trim().slice(0, 120);
  if (url   !== undefined)  {
    try { new URL(url); } catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }
    updates.url = String(url).trim();
  }
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(updates), req.params.id];
  db.prepare(`UPDATE mcp_servers SET ${cols}, updated_at = unixepoch() WHERE id = ?`).run(...vals);

  const updated = db.prepare('SELECT id, name, url, enabled, created_at FROM mcp_servers WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ─── DELETE /api/mcp/:id  – remove a server ───────────────────────────────────

router.delete('/:id', (req, res) => {
  const server = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!server) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── GET /api/mcp/:id/tools  – test connection + list tools ──────────────────

router.get('/:id/tools', async (req, res) => {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!server) return res.status(404).json({ error: 'Not found' });

  try {
    const tools = await listTools(server.url);
    res.json({ ok: true, toolCount: tools.length, tools });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
