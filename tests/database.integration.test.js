const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');

// Opt in with a disposable local PostgreSQL database. Each run uses a unique
// schema, then removes that schema; application tables are never touched.
test('PostgreSQL startup, administrator recovery and SQLite migration remain atomic', {
  skip: !process.env.MRO_TEST_DATABASE_URL,
  timeout: 30_000
}, async t => {
  const root = path.join(__dirname, '..');
  const schema = `mro_test_${process.pid}_${Date.now()}`;
  const control = new Pool({ connectionString: process.env.MRO_TEST_DATABASE_URL });
  const connection = new URL(process.env.MRO_TEST_DATABASE_URL);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const connectionString = connection.toString();
  const db = new Pool({ connectionString });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mro-db-test-'));
  const env = {
    ...process.env, DATABASE_URL: connectionString, DATABASE_SSL: 'false',
    INITIAL_ADMIN_NAME: 'Test Admin', INITIAL_ADMIN_EMAIL: 'admin@example.org',
    INITIAL_ADMIN_PASSWORD: 'TemporaryPassword1!', SQLITE_DATABASE_PATH: path.join(temporary, 'source.db')
  };
  const runScript = script => execFile(process.execPath, [script], { cwd: root, env });
  let source;
  const sourceRun = (sql, params = []) => new Promise((resolve, reject) => source.run(sql, params, error => error ? reject(error) : resolve()));
  try {
    await control.query(`CREATE SCHEMA ${schema}`);

    await t.test('concurrent startups and administrator recovery do not race', async () => {
      await Promise.all([runScript('scripts/ensure-admin.js'), runScript('scripts/ensure-admin.js')]);
      const users = await db.query('SELECT * FROM users');
      assert.equal(users.rowCount, 1);
      assert.equal(users.rows[0].must_change_password, true);
      await db.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ('test-session', $1, NOW() + INTERVAL '1 hour')", [users.rows[0].id]);
      await runScript('scripts/ensure-admin.js');
      assert.equal((await db.query('SELECT * FROM sessions')).rowCount, 0);
      assert.equal((await db.query("SELECT * FROM audit_logs WHERE action = 'Administrator credentials reset'")).rowCount, 3);
      const timeZoneCheck = await execFile(process.execPath, ['-e', "const db = require('./database'); db.get('SHOW TIME ZONE').then(row => console.log(row.TimeZone)).finally(() => db.closeDatabase())"], { cwd: root, env });
      assert.match(timeZoneCheck.stdout, /Asia\/Kuala_Lumpur/);
    });

    await db.query('TRUNCATE users RESTART IDENTITY CASCADE');
    source = await new Promise((resolve, reject) => {
      const instance = new sqlite3.Database(env.SQLITE_DATABASE_PATH, error => error ? reject(error) : resolve(instance));
    });
    await sourceRun('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, email TEXT, password_hash TEXT, role TEXT, active TEXT, must_change_password INTEGER, password_changed_at TEXT, deleted_at TEXT)');
    await sourceRun("INSERT INTO users VALUES (1, 'Migrated staff', 'STAFF@example.org', 'preserved-hash', 'secretary', '0', 1, '2026-10-01 01:02:03', '2026-10-02 01:02:03')");
    await sourceRun('CREATE TABLE submissions(id INTEGER PRIMARY KEY, reference TEXT, reference_number TEXT, fullname TEXT, dob TEXT, family_members_data TEXT)');
    await sourceRun("INSERT INTO submissions VALUES (1, 'MRO-1', '53570', 'First member', '29/02/2024', '[]')");
    await sourceRun("INSERT INTO submissions VALUES (2, 'MRO-2', '53570', 'Duplicate member', '', '[]')");

    await t.test('a duplicate migration row rolls back the entire import', async () => {
      await assert.rejects(runScript('scripts/migrate-sqlite-to-postgres.js'), /duplicate key value/);
      assert.equal((await db.query('SELECT * FROM users')).rowCount, 0);
      assert.equal((await db.query('SELECT * FROM submissions')).rowCount, 0);
    });

    await sourceRun('DELETE FROM submissions WHERE id = 2');
    await t.test('migration preserves account restrictions, dates and IDs', async () => {
      await runScript('scripts/migrate-sqlite-to-postgres.js');
      const user = (await db.query('SELECT * FROM users')).rows[0];
      assert.equal(user.id, '1');
      assert.equal(user.email, 'staff@example.org');
      assert.equal(user.active, false);
      assert.equal(user.must_change_password, true);
      assert.equal(user.password_changed_at.toISOString(), '2026-10-01T01:02:03.000Z');
      assert.equal(user.deleted_at.toISOString(), '2026-10-02T01:02:03.000Z');
      assert.equal(user.password_hash, 'preserved-hash');
      assert.equal((await db.query("SELECT to_char(dob, 'YYYY-MM-DD') AS dob FROM submissions")).rows[0].dob, '2024-02-29');
      const nextId = (await db.query("INSERT INTO users(name,email,password_hash,role) VALUES ('Next','next@example.org','hash','hr') RETURNING id")).rows[0].id;
      assert.equal(nextId, '2');
    });

    await t.test('migration refuses a populated target without changing rows', async () => {
      await assert.rejects(runScript('scripts/migrate-sqlite-to-postgres.js'), /already contains application data/);
      assert.equal((await db.query('SELECT * FROM users')).rowCount, 2);
      assert.equal((await db.query('SELECT * FROM submissions')).rowCount, 1);
    });
  } finally {
    if (source) await new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve()));
    await db.end();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
