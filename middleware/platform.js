const { pool } = require('../db/database');

// Resolves the requesting domain to a platform record (multi-tenant lookup).
// req.platform / res.locals.platform is null when the host doesn't match any
// configured platform — in that case only global admins may sign in (see auth.js).
async function detectPlatform(req, res, next) {
  try {
    const host = (req.hostname || '').toLowerCase();
    const { rows } = await pool.query('SELECT * FROM platforms WHERE domain = $1', [host]);
    req.platform = rows[0] || null;
  } catch (err) {
    console.error('Platform detection error:', err.message);
    req.platform = null;
  }
  res.locals.platform = req.platform;
  next();
}

module.exports = { detectPlatform };
