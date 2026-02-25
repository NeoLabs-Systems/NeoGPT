'use strict';

const express   = require('express');
const bcrypt    = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { db }    = require('../db/database');

const router = express.Router();
const SALT_ROUNDS = 12;

// Rate-limit auth endpoints – 10 attempts per 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many attempts, please try again later.' },
});

// GET /api/auth/config  (public – exposes feature flags to the frontend)
router.get('/config', (req, res) => {
  res.json({
    registrationEnabled: process.env.DISABLE_REGISTRATION !== 'true',
  });
});

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  if (process.env.DISABLE_REGISTRATION === 'true')
    return res.status(403).json({ error: 'Registration is disabled' });
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (typeof username !== 'string' || username.length > 50)  return res.status(400).json({ error: 'Username too long (max 50 chars)' });
  if (typeof email    !== 'string' || email.length    > 254) return res.status(400).json({ error: 'Email too long' });
  if (typeof password !== 'string' || password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (password.length > 128) return res.status(400).json({ error: 'Password too long (max 128 chars)' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(409).json({ error: 'Username or email already taken' });

  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users(username, email, password) VALUES (?, ?, ?)'
    ).run(username.trim(), email.trim().toLowerCase(), hash);

    const newUserId = result.lastInsertRowid;
    const newUsername = username.trim();
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = newUserId;
      req.session.username = newUsername;
      res.json({ ok: true });
    });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (typeof username !== 'string' || username.length > 254) return res.status(400).json({ error: 'Invalid input' });
  if (typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: 'Invalid input' });

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? OR email = ?'
  ).get(username, username);

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  db.prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?').run(user.id);
  const uid = user.id;
  const uname = user.username;
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = uid;
    req.session.username = uname;
    res.json({ ok: true });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json(user || { error: 'User not found' });
});

module.exports = router;
