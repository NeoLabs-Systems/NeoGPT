'use strict';

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const session    = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const { requireAuth, requireNoAuth } = require('./middleware/auth');
const authRoutes     = require('./routes/auth');
const chatRoutes     = require('./routes/chats');
const settingsRoutes = require('./routes/settings');
const memoryRoutes   = require('./routes/memory');
const aiRoutes       = require('./routes/ai');
const mcpRoutes      = require('./routes/mcp');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Trust proxy
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      fontSrc:       ["'self'"],
      imgSrc:        ["'self'", 'data:'],
      connectSrc:    ["'self'"],
      frameSrc:      ["'none'"],
      formAction:    ["'self'"],
      frameAncestors:["'none'"],
      workerSrc:     ["'self'"],
    }
  },
  frameguard: { action: 'deny' },
  crossOriginEmbedderPolicy: false,
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));

// ─── Sessions ─────────────────────────────────────────────────────────────────

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] SESSION_SECRET must be set in production');
    process.exit(1);
  }
  console.warn('[WARN] SESSION_SECRET not set – using insecure default');
}

const dataDir = path.join(__dirname, 'data');
const { existsSync, mkdirSync } = require('fs');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const sessionStore = new SQLiteStore({
  db:    'sessions.db',
  dir:   dataDir,
  table: 'sessions',
});

app.use(session({
  name:             'gptneo.sid',
  secret:           process.env.SESSION_SECRET || 'insecure-default-please-change',
  resave:           false,
  saveUninitialized: false,
  store:            sessionStore,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  },
}));

// ─── Cache-busting for JS/CSS ─────────────────────────────────────────────────

app.use((req, res, next) => {
  if (/\.(js|css)$/.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

// ─── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Page routes ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/app');
  res.redirect('/login');
});

app.get('/login', requireNoAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()) }));

// ─── API routes ───────────────────────────────────────────────────────────────

app.use('/api/auth',     authRoutes);
app.use('/api/chats',    requireAuth, chatRoutes);
app.use('/api/settings', requireAuth, settingsRoutes);
app.use('/api/memory',   requireAuth, memoryRoutes);
app.use('/api/mcp',      requireAuth, mcpRoutes);
app.use('/api/ai',       requireAuth, aiRoutes);

// ─── 404 catchall ─────────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  GPTNeo running at http://localhost:${PORT}\n`);
});

module.exports = app;
