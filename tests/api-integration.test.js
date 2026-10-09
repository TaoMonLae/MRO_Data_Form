const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const ExcelJS = require('exceljs');

// Explicit opt-in: this suite clears fixtures in a disposable mro_test_* database.
test('API security and data regression suite', { skip: !process.env.MRO_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.MRO_TEST_DATABASE_URL);
  assert.match(url.pathname, /^\/mro_test_[a-z0-9_]+$/);
  process.env.DATABASE_URL = url.href;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'test';
  delete process.env.APP_ORIGIN;
  const db = require('../database');
  const { hashPassword } = require('../security');
  const { app } = require('../app-server');
  await db.initializeDatabase();
  await db.run('TRUNCATE users, submissions, sessions, attendance, audit_logs, finance_records, carding_records, import_batches, staff_profiles RESTART IDENTITY CASCADE');
  await db.initializeDatabase(); // Recreate settings removed through user foreign-key cascades.
  await db.run('UPDATE app_settings SET geofence_enabled = FALSE WHERE id = 1');
  const password = 'Audit-fixture-password-42';
  const passwordHash = await hashPassword(password);
  const users = {};
  for (const role of ['admin', 'chair', 'secretary', 'hr', 'finance', 'data_management', 'card_printing']) {
    const result = await db.run('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?) RETURNING id', [`Test ${role}`, `${role}@audit.invalid`, role, passwordHash]);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL '1 hour')", [crypto.createHash('sha256').update(token).digest('hex'), result.lastID]);
    users[role] = { id: result.lastID, cookie: `mro_session=${token}` };
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const photoPaths = new Set();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const filename of photoPaths) await fs.unlink(filename).catch(() => {});
    await db.closeDatabase();
  });
  async function request(route, { role = 'admin', method = 'GET', body, headers = {}, csrf = true } = {}) {
    const response = await fetch(`${base}${route}`, {
      method, headers: { ...(role ? { Cookie: users[role].cookie } : {}),
        ...(csrf ? { 'X-MRO-Request': '1' } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
    });
    const data = response.status === 204 ? null : response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, response };
  }

  await t.test('anonymous access and cross-origin mutations are denied', async () => {
    assert.equal((await request('/api/users', { role: null })).status, 401);
    assert.equal((await request('/api/auth/logout', { method: 'POST', csrf: false })).status, 403);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await request('/api/auth/session', { headers: { Cookie: 'bad=%zz; mro_session=%zz' } })).status, 401);
    assert.equal((await request('/api/users')).response.headers.get('cache-control'), 'no-store');
    const page = await request('/', { role: null });
    for (const match of page.data.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)) {
      assert.equal((await request(match[1], { role: null })).status, 200, `Production asset ${match[1]} must remain public`);
    }
  });

  await t.test('member detail routing preserves Excel exports', async () => {
    const exported = await request('/api/members/export');
    assert.equal(exported.status, 200);
    assert.match(exported.response.headers.get('content-type'), /spreadsheetml/);
  });

  await t.test('role matrix is enforced on the server', async () => {
    for (const role of ['secretary', 'finance', 'hr', 'card_printing', 'data_management']) assert.equal((await request('/api/users', { role })).status, 403);
    assert.equal((await request('/api/members', { role: 'finance' })).status, 403);
    assert.equal((await request('/api/finance', { role: 'secretary' })).status, 403);
    assert.equal((await request('/api/attendance', { role: 'secretary' })).data.team.length, 0);
    assert.ok((await request('/api/attendance', { role: 'hr' })).data.team.length > 0);
    assert.equal((await request('/api/users', { role: 'chair', method: 'POST', body: { name: 'Escalated', email: 'bad@audit.invalid', role: 'admin', password } })).status, 403);
    assert.equal((await request(`/api/users/${users.admin.id}`, { method: 'PUT', body: { role: 'finance' } })).status, 409);
  });

  await t.test('photos require member access, validate bytes, and survive conflicting uploads', async () => {
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    function memberForm(bytes = photo) {
      const form = new FormData(); form.set('reference', 'AUDITPHOTO'); form.set('reference_number', 'AUDIT-REF'); form.set('fullname', 'Synthetic Member');
      form.set('photo', new Blob([bytes], { type: 'image/png' }), 'photo.png'); return form;
    }
    assert.equal((await request('/api/members', { method: 'POST', body: memberForm(Buffer.from('<script>bad</script>')) })).status, 400);
    const created = await request('/api/members', { method: 'POST', body: memberForm() });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const listed = await request('/api/members', { role: 'secretary' });
    assert.equal(listed.status, 200);
    const listMember = listed.data.records.find(row => row.id === created.data.id);
    assert.equal(listMember.fullname, 'Synthetic Member');
    assert.equal(Object.hasOwn(listMember, 'family_members_data'), false);
    assert.equal(Object.hasOwn(listMember, 'arrival'), false);
    assert.equal(Object.hasOwn(listMember, 'photo_path'), false);
    const detail = await request(`/api/members/${created.data.id}`, { role: 'secretary' });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.member.family_members_data, []);
    assert.equal(Object.hasOwn(detail.data.member, 'photo_path'), false);
    assert.equal((await request(`/api/members/${created.data.id}`, { role: 'finance' })).status, 403);
    assert.equal((await request('/api/members/999999999999', { role: 'secretary' })).status, 404);
    const stored = await db.get('SELECT * FROM submissions WHERE id = ?', [created.data.id]); photoPaths.add(stored.photo_path);
    const photoRoute = `/uploads/${encodeURIComponent(require('node:path').basename(stored.photo_path))}`;
    assert.equal((await request(photoRoute, { role: null })).status, 401);
    assert.equal((await request(photoRoute, { role: 'finance' })).status, 403);
    assert.equal((await request(photoRoute, { role: 'secretary' })).status, 200);
    assert.equal((await request('/uploads/missing-audit-photo.png', { role: 'secretary' })).status, 404);
    assert.equal((await request(`/assets${photoRoute}`, { role: null })).status, 404);
    assert.equal((await request('/api/members', { method: 'POST', body: memberForm() })).status, 409);
    assert.deepEqual(await fs.readFile(stored.photo_path), photo);
    const invalidDate = new FormData(); invalidDate.set('reference', 'AUDITDATE'); invalidDate.set('fullname', 'Invalid Date'); invalidDate.set('dob', '2026-02-30');
    assert.equal((await request('/api/members', { method: 'POST', body: invalidDate })).status, 400);
    if (process.env.MRO_TEST_PDF === 'true') {
      const printed = await fetch(`${base}/api/members/${created.data.id}/print`, { headers: { Cookie: users.admin.cookie } });
      assert.equal(printed.status, 200);
      assert.match(printed.headers.get('content-type'), /application\/pdf/);
      assert.equal(Buffer.from(await printed.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    }
  });

  await t.test('simultaneous clock actions produce one success and one conflict', async () => {
    for (const action of ['in', 'out']) {
      const results = await Promise.all([0, 1].map(() => request('/api/attendance/clock', { role: 'secretary', method: 'POST', body: { action } })));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    }
  });

  await t.test('invalid amounts and dates fail instead of silently changing financial records', async () => {
    const body = { payment_date: '2026-10-03', concern_person: 'Synthetic payer', amount: '1e3', deduction: 0 };
    assert.equal((await request('/api/finance', { role: 'finance', method: 'POST', body })).status, 400);
    assert.equal((await request('/api/finance', { role: 'finance', method: 'POST', body: { ...body, amount: '10', payment_date: '2026-02-30' } })).status, 400);
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('October_BankedIn');
    sheet.getRow(4).values = [1, '03-10-2026', 'Zero net fixture', 'TEST', 100, 20, 0, 'Zero is intentional'];
    const form = new FormData(); form.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'audit.xlsx');
    const imported = await request('/api/finance/import', { role: 'finance', method: 'POST', body: form });
    assert.equal(imported.status, 200, JSON.stringify(imported.data));
    assert.equal(Number((await db.get('SELECT net_amount FROM finance_records WHERE concern_person = ?', ['Zero net fixture'])).net_amount), 0);
  });

  await t.test('temporary accounts cannot read records before changing their password', async () => {
    const result = await request('/api/users', { method: 'POST', body: { name: 'New staff', email: 'new@audit.invalid', role: 'secretary', password } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const login = await request('/api/auth/login', { role: null, method: 'POST', body: { email: 'new@audit.invalid', password } });
    assert.equal(login.status, 200);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/members', { headers: { Cookie: cookie } })).status, 403);
    const changed = await request('/api/auth/change-password', { method: 'POST', headers: { Cookie: cookie }, body: { current_password: password, new_password: `${password}-new`, confirm_password: `${password}-new` } });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const activeCookie = changed.response.headers.get('set-cookie')?.split(';')[0] || cookie;
    assert.equal((await request('/api/members', { headers: { Cookie: activeCookie } })).status, 200);
  });

  await t.test('password resets and role changes revoke existing sessions', async () => {
    const reset = await request(`/api/users/${users.secretary.id}/reset-password`, { method: 'POST', body: { password: `${password}-reset` } });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    assert.equal((await request('/api/auth/session', { role: 'secretary' })).status, 401);
    const account = await db.get('SELECT must_change_password FROM users WHERE id = ?', [users.secretary.id]);
    assert.equal(account.must_change_password, true);
    assert.equal((await request(`/api/users/${users.finance.id}`, { method: 'PUT', body: { role: 'secretary' } })).status, 200);
    assert.equal((await request('/api/auth/session', { role: 'finance' })).status, 401);
  });

  await t.test('registry audit access cannot disclose finance or staff account details', async () => {
    const activity = (await request('/api/audit', { role: 'data_management' })).data.activity;
    assert.ok(activity.some(event => event.entity_type === 'member'));
    assert.ok(activity.every(event => ['member', 'import', 'photo_import', 'export'].includes(event.entity_type)));
    assert.ok(activity.every(event => !Object.hasOwn(event, 'ip_address')));
    const dashboard = (await request('/api/dashboard', { role: 'data_management' })).data;
    assert.ok(dashboard.activity.every(event => ['member', 'import', 'photo_import', 'export'].includes(event.entity_type)));
  });

  await t.test('account deletion requires matching confirmation and retains historical attendance', async () => {
    assert.equal((await request(`/api/users/${users.secretary.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await request(`/api/users/${users.secretary.id}`, { method: 'DELETE', body: { confirmation: 'secretary@audit.invalid' } })).status, 204);
    assert.equal((await db.get('SELECT active FROM users WHERE id = ?', [users.secretary.id])).active, false);
    assert.ok(await db.get('SELECT id FROM attendance WHERE user_id = ?', [users.secretary.id]));
  });

  await t.test('concurrent administrators cannot deactivate each other and leave zero administrators', async () => {
    const result = await db.run('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?) RETURNING id', ['Second admin', 'second@audit.invalid', 'admin', passwordHash]);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL '1 hour')", [crypto.createHash('sha256').update(token).digest('hex'), result.lastID]);
    const results = await Promise.all([
      request(`/api/users/${result.lastID}`, { method: 'PUT', body: { active: false } }),
      request(`/api/users/${users.admin.id}`, { method: 'PUT', headers: { Cookie: `mro_session=${token}` }, body: { active: false } })
    ]);
    assert.equal(results.filter(result => result.status === 200).length, 1);
    assert.ok(results.some(result => [401, 403, 409].includes(result.status)));
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM users WHERE active = TRUE AND role = 'admin' AND deleted_at IS NULL")).count, 1);
  });
});
