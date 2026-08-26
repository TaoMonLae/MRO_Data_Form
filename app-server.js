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
require('dotenv').config();
const { run, get, all, transaction, initializeDatabase, closeDatabase } = require('./database');

const app = express();
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HAS_CLIENT_BUILD = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
const SESSION_DAYS = 7;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

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
app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: IS_PRODUCTION ? '1d' : 0 }));
app.use('/uploads', express.static(path.join(ROOT, 'public', 'uploads'), { fallthrough: false }));

function malaysiaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function malaysiaDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date).replace(',', '');
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
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function toDisplayDate(value) {
  const normalized = toIsoDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : normalized;
}

function toIsoDate(value) {
  if (value instanceof Date) return malaysiaDate(value);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  if (iso) return iso[1];
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || ''));
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

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
  }));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function photoUrl(photoPath) {
  return photoPath ? `/uploads/${encodeURIComponent(path.basename(photoPath))}` : '';
}

function memberPayload(row) {
  if (!row) return null;
  return { ...row, dob: toIsoDate(row.dob), arrival: toIsoDate(row.arrival), photo_url: photoUrl(row.photo_path) };
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
  const count = await get('SELECT COUNT(*)::int AS count FROM users');
  if (count.count) return;
  const email = process.env.INITIAL_ADMIN_EMAIL || (IS_PRODUCTION ? '' : 'chair@mro.local');
  const password = process.env.INITIAL_ADMIN_PASSWORD || (IS_PRODUCTION ? '' : 'Mro2026!');
  const role = process.env.INITIAL_ADMIN_ROLE || 'chair';
  if (email && password) {
    await run(`INSERT INTO users (name, email, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, TRUE, NOW(), NOW()) RETURNING id`,
    [process.env.INITIAL_ADMIN_NAME || 'MRO Chair Person', email.toLowerCase(), hashPassword(password), role]);
    console.log(`Initial ${ROLE_LABELS[role]} account created for ${email}`);
  } else {
    console.warn('No users exist. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then restart.');
  }
}

async function audit(req, action, detail, entityType = '', entityId = '') {
  const actor = req.user || { id: null, name: 'System' };
  await run('INSERT INTO audit_logs (user_id, actor_name, action, detail, entity_type, entity_id, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [actor.id, actor.name, action, detail, entityType, String(entityId || ''), req.ip, new Date()]);
}

async function authenticate(req, res, next) {
  try {
    const token = parseCookies(req).mro_session;
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await get(`SELECT users.id, users.name, users.email, users.role, users.active
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > NOW()`, [tokenHash]);
    if (!row || !row.active) return res.status(401).json({ error: 'Your session has expired.' });
    req.user = { ...row, permissions: ROLE_PERMISSIONS[row.role] || [] };
    next();
  } catch (error) { next(error); }
}

function requirePermission(permission) {
  return [authenticate, (req, res, next) => req.user.permissions.includes(permission)
    ? next()
    : res.status(403).json({ error: 'Your role does not allow this action.' })];
}

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await get('SELECT * FROM users WHERE LOWER(email) = ? AND active = TRUE', [email]);
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await run('DELETE FROM sessions WHERE expires_at <= NOW()');
    await run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [tokenHash, user.id, new Date(Date.now() + SESSION_DAYS * 86400000), new Date()]);
    res.cookie('mro_session', token, { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', maxAge: SESSION_DAYS * 86400000, path: '/' });
    req.user = user;
    await audit(req, 'Signed in', `${user.name} signed in to the staff portal.`, 'user', user.id);
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, permissions: ROLE_PERMISSIONS[user.role] || [] });
  } catch (error) { next(error); }
});

app.get('/api/health', async (_req, res, next) => {
  try {
    await get('SELECT 1 AS ok');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.get('/api/auth/session', authenticate, (req, res) => res.json(req.user));
app.post('/api/auth/logout', authenticate, async (req, res, next) => {
  try {
    const token = parseCookies(req).mro_session;
    if (token) await run('DELETE FROM sessions WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]);
    await audit(req, 'Signed out', `${req.user.name} signed out.`, 'user', req.user.id);
    res.clearCookie('mro_session', { path: '/' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/dashboard', authenticate, async (req, res, next) => {
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
    const activity = req.user.permissions.includes('audit:view') ? await all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 6') : [];
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
      ), staff AS (SELECT COUNT(*)::int AS total FROM users WHERE active = TRUE)
      SELECT to_char(days.day, 'Dy') AS label, COUNT(DISTINCT attendance.user_id)::int AS value, staff.total
      FROM days CROSS JOIN staff LEFT JOIN attendance ON attendance.work_date = days.day AND attendance.clock_in IS NOT NULL
      GROUP BY days.day, staff.total ORDER BY days.day`);
    const organization = await get(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE active = TRUE) AS "activeUsers",
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
      (SELECT COUNT(*)::int FROM users WHERE active = TRUE) AS "activeStaff",
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
    const rows = await all(`SELECT * FROM submissions WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 500`, params);
    res.json({ records: rows.map(memberPayload) });
  } catch (error) { next(error); }
});

const MEMBER_FIELDS = ['reference', 'reference_number', 'unhcr_status', 'unhcr_file_number', 'individual_number', 'fullname', 'father_name', 'mother_name',
  'email', 'phone', 'phone2', 'country', 'ethnicity', 'religion', 'gender', 'dob', 'arrival', 'address_state', 'vulnerability', 'consent'];

function memberValues(body) {
  return Object.fromEntries(MEMBER_FIELDS.map(field => [field, String(body[field] ?? '').trim()]));
}

async function storePhoto(file, reference, previousPath = '') {
  if (!file) return previousPath || '';
  const clean = safeReference(reference);
  if (!clean) throw new Error('A valid MRO status number is required before uploading a photo.');
  const uploads = path.join(ROOT, 'public', 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const target = path.join(uploads, `${clean}${PHOTO_TYPES.get(file.mimetype)}`);
  if (previousPath && path.resolve(previousPath) !== path.resolve(target) && fs.existsSync(previousPath)) fs.renameSync(previousPath, target);
  else fs.renameSync(file.path, target);
  return target;
}

app.post('/api/members', ...requirePermission('members:edit'), photoUpload.single('photo'), async (req, res, next) => {
  let completed = false;
  try {
    const values = memberValues(req.body);
    if (!safeReference(values.reference) || !values.fullname) return res.status(400).json({ error: 'MRO status number and full name are required.' });
    values.reference = safeReference(values.reference);
    values.reference_number = cleanReferenceNumber(values.reference_number);
    const photoPath = await storePhoto(req.file, values.reference);
    const now = new Date();
    const columns = [...MEMBER_FIELDS, 'photo_path', 'family_members', 'family_members_data', 'created_at', 'updated_at', 'updated_by'];
    const result = await run(`INSERT INTO submissions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) RETURNING id`,
      [...MEMBER_FIELDS.map(field => field === 'dob' || field === 'arrival' ? dateOrNull(values[field]) : values[field]), photoPath, 0, '[]', now, now, req.user.id]);
    completed = true;
    await audit(req, 'Member record created', `${values.reference} · ${values.fullname}`, 'member', result.lastID);
    res.status(201).json({ id: result.lastID });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That MRO status number or reference number already exists.' });
    next(error);
  } finally { if (req.file && !completed && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
});

app.put('/api/members/:id', ...requirePermission('members:edit'), photoUpload.single('photo'), async (req, res, next) => {
  let completed = false;
  try {
    const existing = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Member record not found.' });
    const values = memberValues(req.body);
    if (!safeReference(values.reference) || !values.fullname) return res.status(400).json({ error: 'MRO status number and full name are required.' });
    values.reference = safeReference(values.reference);
    values.reference_number = cleanReferenceNumber(values.reference_number);
    const photoPath = await storePhoto(req.file, values.reference, existing.photo_path);
    await run(`UPDATE submissions SET ${MEMBER_FIELDS.map(field => `${field} = ?`).join(', ')}, photo_path = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [...MEMBER_FIELDS.map(field => field === 'dob' || field === 'arrival' ? dateOrNull(values[field]) : values[field]), photoPath, new Date(), req.user.id, req.params.id]);
    completed = true;
    await audit(req, 'Member record updated', `${values.reference} · ${values.fullname}`, 'member', req.params.id);
    res.json({ id: Number(req.params.id) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That MRO status number or reference number already exists.' });
    next(error);
  } finally { if (req.file && !completed && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
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
    return `${day}/${month}/${value.getUTCFullYear()}`;
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
    let matched = 0; let invalid = 0; let oversized = 0; const unmatched = [];
    for (const entry of entries) {
      const filename = path.posix.basename(String(entry.path).replaceAll('\\', '/'));
      const extension = path.extname(filename).toLowerCase();
      if (!['.jpg', '.jpeg', '.png'].includes(extension)) { invalid += 1; continue; }
      const stem = path.basename(filename, extension);
      const reference = safeReference(stem);
      if (!reference || reference !== stem || !members.has(reference)) { if (unmatched.length < 100) unmatched.push(filename); continue; }
      const size = Number(entry.uncompressedSize || entry.vars?.uncompressedSize || 0);
      if (size > MAX_PHOTO_BYTES) { oversized += 1; continue; }
      const buffer = await entry.buffer();
      if (buffer.length > MAX_PHOTO_BYTES || !validPhotoBytes(buffer, extension)) { invalid += 1; continue; }
      const member = members.get(reference);
      const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
      const target = path.join(uploads, `${reference}${normalizedExtension}`);
      await fs.promises.writeFile(target, buffer, { mode: 0o640 });
      if (member.photo_path && path.resolve(member.photo_path) !== path.resolve(target) && fs.existsSync(member.photo_path)) await fs.promises.unlink(member.photo_path);
      await run('UPDATE submissions SET photo_path = ?, updated_at = NOW(), updated_by = ? WHERE id = ?', [target, req.user.id, member.id]);
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

function referenceFormHtml(member) {
  const logoPath = path.join(ROOT, 'public', 'unLogo.png');
  const logo = fs.existsSync(logoPath) ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}` : '';
  const yesNo = member.unhcr_status === 'Yes' ? 'Yes, I am registered' : 'No, I am not registered';
  const pageOneFields = [
    ['Reference number', member.reference_number], ['Are you registered with UNHCR?', yesNo],
    ...(member.unhcr_status === 'Yes' ? [['UNHCR file number', member.unhcr_file_number], ['Individual number', member.individual_number]] : []),
    ['Full name', member.fullname], ['Email', member.email], ['Phone number', member.phone], ['Country of origin', member.country], ['Ethnicity', member.ethnicity],
    ['Religion', member.religion], ['Gender', member.gender], ['Date of birth', toDisplayDate(member.dob)],
    ['Date of arrival in Malaysia', toDisplayDate(member.arrival)],
    ['I have the following documents (optional) (Checked)', 'Other identity documents'],
    ['I have the following documents (optional) (Other identity documents)', 'Other identity documents'],
    ['Number of additional family members to be registered', member.family_members || '0']
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 13mm 15mm 15mm; }
    * { box-sizing: border-box; } body { margin: 0; color: #111; font: 12px/1.45 Arial, sans-serif; }
    header { height: 35mm; display: grid; place-content: center; }
    header img { width: 77mm; max-height: 27mm; object-fit: contain; }
    .form { border: 1px solid #d4d4d4; }
    .title { width: 64%; min-height: 7mm; padding: 3px 7px; background: #e5e5e5; font-size: 14px; }
    .row { break-inside: avoid; }
    .label { min-height: 6.7mm; padding: 3px 7px; background: #e8f1f9; border-top: 1px solid #e1e1e1; }
    .value { min-height: 7.4mm; padding: 4px 12mm; background: #fff; border-top: 1px solid #ededed; }
    .value:last-child { padding-bottom: 5px; }
    .second-page { page-break-before: always; padding-top: 0; }
    .second-page .title { margin-bottom: 0; }
    .consent-value { min-height: 7.4mm; padding: 4px 12mm; }
  </style></head><body><header>${logo ? `<img src="${logo}" alt="UNHCR">` : ''}</header><main class="form"><div class="title">New Registration Request</div>
    ${pageOneFields.map(([label, value]) => `<section class="row"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value || '—')}</div></section>`).join('')}
    <section class="row"><div class="label">Consent (Consent)</div></section></main>
    <main class="form second-page"><div class="title">New Registration Request</div>
      <div class="consent-value">${member.consent === 'yes' ? 'Checked' : 'Not checked'}</div>
      <section class="row"><div class="label">Consent (Text)</div><div class="value">I hereby declare that the information provided is true, accurate and giving my permission to UNHCR to use it for the purpose of this form.</div></section>
    </main></body></html>`;
}

app.get('/api/members/:id/print', ...requirePermission('print:forms'), async (req, res, next) => {
  let browser;
  try {
    const member = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).send('Member record not found.');
    if (!member.reference_number) return res.status(409).json({ error: 'Add a Reference Number to this member before printing.' });
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(referenceFormHtml(member), { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    await audit(req, 'UNHCR form printed', `${member.reference_number || 'No reference number'} · ${member.fullname}`, 'member', member.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeReference(member.reference_number) || safeReference(member.reference)}-new-registration-request.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (error) { next(error); }
  finally { if (browser) await browser.close(); }
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

app.get('/api/attendance', authenticate, async (req, res, next) => {
  try {
    const geofence = await geofenceSettings();
    const current = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', [req.user.id, malaysiaDate()]);
    const history = await all('SELECT * FROM attendance WHERE user_id = ? ORDER BY work_date DESC LIMIT 30', [req.user.id]);
    const team = await all(`SELECT users.id AS user_id, users.name, users.role, attendance.clock_in, attendance.clock_out
      FROM users LEFT JOIN attendance ON attendance.user_id = users.id AND attendance.work_date = ?
      WHERE users.active = TRUE ORDER BY users.name`, [malaysiaDate()]);
    res.json({
      current: current ? { ...attendancePayload(current), status: current.clock_in && !current.clock_out ? 'clocked_in' : 'clocked_out' } : null,
      history: history.map(attendancePayload),
      team: team.map(row => ({ ...row, clock_in: displayTime(row.clock_in), clock_out: displayTime(row.clock_out) })),
      geofence: geofencePayload(geofence)
    });
  } catch (error) { next(error); }
});

app.post('/api/attendance/location-check', authenticate, async (req, res, next) => {
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

app.post('/api/attendance/clock', authenticate, async (req, res, next) => {
  try {
    const action = req.body.action;
    const { location } = await verifiedClockLocation(req.body.location);
    const date = malaysiaDate(); const time = malaysiaTime(); const now = new Date(); const clockTimestamp = malaysiaTimestamp(date, time);
    const current = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', [req.user.id, date]);
    if (action === 'in') {
      if (current?.clock_in && !current.clock_out) return res.status(409).json({ error: 'You are already clocked in.' });
      if (current?.clock_out) return res.status(409).json({ error: 'Today\'s attendance is already complete.' });
      await run(`INSERT INTO attendance (user_id, work_date, clock_in, clock_in_latitude, clock_in_longitude,
        clock_in_accuracy_meters, clock_in_distance_meters, clock_in_location_captured_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, work_date) DO UPDATE SET clock_in = excluded.clock_in,
          clock_in_latitude = excluded.clock_in_latitude, clock_in_longitude = excluded.clock_in_longitude,
          clock_in_accuracy_meters = excluded.clock_in_accuracy_meters, clock_in_distance_meters = excluded.clock_in_distance_meters,
          clock_in_location_captured_at = excluded.clock_in_location_captured_at, updated_at = excluded.updated_at`,
      [req.user.id, date, clockTimestamp, location?.latitude ?? null, location?.longitude ?? null, location?.accuracy ?? null,
        location?.distance ?? null, location?.capturedAt ?? null, now, now]);
      const locationDetail = location ? ` Location verified ${Math.round(location.distance)} m from the office.` : '';
      await audit(req, 'Clocked in', `${req.user.name} clocked in at ${time}.${locationDetail}`, 'attendance', date);
      return res.json({ message: `Clocked in at ${time}.${location ? ' Office location verified.' : ''}` });
    }
    if (action === 'out') {
      if (!current?.clock_in || current.clock_out) return res.status(409).json({ error: 'There is no active clock-in to close.' });
      await run(`UPDATE attendance SET clock_out = ?, clock_out_latitude = ?, clock_out_longitude = ?,
        clock_out_accuracy_meters = ?, clock_out_distance_meters = ?, clock_out_location_captured_at = ?, updated_at = ? WHERE id = ?`,
      [clockTimestamp, location?.latitude ?? null, location?.longitude ?? null, location?.accuracy ?? null,
        location?.distance ?? null, location?.capturedAt ?? null, now, current.id]);
      const locationDetail = location ? ` Location verified ${Math.round(location.distance)} m from the office.` : '';
      await audit(req, 'Clocked out', `${req.user.name} clocked out at ${time}.${locationDetail}`, 'attendance', date);
      return res.json({ message: `Clocked out at ${time}.${location ? ' Office location verified.' : ''}` });
    }
    res.status(400).json({ error: 'Choose clock in or clock out.' });
  } catch (error) { next(error); }
});

const CARDING_CATEGORIES = ['service', 'income', 'expense'];

function nonNegativeInteger(value) {
  const number = Math.round(Number(value || 0));
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function cardingValues(body) {
  const category = CARDING_CATEGORIES.includes(body.category) ? body.category : 'service';
  const paidCards = nonNegativeInteger(body.paid_cards);
  const unpaidCards = nonNegativeInteger(body.unpaid_cards);
  const rate = cleanMoney(body.rate);
  const amount = cleanMoney(body.amount);
  return {
    record_date: dateOrNull(body.record_date) || malaysiaDate(),
    category,
    service_type: String(body.service_type || '').trim().slice(0, 120),
    paid_cards: paidCards,
    unpaid_cards: unpaidCards,
    rate,
    amount,
    net_amount: category === 'service' ? paidCards * rate : category === 'expense' ? -Math.abs(amount) : Math.abs(amount),
    payment_method: String(body.payment_method || 'Not recorded').trim().slice(0, 80),
    notes: String(body.notes || '').trim().slice(0, 1000)
  };
}

app.get('/api/carding', ...requirePermission('carding:view'), async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : malaysiaDate().slice(0, 7);
    const records = await all(`SELECT carding_records.*, users.name AS updated_by_name FROM carding_records
      LEFT JOIN users ON users.id = carding_records.updated_by
      WHERE to_char(record_date, 'YYYY-MM') = ? ORDER BY record_date DESC, carding_records.id DESC LIMIT 1000`, [month]);
    const summary = await get(`SELECT COUNT(*)::int AS entries,
      COALESCE(SUM(paid_cards), 0)::int AS "paidCards", COALESCE(SUM(unpaid_cards), 0)::int AS "unpaidCards",
      ROUND(COALESCE(SUM(net_amount) FILTER (WHERE category != 'expense'), 0), 2) AS income,
      ROUND(ABS(COALESCE(SUM(net_amount) FILTER (WHERE category = 'expense'), 0)), 2) AS expenses,
      ROUND(COALESCE(SUM(net_amount), 0), 2) AS net
      FROM carding_records WHERE to_char(record_date, 'YYYY-MM') = ?`, [month]);
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
    await audit(req, 'Daily carding entry added', `${values.record_date} · ${values.service_type} · ${values.paid_cards + values.unpaid_cards} cards · RM ${values.net_amount.toFixed(2)}`, 'carding', result.lastID);
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
    await audit(req, 'Daily carding entry updated', `${values.record_date} · ${values.service_type}`, 'carding', req.params.id);
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
        if (rawDate) currentDate = dateOrNull(rawDate) || currentDate;
        const serviceType = spreadsheetValue(cell(sourceRow, 'service type'));
        if (!serviceType || /totals?|month total/i.test(serviceType)) return;
        const paidCards = nonNegativeInteger(cell(sourceRow, 'paid (cards)'));
        const unpaidCards = nonNegativeInteger(cell(sourceRow, 'unpaid (cards)'));
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
  const number = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function financeValues(body) {
  const amount = cleanMoney(body.amount);
  const deduction = cleanMoney(body.deduction);
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
      FROM months LEFT JOIN finance_records ON date_trunc('month', payment_date)::date = months.month
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
          const netAmount = cleanMoney(spreadsheetValue(row.getCell(7).value));
          const notes = spreadsheetValue(row.getCell(8).value).slice(0, 1000);
          if (!paymentDate || (!concernPerson && !concernNumber && !amount && !deduction && !netAmount)) continue;
          const sourceKey = crypto.createHash('sha256').update([sheet.name, rowNumber, paymentDate, concernPerson, concernNumber, amount, deduction, netAmount, notes].join('|')).digest('hex');
          const result = await txRun(`INSERT INTO finance_records
            (payment_date, concern_person, concern_number, amount, deduction, net_amount, payment_method, payment_status, notes, source_name, source_key, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, 'Not recorded', 'Not recorded', ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING RETURNING id`,
          [paymentDate, concernPerson, concernNumber, amount, deduction, netAmount || amount - deduction, notes, `${req.file.originalname} · ${sheet.name}`, sourceKey, req.user.id, req.user.id]);
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
      ) kpi ON TRUE ORDER BY users.active DESC, users.name`);
    res.json({ staff });
  } catch (error) { next(error); }
});

app.put('/api/hr/staff/:userId', ...requirePermission('hr:edit'), async (req, res, next) => {
  try {
    const employmentType = String(req.body.employment_type || 'full_time');
    const allowedTypes = ['full_time', 'part_time', 'volunteer', 'contract'];
    const targetHours = Math.max(1, Math.min(168, cleanMoney(req.body.weekly_target_hours || 40)));
    if (!allowedTypes.includes(employmentType)) return res.status(400).json({ error: 'Choose a valid employment type.' });
    const target = await get('SELECT id, name FROM users WHERE id = ?', [req.params.userId]);
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

app.get('/api/users', ...requirePermission('users:manage'), async (_req, res, next) => {
  try {
    const users = await all('SELECT id, name, email, role, active, created_at FROM users ORDER BY active DESC, name');
    res.json({ users: users.map(user => ({ ...user, created_at: displayTimestamp(user.created_at), access_summary: roleSummary(user.role) })) });
  } catch (error) { next(error); }
});

function roleSummary(role) {
  return ({ admin: 'Full system access including office settings', chair: 'Oversight, records, carding, finance, HR, printing and users', secretary: 'Member lookup and form printing', hr: 'Attendance, staff profiles and people operations', card_printing: 'Records, photos, printing and daily carding', data_management: 'Records, import and export', finance: 'Payment, daily carding, expense and finance summaries' })[role] || 'Limited access';
}

app.post('/api/users', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim(); const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || ''); const role = String(req.body.role || '');
    if (!name || !email.includes('@') || password.length < 8 || !ROLE_LABELS[role]) return res.status(400).json({ error: 'Name, valid email, role and an 8-character password are required.' });
    const now = new Date();
    const result = await run('INSERT INTO users (name, email, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, TRUE, ?, ?) RETURNING id', [name, email, hashPassword(password), role, now, now]);
    await audit(req, 'Staff account created', `${name} · ${ROLE_LABELS[role]}`, 'user', result.lastID);
    res.status(201).json({ id: result.lastID });
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' }); next(error); }
});

app.put('/api/users/:id', ...requirePermission('users:manage'), async (req, res, next) => {
  try {
    const role = String(req.body.role || ''); if (!ROLE_LABELS[role]) return res.status(400).json({ error: 'Choose a valid role.' });
    const target = await get('SELECT * FROM users WHERE id = ?', [req.params.id]); if (!target) return res.status(404).json({ error: 'User not found.' });
    await run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, new Date(), req.params.id]);
    await audit(req, 'Staff role updated', `${target.name}: ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}`, 'user', target.id);
    res.json({ id: target.id });
  } catch (error) { next(error); }
});

app.get('/api/audit', ...requirePermission('audit:view'), async (_req, res, next) => {
  try { res.json({ activity: (await all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 250')).map(auditPayload) }); }
  catch (error) { next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

if (HAS_CLIENT_BUILD) {
  app.use(express.static(path.join(ROOT, 'dist'), { index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));
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
      error: databaseUnavailable ? 'PostgreSQL is unavailable. Start the PostgreSQL service and try again.' : error.status ? error.message : 'The server could not complete this request.'
    });
  }
  return res.status(500).send('Internal Server Error');
});

let server;
initializeDatabase().then(seedInitialUser).then(() => {
  server = app.listen(PORT, () => console.log(`MRO Node server running at http://localhost:${PORT}`));
}).catch(error => {
  console.error('Unable to initialize MRO Registry:', error);
  process.exitCode = 1;
});

async function shutdown() {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDatabase();
}

process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
