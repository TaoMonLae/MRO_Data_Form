#!/usr/bin/env node

require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { initializeDatabase, pool, transaction, closeDatabase } = require('../database');

const sourcePath = path.resolve(process.env.SQLITE_DATABASE_PATH || path.join(__dirname, '..', 'submissions.db'));

function openSource() {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(database));
  });
}

function sourceAll(database, sql, params = []) {
  return new Promise((resolve, reject) => database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function closeSource(database) {
  return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

function isoDate(value) {
  const input = String(value || '').trim();
  const display = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (display) return `${display[3]}-${display[2]}-${display[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : null;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{12,}$/.test(String(value))) return new Date(Number(value));
  const input = String(value).trim();
  const display = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (display) return new Date(`${display[3]}-${display[2]}-${display[1]}T${display[4]}:${display[5]}:${display[6] || '00'}+08:00`);
  const parsed = new Date(input);
  return Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
}

function attendanceTimestamp(workDate, time) {
  if (!time) return null;
  return new Date(`${isoDate(workDate)}T${String(time).slice(0, 5)}:00+08:00`);
}

function jsonValue(value, fallback) {
  try { return JSON.stringify(JSON.parse(value || JSON.stringify(fallback))); }
  catch { return JSON.stringify(fallback); }
}

async function tableRows(database, table) {
  const exists = await sourceAll(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return exists.length ? sourceAll(database, `SELECT * FROM ${table}`) : [];
}

async function insertRows(txRun, table, columns, rows) {
  for (const row of rows) {
    const values = columns.map(column => row[column] ?? null);
    await txRun(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`, values);
  }
}

async function main() {
  const source = await openSource();
  try {
    await initializeDatabase();
    const target = await pool.query(`SELECT
      (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM submissions) +
      (SELECT COUNT(*) FROM attendance) + (SELECT COUNT(*) FROM audit_logs) AS total`);
    if (Number(target.rows[0].total) > 0) {
      throw new Error('PostgreSQL already contains application data. Use an empty target database for the migration.');
    }

    const [sourceUsers, sourceMembers, sourceSessions, sourceAttendance, sourceAudit] = await Promise.all([
      tableRows(source, 'users'), tableRows(source, 'submissions'), tableRows(source, 'sessions'),
      tableRows(source, 'attendance'), tableRows(source, 'audit_logs')
    ]);

    const users = sourceUsers.map(row => ({
      ...row, active: Boolean(row.active), created_at: timestamp(row.created_at) || new Date(), updated_at: timestamp(row.updated_at) || new Date()
    }));
    const members = sourceMembers.filter(row => row.reference && row.fullname).map(row => ({
      ...row,
      reference_number: row.reference_number || '',
      unhcr_status: row.unhcr_status || 'No',
      unhcr_file_number: row.unhcr_file_number || '',
      individual_number: row.individual_number || '',
      father_name: row.father_name || '',
      mother_name: row.mother_name || '',
      email: row.email || '',
      phone: row.phone || '',
      phone2: row.phone2 || '',
      country: row.country || 'Myanmar',
      ethnicity: row.ethnicity || 'Mon',
      religion: row.religion || '',
      gender: row.gender || '',
      dob: isoDate(row.dob),
      arrival: isoDate(row.arrival),
      address_state: row.address_state || '',
      photo_path: row.photo_path || '',
      family_members: Number(row.family_members || 0),
      vulnerability: row.vulnerability || 'N/A',
      consent: row.consent || 'yes',
      family_members_data: jsonValue(row.family_members_data, []),
      created_at: timestamp(row.created_at) || new Date(),
      updated_at: timestamp(row.updated_at) || new Date()
    }));
    const sessions = sourceSessions.map(row => ({ ...row, expires_at: timestamp(row.expires_at), created_at: timestamp(row.created_at) || new Date() }));
    const attendance = sourceAttendance.map(row => ({
      ...row,
      work_date: isoDate(row.work_date),
      clock_in: attendanceTimestamp(row.work_date, row.clock_in),
      clock_out: attendanceTimestamp(row.work_date, row.clock_out),
      created_at: timestamp(row.created_at) || new Date(),
      updated_at: timestamp(row.updated_at) || new Date()
    }));
    const audit = sourceAudit.map(row => ({
      ...row,
      entity_type: row.entity_type || '',
      entity_id: row.entity_id || '',
      ip_address: row.ip_address || '',
      created_at: timestamp(row.created_at) || new Date()
    }));

    await transaction(async ({ run: txRun, query }) => {
      await insertRows(txRun, 'users', ['id', 'name', 'email', 'password_hash', 'role', 'active', 'created_at', 'updated_at'], users);
      await insertRows(txRun, 'submissions', [
        'id', 'reference', 'reference_number', 'unhcr_status', 'unhcr_file_number', 'individual_number', 'fullname', 'father_name', 'mother_name',
        'email', 'phone', 'phone2', 'country', 'ethnicity', 'religion', 'gender', 'dob', 'arrival', 'address_state', 'photo_path',
        'family_members', 'vulnerability', 'consent', 'family_members_data', 'created_at', 'updated_at', 'updated_by'
      ], members);
      await insertRows(txRun, 'sessions', ['token_hash', 'user_id', 'expires_at', 'created_at'], sessions.filter(row => row.expires_at));
      await insertRows(txRun, 'attendance', ['id', 'user_id', 'work_date', 'clock_in', 'clock_out', 'created_at', 'updated_at'], attendance.filter(row => row.work_date));
      await insertRows(txRun, 'audit_logs', ['id', 'user_id', 'actor_name', 'action', 'detail', 'entity_type', 'entity_id', 'ip_address', 'created_at'], audit);
      for (const table of ['users', 'submissions', 'attendance', 'audit_logs']) {
        await query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
      }
    });

    console.log(`Migration complete: ${users.length} users, ${members.length} members, ${attendance.length} attendance rows, ${audit.length} audit events.`);
  } finally {
    await closeSource(source);
    await closeDatabase();
  }
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
