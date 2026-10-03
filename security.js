const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const DUMMY_PASSWORD_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

function parseCookies(req) {
  const cookies = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      const name = decodeURIComponent(part.slice(0, index).trim());
      if (!Object.prototype.hasOwnProperty.call(cookies, name)) cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch { /* Ignore malformed cookies instead of failing the request. */ }
  }
  return cookies;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(String(password), salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const valid = /^[a-f\d]{32}:[a-f\d]{128}$/i.test(String(stored || ''));
  const [salt, expectedHex] = (valid ? stored : DUMMY_PASSWORD_HASH).split(':');
  const actual = await scrypt(String(password), salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expectedHex, 'hex')) && valid;
}

function protectMutation(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // The client header requires a same-origin request or a successful CORS
  // preflight. This API never grants cross-origin access.
  if (req.get('X-MRO-Request') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site') {
    return res.status(403).json({ error: 'This request could not be verified. Refresh the page and try again.' });
  }
  const origin = req.get('Origin');
  if (origin) {
    const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    try {
      if (origin === 'null' || new URL(origin).origin !== new URL(expected).origin) {
        return res.status(403).json({ error: 'This request must come from the staff portal.' });
      }
    } catch { return res.status(403).json({ error: 'The request origin is invalid.' }); }
  }
  return next();
}

function createRateLimiter({ limit, windowMs, maxKeys = 10000, now = Date.now }) {
  const attempts = new Map();
  return {
    consume(key) {
      const time = now();
      for (const [candidate, entry] of attempts) if (entry.expires <= time) attempts.delete(candidate);
      let entry = attempts.get(key);
      if (!entry) {
        if (attempts.size >= maxKeys) return Math.ceil(windowMs / 1000);
        entry = { count: 0, expires: time + windowMs };
        attempts.set(key, entry);
      }
      if (entry.count >= limit) return Math.max(1, Math.ceil((entry.expires - time) / 1000));
      entry.count += 1;
      return 0;
    },
    clear(key) { attempts.delete(key); }
  };
}

function accountCapabilities(actor, target, activeAdminCount) {
  const admin = actor.role === 'admin';
  const self = String(actor.id) === String(target.id);
  const lastAdmin = target.role === 'admin' && target.active && activeAdminCount <= 1;
  const protectedAdmin = target.role === 'admin' && !admin;
  return {
    capabilities: {
      editDetails: admin,
      changeRole: !self && !lastAdmin && !protectedAdmin,
      changeStatus: admin && !self && !lastAdmin,
      delete: admin && !self && !lastAdmin,
      resetPassword: admin && !self && Boolean(target.active)
    },
    protection_reason: self ? 'Your signed-in account: change your own password from Profile & access.'
      : lastAdmin ? 'Keep at least one active administrator.'
        : protectedAdmin ? 'Only administrators can change this account.' : ''
  };
}

module.exports = { parseCookies, hashPassword, verifyPassword, protectMutation, createRateLimiter, accountCapabilities };
