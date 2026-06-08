const { pool } = require('../db/database');

async function injectNavData(req, res, next) {
  if (!req.session?.user) return next();

  try {
    const user = req.session.user;
    let wsResult;

    if (user.role === 'admin') {
      wsResult = await pool.query('SELECT * FROM workspaces ORDER BY name');
    } else {
      wsResult = await pool.query(`
        SELECT w.* FROM workspaces w
        INNER JOIN user_workspace_access uwa ON uwa.workspace_id = w.id AND uwa.user_id = $1
        ORDER BY w.name
      `, [user.id]);
    }

    let allDashboards;
    if (user.role === 'admin') {
      const { rows } = await pool.query(
        'SELECT id, name, description, workspace_id FROM dashboards ORDER BY name'
      );
      allDashboards = rows;
    } else {
      // Only dashboards the user has explicit access to AND that are
      // curated for the platform (domain) this BA account belongs to
      const { rows } = await pool.query(`
        SELECT d.id, d.name, d.description, d.workspace_id
        FROM dashboards d
        INNER JOIN user_dashboard_access uda ON uda.dashboard_id = d.id AND uda.user_id = $1
        INNER JOIN platform_dashboard_access pda ON pda.dashboard_id = d.id AND pda.platform_id = $2
        ORDER BY d.name
      `, [user.id, user.platformId]);
      allDashboards = rows;
    }

    res.locals.navWorkspaces = wsResult.rows.map(ws => ({
      ...ws,
      dashboards: allDashboards.filter(d => d.workspace_id === ws.id)
    }));
  } catch (_) {
    res.locals.navWorkspaces = [];
  }

  next();
}

module.exports = { injectNavData };
