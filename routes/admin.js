const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { uploadPlatformLogo, logoUrlFor } = require('../middleware/upload');

router.use(requireAdmin);

// ─── OVERVIEW ────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const [users, workspaces, dashboards, baUsers, recentUsers] = await Promise.all([
      pool.query("SELECT COUNT(*) AS count FROM pbi_users"),
      pool.query("SELECT COUNT(*) AS count FROM workspaces"),
      pool.query("SELECT COUNT(*) AS count FROM dashboards"),
      pool.query("SELECT COUNT(*) AS count FROM pbi_users WHERE role = 'BA'"),
      pool.query("SELECT * FROM pbi_users ORDER BY created_at DESC LIMIT 5")
    ]);
    const stats = {
      users:      users.rows[0].count,
      workspaces: workspaces.rows[0].count,
      dashboards: dashboards.rows[0].count,
      baUsers:    baUsers.rows[0].count
    };
    res.render('admin/index', { user: req.session.user, stats, recentUsers: recentUsers.rows });
  } catch (err) {
    console.error('Admin overview error:', err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

// ─── USERS ────────────────────────────────────────────────────────────────────

async function loadWorkspacesWithDashboards() {
  const [wsResult, dashResult] = await Promise.all([
    pool.query('SELECT * FROM workspaces ORDER BY name'),
    pool.query('SELECT * FROM dashboards ORDER BY name')
  ]);
  return wsResult.rows.map(ws => ({
    ...ws,
    dashboards: dashResult.rows.filter(d => d.workspace_id === ws.id)
  }));
}

router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.*, p.name AS platform_name, p.domain AS platform_domain
      FROM pbi_users u
      LEFT JOIN platforms p ON p.id = u.platform_id
      ORDER BY u.created_at DESC
    `);
    res.render('admin/users', { user: req.session.user, users: rows, message: req.query.msg });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.get('/users/new', async (req, res) => {
  try {
    const [workspacesWithDashboards, platforms] = await Promise.all([
      loadWorkspacesWithDashboards(),
      pool.query('SELECT * FROM platforms ORDER BY name')
    ]);
    res.render('admin/user-form', {
      user: req.session.user,
      editUser: null,
      workspacesWithDashboards,
      platforms: platforms.rows,
      selectedPlatformId: null,
      assignedWorkspaces: [],
      assignedDashboards: [],
      error: null
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.post('/users/new', async (req, res) => {
  const { email, first_name, last_name, password, role } = req.body;
  const platformIdRaw = req.body.platform_id;
  let workspace_ids  = req.body.workspace_ids  || [];
  let dashboard_ids  = req.body.dashboard_ids  || [];
  if (!Array.isArray(workspace_ids))  workspace_ids  = [workspace_ids];
  if (!Array.isArray(dashboard_ids))  dashboard_ids  = [dashboard_ids];

  // Admins are global (no platform); BA accounts belong to exactly one platform.
  const platformId = role === 'BA' ? (parseInt(platformIdRaw) || null) : null;

  const renderForm = async (error) => {
    const [workspacesWithDashboards, platforms] = await Promise.all([
      loadWorkspacesWithDashboards(),
      pool.query('SELECT * FROM platforms ORDER BY name')
    ]);
    res.render('admin/user-form', {
      user: req.session.user, editUser: null, workspacesWithDashboards,
      platforms: platforms.rows,
      selectedPlatformId: platformId,
      assignedWorkspaces: workspace_ids.map(Number),
      assignedDashboards: dashboard_ids.map(Number),
      error
    });
  };

  if (!email || !first_name || !last_name || !password || !role) {
    return renderForm('All fields are required.');
  }
  if (role === 'BA' && !platformId) {
    return renderForm('Please select a platform for this Business Analyst account.');
  }

  const client = await pool.connect();
  try {
    // Admin emails must be globally unique; BA emails are unique per platform
    // (the same person can have a separate BA account on each platform).
    const { rows: existing } = await client.query(
      role === 'admin'
        ? 'SELECT id FROM pbi_users WHERE email = $1 AND platform_id IS NULL'
        : 'SELECT id FROM pbi_users WHERE email = $1 AND platform_id = $2',
      role === 'admin' ? [email] : [email, platformId]
    );
    if (existing.length) return renderForm('A user with this email already exists on this platform.');

    await client.query('BEGIN');
    const { rows: inserted } = await client.query(
      'INSERT INTO pbi_users (email, first_name, last_name, password, role, platform_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, first_name, last_name, password, role, platformId]
    );
    const newId = inserted[0].id;

    for (const wid of workspace_ids) {
      await client.query(
        'INSERT INTO user_workspace_access (user_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [newId, parseInt(wid)]
      );
    }
    for (const did of dashboard_ids) {
      await client.query(
        'INSERT INTO user_dashboard_access (user_id, dashboard_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [newId, parseInt(did)]
      );
    }

    await client.query('COMMIT');
    res.redirect('/admin/users?msg=User+created+successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create user error:', err.message);
    renderForm('A server error occurred. Please try again.');
  } finally {
    client.release();
  }
});

router.get('/users/:id/edit', async (req, res) => {
  try {
    const { rows: userRows } = await pool.query('SELECT * FROM pbi_users WHERE id = $1', [req.params.id]);
    if (!userRows.length) return res.redirect('/admin/users');
    const editUser = userRows[0];

    const [workspacesWithDashboards, platforms, wsAccess, dashAccess] = await Promise.all([
      loadWorkspacesWithDashboards(),
      pool.query('SELECT * FROM platforms ORDER BY name'),
      pool.query('SELECT workspace_id FROM user_workspace_access WHERE user_id = $1', [editUser.id]),
      pool.query('SELECT dashboard_id FROM user_dashboard_access WHERE user_id = $1', [editUser.id])
    ]);

    res.render('admin/user-form', {
      user: req.session.user,
      editUser,
      workspacesWithDashboards,
      platforms: platforms.rows,
      selectedPlatformId: editUser.platform_id,
      assignedWorkspaces: wsAccess.rows.map(r => r.workspace_id),
      assignedDashboards: dashAccess.rows.map(r => r.dashboard_id),
      error: null
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.post('/users/:id/edit', async (req, res) => {
  const userId = parseInt(req.params.id);
  const { email, first_name, last_name, password, role } = req.body;
  const platformIdRaw = req.body.platform_id;
  let workspace_ids = req.body.workspace_ids || [];
  let dashboard_ids = req.body.dashboard_ids || [];
  if (!Array.isArray(workspace_ids)) workspace_ids = [workspace_ids];
  if (!Array.isArray(dashboard_ids)) dashboard_ids = [dashboard_ids];

  const platformId = role === 'BA' ? (parseInt(platformIdRaw) || null) : null;

  const renderForm = async (error) => {
    const [workspacesWithDashboards, platforms, userResult] = await Promise.all([
      loadWorkspacesWithDashboards(),
      pool.query('SELECT * FROM platforms ORDER BY name'),
      pool.query('SELECT * FROM pbi_users WHERE id = $1', [userId])
    ]);
    res.render('admin/user-form', {
      user: req.session.user,
      editUser: userResult.rows[0],
      workspacesWithDashboards,
      platforms: platforms.rows,
      selectedPlatformId: platformId,
      assignedWorkspaces: workspace_ids.map(Number),
      assignedDashboards: dashboard_ids.map(Number),
      error
    });
  };

  if (!email || !first_name || !last_name || !password || !role) {
    return renderForm('All fields are required.');
  }
  if (role === 'BA' && !platformId) {
    return renderForm('Please select a platform for this Business Analyst account.');
  }

  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      role === 'admin'
        ? 'SELECT id FROM pbi_users WHERE email = $1 AND platform_id IS NULL AND id != $2'
        : 'SELECT id FROM pbi_users WHERE email = $1 AND platform_id = $2 AND id != $3',
      role === 'admin' ? [email, userId] : [email, platformId, userId]
    );
    if (existing.length) return renderForm('A user with this email already exists on this platform.');

    await client.query('BEGIN');
    await client.query(
      'UPDATE pbi_users SET email=$1, first_name=$2, last_name=$3, password=$4, role=$5, platform_id=$6 WHERE id=$7',
      [email, first_name, last_name, password, role, platformId, userId]
    );

    await client.query('DELETE FROM user_workspace_access WHERE user_id = $1', [userId]);
    for (const wid of workspace_ids) {
      await client.query(
        'INSERT INTO user_workspace_access (user_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [userId, parseInt(wid)]
      );
    }

    await client.query('DELETE FROM user_dashboard_access WHERE user_id = $1', [userId]);
    for (const did of dashboard_ids) {
      await client.query(
        'INSERT INTO user_dashboard_access (user_id, dashboard_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [userId, parseInt(did)]
      );
    }

    await client.query('COMMIT');
    res.redirect('/admin/users?msg=User+updated+successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update user error:', err.message);
    renderForm('A server error occurred. Please try again.');
  } finally {
    client.release();
  }
});

router.post('/users/:id/delete', async (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.session.user.id) {
    return res.redirect('/admin/users?msg=Cannot+delete+your+own+account');
  }
  try {
    await pool.query('DELETE FROM pbi_users WHERE id = $1', [userId]);
    res.redirect('/admin/users?msg=User+deleted+successfully');
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/users?msg=Error+deleting+user');
  }
});

// ─── WORKSPACES ───────────────────────────────────────────────────────────────

router.get('/workspaces', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT w.*, COUNT(d.id) AS dashboard_count
      FROM workspaces w
      LEFT JOIN dashboards d ON d.workspace_id = w.id
      GROUP BY w.id ORDER BY w.created_at DESC
    `);
    res.render('admin/workspaces', { user: req.session.user, workspaces: rows, message: req.query.msg });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.get('/workspaces/new', (req, res) => {
  res.render('admin/workspace-form', { user: req.session.user, editWorkspace: null, error: null });
});

router.post('/workspaces/new', async (req, res) => {
  const { name, description, pbi_workspace_id } = req.body;
  if (!name || !pbi_workspace_id) {
    return res.render('admin/workspace-form', {
      user: req.session.user, editWorkspace: null,
      error: 'Name and Power BI Workspace ID are required.'
    });
  }
  try {
    await pool.query(
      'INSERT INTO workspaces (name, description, pbi_workspace_id) VALUES ($1,$2,$3)',
      [name, description || '', pbi_workspace_id]
    );
    res.redirect('/admin/workspaces?msg=Workspace+created+successfully');
  } catch (err) {
    console.error(err.message);
    res.render('admin/workspace-form', {
      user: req.session.user, editWorkspace: null, error: 'A server error occurred.'
    });
  }
});

router.get('/workspaces/:id/edit', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.redirect('/admin/workspaces');
    res.render('admin/workspace-form', { user: req.session.user, editWorkspace: rows[0], error: null });
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/workspaces');
  }
});

router.post('/workspaces/:id/edit', async (req, res) => {
  const { name, description, pbi_workspace_id } = req.body;
  if (!name || !pbi_workspace_id) {
    const { rows } = await pool.query('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    return res.render('admin/workspace-form', {
      user: req.session.user, editWorkspace: rows[0] || null,
      error: 'Name and Power BI Workspace ID are required.'
    });
  }
  try {
    await pool.query(
      'UPDATE workspaces SET name=$1, description=$2, pbi_workspace_id=$3 WHERE id=$4',
      [name, description || '', pbi_workspace_id, req.params.id]
    );
    res.redirect('/admin/workspaces?msg=Workspace+updated+successfully');
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/workspaces?msg=Error+updating+workspace');
  }
});

router.post('/workspaces/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM workspaces WHERE id = $1', [req.params.id]);
    res.redirect('/admin/workspaces?msg=Workspace+deleted+successfully');
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/workspaces?msg=Error+deleting+workspace');
  }
});

// ─── DASHBOARDS ───────────────────────────────────────────────────────────────

router.get('/dashboards', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.*, w.name AS workspace_name
      FROM dashboards d
      INNER JOIN workspaces w ON w.id = d.workspace_id
      ORDER BY d.created_at DESC
    `);
    res.render('admin/dashboards', { user: req.session.user, dashboards: rows, message: req.query.msg });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.get('/dashboards/new', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM workspaces ORDER BY name');
    res.render('admin/dashboard-form', {
      user: req.session.user, editDashboard: null, workspaces: rows, error: null
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.post('/dashboards/new', async (req, res) => {
  const { name, description, pbi_report_id, workspace_id } = req.body;
  if (!name || !pbi_report_id || !workspace_id) {
    const { rows } = await pool.query('SELECT * FROM workspaces ORDER BY name');
    return res.render('admin/dashboard-form', {
      user: req.session.user, editDashboard: null, workspaces: rows,
      error: 'Name, Report ID, and Workspace are required.'
    });
  }
  try {
    await pool.query(
      'INSERT INTO dashboards (name, description, pbi_report_id, workspace_id) VALUES ($1,$2,$3,$4)',
      [name, description || '', pbi_report_id, workspace_id]
    );
    res.redirect('/admin/dashboards?msg=Dashboard+created+successfully');
  } catch (err) {
    console.error(err.message);
    const { rows } = await pool.query('SELECT * FROM workspaces ORDER BY name');
    res.render('admin/dashboard-form', {
      user: req.session.user, editDashboard: null, workspaces: rows, error: 'A server error occurred.'
    });
  }
});

router.get('/dashboards/:id/edit', async (req, res) => {
  try {
    const [dashResult, wsResult] = await Promise.all([
      pool.query('SELECT * FROM dashboards WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM workspaces ORDER BY name')
    ]);
    if (!dashResult.rows.length) return res.redirect('/admin/dashboards');
    res.render('admin/dashboard-form', {
      user: req.session.user, editDashboard: dashResult.rows[0],
      workspaces: wsResult.rows, error: null
    });
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/dashboards');
  }
});

router.post('/dashboards/:id/edit', async (req, res) => {
  const { name, description, pbi_report_id, workspace_id } = req.body;
  if (!name || !pbi_report_id || !workspace_id) {
    const [dashResult, wsResult] = await Promise.all([
      pool.query('SELECT * FROM dashboards WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM workspaces ORDER BY name')
    ]);
    return res.render('admin/dashboard-form', {
      user: req.session.user, editDashboard: dashResult.rows[0] || null,
      workspaces: wsResult.rows, error: 'Name, Report ID, and Workspace are required.'
    });
  }
  try {
    await pool.query(
      'UPDATE dashboards SET name=$1, description=$2, pbi_report_id=$3, workspace_id=$4 WHERE id=$5',
      [name, description || '', pbi_report_id, workspace_id, req.params.id]
    );
    res.redirect('/admin/dashboards?msg=Dashboard+updated+successfully');
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/dashboards?msg=Error+updating+dashboard');
  }
});

router.post('/dashboards/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM dashboards WHERE id = $1', [req.params.id]);
    res.redirect('/admin/dashboards?msg=Dashboard+deleted+successfully');
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/dashboards?msg=Error+deleting+dashboard');
  }
});

// ─── PLATFORMS (multi-domain tenants) ────────────────────────────────────────

// Accepts a bare hostname or a pasted full URL (e.g. "https://botox.example.com/")
// and reduces it to the bare hostname Express's req.hostname will report
// (no protocol, no port, no path) so platform detection matches reliably.
function normalizeDomain(input) {
  let d = (input || '').trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip protocol (http://, https://, ...)
  d = d.split('/')[0];                          // strip path
  d = d.split('?')[0];                          // strip query
  d = d.split(':')[0];                          // strip port
  return d;
}

router.get('/platforms', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*,
        COUNT(DISTINCT pu.id)  AS user_count,
        COUNT(DISTINCT pda.dashboard_id) AS dashboard_count
      FROM platforms p
      LEFT JOIN pbi_users pu ON pu.platform_id = p.id
      LEFT JOIN platform_dashboard_access pda ON pda.platform_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    res.render('admin/platforms', { user: req.session.user, platforms: rows, message: req.query.msg });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.get('/platforms/new', async (req, res) => {
  try {
    const workspacesWithDashboards = await loadWorkspacesWithDashboards();
    res.render('admin/platform-form', {
      user: req.session.user,
      editPlatform: null,
      workspacesWithDashboards,
      assignedDashboards: [],
      error: null
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('error', { user: req.session.user, message: 'Server error.', code: 500 });
  }
});

router.post('/platforms/new', uploadPlatformLogo, async (req, res) => {
  const {
    domain, name, description,
    pbi_client_id, pbi_username, pbi_password, pbi_authority_url, pbi_scope, pbi_api_url
  } = req.body;
  let dashboard_ids = req.body.dashboard_ids || [];
  if (!Array.isArray(dashboard_ids)) dashboard_ids = [dashboard_ids];

  const renderForm = async (error) => {
    const workspacesWithDashboards = await loadWorkspacesWithDashboards();
    res.render('admin/platform-form', {
      user: req.session.user,
      editPlatform: null,
      workspacesWithDashboards,
      assignedDashboards: dashboard_ids.map(Number),
      error
    });
  };

  if (!domain || !name) {
    return renderForm('Domain and Name are required.');
  }

  const normalizedDomain = normalizeDomain(domain);
  const logoUrl = logoUrlFor(req.file) || '';
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query('SELECT id FROM platforms WHERE domain = $1', [normalizedDomain]);
    if (existing.length) return renderForm('A platform with this domain already exists.');

    await client.query('BEGIN');
    const { rows: inserted } = await client.query(`
      INSERT INTO platforms
        (domain, name, description, pbi_client_id, pbi_username, pbi_password, pbi_authority_url, pbi_scope, pbi_api_url, logo_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [
      normalizedDomain, name, description || '',
      pbi_client_id || '', pbi_username || '', pbi_password || '',
      pbi_authority_url || '', pbi_scope || '', pbi_api_url || '', logoUrl
    ]);
    const newId = inserted[0].id;

    for (const did of dashboard_ids) {
      await client.query(
        'INSERT INTO platform_dashboard_access (platform_id, dashboard_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [newId, parseInt(did)]
      );
    }

    await client.query('COMMIT');
    res.redirect('/admin/platforms?msg=Platform+created+successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create platform error:', err.message);
    renderForm('A server error occurred. Please try again.');
  } finally {
    client.release();
  }
});

router.get('/platforms/:id/edit', async (req, res) => {
  try {
    const { rows: platRows } = await pool.query('SELECT * FROM platforms WHERE id = $1', [req.params.id]);
    if (!platRows.length) return res.redirect('/admin/platforms');

    const [workspacesWithDashboards, dashAccess] = await Promise.all([
      loadWorkspacesWithDashboards(),
      pool.query('SELECT dashboard_id FROM platform_dashboard_access WHERE platform_id = $1', [platRows[0].id])
    ]);

    res.render('admin/platform-form', {
      user: req.session.user,
      editPlatform: platRows[0],
      workspacesWithDashboards,
      assignedDashboards: dashAccess.rows.map(r => r.dashboard_id),
      error: null
    });
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/platforms');
  }
});

router.post('/platforms/:id/edit', uploadPlatformLogo, async (req, res) => {
  const platformId = parseInt(req.params.id);
  const {
    domain, name, description,
    pbi_client_id, pbi_username, pbi_password, pbi_authority_url, pbi_scope, pbi_api_url
  } = req.body;
  const removeLogo = req.body.remove_logo === 'on';
  let dashboard_ids = req.body.dashboard_ids || [];
  if (!Array.isArray(dashboard_ids)) dashboard_ids = [dashboard_ids];

  const renderForm = async (error) => {
    const [workspacesWithDashboards, platResult] = await Promise.all([
      loadWorkspacesWithDashboards(),
      pool.query('SELECT * FROM platforms WHERE id = $1', [platformId])
    ]);
    res.render('admin/platform-form', {
      user: req.session.user,
      editPlatform: platResult.rows[0],
      workspacesWithDashboards,
      assignedDashboards: dashboard_ids.map(Number),
      error
    });
  };

  if (!domain || !name) {
    return renderForm('Domain and Name are required.');
  }

  const normalizedDomain = normalizeDomain(domain);
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      'SELECT id FROM platforms WHERE domain = $1 AND id != $2',
      [normalizedDomain, platformId]
    );
    if (existing.length) return renderForm('A platform with this domain already exists.');

    // Logo precedence: a freshly uploaded file replaces it, the "remove" checkbox
    // clears it, otherwise the existing logo is kept untouched.
    const { rows: currentRows } = await client.query('SELECT logo_url FROM platforms WHERE id = $1', [platformId]);
    const uploadedLogoUrl = logoUrlFor(req.file);
    const logoUrl = uploadedLogoUrl || (removeLogo ? '' : (currentRows[0]?.logo_url || ''));

    await client.query('BEGIN');
    await client.query(`
      UPDATE platforms SET
        domain=$1, name=$2, description=$3,
        pbi_client_id=$4, pbi_username=$5, pbi_password=$6,
        pbi_authority_url=$7, pbi_scope=$8, pbi_api_url=$9, logo_url=$10
      WHERE id=$11
    `, [
      normalizedDomain, name, description || '',
      pbi_client_id || '', pbi_username || '', pbi_password || '',
      pbi_authority_url || '', pbi_scope || '', pbi_api_url || '', logoUrl, platformId
    ]);

    await client.query('DELETE FROM platform_dashboard_access WHERE platform_id = $1', [platformId]);
    for (const did of dashboard_ids) {
      await client.query(
        'INSERT INTO platform_dashboard_access (platform_id, dashboard_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [platformId, parseInt(did)]
      );
    }

    await client.query('COMMIT');
    res.redirect('/admin/platforms?msg=Platform+updated+successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update platform error:', err.message);
    renderForm('A server error occurred. Please try again.');
  } finally {
    client.release();
  }
});

router.post('/platforms/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM platforms WHERE id = $1', [req.params.id]);
    res.redirect('/admin/platforms?msg=Platform+deleted+successfully');
  } catch (err) {
    console.error(err.message);
    res.redirect('/admin/platforms?msg=Error+deleting+platform');
  }
});

module.exports = router;
