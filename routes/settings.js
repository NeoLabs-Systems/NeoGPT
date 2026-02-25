'use strict';

const express = require('express');
const { getUserSettings, setSetting } = require('../db/database');

const router = express.Router();

// Allowed setting keys and their defaults
const ALLOWED_KEYS = new Set([
  'model',
  'provider',
  'custom_instructions',
  'memory_enabled',
  'temperature',
  'system_prompt',
  'stream_enabled',
  'openai_api_key',
  'auto_memory',
  'tavily_api_key',
  'chat_mode',
]);

const DEFAULTS = {
  model:               'gpt-5-mini',
  provider:            'openai',
  custom_instructions: '',
  memory_enabled:      '1',
  temperature:         '0.7',
  system_prompt:       'You are a helpful, harmless, and honest AI assistant.',
  stream_enabled:      '1',
  auto_memory:         '1',
  chat_mode:           'normal',
};

// Helper: strip raw keys from a settings object before sending to client
function maskSettings(merged) {
  const openai_api_key_set  = !!(merged.openai_api_key  && merged.openai_api_key.trim());
  const tavily_api_key_set  = !!(merged.tavily_api_key  && merged.tavily_api_key.trim());
  const out = { ...merged };
  delete out.openai_api_key;
  delete out.tavily_api_key;
  return { ...out, openai_api_key_set, tavily_api_key_set };
}

// GET /api/settings
router.get('/', (req, res) => {
  const stored = getUserSettings(req.session.userId);
  res.json(maskSettings({ ...DEFAULTS, ...stored }));
});

const MAX_LENGTHS = {
  custom_instructions: 4000,
  system_prompt:       4000,
  model:               64,
  provider:            64,
  chat_mode:           32,
};

// PATCH /api/settings
router.patch('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid body' });

  for (const [k, v] of Object.entries(updates)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    const val = String(v ?? '');
    const max = MAX_LENGTHS[k];
    if (max && val.length > max) continue; // silently skip over-long values
    setSetting(req.session.userId, k, val);
  }
  const stored = getUserSettings(req.session.userId);
  res.json(maskSettings({ ...DEFAULTS, ...stored }));
});

// GET /api/settings/models  – GPT-5 family only
router.get('/models', (_req, res) => {
  res.json({
    openai: [
      { id: 'gpt-5',      name: 'GPT-5',           context: 1000000 },
      { id: 'gpt-5-mini', name: 'GPT-5 mini',       context: 1000000 },
    ],
  });
});

module.exports = router;
