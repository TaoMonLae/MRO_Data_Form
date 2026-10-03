const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function loadModule(file, replacements = {}, env = {}) {
  const filename = path.join(__dirname, '..', file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const requireMock = name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace(/^#!.*\n/, ''), {
    require: requireMock, module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env }, Buffer, URL, console: { log() {}, warn() {}, error() {} }
  }, { filename });
  return module.exports;
}

function loadDatabase(env = {}, client = {}) {
  let pool;
  class MockPool extends EventEmitter {
    constructor(options) { super(); this.options = options; pool = this; }
    async connect() { return client; }
  }
  const database = loadModule('database.js', { pg: { Pool: MockPool } }, {
    DATABASE_URL: 'postgres://test:test@localhost/test', ...env
  });
  return { database, pool };
}

test('DATABASE_SSL verifies certificates even when the URL asks to disable verification', () => {
  const { pool } = loadDatabase({ DATABASE_SSL: 'true', DATABASE_URL: 'postgres://test:test@localhost/test?sslmode=no-verify&uselibpqcompat=true' });
  const { Client } = require('pg');
  const client = new Client(pool.options);
  assert.ok(client.ssl);
  assert.notEqual(client.ssl.rejectUnauthorized, false);
  assert.equal(client.ssl.checkServerIdentity, undefined);
  assert.equal(new URL(pool.options.connectionString).searchParams.get('sslmode'), 'verify-full');
});

test('invalid pool sizes fail before a connection is opened', () => {
  for (const size of ['NaN', '0', '-1', '1.5', '101']) {
    assert.throws(() => loadDatabase({ DATABASE_POOL_MAX: size }), /DATABASE_POOL_MAX/);
  }
});

test('database business days use Malaysia time without removing connection options', () => {
  const { pool } = loadDatabase({ DATABASE_URL: 'postgres://test:test@localhost/test?options=-c%20search_path%3Dtest_schema' });
  const { Client } = require('pg');
  const client = new Client(pool.options);
  assert.equal(client.connectionParameters.options, '-c search_path=test_schema -c timezone=Asia/Kuala_Lumpur');
});

test('an idle PostgreSQL connection failure is handled without crashing', () => {
  const { pool } = loadDatabase();
  assert.doesNotThrow(() => pool.emit('error', new Error('disconnected')));
});

test('failed rollback preserves the original error and discards the client once', async () => {
  const original = new Error('write failed');
  const disconnected = new Error('connection lost');
  const releases = [];
  const { database } = loadDatabase({}, {
    async query(sql) { if (sql === 'ROLLBACK') throw disconnected; return { rows: [], rowCount: 0 }; },
    release(error) { releases.push(error); }
  });
  await assert.rejects(database.transaction(async () => { throw original; }), error => error === original);
  assert.deepEqual(releases, [disconnected]);
});

test('successful transactions commit and release their connection once', async () => {
  const calls = [];
  const { database } = loadDatabase({}, {
    async query(sql, params) { calls.push([sql, params]); return { rows: [{ id: 7 }], rowCount: 1 }; },
    release(error) { calls.push(['release', error]); }
  });
  assert.equal(await database.transaction(async ({ get }) => (await get('SELECT id WHERE email = ?', ['person@example.org'])).id), 7);
  assert.deepEqual(calls.map(call => call[0]), ['BEGIN', 'SELECT id WHERE email = $1', 'COMMIT', 'release']);
});

function migrationHelpers() {
  return loadModule('scripts/migrate-sqlite-to-postgres.js', {
    dotenv: { config() {} }, sqlite3: { verbose() { return {}; } }, '../database': {}
  });
}

test('migration dates reject impossible calendar values without silently replacing data', () => {
  const { isoDate, timestamp, attendanceTimestamp } = migrationHelpers();
  assert.equal(isoDate('29/02/2024'), '2024-02-29');
  assert.throws(() => isoDate('29/02/2025'), /invalid date/);
  assert.throws(() => timestamp('not a timestamp'), /invalid timestamp/);
  assert.throws(() => timestamp('2025-02-30 12:00:00'), /invalid date/);
  assert.throws(() => attendanceTimestamp('2026-10-03', '25:01'), /invalid attendance time/);
  assert.equal(attendanceTimestamp('2026-10-03', '09:12:30').toISOString(), '2026-10-03T01:12:30.000Z');
  assert.equal(timestamp('2026-10-03 01:02:03').toISOString(), '2026-10-03T01:02:03.000Z');
  assert.equal(timestamp(1700000000).toISOString(), timestamp(1700000000000).toISOString());
});

test('migration preserves explicit inactive states and rejects malformed family records', () => {
  const { booleanValue, jsonArray } = migrationHelpers();
  assert.equal(booleanValue('0'), false);
  assert.equal(booleanValue('false'), false);
  assert.equal(booleanValue('1'), true);
  assert.equal(booleanValue(null, true), true);
  assert.throws(() => booleanValue('unknown'), /invalid account status/);
  assert.equal(jsonArray('[{"name":"Family member"}]'), '[{"name":"Family member"}]');
  assert.throws(() => jsonArray('{bad json}'), /invalid family data/);
  assert.throws(() => jsonArray('{}'), /JSON array/);
});

test('admin recovery revokes sessions and records the reset inside the account transaction', async () => {
  const calls = [];
  let inTransaction = false;
  const { main } = loadModule('scripts/ensure-admin.js', {
    dotenv: { config() {} },
    '../database': {
      async initializeDatabase() {},
      async transaction(callback) {
        inTransaction = true;
        await callback({
          async get(sql) { calls.push(sql); return { id: 9 }; },
          async run(sql, params) { assert.equal(inTransaction, true); calls.push(sql); assert.equal(String(params[0]), '9'); }
        });
        inTransaction = false;
      }
    }
  }, { INITIAL_ADMIN_EMAIL: 'admin@example.org', INITIAL_ADMIN_PASSWORD: 'TemporaryPassword1!' });
  await main();
  assert.equal(calls.length, 4);
  assert.match(calls[0], /pg_advisory_xact_lock/);
  assert.match(calls[1], /ON CONFLICT \(LOWER\(email\)\) DO UPDATE/);
  assert.match(calls[2], /DELETE FROM sessions/);
  assert.match(calls[3], /INSERT INTO audit_logs/);
});
