function clamp(n) {
  return Math.max(0, Math.min(255, n));
}

function hexToRgb(hex) {
  const clean = (hex || '').replace('#', '').trim();
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const num = parseInt(full, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v)).toString(16).padStart(2, '0')).join('');
}

// Blend `hex` toward `targetHex` by `weight` (0 = pure hex, 1 = pure targetHex).
function mix(hex, targetHex, weight) {
  const a = hexToRgb(hex);
  const b = hexToRgb(targetHex);
  return rgbToHex({
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
  });
}

function lighten(hex, weight) { return mix(hex, '#ffffff', weight); }
function darken(hex, weight)  { return mix(hex, '#000000', weight); }

function isValidHex(hex) {
  return /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test((hex || '').trim());
}

function normalizeHex(hex, fallback) {
  if (!isValidHex(hex)) return fallback;
  const clean = hex.trim().replace(/^#/, '').toLowerCase();
  return '#' + (clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean);
}

module.exports = { hexToRgb, rgbToHex, mix, lighten, darken, isValidHex, normalizeHex };
