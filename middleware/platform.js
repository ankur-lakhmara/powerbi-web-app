const { pool } = require('../db/database');
const { lighten, darken, hexToRgb, normalizeHex } = require('../utils/color');

const DEFAULT_PRIMARY   = '#7c3aed';
const DEFAULT_SECONDARY = '#2563eb';

// Derives the full accent palette (hover/bg/border/text/gradient/shadow) from
// just the two colors an admin picks, so the rest of the UI stays consistent
// without needing a color field for every CSS variable.
function buildTheme(primaryRaw, secondaryRaw) {
  const primary   = normalizeHex(primaryRaw,   DEFAULT_PRIMARY);
  const secondary = normalizeHex(secondaryRaw, DEFAULT_SECONDARY);
  const rgb = hexToRgb(primary);
  return {
    primary,
    secondary,
    accentHover:  darken(primary, 0.12),
    accentBg:     lighten(primary, 0.94),
    accentBorder: lighten(primary, 0.78),
    accentText:   darken(primary, 0.22),
    gradient:     `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`,
    shadowAccent: `0 4px 14px 0 rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .25)`,
  };
}

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
  res.locals.theme = buildTheme(req.platform?.theme_primary_color, req.platform?.theme_secondary_color);
  next();
}

module.exports = { detectPlatform };
