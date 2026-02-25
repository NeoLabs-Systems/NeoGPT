'use strict';

const express = require('express');
const { db, getUserMemory } = require('../db/database');

const router = express.Router();

// GET /api/memory
router.get('/', (req, res) => {
  res.json(getUserMemory(req.session.userId));
});

// POST /api/memory  – add a memory fact
router.post('/', (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  if (content.length > 1000) return res.status(400).json({ error: 'Memory fact too long (max 1000 chars)' });

  const count = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE user_id = ?').get(req.session.userId).n;
  if (count >= 500) return res.status(400).json({ error: 'Memory limit reached (500 facts max). Delete some facts first.' });

  const result = db.prepare(
    'INSERT INTO memory(user_id, content) VALUES (?, ?)'
  ).run(req.session.userId, content.trim());

  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(result.lastInsertRowid);
  res.json(row);
});

// PATCH /api/memory/:id – update a memory fact
router.patch('/:id', (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  if (content.length > 1000) return res.status(400).json({ error: 'Memory fact too long (max 1000 chars)' });

  const result = db.prepare(
    'UPDATE memory SET content = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?'
  ).run(content.trim(), req.params.id, req.session.userId);

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// DELETE /api/memory/:id
router.delete('/:id', (req, res) => {
  const result = db.prepare(
    'DELETE FROM memory WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.session.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// DELETE /api/memory  – clear all memory
router.delete('/', (req, res) => {
  db.prepare('DELETE FROM memory WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
