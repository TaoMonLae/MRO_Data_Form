const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and add your PostgreSQL connection string.');
}

const poolMax = Number(process.env.DATABASE_POOL_MAX || 10);
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) {
  throw new Error('DATABASE_POOL_MAX must be an integer between 1 and 100.');
}

let connectionUrl;
try { connectionUrl = new URL(DATABASE_URL); }
catch { throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.'); }
const connectionOptions = connectionUrl.searchParams.get('options') || process.env.PGOPTIONS || '';
// CURRENT_DATE and date_trunc must use the same business day as attendance and
// the UI. Preserve provider/search-path options while making the timezone final.
connectionUrl.searchParams.set('options', `${connectionOptions} -c timezone=Asia/Kuala_Lumpur`.trim());
if (process.env.DATABASE_SSL === 'true') {
  // pg gives URL SSL parameters precedence over its ssl option. Set the mode
  // in the URL too, so sslmode=require/no-verify cannot disable verification.
  connectionUrl.searchParams.set('sslmode', 'verify-full');
}

const pool = new Pool({
  connectionString: connectionUrl.toString(),
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

// Idle connections can fail when PostgreSQL restarts. Without an error listener
// pg emits an unhandled error and terminates the entire application process.
pool.on('error', error => {
  console.error('An idle PostgreSQL connection failed:', error.code || 'CONNECTION_ERROR');
});

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function query(sql, params = [], client = pool) {
  return client.query(postgresSql(sql), params);
}

async function run(sql, params = [], client = pool) {
  const result = await query(sql, params, client);
  return {
    lastID: result.rows[0]?.id,
    changes: result.rowCount,
    rows: result.rows
  };
}

async function get(sql, params = [], client = pool) {
  const result = await query(sql, params, client);
  return result.rows[0];
}

async function all(sql, params = [], client = pool) {
  const result = await query(sql, params, client);
  return result.rows;
}

async function transaction(callback) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const helpers = {
      query: (sql, params = []) => query(sql, params, client),
      run: (sql, params = []) => run(sql, params, client),
      get: (sql, params = []) => get(sql, params, client),
      all: (sql, params = []) => all(sql, params, client)
    };
    const value = await callback(helpers);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) {
      // A disconnected client must not be returned to the pool for reuse.
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function initializeDatabase() {
  await transaction(async ({ query: schemaQuery }) => {
    // Startup may run concurrently in several processes. Serialize schema
    // changes so checks and CREATE/ALTER statements cannot race each other.
    await schemaQuery('SELECT pg_advisory_xact_lock(771462, 1)');
    await schemaQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'chair', 'secretary', 'hr', 'card_printing', 'data_management', 'finance')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      password_changed_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email));

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'chair', 'secretary', 'hr', 'card_printing', 'data_management', 'finance'));

    CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      reference VARCHAR(40) NOT NULL UNIQUE,
      reference_number VARCHAR(80) NOT NULL DEFAULT '',
      unhcr_status TEXT NOT NULL DEFAULT 'No',
      unhcr_file_number TEXT NOT NULL DEFAULT '',
      individual_number TEXT NOT NULL DEFAULT '',
      fullname TEXT NOT NULL,
      father_name TEXT NOT NULL DEFAULT '',
      mother_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      phone2 TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT 'Myanmar',
      ethnicity TEXT NOT NULL DEFAULT 'Mon',
      religion TEXT NOT NULL DEFAULT '',
      gender TEXT NOT NULL DEFAULT '',
      dob DATE,
      arrival DATE,
      address_state TEXT NOT NULL DEFAULT '',
      photo_path TEXT NOT NULL DEFAULT '',
      family_members INTEGER NOT NULL DEFAULT 0,
      vulnerability TEXT NOT NULL DEFAULT 'N/A',
      consent TEXT NOT NULL DEFAULT 'yes',
      family_members_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
    );

    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reference_number VARCHAR(80) NOT NULL DEFAULT '';
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_reference_number_unique
      ON submissions (LOWER(reference_number)) WHERE reference_number <> '';
    CREATE INDEX IF NOT EXISTS submissions_fullname_search ON submissions (LOWER(fullname));
    CREATE INDEX IF NOT EXISTS submissions_created_at ON submissions (created_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);

    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_date DATE NOT NULL,
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      clock_in_latitude DOUBLE PRECISION,
      clock_in_longitude DOUBLE PRECISION,
      clock_in_accuracy_meters DOUBLE PRECISION,
      clock_in_distance_meters DOUBLE PRECISION,
      clock_in_location_captured_at TIMESTAMPTZ,
      clock_out_latitude DOUBLE PRECISION,
      clock_out_longitude DOUBLE PRECISION,
      clock_out_accuracy_meters DOUBLE PRECISION,
      clock_out_distance_meters DOUBLE PRECISION,
      clock_out_location_captured_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, work_date)
    );

    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_latitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_longitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_accuracy_meters DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_distance_meters DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_location_captured_at TIMESTAMPTZ;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_latitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_longitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_accuracy_meters DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_distance_meters DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_location_captured_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS attendance_work_date ON attendance (work_date DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      office_address TEXT NOT NULL,
      geofence_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      geofence_latitude DOUBLE PRECISION,
      geofence_longitude DOUBLE PRECISION,
      geofence_radius_meters INTEGER NOT NULL DEFAULT 150 CHECK (geofence_radius_meters BETWEEN 10 AND 5000),
      geofence_max_accuracy_meters INTEGER NOT NULL DEFAULT 100 CHECK (geofence_max_accuracy_meters BETWEEN 10 AND 1000),
      geofence_max_age_seconds INTEGER NOT NULL DEFAULT 120 CHECK (geofence_max_age_seconds BETWEEN 10 AND 900),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
    );

    INSERT INTO app_settings (id, office_address, geofence_enabled, geofence_latitude, geofence_longitude)
      VALUES (1, '68, Jalan Landak, Pudu, 55100 Kuala Lumpur, Wilayah Persekutuan Kuala Lumpur', TRUE, 3.137768, 101.7124437)
      ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS import_batches (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      import_type TEXT NOT NULL CHECK (import_type IN ('members', 'carding')),
      source_name TEXT NOT NULL,
      rows JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS import_batches_expires_at ON import_batches (expires_at);

    CREATE TABLE IF NOT EXISTS carding_records (
      id BIGSERIAL PRIMARY KEY,
      record_date DATE NOT NULL,
      category TEXT NOT NULL DEFAULT 'service' CHECK (category IN ('service', 'income', 'expense')),
      service_type TEXT NOT NULL,
      paid_cards INTEGER NOT NULL DEFAULT 0 CHECK (paid_cards >= 0),
      unpaid_cards INTEGER NOT NULL DEFAULT 0 CHECK (unpaid_cards >= 0),
      rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'Not recorded',
      notes TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS carding_records_source_key_unique
      ON carding_records (source_key) WHERE source_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS carding_records_date ON carding_records (record_date DESC);

    CREATE TABLE IF NOT EXISTS staff_profiles (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      employment_type TEXT NOT NULL DEFAULT 'full_time'
        CHECK (employment_type IN ('full_time', 'part_time', 'volunteer', 'contract')),
      job_title TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      start_date DATE,
      weekly_target_hours NUMERIC(5,2) NOT NULL DEFAULT 40,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS finance_records (
      id BIGSERIAL PRIMARY KEY,
      payment_date DATE NOT NULL,
      concern_person TEXT NOT NULL DEFAULT '',
      concern_number TEXT NOT NULL DEFAULT '',
      service_type TEXT NOT NULL DEFAULT '',
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'Not recorded',
      payment_status TEXT NOT NULL DEFAULT 'Not recorded',
      notes TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS finance_records_source_key_unique
      ON finance_records (source_key) WHERE source_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS finance_records_payment_date ON finance_records (payment_date DESC);
    CREATE INDEX IF NOT EXISTS finance_records_person_search ON finance_records (LOWER(concern_person));

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS audit_logs_created_at ON audit_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_entity ON audit_logs (entity_type, entity_id);
    `);
  });
}

async function closeDatabase() {
  await pool.end();
}

module.exports = { pool, query, run, get, all, transaction, initializeDatabase, closeDatabase };
