'use strict';

const express = require('express');
const { db }  = require('../db/database');

const router = express.Router();

// ── List conversations ─────────────────────────────────────────────────────
// GET /api/chats
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
    FROM conversations c
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC
    LIMIT 200
  `).all(req.session.userId);
  res.json(rows);
});

// ── Create conversation ────────────────────────────────────────────────────
// POST /api/chats
router.post('/', (req, res) => {
  const { title } = req.body;
  const result = db.prepare(
    'INSERT INTO conversations(user_id, title) VALUES (?, ?)'
  ).run(req.session.userId, (title || 'New Chat').trim());
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
  res.json(conv);
});

// ── Get single conversation with messages ──────────────────────────────────
// GET /api/chats/:id
router.get('/:id', (req, res) => {
  const conv = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const messages = db.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at'
  ).all(conv.id);

  res.json({ ...conv, messages });
});

// ── Rename conversation ────────────────────────────────────────────────────
// PATCH /api/chats/:id
router.patch('/:id', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const result = db.prepare(
    'UPDATE conversations SET title = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?'
  ).run(title.trim(), req.params.id, req.session.userId);

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Delete conversation ────────────────────────────────────────────────────
// DELETE /api/chats/:id
router.delete('/:id', (req, res) => {
  const result = db.prepare(
    'DELETE FROM conversations WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.session.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Get messages for a conversation ───────────────────────────────────────
// GET /api/chats/:id/messages
router.get('/:id/messages', (req, res) => {
  const conv = db.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const messages = db.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at'
  ).all(conv.id);
  res.json(messages);
});

// ── Edit a message and delete everything after it ─────────────────────────
// PATCH /api/chats/:id/messages/:msgId
router.patch('/:id/messages/:msgId', (req, res) => {
  const conv = db.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const msg = db.prepare(
    'SELECT id, role, created_at FROM messages WHERE id = ? AND conversation_id = ?'
  ).get(req.params.msgId, conv.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.role !== 'user') return res.status(400).json({ error: 'Only user messages can be edited' });

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  // Delete this message and everything after it (we'll re-insert via the chat endpoint)
  db.prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?').run(conv.id, msg.created_at);
  db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conv.id);

  res.json({ ok: true, deletedFrom: msg.created_at });
});

module.exports = router;
