const pg = require('pg');

// Return bigint (COUNT results) as JS numbers instead of strings
pg.types.setTypeParser(20, val => parseInt(val, 10));

const { Pool } = pg;

const SCHEMA = process.env.PG_SCHEMA || 'nexor_systems';

const pool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT  || '18722'),
  database: process.env.PG_DATABASE       || 'learning_db',
  user:     process.env.PG_USER           || 'avnadmin',
  password: process.env.PG_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  max:      10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000
});

// Set search_path for every connection from the pool
pool.on('connect', client => {
  client.query(`SET search_path TO ${SCHEMA}, public`).catch(console.error);
});

pool.on('error', err => {
  console.error('PostgreSQL pool error:', err.message);
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Ensure schema exists then pin the search_path for this init session
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}, public`);

    // ── Platforms (multi-domain tenants) ───────────────────────
    // Created before pbi_users so it can be referenced by platform_id.
    await client.query(`
      CREATE TABLE IF NOT EXISTS platforms (
        id                SERIAL      PRIMARY KEY,
        domain            TEXT        UNIQUE NOT NULL,
        name              TEXT        NOT NULL,
        description       TEXT        NOT NULL DEFAULT '',
        pbi_client_id     TEXT        NOT NULL DEFAULT '',
        pbi_username      TEXT        NOT NULL DEFAULT '',
        pbi_password      TEXT        NOT NULL DEFAULT '',
        pbi_authority_url TEXT        NOT NULL DEFAULT '',
        pbi_scope         TEXT        NOT NULL DEFAULT '',
        pbi_api_url       TEXT        NOT NULL DEFAULT '',
        logo_url          TEXT        NOT NULL DEFAULT '',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS pbi_api_url TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ms_sso_enabled BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ms_tenant_id TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ms_client_id TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ms_client_secret TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS sso_email_domain TEXT NOT NULL DEFAULT ''`);

    // ── PBI Users (prefixed to avoid collision with other app's users table) ──
    // platform_id is NULL for global admins; required (enforced in app layer) for BA users.
    // The same email may exist across multiple platforms as separate accounts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pbi_users (
        id          SERIAL      PRIMARY KEY,
        email       TEXT        NOT NULL,
        first_name  TEXT        NOT NULL,
        last_name   TEXT        NOT NULL,
        password    TEXT        NOT NULL,
        role        TEXT        NOT NULL DEFAULT 'BA'
                                CHECK (role IN ('admin', 'BA')),
        platform_id INTEGER     REFERENCES platforms(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration support for pre-existing installs: drop the old global unique
    // constraint on email and add the platform_id column if missing.
    await client.query(`ALTER TABLE pbi_users DROP CONSTRAINT IF EXISTS pbi_users_email_key`);
    await client.query(`ALTER TABLE pbi_users ADD COLUMN IF NOT EXISTS platform_id INTEGER REFERENCES platforms(id) ON DELETE CASCADE`);

    // Scoped uniqueness: one email per platform for BA users, and a separate
    // uniqueness scope for admins (platform_id IS NULL).
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pbi_users_platform_email
        ON pbi_users (platform_id, email) WHERE platform_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pbi_users_admin_email
        ON pbi_users (email) WHERE platform_id IS NULL
    `);

    // ── Workspaces ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id               SERIAL      PRIMARY KEY,
        name             TEXT        NOT NULL,
        description      TEXT        NOT NULL DEFAULT '',
        pbi_workspace_id TEXT        NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Dashboards ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id            SERIAL      PRIMARY KEY,
        name          TEXT        NOT NULL,
        description   TEXT        NOT NULL DEFAULT '',
        pbi_report_id TEXT        NOT NULL,
        workspace_id  INTEGER     NOT NULL
                      REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── User-Workspace Access ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_workspace_access (
        user_id      INTEGER NOT NULL REFERENCES pbi_users(id)  ON DELETE CASCADE,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, workspace_id)
      )
    `);

    // ── User-Dashboard Access ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_dashboard_access (
        user_id      INTEGER NOT NULL REFERENCES pbi_users(id)  ON DELETE CASCADE,
        dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, dashboard_id)
      )
    `);

    // ── Platform-Dashboard Access (per-domain curation) ────────
    // Controls which dashboards are exposed on a given platform/domain.
    // Workspace visibility on a platform is derived from this (a workspace
    // shows up if it has at least one curated dashboard for that platform).
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_dashboard_access (
        platform_id  INTEGER NOT NULL REFERENCES platforms(id)  ON DELETE CASCADE,
        dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        PRIMARY KEY (platform_id, dashboard_id)
      )
    `);

    // ── Seed default data once ─────────────────────────────────
    const { rows } = await client.query('SELECT COUNT(*) AS count FROM pbi_users');
    if (rows[0].count === 0) {
      await client.query(`
        INSERT INTO pbi_users (email, first_name, last_name, password, role)
        VALUES ('admin@company.com', 'Admin', 'User', 'admin123', 'admin')
      `);

      const { rows: wsRows } = await client.query(`
        INSERT INTO workspaces (name, description, pbi_workspace_id)
        VALUES ('MyPharmaDash', 'Default pharmaceutical dashboard workspace',
                '7cbf476f-a513-489e-a712-504dd06191ac')
        RETURNING id
      `);

      const { rows: dashRows } = await client.query(`
        INSERT INTO dashboards (name, description, pbi_report_id, workspace_id)
        VALUES ('Main Dashboard', 'Primary Power BI report',
                '0b6bceab-9a92-4f68-b840-e708301b4414', $1)
        RETURNING id
      `, [wsRows[0].id]);

      console.log('Seeded default admin → admin@company.com / admin123');
    }

    console.log(`PostgreSQL ready  schema: ${SCHEMA}`);
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase };
