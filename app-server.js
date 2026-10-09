const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const puppeteer = require('puppeteer');
const ExcelJS = require('exceljs');
const unzipper = require('unzipper');
const morgan = require('morgan');
const { invalid, validIsoDate, monthRange, money, count: cardCount, importNetAmount } = require('./validation');
require('dotenv').config();
const { run, get, all, transaction, initializeDatabase, closeDatabase } = require('./database');
const { parseCookies, hashPassword, verifyPassword, protectMutation, createRateLimiter, accountCapabilities } = require('./security');
const { referenceFormHtml, familyData } = require('./print-form');

const app = express();
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HAS_CLIENT_BUILD = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
const SESSION_DAYS = 7;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;
const SESSION_COOKIE_OPTIONS = { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/' };
const loginIpLimiter = createRateLimiter({ limit: 40, windowMs: 15 * 60_000 });
const loginAccountLimiter = createRateLimiter({ limit: 12, windowMs: 15 * 60_000 });
const passwordChangeLimiter = createRateLimiter({ limit: 12, windowMs: 15 * 60_000 });

function environmentNumber(name, fallback) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const CLOCK_GEOFENCE_DEFAULTS = {
  enabled: process.env.CLOCK_GEOFENCE_ENABLED === 'true',
  latitude: environmentNumber('CLOCK_GEOFENCE_LATITUDE', Number.NaN),
  longitude: environmentNumber('CLOCK_GEOFENCE_LONGITUDE', Number.NaN),
  radiusMeters: Math.max(10, environmentNumber('CLOCK_GEOFENCE_RADIUS_METERS', 150)),
  maxAccuracyMeters: Math.max(10, environmentNumber('CLOCK_GEO_MAX_ACCURACY_METERS', 100)),
  maxAgeSeconds: Math.max(10, environmentNumber('CLOCK_GEO_MAX_AGE_SECONDS', 120))
};

const ROLE_LABELS = {
  admin: 'Admin', chair: 'Chair Person', secretary: 'Secretary', hr: 'HR', card_printing: 'Card Printing Staff',
  data_management: 'Data Management Staff', finance: 'Finance Officer'
};

const ROLE_PERMISSIONS = {
  admin: ['members:view', 'members:edit', 'members:import', 'members:export', 'print:forms', 'users:manage', 'audit:view', 'finance:view', 'finance:edit', 'hr:view', 'hr:edit', 'carding:view', 'carding:edit', 'settings:manage'],
  chair: ['members:view', 'members:edit', 'members:import', 'members:export', 'print:forms', 'users:manage', 'audit:view', 'finance:view', 'finance:edit', 'hr:view', 'hr:edit', 'carding:view', 'carding:edit'],
  secretary: ['members:view', 'print:forms'],
  hr: ['hr:view', 'hr:edit'],
  card_printing: ['members:view', 'members:edit', 'print:forms', 'carding:view', 'carding:edit'],
  data_management: ['members:view', 'members:edit', 'members:import', 'members:export', 'print:forms', 'audit:view'],
  finance: ['finance:view', 'finance:edit', 'carding:view', 'carding:edit']
};

const PHOTO_TYPES = new Map([['image/jpeg', '.jpg'], ['image/png', '.png']]);
const photoUpload = multer({
  dest: os.tmpdir(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => PHOTO_TYPES.has(file.mimetype)
    ? callback(null, true)
    : callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo'))
});
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
const bulkPhotoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024, files: 1 } });

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
morgan.token('safe-path', req => req.path);
app.use(morgan(':method :safe-path :status :response-time ms'));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)' });
  if (IS_PRODUCTION) {
    res.set('Strict-Transport-Security', 'max-age=31536000');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  }
  next();
});
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, protectMutation);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
// Serve only the explicitly public brand assets; never expose public/uploads
// through an alternate /assets path or a URL-encoded traversal.
app.use('/assets', express.static(path.join(ROOT, 'dist', 'assets'), {
  maxAge: IS_PRODUCTION ? '1y' : 0, immutable: IS_PRODUCTION, index: false, dotfiles: 'deny'
}));
app.get('/assets/:name', (req, res) => {
  if (!['mro-logo.png', 'logo.png', 'left-logo.png', 'unLogo.png'].includes(req.params.name)) return res.sendStatus(404);
  return res.sendFile(req.params.name, { root: path.join(ROOT, 'public'), maxAge: IS_PRODUCTION ? '1d' : 0 });
});
app.use('/assets', (_req, res) => res.sendStatus(404));

function malaysiaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function malaysiaDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date).replace(',', '').replaceAll('/', '-');
}

function malaysiaTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function malaysiaTimestamp(workDate = malaysiaDate(), time = malaysiaTime()) {
  return new Date(`${workDate}T${time}:00+08:00`);
}

function displayTimestamp(value) {
  return value ? malaysiaDateTime(new Date(value)) : '';
}

function displayTime(value) {
  return value ? malaysiaTime(new Date(value)) : '';
}

function dateOrNull(value) {
  const normalized = toIsoDate(value);
  return validIsoDate(normalized);
}

function toDisplayDate(value) {
  const normalized = toIsoDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : normalized;
}

function toIsoDate(value) {
  if (value instanceof Date) return malaysiaDate(value);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  if (iso) return iso[1];
  const match = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(String(value || '').trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : String(value || '');
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function safeReference(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
}

function cleanReferenceNumber(value) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
}

function passwordPolicyError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.`;
  if (password.length > 200) return 'Use a password no longer than 200 characters.';
  return '';
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function userPayload(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    must_change_password: Boolean(row.must_change_password),
    permissions: ROLE_PERMISSIONS[row.role] || []
  };
}

function photoUrl(photoPath) {
  return photoPath ? `/uploads/${encodeURIComponent(path.basename(photoPath))}` : '';
}

function memberPayload(row) {
  if (!row) return null;
  const { photo_path, ...member } = row;
  return { ...member, dob: toIsoDate(row.dob), arrival: toIsoDate(row.arrival), photo_url: photoUrl(photo_path) };
}

function memberListPayload({ photo_path, ...row }) {
  return { ...row, dob: toIsoDate(row.dob), photo_url: photoUrl(photo_path) };
}

async function geofenceSettings() {
  const row = await get('SELECT * FROM app_settings WHERE id = 1');
  return row ? {
    enabled: Boolean(row.geofence_enabled),
    latitude: Number(row.geofence_latitude),
    longitude: Number(row.geofence_longitude),
    radiusMeters: Number(row.geofence_radius_meters),
    maxAccuracyMeters: Number(row.geofence_max_accuracy_meters),
    maxAgeSeconds: Number(row.geofence_max_age_seconds),
    address: row.office_address,
    updatedAt: row.updated_at
  } : { ...CLOCK_GEOFENCE_DEFAULTS, address: '' };
}

function geofenceConfigured(settings) {
  return Number.isFinite(settings.latitude) && settings.latitude >= -90 && settings.latitude <= 90 &&
    Number.isFinite(settings.longitude) && settings.longitude >= -180 && settings.longitude <= 180;
}

function geofencePayload(settings) {
  return {
    enabled: settings.enabled,
    configured: geofenceConfigured(settings),
    radiusMeters: settings.radiusMeters,
    maxAccuracyMeters: settings.maxAccuracyMeters,
    address: settings.address
  };
}

function distanceMeters(latitudeOne, longitudeOne, latitudeTwo, longitudeTwo) {
  const radians = value => value * Math.PI / 180;
  const earthRadius = 6_371_000;
  const latitudeDelta = radians(latitudeTwo - latitudeOne);
  const longitudeDelta = radians(longitudeTwo - longitudeOne);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(latitudeOne)) * Math.cos(radians(latitudeTwo)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function verifiedClockLocation(location) {
  const settings = await geofenceSettings();
  if (!settings.enabled) return { location: null, settings };
  if (!geofenceConfigured(settings)) {
    const error = new Error('Office location lock is enabled but has not been configured. Ask an administrator to add the office coordinates.');
    error.status = 503;
    throw error;
  }
  if (!location || typeof location !== 'object') {
    const error = new Error('Your location is required to record attendance. Allow location access and try again.');
    error.status = 400;
    throw error;
  }
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracy);
  const capturedAt = new Date(location.captured_at);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    const error = new Error('The device returned an invalid location. Turn location services on and try again.');
    error.status = 400;
    throw error;
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > settings.maxAccuracyMeters) {
    const detail = Number.isFinite(accuracy) ? ` Current accuracy is about ${Math.round(accuracy)} m.` : '';
    const error = new Error(`Location accuracy is too low to record attendance.${detail} Move near a window, enable precise location, and try again.`);
    error.status = 422;
    throw error;
  }
  const locationAge = Date.now() - capturedAt.getTime();
  if (Number.isNaN(capturedAt.getTime()) || locationAge > settings.maxAgeSeconds * 1000 || locationAge < -30_000) {
    const error = new Error('The location reading is out of date. Refresh your location and try again.');
    error.status = 422;
    throw error;
  }
  const distance = distanceMeters(settings.latitude, settings.longitude, latitude, longitude);
  if (distance > settings.radiusMeters) {
    const error = new Error(`You are about ${Math.round(distance)} m from the MRO office. Clock in or out within the ${Math.round(settings.radiusMeters)} m office zone.`);
    error.status = 403;
    throw error;
  }
  return { location: { latitude, longitude, accuracy, distance, capturedAt }, settings };
}

function attendancePayload(row) {
  if (!row) return null;
  const {
    clock_in_latitude: clockInLatitude, clock_in_longitude: _clockInLongitude,
    clock_in_accuracy_meters: clockInAccuracy, clock_in_distance_meters: clockInDistance,
    clock_in_location_captured_at: _clockInLocationCapturedAt,
    clock_out_latitude: clockOutLatitude, clock_out_longitude: _clockOutLongitude,
    clock_out_accuracy_meters: clockOutAccuracy, clock_out_distance_meters: clockOutDistance,
    clock_out_location_captured_at: _clockOutLocationCapturedAt,
    ...safeRow
  } = row;
  const clockIn = row.clock_in ? new Date(row.clock_in) : null;
  const clockOut = row.clock_out ? new Date(row.clock_out) : null;
  const minutes = clockIn && clockOut ? Math.max(0, Math.round((clockOut - clockIn) / 60000)) : null;
  return {
    ...safeRow,
    work_date: toIsoDate(row.work_date),
    clock_in: displayTime(clockIn),
    clock_out: displayTime(clockOut),
    duration: minutes == null ? '' : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`,
    clock_in_location_verified: clockInLatitude != null,
    clock_out_location_verified: clockOutLatitude != null,
    clock_in_distance_meters: clockInDistance == null ? null : Math.round(Number(clockInDistance)),
    clock_out_distance_meters: clockOutDistance == null ? null : Math.round(Number(clockOutDistance)),
    clock_in_accuracy_meters: clockInAccuracy == null ? null : Math.round(Number(clockInAccuracy)),
    clock_out_accuracy_meters: clockOutAccuracy == null ? null : Math.round(Number(clockOutAccuracy))
  };
}

function auditPayload(row) {
  return row ? { ...row, created_at: displayTimestamp(row.created_at) } : row;
}

async function seedInitialUser() {
  await transaction(async ({ get: txGet, run: txRun }) => {
    await txRun('SELECT pg_advisory_xact_lock(771462, 2)');
    const count = await txGet('SELECT COUNT(*)::int AS count FROM users WHERE deleted_at IS NULL');
    if (count.count) return;
    const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
    const role = process.env.INITIAL_ADMIN_ROLE || 'admin';
    if (!email || !password) {
      console.warn('No users exist. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then restart.');
      return;
    }
    if (!validEmail(email)) throw new Error('INITIAL_ADMIN_EMAIL must be a valid email address.');
    if (!Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) throw new Error('INITIAL_ADMIN_ROLE must be a supported role.');
    const policyError = passwordPolicyError(password);
    if (policyError) throw new Error(`INITIAL_ADMIN_PASSWORD: ${policyError}`);
    await txRun(`INSERT INTO users (name, email, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, TRUE, TRUE, NOW(), NOW()) RETURNING id`,
    [process.env.INITIAL_ADMIN_NAME || 'MRO Administrator', email, await hashPassword(password), role]);
    console.log(`Initial ${ROLE_LABELS[role]} account created.`);
  });
}

async function audit(req, action, detail, entityType = '', entityId = '') {
  const actor = req.user || { id: null, name: 'System' };
  await run('INSERT INTO audit_logs (user_id, actor_name, action, detail, entity_type, entity_id, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [actor.id, actor.name, action, detail, entityType, String(entityId || ''), req.ip, new Date()]);
}

async function visibleAuditRows(user, limit) {
  if (['admin', 'chair'].includes(user.role)) return all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
  // Registry staff must not learn finance, HR or account details through logs.
  return all(`SELECT id, user_id, actor_name, action, detail, entity_type, entity_id, created_at FROM audit_logs
    WHERE entity_type IN ('member', 'import', 'photo_import', 'export') ORDER BY id DESC LIMIT ?`, [limit]);
}

async function authenticate(req, res, next) {
  try {
    const token = parseCookies(req).mro_session;
    if (!token) return res.status(401).json({ error: 'Please sign in.', code: 'SESSION_REQUIRED' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await get(`SELECT users.id, users.name, users.email, users.role, users.active, users.must_change_password
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > NOW() AND users.deleted_at IS NULL`, [tokenHash]);
    if (!row || !row.active) return res.status(401).json({ error: 'Your session has expired.', code: 'SESSION_EXPIRED' });
    req.user = userPayload(row);
    req.sessionTokenHash = tokenHash;
    next();
  } catch (error) { next(error); }
}

function requirePasswordChangeComplete(req, res, next) {
  return req.user.must_change_password
    ? res.status(403).json({ error: 'Change your temporary password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' })
    : next();
}

function requirePermission(permission) {
  return [authenticate, requirePasswordChangeComplete, (req, res, next) => req.user.permissions.includes(permission)
    ? next()
    : res.status(403).json({ error: 'Your role does not allow this action.' })];
}

app.use('/uploads', ...requirePermission('members:view'), (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
}, express.static(path.join(ROOT, 'public', 'uploads'), { fallthrough: false, dotfiles: 'deny', index: false,
  setHeaders: res => res.setHeader('Cache-Control', 'private, no-store') }));

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const ipRetryAfter = loginIpLimiter.consume(req.ip);
    if (ipRetryAfter) return res.set('Retry-After', String(ipRetryAfter)).status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
    if (!validEmail(email) || !password || password.length > 200) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const retryAfter = loginAccountLimiter.consume(email);
    if (retryAfter) return res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
    const user = await get('SELECT * FROM users WHERE LOWER(email) = ? AND active = TRUE AND deleted_at IS NULL', [email]);
    const validPassword = await verifyPassword(password, user?.password_hash);
    if (!user || !validPassword) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const currentUser = await transaction(async tx => {
      await tx.run('SELECT pg_advisory_xact_lock(771462, 2)');
      const current = await tx.get('SELECT * FROM users WHERE id = ? AND active = TRUE AND deleted_at IS NULL', [user.id]);
      if (!current || current.password_hash !== user.password_hash || current.email !== user.email) throw requestError(401, 'Email or password is incorrect.');
      await tx.run('DELETE FROM sessions WHERE expires_at <= NOW()');
      await tx.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [tokenHash, current.id, new Date(Date.now() + SESSION_DAYS * 86400000), new Date()]);
      return current;
    });
    loginAccountLimiter.clear(email);
    res.cookie('mro_session', token, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_DAYS * 86400000 });
    req.user = currentUser;
    await audit(req, 'Signed in', `${currentUser.name} signed in to the staff portal.`, 'user', currentUser.id);
    res.json(userPayload(currentUser));
  } catch (error) { next(error); }
});

app.get('/api/health', async (_req, res, next) => {
  try {
    await get('SELECT 1 AS ok');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.get('/api/auth/session', authenticate, (req, res) => res.json(req.user));
app.post('/api/auth/change-password', authenticate, async (req, res, next) => {
  try {
    const retryAfter = passwordChangeLimiter.consume(String(req.user.id));
    if (retryAfter) return res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'Too many password attempts. Try again later.' });
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    const confirmation = String(req.body.confirm_password || '');
    const policyError = passwordPolicyError(newPassword);
    if (!currentPassword || currentPassword.length > 200) return res.status(400).json({ error: 'Enter your temporary or current password.' });
    if (policyError) return res.status(400).json({ error: policyError });
    if (newPassword !== confirmation) return res.status(400).json({ error: 'The new passwords do not match.' });
    const newHash = await hashPassword(newPassword);
    await transaction(async ({ run: txRun, get: txGet }) => {
      await txRun('SELECT pg_advisory_xact_lock(771462, 2)');
      const account = await txGet(`SELECT users.password_hash FROM users JOIN sessions ON sessions.user_id = users.id
        WHERE users.id = ? AND users.active = TRUE AND users.deleted_at IS NULL AND sessions.token_hash = ? AND sessions.expires_at > NOW()`, [req.user.id, req.sessionTokenHash]);
      if (!account) {
        const error = requestError(401, 'Your session has expired.'); error.responseCode = 'SESSION_EXPIRED'; throw error;
      }
      if (!await verifyPassword(currentPassword, account.password_hash)) throw requestError(401, 'The current password is incorrect.');
      if (await verifyPassword(newPassword, account.password_hash)) throw requestError(400, 'Choose a password different from the temporary or current password.');
      await txRun(`UPDATE users SET password_hash = ?, must_change_password = FALSE, password_changed_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [newHash, req.user.id]);
      await txRun('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [req.user.id, req.sessionTokenHash]);
    });
    passwordChangeLimiter.clear(String(req.user.id));
    req.user.must_change_password = false;
    await audit(req, 'Password changed', `${req.user.name} changed their account password.`, 'user', req.user.id);
    res.json(userPayload(req.user));
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', authenticate, async (req, res, next) => {
  try {
    const token = parseCookies(req).mro_session;
    if (token) await run('DELETE FROM sessions WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]);
    await audit(req, 'Signed out', `${req.user.name} signed out.`, 'user', req.user.id);
    res.clearCookie('mro_session', SESSION_COOKIE_OPTIONS);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/dashboard', authenticate, requirePasswordChangeComplete, async (req, res, next) => {
  try {
    const mayViewMembers = req.user.permissions.includes('members:view');
    const mayViewFinance = req.user.permissions.includes('finance:view');
    const mayViewHr = req.user.permissions.includes('hr:view');
    const memberStats = mayViewMembers ? await get(`SELECT COUNT(*)::int AS members,
      COUNT(*) FILTER (WHERE photo_path != '' AND reference_number != '')::int AS "readyToPrint",
      COUNT(*) FILTER (WHERE photo_path = '')::int AS "missingPhotos",
      COUNT(*) FILTER (WHERE reference_number = '')::int AS "missingReferenceNumbers",
      COUNT(*) FILTER (WHERE unhcr_status = 'Yes')::int AS "unhcrRegistered",
      COUNT(*) FILTER (WHERE fullname = '' OR reference = '' OR reference_number = '' OR dob IS NULL OR phone = '')::int AS "needsReview",
      COUNT(*) FILTER (WHERE dob IS NOT NULL AND dob <= CURRENT_DATE - INTERVAL '18 years')::int AS adults,
      COUNT(*) FILTER (WHERE dob IS NOT NULL AND dob > CURRENT_DATE - INTERVAL '18 years')::int AS underage,
      COUNT(*) FILTER (WHERE dob IS NULL)::int AS "ageNotRecorded",
      COUNT(*) FILTER (WHERE dob > CURRENT_DATE - INTERVAL '18 years' AND LOWER(gender) IN ('male', 'm'))::int AS "maleUnderage",
      COUNT(*) FILTER (WHERE dob > CURRENT_DATE - INTERVAL '18 years' AND LOWER(gender) IN ('female', 'f'))::int AS "femaleUnderage",
      COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur')::int AS "addedThisMonth"
      FROM submissions`) : {};
    const current = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', [req.user.id, malaysiaDate()]);
    const geofence = await geofenceSettings();
    const attention = req.user.permissions.includes('members:view') ? await all(`SELECT id, reference, reference_number, fullname, photo_path,
      CASE WHEN photo_path IS NULL OR photo_path = '' THEN 'Missing photo'
        WHEN reference_number = '' THEN 'Missing reference number' ELSE 'Incomplete data' END AS reason
      FROM submissions WHERE photo_path = '' OR reference_number = '' OR fullname = '' OR dob IS NULL OR phone = ''
      ORDER BY id DESC LIMIT 5`) : [];
    const activity = req.user.permissions.includes('audit:view') ? await visibleAuditRows(req.user, 6) : [];
    const registryTrend = mayViewMembers ? await all(`WITH months AS (
        SELECT generate_series(date_trunc('month', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') - INTERVAL '5 months',
          date_trunc('month', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur'), INTERVAL '1 month') AS month
      )
      SELECT to_char(month, 'Mon') AS label, COUNT(submissions.id)::int AS value
      FROM months LEFT JOIN submissions
        ON date_trunc('month', submissions.created_at AT TIME ZONE 'Asia/Kuala_Lumpur') = months.month
      GROUP BY month ORDER BY month`) : [];
    const genderBreakdown = mayViewMembers ? await all(`SELECT COALESCE(NULLIF(INITCAP(gender), ''), 'Not recorded') AS label, COUNT(*)::int AS value
      FROM submissions GROUP BY 1 ORDER BY value DESC, label`) : [];
    const attendanceCoverage = await all(`WITH days AS (
        SELECT generate_series((NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - 6,
          (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, INTERVAL '1 day')::date AS day
      ), staff AS (SELECT COUNT(*)::int AS total FROM users WHERE active = TRUE AND deleted_at IS NULL)
      SELECT to_char(days.day, 'Dy') AS label, COUNT(DISTINCT attendance.user_id)::int AS value, staff.total
      FROM days CROSS JOIN staff LEFT JOIN attendance ON attendance.work_date = days.day AND attendance.clock_in IS NOT NULL
      GROUP BY days.day, staff.total ORDER BY days.day`);
    const organization = await get(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE active = TRUE AND deleted_at IS NULL) AS "activeUsers",
      (SELECT COUNT(*)::int FROM attendance WHERE work_date = ? AND clock_in IS NOT NULL AND clock_out IS NULL) AS "presentNow",
      (SELECT COUNT(*)::int FROM audit_logs WHERE action = 'UNHCR form printed' AND created_at >= date_trunc('month', NOW())) AS "printedThisMonth"`,
    [malaysiaDate()]);
    const personalKpi = await get(`SELECT
      COUNT(*) FILTER (WHERE work_date >= date_trunc('month', CURRENT_DATE)::date)::int AS "daysRecorded",
      COUNT(*) FILTER (WHERE work_date >= date_trunc('month', CURRENT_DATE)::date AND clock_in IS NOT NULL AND clock_out IS NOT NULL)::int AS "completedShifts",
      ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600)
        FILTER (WHERE work_date >= date_trunc('month', CURRENT_DATE)::date AND clock_out IS NOT NULL), 0)::numeric, 1) AS "hoursThisMonth"
      FROM attendance WHERE user_id = ?`, [req.user.id]);
    const financeKpi = mayViewFinance ? await get(`SELECT COUNT(*)::int AS transactions,
      ROUND(COALESCE(SUM(net_amount), 0), 2) AS collected,
      ROUND(COALESCE(SUM(deduction), 0), 2) AS deductions,
      COUNT(*) FILTER (WHERE payment_status IN ('Pending', 'Partial'))::int AS pending
      FROM finance_records WHERE payment_date >= date_trunc('month', CURRENT_DATE)::date`) : null;
    const workforceKpi = mayViewHr ? await get(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE active = TRUE AND deleted_at IS NULL) AS "activeStaff",
      (SELECT COUNT(*)::int FROM staff_profiles WHERE employment_type = 'part_time') AS "partTimeStaff",
      (SELECT COUNT(DISTINCT user_id)::int FROM attendance WHERE work_date >= date_trunc('month', CURRENT_DATE)::date) AS "activeThisMonth",
      (SELECT ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600), 0)::numeric, 1)
        FROM attendance WHERE work_date >= date_trunc('month', CURRENT_DATE)::date AND clock_out IS NOT NULL) AS "hoursThisMonth"`) : null;
    const ageBreakdown = mayViewMembers ? [
      { label: 'Adult', value: memberStats.adults },
      { label: 'Underage', value: memberStats.underage },
      { label: 'Age not recorded', value: memberStats.ageNotRecorded }
    ] : [];
    const underageGender = mayViewMembers ? [
      { label: 'Male underage', value: memberStats.maleUnderage },
      { label: 'Female underage', value: memberStats.femaleUnderage },
      { label: 'Other / not recorded', value: Math.max(0, memberStats.underage - memberStats.maleUnderage - memberStats.femaleUnderage) }
    ] : [];
    res.json({
      stats: { ...memberStats, ...organization },
      overview: { personal: personalKpi, finance: financeKpi, workforce: workforceKpi },
      attendance: current ? { ...attendancePayload(current), status: current.clock_in && !current.clock_out ? 'clocked_in' : 'clocked_out' } : { status: 'not_clocked_in' },
      geofence: geofencePayload(geofence),
      attention: attention.map(item => ({ ...item, photo_url: photoUrl(item.photo_path), label: item.photo_path ? 'Review' : 'Photo', tone: item.photo_path ? 'warning' : 'error' })),
      activity: activity.map(auditPayload),
      charts: { registryTrend, genderBreakdown, ageBreakdown, underageGender, attendanceCoverage }
    });
  } catch (error) { next(error); }
});

app.get('/api/members', ...requirePermission('members:view'), async (req, res, next) => {
  try {
    const query = `%${String(req.query.q || '').trim()}%`;
    const conditions = ['(reference ILIKE ? OR reference_number ILIKE ? OR fullname ILIKE ? OR email ILIKE ? OR phone ILIKE ?)'];
    const params = [query, query, query, query, query];
    if (req.query.photo === 'ready') conditions.push("photo_path IS NOT NULL AND photo_path != ''");
    if (req.query.photo === 'missing') conditions.push("(photo_path IS NULL OR photo_path = '')");
    const rows = await all(`SELECT id, reference, reference_number, fullname, gender, dob, email, phone, photo_path
      FROM submissions WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 500`, params);
    res.json({ records: rows.map(memberListPayload) });
  } catch (error) { next(error); }
});

app.get('/api/members/:id([0-9]+)', ...requirePermission('members:view'), async (req, res, next) => {
  try {
    const member = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'Member record not found.' });
    res.json({ member: memberPayload(member) });
  } catch (error) { next(error); }
});

const MEMBER_FIELDS = ['reference', 'reference_number', 'unhcr_status', 'unhcr_file_number', 'individual_number', 'fullname', 'father_name', 'mother_name',
  'email', 'phone', 'phone2', 'country', 'ethnicity', 'religion', 'gender', 'dob', 'arrival', 'address_state', 'vulnerability', 'consent',
  'identity_documents', 'identity_document_filename', 'family_members_in_malaysia'];

function memberValues(body) {
  return Object.fromEntries(MEMBER_FIELDS.map(field => [field, String(body[field] ?? '').trim()]));
}

function memberFamily(body) {
  let relatives;
  try { relatives = Array.isArray(body.family_members_data) ? body.family_members_data : JSON.parse(body.family_members_data || '[]'); }
  catch { throw requestError(400, 'Family member details must be a valid list.'); }
  if (!Array.isArray(relatives)) throw requestError(400, 'Family member details must be a valid list.');
  if (relatives.length > 20) throw requestError(400, 'Add no more than 20 family members to one request.');
  const clean = relatives.map(relative => {
    if (!relative || typeof relative !== 'object' || Array.isArray(relative)) throw requestError(400, 'Each family member needs a valid record.');
    return { ...relative, ...Object.fromEntries(['fullname', 'country', 'ethnicity', 'religion', 'gender', 'relationship', 'dob', 'arrival', 'photo_filename', 'identity_documents', 'identity_document_filename']
      .map(key => [key, String(relative[key] ?? (key === 'fullname' ? relative.name || '' : '')).trim().slice(0, 200)])) };
  });
  if (clean.some(relative => (relative.dob && !dateOrNull(relative.dob)) || (relative.arrival && !dateOrNull(relative.arrival)))) {
    throw requestError(400, 'Enter valid family member dates or leave them blank.');
  }
  return clean;
}

async function storePhoto(file, reference, previousPath = '') {
  if (!file) return previousPath || '';
  const clean = safeReference(reference);
  if (!clean) throw new Error('A valid MRO status number is required before uploading a photo.');
  const uploads = path.join(ROOT, 'public', 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const extension = PHOTO_TYPES.get(file.mimetype);
  const bytes = await fs.promises.readFile(file.path);
  if (!extension || bytes.length > MAX_PHOTO_BYTES || !validPhotoBytes(bytes, extension)) {
    const error = new Error('The selected file is not a valid JPG or PNG photo.'); error.status = 400; throw error;
  }
  const target = path.join(uploads, `${clean}-${crypto.randomUUID()}${extension}`);
  await fs.promises.writeFile(target, bytes, { flag: 'wx', mode: 0o640 });
  return target;
}

async function removeManagedPhoto(photoPath) {
  if (!photoPath) return;
  const uploads = path.resolve(ROOT, 'public', 'uploads');
  const resolved = path.resolve(photoPath);
  if (path.dirname(resolved) !== uploads) return;
  try { await fs.promises.unlink(resolved); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Unable to remove a managed member photo:', error.code); }
}

app.post('/api/members', ...requirePermission('members:edit'), photoUpload.single('photo'), async (req, res, next) => {
  let completed = false;
  let photoPath = '';
  try {
    const values = memberValues(req.body);
    const relatives = memberFamily(req.body);
    if (!safeReference(values.reference) || !values.fullname) return res.status(400).json({ error: 'MRO status number and full name are required.' });
    if (['dob', 'arrival'].some(field => values[field] && !dateOrNull(values[field]))) return res.status(400).json({ error: 'Enter a valid date of birth and arrival date, or leave them blank.' });
    values.reference = safeReference(values.reference);
    values.reference_number = cleanReferenceNumber(values.reference_number);
    photoPath = await storePhoto(req.file, values.reference);
    const now = new Date();
    const columns = [...MEMBER_FIELDS, 'photo_path', 'family_members', 'family_members_data', 'created_at', 'updated_at', 'updated_by'];
    const result = await run(`INSERT INTO submissions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) RETURNING id`,
      [...MEMBER_FIELDS.map(field => field === 'dob' || field === 'arrival' ? dateOrNull(values[field]) : values[field]), photoPath, relatives.length, JSON.stringify(relatives), now, now, req.user.id]);
    completed = true;
    await audit(req, 'Member record created', `${values.reference} · ${values.fullname}`, 'member', result.lastID);
    res.status(201).json({ id: result.lastID });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That MRO status number or reference number already exists.' });
    next(error);
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (!completed) await removeManagedPhoto(photoPath);
  }
});

app.put('/api/members/:id', ...requirePermission('members:edit'), photoUpload.single('photo'), async (req, res, next) => {
  let completed = false;
  let photoPath = ''; let previousPath = '';
  try {
    const values = memberValues(req.body);
    const relatives = Object.hasOwn(req.body, 'family_members_data') ? memberFamily(req.body) : null;
    if (!safeReference(values.reference) || !values.fullname) return res.status(400).json({ error: 'MRO status number and full name are required.' });
    if (['dob', 'arrival'].some(field => values[field] && !dateOrNull(values[field]))) return res.status(400).json({ error: 'Enter a valid date of birth and arrival date, or leave them blank.' });
    values.reference = safeReference(values.reference);
    values.reference_number = cleanReferenceNumber(values.reference_number);
    await transaction(async tx => {
      const existing = await tx.get('SELECT * FROM submissions WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!existing) throw requestError(404, 'Member record not found.');
      for (const field of ['identity_documents', 'identity_document_filename', 'family_members_in_malaysia']) {
        if (!Object.hasOwn(req.body, field)) values[field] = existing[field];
      }
      const savedRelatives = relatives ?? familyData(existing.family_members_data);
      previousPath = existing.photo_path;
      photoPath = await storePhoto(req.file, values.reference, previousPath);
      await tx.run(`UPDATE submissions SET ${MEMBER_FIELDS.map(field => `${field} = ?`).join(', ')}, photo_path = ?, family_members = ?, family_members_data = ?::jsonb, updated_at = ?, updated_by = ? WHERE id = ?`,
        [...MEMBER_FIELDS.map(field => field === 'dob' || field === 'arrival' ? dateOrNull(values[field]) : values[field]), photoPath, savedRelatives.length, JSON.stringify(savedRelatives), new Date(), req.user.id, req.params.id]);
    });
    completed = true;
    if (photoPath !== previousPath) await removeManagedPhoto(previousPath);
    await audit(req, 'Member record updated', `${values.reference} · ${values.fullname}`, 'member', req.params.id);
    res.json({ id: Number(req.params.id) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That MRO status number or reference number already exists.' });
    next(error);
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (!completed && photoPath !== previousPath) await removeManagedPhoto(photoPath);
  }
});

app.delete('/api/members/:id', ...requirePermission('members:edit'), async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can permanently delete member records.' });
    const photoPath = await transaction(async tx => {
      const member = await tx.get('SELECT id, reference, photo_path FROM submissions WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!member) throw requestError(404, 'Member record not found.');
      const confirmation = String(req.body?.confirmation || '').trim().toLowerCase();
      if (confirmation !== String(member.reference).trim().toLowerCase()) throw requestError(400, 'Enter the member’s MRO Status number exactly to confirm deletion.');
      await tx.run('DELETE FROM submissions WHERE id = ?', [member.id]);
      await tx.run(`INSERT INTO audit_logs (user_id, actor_name, action, detail, entity_type, entity_id, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [req.user.id, req.user.name, 'Member record permanently deleted',
        'A member record and its managed photo were permanently removed.', 'member', String(member.id), req.ip, new Date()]);
      return member.photo_path;
    });
    await removeManagedPhoto(photoPath);
    res.status(204).end();
  } catch (error) { next(error); }
});

const IMPORT_ALIASES = {
  reference: ['mro status number', 'mro status no', 'mro number', 'mro status'],
  reference_number: ['reference number', 'reference no', 'reference', 'ref number', 'ref no'],
  fullname: ['name', 'full name', 'fullname'], gender: ['gender', 'sex'], dob: ['dob', 'date of birth'],
  father_name: ["father's name", 'father name'], mother_name: ["mother's name", 'mother name'],
  arrival: ['date of arrival to malaysia', 'date of arrival in malaysia', 'date of arrival', 'arrival', 'arrival date'],
  email: ['email', 'email address'], phone: ['phone', 'phone number', 'mobile', 'mobile number']
};

function spreadsheetValue(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    const day = String(value.getUTCDate()).padStart(2, '0');
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    return `${day}-${month}-${value.getUTCFullYear()}`;
  }
  if (typeof value === 'object') return String(value.text ?? value.result ?? value.hyperlink ?? '');
  return String(value).trim();
}

function normalizeImportRow(row) {
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).replace(/\s+/g, ' ').trim().toLowerCase(), value]));
  const result = {};
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    const alias = aliases.find(name => Object.hasOwn(normalized, name));
    result[field] = alias ? spreadsheetValue(normalized[alias]) : '';
  }
  return result;
}

function memberHeaderRow(worksheet) {
  let best = null;
  for (let rowNumber = 1; rowNumber <= Math.min(12, worksheet.rowCount); rowNumber += 1) {
    const headers = worksheet.getRow(rowNumber).values.slice(1).map(value => spreadsheetValue(value).replace(/\s+/g, ' ').trim());
    const normalized = headers.map(value => value.toLowerCase());
    const hasMro = IMPORT_ALIASES.reference.some(alias => normalized.includes(alias));
    const hasName = IMPORT_ALIASES.fullname.some(alias => normalized.includes(alias));
    if (hasMro && hasName && (!best || headers.filter(Boolean).length > best.headers.filter(Boolean).length)) best = { rowNumber, headers };
  }
  return best;
}

app.post('/api/members/import/preview', ...requirePermission('members:import'), importUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an Excel or CSV file.' });
    const workbook = new ExcelJS.Workbook();
    if (path.extname(req.file.originalname).toLowerCase() === '.csv') {
      await workbook.csv.read(Readable.from(req.file.buffer));
    } else {
      await workbook.xlsx.load(req.file.buffer);
    }
    const existingRows = await all('SELECT reference FROM submissions');
    const existing = new Set(existingRows.map(row => String(row.reference)));
    const seen = new Set();
    const previewRows = [];
    for (const worksheet of workbook.worksheets) {
      const header = memberHeaderRow(worksheet);
      if (!header) continue;
      worksheet.eachRow((sourceRow, rowNumber) => {
        if (rowNumber <= header.rowNumber || previewRows.length >= 10000) return;
        const source = Object.fromEntries(header.headers.map((name, index) => [name, sourceRow.getCell(index + 1).value]));
        const row = normalizeImportRow(source);
        row.reference = safeReference(row.reference);
        row.reference_number = cleanReferenceNumber(row.reference_number);
        if (!Object.values(row).some(Boolean)) return;
        const duplicateInFile = row.reference && seen.has(row.reference);
        if (row.reference) seen.add(row.reference);
        const issue = !row.reference ? 'Missing MRO Status number' : !row.fullname ? 'Missing name' : duplicateInFile ? 'Duplicate MRO number in workbook' : existing.has(row.reference) ? 'Already in registry' : '';
        previewRows.push({ id: previewRows.length + 1, sheet: worksheet.name, sourceRow: rowNumber, ...row, valid: !issue, issue });
      });
    }
    if (!previewRows.length) return res.status(400).json({ error: 'No member rows were found. Include columns for MRO Status and Name.' });
    const batchId = crypto.randomUUID();
    await run('DELETE FROM import_batches WHERE expires_at <= NOW()');
    await run('INSERT INTO import_batches (id, user_id, import_type, source_name, rows, expires_at) VALUES (?, ?, ?, ?, ?::jsonb, NOW() + INTERVAL \'24 hours\')',
      [batchId, req.user.id, 'members', req.file.originalname, JSON.stringify(previewRows)]);
    res.json({ batchId, sourceName: req.file.originalname, rows: previewRows, valid: previewRows.filter(row => row.valid).length, attention: previewRows.filter(row => !row.valid).length });
  } catch (error) { next(error); }
});

app.post('/api/members/import/commit', ...requirePermission('members:import'), async (req, res, next) => {
  try {
    const selectedIds = new Set((Array.isArray(req.body.selectedIds) ? req.body.selectedIds : []).map(Number));
    if (!selectedIds.size || selectedIds.size > 10000) return res.status(400).json({ error: 'Select between 1 and 10,000 valid rows to import.' });
    const batch = await get(`SELECT * FROM import_batches WHERE id = ? AND user_id = ? AND import_type = 'members' AND expires_at > NOW()`, [req.body.batchId, req.user.id]);
    if (!batch) return res.status(404).json({ error: 'This import preview has expired. Upload the workbook again.' });
    const selected = batch.rows.filter(row => selectedIds.has(Number(row.id)) && row.valid);
    let imported = 0; let skipped = selectedIds.size - selected.length;
    await transaction(async ({ run: txRun }) => {
      for (const row of selected) {
        const result = await txRun(`INSERT INTO submissions (reference, reference_number, fullname, gender, dob, father_name, mother_name, arrival, email, phone,
          unhcr_status, country, ethnicity, religion, vulnerability, consent, family_members, family_members_data, created_at, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'No', 'Myanmar', 'Mon', '', 'N/A', 'yes', 0, '[]', ?, ?, ?)
          ON CONFLICT DO NOTHING RETURNING id`,
          [row.reference, row.reference_number, row.fullname, row.gender, dateOrNull(row.dob), row.father_name, row.mother_name, dateOrNull(row.arrival), row.email, row.phone, new Date(), new Date(), req.user.id]);
        if (result.changes) imported += 1; else skipped += 1;
      }
    });
    await run('DELETE FROM import_batches WHERE id = ?', [batch.id]);
    await audit(req, 'Member data imported', `${imported} selected records imported from ${batch.source_name}; ${skipped} skipped.`, 'import', batch.id);
    res.json({ imported, skipped });
  } catch (error) { next(error); }
});

function validPhotoBytes(buffer, extension) {
  if (extension === '.png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

async function boundedPhotoBuffer(stream, limit = MAX_PHOTO_BYTES) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw requestError(400, 'The uncompressed photo exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

app.post('/api/members/photos/bulk', ...requirePermission('members:edit'), bulkPhotoUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || path.extname(req.file.originalname).toLowerCase() !== '.zip') return res.status(400).json({ error: 'Choose a ZIP file containing JPG, JPEG or PNG member photos.' });
    const archive = await unzipper.Open.file(req.file.path);
    const memberRows = await all('SELECT id, reference, photo_path FROM submissions');
    const members = new Map(memberRows.map(row => [String(row.reference), row]));
    const entries = archive.files.filter(entry => entry.type === 'File');
    if (entries.length > 20000) return res.status(400).json({ error: 'The ZIP contains more than 20,000 files. Split it into smaller archives.' });
    const totalUncompressed = entries.reduce((sum, entry) => sum + Number(entry.uncompressedSize || entry.vars?.uncompressedSize || 0), 0);
    if (totalUncompressed > 2 * 1024 * 1024 * 1024) return res.status(400).json({ error: 'The uncompressed photos exceed 2 GB. Split the archive into smaller files.' });
    const uploads = path.join(ROOT, 'public', 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    let matched = 0; let invalid = 0; let oversized = 0; let actualBytes = 0; const unmatched = [];
    for (const entry of entries) {
      const filename = path.posix.basename(String(entry.path).replaceAll('\\', '/'));
      const extension = path.extname(filename).toLowerCase();
      if (!['.jpg', '.jpeg', '.png'].includes(extension)) { invalid += 1; continue; }
      const stem = path.basename(filename, extension);
      const reference = safeReference(stem);
      if (!reference || reference !== stem || !members.has(reference)) { if (unmatched.length < 100) unmatched.push(filename); continue; }
      const size = Number(entry.uncompressedSize || entry.vars?.uncompressedSize || 0);
      if (size > MAX_PHOTO_BYTES) { oversized += 1; continue; }
      let buffer;
      try { buffer = await boundedPhotoBuffer(entry.stream()); }
      catch (error) { if (error.status === 400) { oversized += 1; continue; } throw error; }
      actualBytes += buffer.length;
      if (actualBytes > 2 * 1024 * 1024 * 1024) throw requestError(400, 'The expanded photos exceed 2 GB. Split the archive into smaller files.');
      if (buffer.length > MAX_PHOTO_BYTES || !validPhotoBytes(buffer, extension)) { invalid += 1; continue; }
      const member = members.get(reference);
      const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
      const target = path.join(uploads, `${reference}-${crypto.randomUUID()}${normalizedExtension}`);
      await fs.promises.writeFile(target, buffer, { flag: 'wx', mode: 0o640 });
      let previousPath;
      try {
        const result = await transaction(async tx => {
          const current = await tx.get('SELECT reference, photo_path FROM submissions WHERE id = ? FOR UPDATE', [member.id]);
          if (!current || current.reference !== reference) return false;
          previousPath = current.photo_path;
          await tx.run('UPDATE submissions SET photo_path = ?, updated_at = NOW(), updated_by = ? WHERE id = ?', [target, req.user.id, member.id]);
          return true;
        });
        if (!result) { await removeManagedPhoto(target); continue; }
      } catch (error) { await removeManagedPhoto(target); throw error; }
      await removeManagedPhoto(previousPath);
      member.photo_path = target;
      matched += 1;
    }
    await audit(req, 'Bulk member photos imported', `${matched} photos matched from ${req.file.originalname}; ${unmatched.length} filenames unmatched; ${invalid} invalid; ${oversized} oversized.`, 'photo_import', '');
    res.json({ matched, unmatched, invalid, oversized, totalFiles: entries.length });
  } catch (error) { next(error); }
  finally { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
});

app.get('/api/members/export', ...requirePermission('members:export'), async (req, res, next) => {
  try {
    const sourceRows = await all(`SELECT reference, reference_number, fullname, gender, dob, father_name, mother_name, arrival, email, phone
      FROM submissions ORDER BY id`);
    const rows = sourceRows.map(row => ({
      'MRO Status Number': row.reference,
      'Reference Number': row.reference_number,
      Name: row.fullname,
      Gender: row.gender,
      DOB: toDisplayDate(row.dob),
      "Father's Name": row.father_name,
      'Mother Name': row.mother_name,
      'Date of Arrival to Malaysia': toDisplayDate(row.arrival),
      Email: row.email,
      'Phone Number': row.phone
    }));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Mon Refugee Organization';
    const worksheet = workbook.addWorksheet('MRO Refugee Data', { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = Object.keys(rows[0] || {
      'MRO Status Number': '', 'Reference Number': '', Name: '', Gender: '', DOB: '', "Father's Name": '', 'Mother Name': '',
      'Date of Arrival to Malaysia': '', Email: '', 'Phone Number': ''
    }).map(header => ({ header, key: header, width: Math.max(14, Math.min(34, header.length + 4)) }));
    rows.forEach(row => worksheet.addRow(row));
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9231E' } };
    worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(worksheet.columnCount).letter}1` };
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await audit(req, 'Member data exported', `${rows.length} member records exported to Excel.`, 'export', '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mro-member-data-${malaysiaDate()}.xlsx"`);
    res.send(buffer);
  } catch (error) { next(error); }
});

let activePrintJobs = 0;
app.get('/api/members/:id/print', ...requirePermission('print:forms'), async (req, res, next) => {
  if (activePrintJobs >= 2) return res.set('Retry-After', '5').status(429).json({ error: 'Two forms are being prepared. Please try again in a few seconds.' });
  activePrintJobs += 1;
  let browser;
  try {
    const member = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).send('Member record not found.');
    if (!member.reference_number) return res.status(409).json({ error: 'Add a Reference Number to this member before printing.' });
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(referenceFormHtml(member), { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    await audit(req, 'UNHCR form printed', `${member.reference_number || 'No reference number'} · ${member.fullname}`, 'member', member.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeReference(member.reference_number) || safeReference(member.reference)}-new-registration-request.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (error) { next(error); }
  finally { activePrintJobs -= 1; if (browser) await browser.close(); }
});

app.get('/api/settings/geofence', ...requirePermission('settings:manage'), async (_req, res, next) => {
  try {
    const settings = await geofenceSettings();
    res.json({
      enabled: settings.enabled,
      address: settings.address,
      latitude: settings.latitude,
      longitude: settings.longitude,
      radiusMeters: settings.radiusMeters,
      maxAccuracyMeters: settings.maxAccuracyMeters,
      maxAgeSeconds: settings.maxAgeSeconds,
      configured: geofenceConfigured(settings),
      updatedAt: displayTimestamp(settings.updatedAt)
    });
  } catch (error) { next(error); }
});

app.put('/api/settings/geofence', ...requirePermission('settings:manage'), async (req, res, next) => {
  try {
    const address = String(req.body.address || '').trim().slice(0, 500);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const radius = Math.round(Number(req.body.radiusMeters));
    const maxAccuracy = Math.round(Number(req.body.maxAccuracyMeters));
    const maxAge = Math.round(Number(req.body.maxAgeSeconds));
    if (!address || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Enter the office address and valid latitude/longitude coordinates.' });
    }
    if (!Number.isInteger(radius) || radius < 10 || radius > 5000 || !Number.isInteger(maxAccuracy) || maxAccuracy < 10 || maxAccuracy > 1000 || !Number.isInteger(maxAge) || maxAge < 10 || maxAge > 900) {
      return res.status(400).json({ error: 'Use a radius of 10–5000 m, accuracy of 10–1000 m, and location age of 10–900 seconds.' });
    }
    await run(`UPDATE app_settings SET office_address = ?, geofence_enabled = ?, geofence_latitude = ?, geofence_longitude = ?,
      geofence_radius_meters = ?, geofence_max_accuracy_meters = ?, geofence_max_age_seconds = ?, updated_at = NOW(), updated_by = ? WHERE id = 1`,
    [address, req.body.enabled === true, latitude, longitude, radius, maxAccuracy, maxAge, req.user.id]);
    await audit(req, 'Office geofence updated', `${address} · ${latitude.toFixed(6)}, ${longitude.toFixed(6)} · ${radius} m radius · ${req.body.enabled === true ? 'enabled' : 'disabled'}`, 'settings', 'geofence');
    res.json({ message: 'Office location lock updated.' });
  } catch (error) { next(error); }
});

app.get('/api/attendance', authenticate, requirePasswordChangeComplete, async (req, res, next) => {
  try {
    const geofence = await geofenceSettings();
    const current = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', [req.user.id, malaysiaDate()]);
    const history = await all('SELECT * FROM attendance WHERE user_id = ? ORDER BY work_date DESC LIMIT 30', [req.user.id]);
    const team = req.user.permissions.includes('hr:view') ? await all(`SELECT users.id AS user_id, users.name, users.role, attendance.clock_in, attendance.clock_out
      FROM users LEFT JOIN attendance ON attendance.user_id = users.id AND attendance.work_date = ?
      WHERE users.active = TRUE AND users.deleted_at IS NULL ORDER BY users.name`, [malaysiaDate()]) : [];
    res.json({
      current: current ? { ...attendancePayload(current), status: current.clock_in && !current.clock_out ? 'clocked_in' : 'clocked_out' } : null,
      history: history.map(attendancePayload),
      team: team.map(row => ({ ...row, clock_in: displayTime(row.clock_in), clock_out: displayTime(row.clock_out) })),
      geofence: geofencePayload(geofence)
    });
  } catch (error) { next(error); }
});

app.post('/api/attendance/location-check', authenticate, requirePasswordChangeComplete, async (req, res, next) => {
  try {
    const result = await verifiedClockLocation(req.body.location);
    res.json({
      verified: Boolean(result.location) || !result.settings.enabled,
      distanceMeters: result.location ? Math.round(result.location.distance) : null,
      radiusMeters: result.settings.radiusMeters,
      address: result.settings.address
    });
  } catch (error) { next(error); }
});

app.post('/api/attendance/clock', authenticate, requirePasswordChangeComplete, async (req, res, next) => {
  try {
    const action = req.body.action;
    const { location } = await verifiedClockLocation(req.body.location);
    const date = malaysiaDate(); const time = malaysiaTime(); const now = new Date(); const clockTimestamp = malaysiaTimestamp(date, time);
    const current = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', [req.user.id, date]);
    if (action === 'in') {
      if (current?.clock_in && !current.clock_out) return res.status(409).json({ error: 'You are already clocked in.' });
      if (current?.clock_out) return res.status(409).json({ error: 'Today\'s attendance is already complete.' });
      const inserted = await run(`INSERT INTO attendance (user_id, work_date, clock_in, clock_in_latitude, clock_in_longitude,
        clock_in_accuracy_meters, clock_in_distance_meters, clock_in_location_captured_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, work_date) DO UPDATE SET clock_in = excluded.clock_in,
          clock_in_latitude = excluded.clock_in_latitude, clock_in_longitude = excluded.clock_in_longitude,
          clock_in_accuracy_meters = excluded.clock_in_accuracy_meters, clock_in_distance_meters = excluded.clock_in_distance_meters,
          clock_in_location_captured_at = excluded.clock_in_location_captured_at, updated_at = excluded.updated_at
          WHERE attendance.clock_in IS NULL AND attendance.clock_out IS NULL`,
      [req.user.id, date, clockTimestamp, location?.latitude ?? null, location?.longitude ?? null, location?.accuracy ?? null,
        location?.distance ?? null, location?.capturedAt ?? null, now, now]);
      if (!inserted.changes) return res.status(409).json({ error: 'Attendance has already been recorded. Refresh to see the latest status.' });
      const locationDetail = location ? ` Location verified ${Math.round(location.distance)} m from the office.` : '';
      await audit(req, 'Clocked in', `${req.user.name} clocked in at ${time}.${locationDetail}`, 'attendance', date);
      return res.json({ message: `Clocked in at ${time}.${location ? ' Office location verified.' : ''}` });
    }
    if (action === 'out') {
      if (!current?.clock_in || current.clock_out) return res.status(409).json({ error: 'There is no active clock-in to close.' });
      const updated = await run(`UPDATE attendance SET clock_out = ?, clock_out_latitude = ?, clock_out_longitude = ?,
        clock_out_accuracy_meters = ?, clock_out_distance_meters = ?, clock_out_location_captured_at = ?, updated_at = ?
        WHERE id = ? AND clock_in IS NOT NULL AND clock_out IS NULL`,
      [clockTimestamp, location?.latitude ?? null, location?.longitude ?? null, location?.accuracy ?? null,
        location?.distance ?? null, location?.capturedAt ?? null, now, current.id]);
      if (!updated.changes) return res.status(409).json({ error: 'This shift has already been closed. Refresh to see the latest status.' });
      const locationDetail = location ? ` Location verified ${Math.round(location.distance)} m from the office.` : '';
      await audit(req, 'Clocked out', `${req.user.name} clocked out at ${time}.${locationDetail}`, 'attendance', date);
      return res.json({ message: `Clocked out at ${time}.${location ? ' Office location verified.' : ''}` });
    }
    res.status(400).json({ error: 'Choose clock in or clock out.' });
  } catch (error) { next(error); }
});

const CARDING_CATEGORIES = ['service', 'income', 'expense'];

function nonNegativeInteger(value) {
  return cardCount(value);
}

function cardingValues(body) {
  if (!CARDING_CATEGORIES.includes(body.category)) throw invalid('Choose a valid entry category.');
  if (!dateOrNull(body.record_date)) throw invalid('Enter a valid record date.');
  const category = body.category;
  const paidCards = nonNegativeInteger(body.paid_cards);
  const unpaidCards = nonNegativeInteger(body.unpaid_cards);
  const rate = cleanMoney(body.rate);
  const amount = cleanMoney(body.amount);
  if (rate < 0 || amount < 0) throw invalid('Rate and amount cannot be negative. Choose Expense to record an expense.');
  const serviceTotal = cleanMoney(paidCards * rate);
  return {
    record_date: dateOrNull(body.record_date) || malaysiaDate(),
    category,
    service_type: String(body.service_type || '').trim().slice(0, 120),
    paid_cards: paidCards,
    unpaid_cards: unpaidCards,
    rate,
    amount,
    net_amount: category === 'service' ? serviceTotal : category === 'expense' ? -amount : amount,
    payment_method: String(body.payment_method || 'Not recorded').trim().slice(0, 80),
    notes: String(body.notes || '').trim().slice(0, 1000)
  };
}

app.get('/api/carding', ...requirePermission('carding:view'), async (req, res, next) => {
  try {
    const month = monthRange(req.query.month) ? String(req.query.month) : malaysiaDate().slice(0, 7);
    const range = monthRange(month);
    const records = await all(`SELECT carding_records.*, users.name AS updated_by_name FROM carding_records
      LEFT JOIN users ON users.id = carding_records.updated_by
      WHERE record_date >= ? AND record_date < ? ORDER BY record_date DESC, carding_records.id DESC LIMIT 1000`, [range.start, range.end]);
    const summary = await get(`SELECT COUNT(*)::int AS entries,
      COALESCE(SUM(paid_cards), 0)::int AS "paidCards", COALESCE(SUM(unpaid_cards), 0)::int AS "unpaidCards",
      ROUND(COALESCE(SUM(net_amount) FILTER (WHERE category != 'expense'), 0), 2) AS income,
      ROUND(ABS(COALESCE(SUM(net_amount) FILTER (WHERE category = 'expense'), 0)), 2) AS expenses,
      ROUND(COALESCE(SUM(net_amount), 0), 2) AS net
      FROM carding_records WHERE record_date >= ? AND record_date < ?`, [range.start, range.end]);
    res.json({ month, records, summary });
  } catch (error) { next(error); }
});

app.post('/api/carding', ...requirePermission('carding:edit'), async (req, res, next) => {
  try {
    const values = cardingValues(req.body);
    if (!values.service_type) return res.status(400).json({ error: 'Service or expense type is required.' });
    const result = await run(`INSERT INTO carding_records (record_date, category, service_type, paid_cards, unpaid_cards, rate, amount,
      net_amount, payment_method, notes, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?) RETURNING id`,
    [values.record_date, values.category, values.service_type, values.paid_cards, values.unpaid_cards, values.rate, values.amount,
      values.net_amount, values.payment_method, values.notes, req.user.id, req.user.id]);
    await audit(req, 'Daily carding entry added', `${toDisplayDate(values.record_date)} · ${values.service_type} · ${values.paid_cards + values.unpaid_cards} cards · RM ${values.net_amount.toFixed(2)}`, 'carding', result.lastID);
    res.status(201).json({ id: result.lastID });
  } catch (error) { next(error); }
});

app.put('/api/carding/:id', ...requirePermission('carding:edit'), async (req, res, next) => {
  try {
    const values = cardingValues(req.body);
    if (!values.service_type) return res.status(400).json({ error: 'Service or expense type is required.' });
    const result = await run(`UPDATE carding_records SET record_date = ?, category = ?, service_type = ?, paid_cards = ?, unpaid_cards = ?, rate = ?,
      amount = ?, net_amount = ?, payment_method = ?, notes = ?, updated_at = NOW(), updated_by = ? WHERE id = ?`,
    [values.record_date, values.category, values.service_type, values.paid_cards, values.unpaid_cards, values.rate, values.amount,
      values.net_amount, values.payment_method, values.notes, req.user.id, req.params.id]);
    if (!result.changes) return res.status(404).json({ error: 'Carding entry not found.' });
    await audit(req, 'Daily carding entry updated', `${toDisplayDate(values.record_date)} · ${values.service_type}`, 'carding', req.params.id);
    res.json({ id: Number(req.params.id) });
  } catch (error) { next(error); }
});

function cardingHeaderRow(worksheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.rowCount); rowNumber += 1) {
    const headers = worksheet.getRow(rowNumber).values.slice(1).map(value => spreadsheetValue(value).replace(/\s+/g, ' ').trim());
    const normalized = headers.map(value => value.toLowerCase());
    if (normalized.includes('date') && normalized.includes('service type')) return { rowNumber, headers };
  }
  return null;
}

app.post('/api/carding/import/preview', ...requirePermission('carding:edit'), importUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose the MRO carding workbook.' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const rows = [];
    for (const worksheet of workbook.worksheets.filter(sheet => /_daily$/i.test(sheet.name))) {
      const header = cardingHeaderRow(worksheet); if (!header) continue;
      const names = header.headers.map(name => name.replace(/\s+/g, ' ').trim().toLowerCase());
      const cell = (sourceRow, label) => sourceRow.getCell(names.indexOf(label) + 1).value;
      let currentDate = '';
      worksheet.eachRow((sourceRow, rowNumber) => {
        if (rowNumber <= header.rowNumber || rows.length >= 10000) return;
        const rawDate = spreadsheetValue(cell(sourceRow, 'date'));
        if (rawDate) currentDate = dateOrNull(rawDate) || '';
        const serviceType = spreadsheetValue(cell(sourceRow, 'service type'));
        if (!serviceType || /totals?|month total/i.test(serviceType)) return;
        const paidCards = nonNegativeInteger(spreadsheetValue(cell(sourceRow, 'paid (cards)')));
        const unpaidCards = nonNegativeInteger(spreadsheetValue(cell(sourceRow, 'unpaid (cards)')));
        const rate = cleanMoney(spreadsheetValue(cell(sourceRow, 'rate (rm)')));
        const net = cleanMoney(spreadsheetValue(cell(sourceRow, 'net income (rm)')));
        const category = /card delivery|other expense/i.test(serviceType) ? 'expense' : paidCards || unpaidCards ? 'service' : 'income';
        const amount = category === 'service' ? 0 : Math.abs(net);
        if (!currentDate || (!paidCards && !unpaidCards && !amount)) return;
        rows.push({ id: rows.length + 1, sheet: worksheet.name, sourceRow: rowNumber, record_date: currentDate, category, service_type: serviceType,
          paid_cards: paidCards, unpaid_cards: unpaidCards, rate, amount, net_amount: category === 'service' ? paidCards * rate : category === 'expense' ? -amount : amount,
          valid: true, issue: '' });
      });
    }
    if (!rows.length) return res.status(400).json({ error: 'No completed daily carding rows were found in *_Daily sheets.' });
    const batchId = crypto.randomUUID();
    await run('DELETE FROM import_batches WHERE expires_at <= NOW()');
    await run('INSERT INTO import_batches (id, user_id, import_type, source_name, rows, expires_at) VALUES (?, ?, ?, ?, ?::jsonb, NOW() + INTERVAL \'24 hours\')',
      [batchId, req.user.id, 'carding', req.file.originalname, JSON.stringify(rows)]);
    res.json({ batchId, sourceName: req.file.originalname, rows, valid: rows.length, attention: 0 });
  } catch (error) { next(error); }
});

app.post('/api/carding/import/commit', ...requirePermission('carding:edit'), async (req, res, next) => {
  try {
    const selectedIds = new Set((Array.isArray(req.body.selectedIds) ? req.body.selectedIds : []).map(Number));
    if (!selectedIds.size || selectedIds.size > 10000) return res.status(400).json({ error: 'Select between 1 and 10,000 rows.' });
    const batch = await get(`SELECT * FROM import_batches WHERE id = ? AND user_id = ? AND import_type = 'carding' AND expires_at > NOW()`, [req.body.batchId, req.user.id]);
    if (!batch) return res.status(404).json({ error: 'This import preview has expired. Upload the workbook again.' });
    const selected = batch.rows.filter(row => selectedIds.has(Number(row.id)));
    let imported = 0; let skipped = selectedIds.size - selected.length;
    await transaction(async ({ run: txRun }) => {
      for (const row of selected) {
        const sourceKey = `${batch.source_name}|${row.sheet}|${row.sourceRow}`;
        const result = await txRun(`INSERT INTO carding_records (record_date, category, service_type, paid_cards, unpaid_cards, rate, amount, net_amount,
          source_name, source_key, created_at, updated_at, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
        [row.record_date, row.category, row.service_type, row.paid_cards, row.unpaid_cards, row.rate, row.amount, row.net_amount,
          batch.source_name, sourceKey, req.user.id, req.user.id]);
        if (result.changes) imported += 1; else skipped += 1;
      }
    });
    await run('DELETE FROM import_batches WHERE id = ?', [batch.id]);
    await audit(req, 'Daily carding workbook imported', `${imported} selected rows imported from ${batch.source_name}; ${skipped} skipped.`, 'carding_import', batch.id);
    res.json({ imported, skipped });
  } catch (error) { next(error); }
});

const FINANCE_METHODS = ['Cash', 'Bank transfer', 'E-wallet', 'Cheque', 'Not recorded', 'Other'];
const FINANCE_STATUSES = ['Paid', 'Partial', 'Pending', 'Not recorded'];

function cleanMoney(value) {
  return money(value);
}

function financeValues(body) {
  if (!dateOrNull(body.payment_date)) throw invalid('Enter a valid payment date.');
  const amount = cleanMoney(body.amount);
  const deduction = cleanMoney(body.deduction);
  if (amount < 0 || deduction < 0) throw invalid('Amount and deduction cannot be negative.');
  return {
    payment_date: dateOrNull(body.payment_date) || malaysiaDate(),
    concern_person: String(body.concern_person || '').trim().slice(0, 180),
    concern_number: String(body.concern_number || '').trim().slice(0, 80),
    service_type: String(body.service_type || '').trim().slice(0, 100),
    amount,
    deduction,
    net_amount: body.net_amount === '' || body.net_amount == null ? amount - deduction : cleanMoney(body.net_amount),
    payment_method: FINANCE_METHODS.includes(body.payment_method) ? body.payment_method : 'Not recorded',
    payment_status: FINANCE_STATUSES.includes(body.payment_status) ? body.payment_status : 'Not recorded',
    notes: String(body.notes || '').trim().slice(0, 1000)
  };
}

app.get('/api/finance', ...requirePermission('finance:view'), async (req, res, next) => {
  try {
    const query = `%${String(req.query.q || '').trim()}%`;
    const rows = await all(`SELECT finance_records.*, users.name AS updated_by_name
      FROM finance_records LEFT JOIN users ON users.id = finance_records.updated_by
      WHERE concern_person ILIKE ? OR concern_number ILIKE ? OR service_type ILIKE ? OR notes ILIKE ?
      ORDER BY payment_date DESC, finance_records.id DESC LIMIT 1000`, [query, query, query, query]);
    const summary = await get(`SELECT COUNT(*)::int AS transactions,
      ROUND(COALESCE(SUM(amount), 0), 2) AS amount,
      ROUND(COALESCE(SUM(deduction), 0), 2) AS deductions,
      ROUND(COALESCE(SUM(net_amount), 0), 2) AS net,
      COUNT(*) FILTER (WHERE payment_status IN ('Pending', 'Partial'))::int AS pending
      FROM finance_records WHERE payment_date >= date_trunc('month', CURRENT_DATE)::date`);
    const trend = await all(`WITH months AS (
        SELECT generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months', date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS month
      ) SELECT to_char(month, 'Mon') AS label, ROUND(COALESCE(SUM(net_amount), 0), 2) AS value
      FROM months LEFT JOIN finance_records ON payment_date >= months.month AND payment_date < months.month + INTERVAL '1 month'
      GROUP BY month ORDER BY month`);
    const methods = await all(`SELECT payment_method AS label, COUNT(*)::int AS value
      FROM finance_records GROUP BY payment_method ORDER BY value DESC, label`);
    res.json({ records: rows, summary, charts: { trend, methods } });
  } catch (error) { next(error); }
});

app.post('/api/finance', ...requirePermission('finance:edit'), async (req, res, next) => {
  try {
    const values = financeValues(req.body);
    if (!values.concern_person && !values.concern_number) return res.status(400).json({ error: 'Add the Concern Person or Concern Person’s number.' });
    const fields = Object.keys(values);
    const result = await run(`INSERT INTO finance_records (${fields.join(', ')}, created_by, updated_by)
      VALUES (${fields.map(() => '?').join(', ')}, ?, ?) RETURNING id`, [...fields.map(field => values[field]), req.user.id, req.user.id]);
    await audit(req, 'Finance record created', `${values.concern_person || values.concern_number} · RM ${values.net_amount.toFixed(2)}`, 'finance', result.lastID);
    res.status(201).json({ id: result.lastID });
  } catch (error) { next(error); }
});

app.put('/api/finance/:id', ...requirePermission('finance:edit'), async (req, res, next) => {
  try {
    const existing = await get('SELECT * FROM finance_records WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Finance record not found.' });
    const values = financeValues(req.body);
    if (!values.concern_person && !values.concern_number) return res.status(400).json({ error: 'Add the Concern Person or Concern Person’s number.' });
    const fields = Object.keys(values);
    await run(`UPDATE finance_records SET ${fields.map(field => `${field} = ?`).join(', ')}, updated_at = NOW(), updated_by = ? WHERE id = ?`,
      [...fields.map(field => values[field]), req.user.id, req.params.id]);
    await audit(req, 'Finance record updated', `${values.concern_person || values.concern_number} · RM ${values.net_amount.toFixed(2)}`, 'finance', req.params.id);
    res.json({ id: Number(req.params.id) });
  } catch (error) { next(error); }
});

app.post('/api/finance/import', ...requirePermission('finance:edit'), importUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose the MRO carding Excel workbook.' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheets = workbook.worksheets.filter(sheet => /_BankedIn$/i.test(sheet.name));
    if (!sheets.length) return res.status(400).json({ error: 'No monthly BankedIn sheets were found in this workbook.' });
    let imported = 0; let skipped = 0;
    await transaction(async ({ run: txRun }) => {
      for (const sheet of sheets) {
        for (let rowNumber = 4; rowNumber <= sheet.rowCount; rowNumber += 1) {
          const row = sheet.getRow(rowNumber);
          const paymentDate = dateOrNull(spreadsheetValue(row.getCell(2).value));
          const concernPerson = spreadsheetValue(row.getCell(3).value).slice(0, 180);
          const concernNumber = spreadsheetValue(row.getCell(4).value).slice(0, 80);
          const amount = cleanMoney(spreadsheetValue(row.getCell(5).value));
          const deduction = cleanMoney(spreadsheetValue(row.getCell(6).value));
          const netAmount = importNetAmount(spreadsheetValue(row.getCell(7).value), amount, deduction);
          const notes = spreadsheetValue(row.getCell(8).value).slice(0, 1000);
          if (!paymentDate || (!concernPerson && !concernNumber && !amount && !deduction && !netAmount)) continue;
          const sourceKey = crypto.createHash('sha256').update([sheet.name, rowNumber, paymentDate, concernPerson, concernNumber, amount, deduction, netAmount, notes].join('|')).digest('hex');
          const result = await txRun(`INSERT INTO finance_records
            (payment_date, concern_person, concern_number, amount, deduction, net_amount, payment_method, payment_status, notes, source_name, source_key, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, 'Not recorded', 'Not recorded', ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING RETURNING id`,
          [paymentDate, concernPerson, concernNumber, amount, deduction, netAmount, notes, `${req.file.originalname} · ${sheet.name}`, sourceKey, req.user.id, req.user.id]);
          if (result.changes) imported += 1; else skipped += 1;
        }
      }
    });
    await audit(req, 'Finance workbook imported', `${imported} payment rows imported from ${req.file.originalname}; ${skipped} duplicates skipped.`, 'finance_import', '');
    res.json({ imported, skipped });
  } catch (error) { next(error); }
});

app.get('/api/hr/staff', ...requirePermission('hr:view'), async (_req, res, next) => {
  try {
    const staff = await all(`SELECT users.id, users.name, users.email, users.role, users.active,
      COALESCE(staff_profiles.employment_type, 'full_time') AS employment_type,
      COALESCE(staff_profiles.job_title, '') AS job_title,
      COALESCE(staff_profiles.department, '') AS department,
      staff_profiles.start_date,
      COALESCE(staff_profiles.weekly_target_hours, 40) AS weekly_target_hours,
      COALESCE(staff_profiles.notes, '') AS notes,
      COALESCE(kpi.days_this_month, 0)::int AS days_this_month,
      COALESCE(kpi.completed_shifts, 0)::int AS completed_shifts,
      ROUND(COALESCE(kpi.hours_this_month, 0)::numeric, 1) AS hours_this_month
      FROM users LEFT JOIN staff_profiles ON staff_profiles.user_id = users.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE work_date >= date_trunc('month', CURRENT_DATE)::date) AS days_this_month,
          COUNT(*) FILTER (WHERE work_date >= date_trunc('month', CURRENT_DATE)::date AND clock_in IS NOT NULL AND clock_out IS NOT NULL) AS completed_shifts,
          SUM(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600) FILTER (WHERE work_date >= date_trunc('month', CURRENT_DATE)::date AND clock_out IS NOT NULL) AS hours_this_month
        FROM attendance WHERE attendance.user_id = users.id
      ) kpi ON TRUE WHERE users.deleted_at IS NULL ORDER BY users.active DESC, users.name`);
    res.json({ staff });
  } catch (error) { next(error); }
});

app.put('/api/hr/staff/:userId', ...requirePermission('hr:edit'), async (req, res, next) => {
  try {
    const employmentType = String(req.body.employment_type || 'full_time');
    const allowedTypes = ['full_time', 'part_time', 'volunteer', 'contract'];
    const targetHours = Math.max(1, Math.min(168, cleanMoney(req.body.weekly_target_hours || 40)));
    if (!allowedTypes.includes(employmentType)) return res.status(400).json({ error: 'Choose a valid employment type.' });
    const target = await get('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'Staff account not found.' });
    await run(`INSERT INTO staff_profiles (user_id, employment_type, job_title, department, start_date, weekly_target_hours, notes, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)
      ON CONFLICT (user_id) DO UPDATE SET employment_type = EXCLUDED.employment_type, job_title = EXCLUDED.job_title,
        department = EXCLUDED.department, start_date = EXCLUDED.start_date, weekly_target_hours = EXCLUDED.weekly_target_hours,
        notes = EXCLUDED.notes, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [target.id, employmentType, String(req.body.job_title || '').trim().slice(0, 120), String(req.body.department || '').trim().slice(0, 120),
      dateOrNull(req.body.start_date), targetHours, String(req.body.notes || '').trim().slice(0, 1000), req.user.id]);
    await audit(req, 'Staff profile updated', `${target.name} · ${employmentType.replace('_', ' ')}`, 'staff', target.id);
    res.json({ id: target.id });
  } catch (error) { next(error); }
});

app.get('/api/users', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    const users = await all(`SELECT id, name, email, role, active, must_change_password, created_at
      FROM users WHERE deleted_at IS NULL ORDER BY active DESC, name`);
    const activeAdminCount = users.filter(user => user.role === 'admin' && user.active).length;
    res.json({
      users: users.map(user => ({ ...user, created_at: displayTimestamp(user.created_at), access_summary: roleSummary(user.role),
        ...accountCapabilities(req.user, user, activeAdminCount) })),
      roles: Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label, summary: roleSummary(id), permissions: ROLE_PERMISSIONS[id],
        assignable: id !== 'admin' || req.user.role === 'admin' })),
      activeAdminCount
    });
  } catch (error) { next(error); }
});

function roleSummary(role) {
  return ({ admin: 'Full system access including office settings', chair: 'Oversight, records, carding, finance, HR, printing and non-admin roles', secretary: 'Member lookup and form printing', hr: 'Attendance, staff profiles and people operations', card_printing: 'Records, photos, printing and daily carding', data_management: 'Records, import and export', finance: 'Payment, daily carding, expense and finance summaries' })[role] || 'Limited access';
}

function requestError(status, message) {
  const error = new Error(message); error.status = status; return error;
}

async function manageAccounts(req, callback) {
  return transaction(async tx => {
    // Serialize all account mutations, including the bootstrap/admin CLI, so
    // two requests cannot both remove what each thinks is the other admin.
    await tx.run('SELECT pg_advisory_xact_lock(771462, 2)');
    const actor = await tx.get(`SELECT users.* FROM users JOIN sessions ON sessions.user_id = users.id
      WHERE sessions.token_hash = ? AND sessions.expires_at > NOW() AND users.active = TRUE AND users.deleted_at IS NULL`, [req.sessionTokenHash]);
    if (!actor || actor.must_change_password || !ROLE_PERMISSIONS[actor.role]?.includes('users:manage')) {
      throw requestError(403, 'Your access has changed. Refresh the page and sign in again.');
    }
    return callback(tx, actor);
  });
}

app.post('/api/users', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim(); const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || ''); const role = String(req.body.role || '');
    const policyError = passwordPolicyError(password);
    if (!name || name.length > 160 || !validEmail(email) || !Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) return res.status(400).json({ error: 'A name up to 160 characters, valid email and supported role are required.' });
    if (policyError) return res.status(400).json({ error: policyError.replace('new password', 'temporary password') });
    const passwordHash = await hashPassword(password);
    const result = await manageAccounts(req, async (tx, actor) => {
      if (role === 'admin' && actor.role !== 'admin') throw requestError(403, 'Only an administrator can create another administrator.');
      return tx.run(`INSERT INTO users (name, email, password_hash, role, active, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, TRUE, TRUE, NOW(), NOW()) RETURNING id`, [name, email, passwordHash, role]);
    });
    await audit(req, 'Staff account created', `${name} · ${ROLE_LABELS[role]}`, 'user', result.lastID);
    res.status(201).json({ id: result.lastID });
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' }); next(error); }
});

app.put('/api/users/:id', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    const result = await manageAccounts(req, async (tx, actor) => {
      const target = await tx.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!target) throw requestError(404, 'User not found.');
      const has = field => Object.prototype.hasOwnProperty.call(req.body, field);
      if (['name', 'email', 'active'].some(has) && actor.role !== 'admin') throw requestError(403, 'Only an administrator can edit staff account details.');
      if (has('active') && typeof req.body.active !== 'boolean') throw requestError(400, 'Account status must be active or inactive.');
      const name = has('name') ? String(req.body.name || '').trim() : target.name;
      const email = has('email') ? String(req.body.email || '').trim().toLowerCase() : target.email;
      const role = has('role') ? String(req.body.role || '') : target.role;
      const active = has('active') ? req.body.active : Boolean(target.active);
      if (!name || name.length > 160) throw requestError(400, 'Enter a staff name no longer than 160 characters.');
      if (!validEmail(email)) throw requestError(400, 'Enter a valid email address.');
      if (!Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) throw requestError(400, 'Choose a valid role.');
      if (actor.role !== 'admin' && (target.role === 'admin' || role === 'admin')) throw requestError(403, 'Only an administrator can assign or change administrator access.');
      if (String(target.id) === String(actor.id) && (role !== target.role || !active)) throw requestError(409, 'You cannot change your own role or deactivate the account you are currently using.');
      if (target.role === 'admin' && target.active && (role !== 'admin' || !active)) {
        const otherAdmins = await tx.get(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE AND deleted_at IS NULL AND id <> ?`, [target.id]);
        if (!otherAdmins.count) throw requestError(409, 'Assign another active administrator before changing or deactivating the last administrator.');
      }
      await tx.run('UPDATE users SET name = ?, email = ?, role = ?, active = ?, updated_at = NOW() WHERE id = ?', [name, email, role, active, target.id]);
      if (!active || role !== target.role) await tx.run('DELETE FROM sessions WHERE user_id = ?', [target.id]);
      const changes = [];
      if (name !== target.name) changes.push(`name: ${target.name} → ${name}`);
      if (email !== target.email) changes.push(`email: ${target.email} → ${email}`);
      if (role !== target.role) changes.push(`role: ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}`);
      if (active !== Boolean(target.active)) changes.push(active ? 'account reactivated' : 'account deactivated');
      return { updated: { ...target, name, email, role, active }, changes };
    });
    const { updated, changes } = result;
    await audit(req, 'Staff account updated', `${updated.name} · ${changes.join('; ') || 'details saved without changes'}`, 'user', updated.id);
    res.json({ user: userPayload(updated), record: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, active: updated.active, must_change_password: Boolean(updated.must_change_password), access_summary: roleSummary(updated.role) } });
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' }); next(error); }
});

app.post('/api/users/:id/reset-password', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can reset staff passwords.' });
    const password = String(req.body.password || '');
    const policyError = passwordPolicyError(password);
    if (policyError) return res.status(400).json({ error: policyError.replace('new password', 'temporary password') });
    const passwordHash = await hashPassword(password);
    const target = await manageAccounts(req, async (tx, actor) => {
      if (actor.role !== 'admin') throw requestError(403, 'Only an administrator can reset staff passwords.');
      const user = await tx.get('SELECT id, name, active FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!user) throw requestError(404, 'User not found.');
      if (String(user.id) === String(actor.id)) throw requestError(409, 'Change your own password from Profile & access.');
      if (!user.active) throw requestError(409, 'Reactivate the account before resetting its password.');
      await tx.run('UPDATE users SET password_hash = ?, must_change_password = TRUE, password_changed_at = NOW(), updated_at = NOW() WHERE id = ?', [passwordHash, user.id]);
      await tx.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      return user;
    });
    await audit(req, 'Staff password reset', `${target.name} · temporary password issued; existing sessions revoked.`, 'user', target.id);
    res.json({ id: target.id });
  } catch (error) { next(error); }
});

app.delete('/api/users/:id', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    const target = await manageAccounts(req, async (tx, actor) => {
      if (actor.role !== 'admin') throw requestError(403, 'Only an administrator can delete staff accounts.');
      const user = await tx.get('SELECT id, name, email, role, active FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!user) throw requestError(404, 'User not found.');
      if (String(user.id) === String(actor.id)) throw requestError(409, 'You cannot delete the account you are currently using.');
      if (String(req.body?.confirmation || '').trim().toLowerCase() !== user.email.toLowerCase()) throw requestError(400, 'Type the staff email address to confirm account deletion.');
      if (user.role === 'admin' && user.active) {
        const otherAdmins = await tx.get(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE AND deleted_at IS NULL AND id <> ?`, [user.id]);
        if (!otherAdmins.count) throw requestError(409, 'Create another active administrator before deleting the last administrator.');
      }
      await tx.run(`UPDATE users SET email = ?, active = FALSE, must_change_password = FALSE, deleted_at = NOW(), updated_at = NOW()
        WHERE id = ?`, [`deleted+${user.id}.${crypto.randomUUID()}@mro.invalid`, user.id]);
      await tx.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      return user;
    });
    await audit(req, 'Staff account deleted', `${target.name} · ${ROLE_LABELS[target.role]} · access revoked; historical records retained.`, 'user', target.id);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/audit', ...requirePermission('audit:view'), async (req, res, next) => {
  try { res.json({ activity: (await visibleAuditRows(req.user, 250)).map(auditPayload) }); }
  catch (error) { next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

if (HAS_CLIENT_BUILD) {
  app.use(express.static(path.join(ROOT, 'dist'), { index: false }));
  app.get('*', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, 'dist', 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('MRO API is running. Open http://localhost:5173 for the React app.'));
}

app.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'The selected file is too large.' : 'Use a JPG or PNG photo.';
    return res.status(400).json({ error: message });
  }
  if (!error.status || error.status >= 500) console.error(error);
  if (req.path.startsWith('/api')) {
    const databaseUnavailable = ['ECONNREFUSED', '57P01', '57P03', '08001', '08006'].includes(error.code);
    const status = databaseUnavailable ? 503 : Number.isInteger(error.status) ? error.status : 500;
    return res.status(status).json({
      error: databaseUnavailable ? 'PostgreSQL is unavailable. Start the PostgreSQL service and try again.' : error.status ? error.message : 'The server could not complete this request.',
      ...(error.responseCode ? { code: error.responseCode } : {})
    });
  }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  return res.status(status).send(status === 404 ? 'Not found.' : status === 403 ? 'Access denied.' : 'Internal Server Error');
});

let server;
async function startServer() {
  await initializeDatabase();
  await seedInitialUser();
  server = app.listen(PORT, () => console.log(`MRO Node server running at http://localhost:${PORT}`));
  return server;
}

async function shutdown() {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDatabase();
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('Unable to initialize MRO Registry:', error);
    process.exitCode = 1;
  });
  process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
}

module.exports = { app, startServer, shutdown, seedInitialUser, storePhoto, validPhotoBytes, boundedPhotoBuffer };
