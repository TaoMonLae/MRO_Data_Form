const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseCookies, hashPassword, verifyPassword, protectMutation, createRateLimiter, accountCapabilities } = require('../security');

test('malformed cookies do not crash authentication or pollute cookie objects', () => {
  const cookies = parseCookies({ headers: { cookie: 'broken; bad=%E0%A4%A; mro_session=valid; mro_session=override; __proto__=bad' } });
  assert.equal(cookies.mro_session, 'valid');
  assert.equal(cookies.bad, undefined);
  assert.equal(Object.getPrototypeOf(cookies), null);
});

function requestGuard(method, headers = {}) {
  let status = 200; let allowed = false;
  const req = { method, protocol: 'https', get: name => ({ host: 'portal.example.org', ...headers })[name.toLowerCase()] };
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  protectMutation(req, res, () => { allowed = true; });
  return { status, allowed };
}

test('CSRF guard rejects simple forms, cross-site requests and untrusted origins', () => {
  const previous = process.env.APP_ORIGIN;
  delete process.env.APP_ORIGIN;
  try {
    assert.deepEqual(requestGuard('POST'), { status: 403, allowed: false });
    assert.equal(requestGuard('PUT', { 'x-mro-request': '1', 'sec-fetch-site': 'cross-site' }).status, 403);
    assert.equal(requestGuard('DELETE', { 'x-mro-request': '1', origin: 'https://attacker.example.org' }).status, 403);
    assert.equal(requestGuard('POST', { 'x-mro-request': '1', origin: 'null' }).status, 403);
    assert.equal(requestGuard('POST', { 'x-mro-request': '1', origin: 'https://portal.example.org' }).allowed, true);
    assert.equal(requestGuard('POST', { 'x-mro-request': '1' }).allowed, true);
    assert.equal(requestGuard('GET').allowed, true);
    process.env.APP_ORIGIN = 'https://proxy.example.org';
    assert.equal(requestGuard('POST', { 'x-mro-request': '1', origin: 'https://proxy.example.org' }).allowed, true);
    assert.equal(requestGuard('POST', { 'x-mro-request': '1', origin: 'https://portal.example.org' }).status, 403);
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  }
});

test('throttling reserves attempts immediately and expires without unbounded storage', () => {
  let time = 1_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 10_000, maxKeys: 2, now: () => time });
  assert.equal(limiter.consume('ip1'), 0);
  assert.equal(limiter.consume('ip1'), 0);
  assert.equal(limiter.consume('ip1'), 10);
  assert.equal(limiter.consume('ip2'), 0);
  assert.equal(limiter.consume('ip3'), 10);
  time += 10_000;
  assert.equal(limiter.consume('ip3'), 0);
  limiter.clear('ip3');
  assert.equal(limiter.consume('ip3'), 0);
});

test('password verification accepts valid hashes and safely rejects corrupt or unknown credentials', async () => {
  const hash = await hashPassword('A sufficiently long test password');
  assert.equal(await verifyPassword('A sufficiently long test password', hash), true);
  assert.equal(await verifyPassword('A different sufficiently long password', hash), false);
  assert.equal(await verifyPassword('test', 'broken:hash'), false);
  assert.equal(await verifyPassword('test', undefined), false);
});

test('account capabilities protect own account, administrators and the last administrator', () => {
  const admin = { id: '1', role: 'admin', active: true };
  const chair = { id: '2', role: 'chair', active: true };
  const staff = { id: '3', role: 'hr', active: true };
  assert.equal(accountCapabilities(chair, admin, 2).capabilities.changeRole, false);
  assert.equal(accountCapabilities(chair, staff, 1).capabilities.changeRole, true);
  assert.equal(accountCapabilities(chair, staff, 1).capabilities.resetPassword, false);
  assert.equal(accountCapabilities(admin, admin, 2).capabilities.changeRole, false);
  assert.equal(accountCapabilities(admin, admin, 2).capabilities.delete, false);
  assert.equal(accountCapabilities(admin, { ...admin, id: '4' }, 1).capabilities.changeStatus, false);
  assert.equal(accountCapabilities(admin, staff, 1).capabilities.resetPassword, true);
  assert.equal(accountCapabilities(admin, { ...staff, active: false }, 1).capabilities.resetPassword, false);
});

test('photo replacement preserves old image until persistence and rejects spoofed MIME types', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused@127.0.0.1:1/unused';
  const { storePhoto } = require('../app-server');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mro-photo-test-'));
  const previous = path.join(directory, 'old.jpg');
  const uploaded = path.join(directory, 'new.png');
  const spoof = path.join(directory, 'spoof.png');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let stored;
  try {
    await fs.writeFile(previous, 'old image');
    await fs.writeFile(uploaded, png);
    await fs.writeFile(spoof, '<html>not an image</html>');
    stored = await storePhoto({ path: uploaded, mimetype: 'image/png' }, 'test-photo', previous);
    assert.deepEqual(await fs.readFile(stored), png);
    assert.equal(await fs.readFile(previous, 'utf8'), 'old image');
    await assert.rejects(storePhoto({ path: spoof, mimetype: 'image/png' }, 'test-photo'), error => error.status === 400);
  } finally {
    if (stored) await fs.unlink(stored);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('ZIP photo streaming enforces actual bytes independent of ZIP metadata', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused@127.0.0.1:1/unused';
  const { boundedPhotoBuffer } = require('../app-server');
  assert.deepEqual(await boundedPhotoBuffer(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4), Buffer.from('abcd'));
  const oversized = Readable.from([Buffer.alloc(3), Buffer.alloc(3)]);
  await assert.rejects(boundedPhotoBuffer(oversized, 4), error => error.status === 400);
  assert.equal(oversized.destroyed, true);
});
