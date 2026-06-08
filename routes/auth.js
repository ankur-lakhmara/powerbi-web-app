const express = require('express');
const router  = express.Router();
const { pool } = require('../db/database');

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

module.exports = router;
