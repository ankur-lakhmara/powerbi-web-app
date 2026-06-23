const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { getEmbedConfig } = require('../services/powerbi');

router.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/workspaces');
  res.redirect('/login');
});

router.get('/workspaces', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    let result;
    if (user.role === 'admin') {
      result = await pool.query(`
        SELECT w.*, COUNT(d.id) AS dashboard_count
        FROM workspaces w
        LEFT JOIN dashboards d ON d.workspace_id = w.id
        GROUP BY w.id
        ORDER BY w.created_at DESC
      `);
    } else {
      // Effective dashboards = explicit user grant ∩ platform curation for
      // the platform this BA account belongs to.
      result = await pool.query(`
        WITH effective_dashboards AS (
          SELECT uda.dashboard_id
          FROM user_dashboard_access uda
          INNER JOIN platform_dashboard_access pda
            ON pda.dashboard_id = uda.dashboard_id AND pda.platform_id = $2
          WHERE uda.user_id = $1
        )
        SELECT w.*, COUNT(ed.dashboard_id) AS dashboard_count
        FROM workspaces w
        INNER JOIN user_workspace_access uwa ON uwa.workspace_id = w.id AND uwa.user_id = $1
        LEFT JOIN dashboards d ON d.workspace_id = w.id
        LEFT JOIN effective_dashboards ed ON ed.dashboard_id = d.id
        GROUP BY w.id
        ORDER BY w.created_at DESC
      `, [user.id, user.platformId]);
    }
    // Skip the workspace picker entirely when there's only one to choose from.
    if (result.rows.length === 1) {
      return res.redirect(`/workspace/${result.rows[0].id}`);
    }

    res.render('workspaces', { user, workspaces: result.rows });
  } catch (err) {
    console.error('Workspaces error:', err.message);
    res.status(500).render('error', { user, message: 'Failed to load workspaces.', code: 500 });
  }
});

router.get('/workspace/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  const workspaceId = parseInt(req.params.id);
  try {
    if (user.role !== 'admin') {
      const { rows } = await pool.query(
        'SELECT 1 FROM user_workspace_access WHERE user_id = $1 AND workspace_id = $2',
        [user.id, workspaceId]
      );
      if (!rows.length) {
        return res.status(403).render('error', {
          user, message: 'You do not have access to this workspace.', code: 403
        });
      }
    }

    const { rows: wsRows } = await pool.query(
      'SELECT * FROM workspaces WHERE id = $1', [workspaceId]
    );
    if (!wsRows.length) {
      return res.status(404).render('error', { user, message: 'Workspace not found.', code: 404 });
    }

    let dashboards;
    if (user.role === 'admin') {
      const { rows } = await pool.query(
        'SELECT * FROM dashboards WHERE workspace_id = $1 ORDER BY created_at DESC',
        [workspaceId]
      );
      dashboards = rows;
    } else {
      // Only show dashboards the user has explicit access to AND that are
      // curated for the platform (domain) this BA account belongs to.
      const { rows } = await pool.query(`
        SELECT d.* FROM dashboards d
        INNER JOIN user_dashboard_access uda ON uda.dashboard_id = d.id AND uda.user_id = $1
        INNER JOIN platform_dashboard_access pda ON pda.dashboard_id = d.id AND pda.platform_id = $3
        WHERE d.workspace_id = $2
        ORDER BY d.created_at DESC
      `, [user.id, workspaceId, user.platformId]);
      dashboards = rows;
    }

    res.render('workspace-detail', { user, workspace: wsRows[0], dashboards });
  } catch (err) {
    console.error('Workspace detail error:', err.message);
    res.status(500).render('error', { user, message: 'Failed to load workspace.', code: 500 });
  }
});

router.get('/dashboard/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  const dashboardId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(`
      SELECT d.*, w.name AS workspace_name, w.pbi_workspace_id
      FROM dashboards d
      INNER JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = $1
    `, [dashboardId]);

    if (!rows.length) {
      return res.status(404).render('error', { user, message: 'Dashboard not found.', code: 404 });
    }
    const dashboard = rows[0];

    if (user.role !== 'admin') {
      // Check workspace-level access
      const { rows: wsAccess } = await pool.query(
        'SELECT 1 FROM user_workspace_access WHERE user_id = $1 AND workspace_id = $2',
        [user.id, dashboard.workspace_id]
      );
      if (!wsAccess.length) {
        return res.status(403).render('error', {
          user, message: 'You do not have access to this workspace.', code: 403
        });
      }
      // Check dashboard-level access
      const { rows: dashAccess } = await pool.query(
        'SELECT 1 FROM user_dashboard_access WHERE user_id = $1 AND dashboard_id = $2',
        [user.id, dashboardId]
      );
      if (!dashAccess.length) {
        return res.status(403).render('error', {
          user, message: 'You do not have access to this report.', code: 403
        });
      }
      // Check platform curation — the dashboard must be exposed on the
      // platform (domain) this BA account belongs to.
      const { rows: platAccess } = await pool.query(
        'SELECT 1 FROM platform_dashboard_access WHERE platform_id = $1 AND dashboard_id = $2',
        [user.platformId, dashboardId]
      );
      if (!platAccess.length) {
        return res.status(403).render('error', {
          user, message: 'This report is not available on this platform.', code: 403
        });
      }
    }

    try {
      const embedConfig = await getEmbedConfig(dashboard.pbi_workspace_id, dashboard.pbi_report_id, req.platform);
      res.render('dashboard', { user, dashboard, embedConfig });
    } catch (pbiErr) {
      console.error('Power BI embed error:', pbiErr.response?.data || pbiErr.message);
      res.render('dashboard', {
        user,
        dashboard,
        embedConfig: null,
        pbiError: pbiErr.response?.data?.error?.message || 'Failed to load Power BI report. Check credentials and report IDs.'
      });
    }
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).render('error', { user, message: 'Failed to load dashboard.', code: 500 });
  }
});

module.exports = router;
