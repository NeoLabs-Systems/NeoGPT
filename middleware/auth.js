'use strict';

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }
  next();
}

function requireNoAuth(req, res, next) {
  if (req.session?.userId) return res.redirect('/app');
  next();
}

module.exports = { requireAuth, requireNoAuth };
