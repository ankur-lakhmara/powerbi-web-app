const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const axios   = require('axios');
const { pool } = require('../db/database');

// ── PKCE helpers ─────────────────────────────────────────────────
function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function callbackUri(req) {
  return `${req.protocol}://${req.get('host')}/auth/microsoft/callback`;
}

// Temporary debug endpoint — remove after confirming SSO wiring
router.get('/platform-debug', (req, res) => {
  res.json({
    hostname:       req.hostname,
    platform:       req.platform ? {
      id:              req.platform.id,
      domain:          req.platform.domain,
      name:            req.platform.name,
      ms_sso_enabled:  req.platform.ms_sso_enabled,
    } : null
  });
});

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/workspaces');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('login', { error: 'Email and password are required.' });
  }

  try {
    // Global admins (platform_id IS NULL) can sign in from any domain.
    // BA users only exist on the platform they were created for, so they
    // can only sign in from that platform's domain.
    const platformId = req.platform ? req.platform.id : null;
    const { rows } = await pool.query(
      `SELECT * FROM pbi_users
       WHERE email = $1 AND password = $2
         AND (role = 'admin' OR platform_id = $3)`,
      [email, password, platformId]
    );
    const user = rows[0];

    if (!user) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    req.session.user = {
      id:         user.id,
      email:      user.email,
      firstName:  user.first_name,
      lastName:   user.last_name,
      role:       user.role,
      platformId: user.platform_id
    };

    res.redirect('/workspaces');
  } catch (err) {
    console.error('Login error:', err.message);
    res.render('login', { error: 'A server error occurred. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Microsoft SSO — initiate ──────────────────────────────────────
router.get('/microsoft', (req, res) => {
  const platform = req.platform;
  if (!platform?.ms_sso_enabled || !platform.ms_client_id || !platform.ms_tenant_id) {
    return res.redirect('/auth/login');
  }

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  req.session.mssoState   = state;
  req.session.mssoPkce    = verifier;

  const params = new URLSearchParams({
    client_id:             platform.ms_client_id,
    response_type:         'code',
    redirect_uri:          callbackUri(req),
    scope:                 'openid profile email User.Read',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(
    `https://login.microsoftonline.com/${platform.ms_tenant_id}/oauth2/v2.0/authorize?${params}`
  );
});

// ── Microsoft SSO — callback ──────────────────────────────────────
router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const platform = req.platform;

  if (error) {
    return res.render('login', {
      error: `Microsoft sign-in failed: ${error_description || error}`
    });
  }

  if (!state || state !== req.session.mssoState) {
    return res.render('login', { error: 'Invalid state parameter. Please try again.' });
  }

  const verifier = req.session.mssoPkce;
  delete req.session.mssoState;
  delete req.session.mssoPkce;

  if (!platform?.ms_sso_enabled) {
    return res.render('login', { error: 'SSO is not enabled for this platform.' });
  }

  try {
    // Exchange authorization code for access token
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${platform.ms_tenant_id}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id:     platform.ms_client_id,
        client_secret: platform.ms_client_secret,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  callbackUri(req),
        code_verifier: verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;

    // Fetch user profile from Microsoft Graph
    const graphRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const { mail, userPrincipalName, givenName, surname, displayName } = graphRes.data;
    const email = (mail || userPrincipalName || '').toLowerCase().trim();

    if (!email) {
      return res.render('login', {
        error: 'Could not retrieve email from Microsoft. Make sure your account has an email address.'
      });
    }

    // Find existing BA user on this platform or auto-provision one
    const { rows } = await pool.query(
      `SELECT * FROM pbi_users WHERE email = $1 AND platform_id = $2`,
      [email, platform.id]
    );

    let dbUser = rows[0];
    if (!dbUser) {
      const firstName = givenName  || displayName?.split(' ')[0]             || email.split('@')[0];
      const lastName  = surname    || displayName?.split(' ').slice(1).join(' ') || '';
      const { rows: inserted } = await pool.query(
        `INSERT INTO pbi_users (email, first_name, last_name, password, role, platform_id)
         VALUES ($1, $2, $3, '', 'BA', $4) RETURNING *`,
        [email, firstName, lastName, platform.id]
      );
      dbUser = inserted[0];
    }

    req.session.user = {
      id:         dbUser.id,
      email:      dbUser.email,
      firstName:  dbUser.first_name,
      lastName:   dbUser.last_name,
      role:       dbUser.role,
      platformId: dbUser.platform_id,
    };

    res.redirect('/workspaces');
  } catch (err) {
    console.error('SSO callback error:', err.response?.data || err.message);
    res.render('login', {
      error: 'Microsoft sign-in failed. Please try again or use email/password login.'
    });
  }
});

module.exports = router;
