'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'gptneo.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch()),
    last_login  INTEGER
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL DEFAULT 'New Chat',
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_conv_user_updated
    ON conversations(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL CHECK(role IN ('system','user','assistant','tool')),
    content         TEXT    NOT NULL,
    created_at      INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

  -- Per-user settings (key/value). Known keys:
  --   model              – e.g. "gpt-4o"
  --   provider           – e.g. "openai"
  --   custom_instructions – free text
  --   memory_enabled     – "1" | "0"
  --   auto_memory        – "1" | "0"
  --   temperature        – float string
  --   system_prompt      – override global system prompt
  --   openai_api_key     – per-user OpenAI key (stored in plaintext, access-controlled)
  CREATE TABLE IF NOT EXISTS settings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key       TEXT    NOT NULL,
    value     TEXT,
    UNIQUE(user_id, key)
  );

  -- Cross-chat memory facts
  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT    NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id, updated_at DESC);

  -- MCP server configurations per-user
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_servers(user_id);
`);

// ─── Migrations (safe ALTER TABLE – no-op if column exists) ──────────────────
try { db.exec(`ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'`); } catch (_) {}
try { db.exec(`ALTER TABLE mcp_servers ADD COLUMN auth_data TEXT`); } catch (_) {}


// ─── Helper functions ─────────────────────────────────────────────────────────

/** Get all settings for a user as a plain object */
function getUserSettings(userId) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Upsert a single setting */
function setSetting(userId, key, value) {
  db.prepare(`
    INSERT INTO settings(user_id, key, value) VALUES (?,?,?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, value);
}

/** Get all memory facts for a user */
function getUserMemory(userId) {
  return db.prepare('SELECT * FROM memory WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

/** Get enabled MCP servers for a user */
function getUserMCPServers(userId) {
  return db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY created_at').all(userId);
}

module.exports = { db, getUserSettings, setSetting, getUserMemory, getUserMCPServers };
