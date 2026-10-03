#!/usr/bin/env node

require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { initializeDatabase, transaction, closeDatabase } = require('../database');

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
  if (!input) return null;
  const display = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  const result = display ? `${display[3]}-${display[2]}-${display[1]}` : input;
  const date = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== result) {
    throw new Error('The SQLite source contains an invalid date. Correct it before migration.');
  }
  return result;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  const input = String(value).trim();
  if (/^\d+$/.test(input)) {
    const numeric = Number(input);
    const parsed = new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
    throw new Error('The SQLite source contains an invalid numeric timestamp.');
  }
  const display = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (display) return attendanceTimestamp(`${display[1]}/${display[2]}/${display[3]}`, `${display[4]}:${display[5]}:${display[6] || '00'}`);
  // SQLite CURRENT_TIMESTAMP is UTC, even when the migration host is not.
  const sqliteUtc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(input);
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) isoDate(input.slice(0, 10));
  const parsed = new Date(sqliteUtc ? `${input.replace(' ', 'T')}Z` : input);
  if (Number.isNaN(parsed.valueOf())) throw new Error('The SQLite source contains an invalid timestamp. Correct it before migration.');
  return parsed;
}

function attendanceTimestamp(workDate, time) {
  if (!time) return null;
  const date = isoDate(workDate);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(time).trim());
  if (!date || !match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) {
    throw new Error('The SQLite source contains an invalid attendance time. Correct it before migration.');
  }
  return new Date(`${date}T${match[1]}:${match[2]}:${match[3] || '00'}+08:00`);
}

function jsonArray(value) {
  let parsed;
  try { parsed = JSON.parse(value || '[]'); }
  catch { throw new Error('The SQLite source contains invalid family data JSON. Correct it before migration.'); }
  if (!Array.isArray(parsed)) throw new Error('Family data must be a JSON array.');
  return JSON.stringify(parsed);
}

function booleanValue(value, fallback = false) {
  if (value == null) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new Error('The SQLite source contains an invalid account status. Correct it before migration.');
}

async function tableRows(database, table) {
  const exists = await sourceAll(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return exists.length ? sourceAll(database, `SELECT * FROM ${table}`) : [];
}

async function insertRows(txRun, table, columns, rows) {
  for (const row of rows) {
    const values = columns.map(column => row[column] ?? null);
    await txRun(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
  }
}

async function main() {
  let source;
  try {
    source = await openSource();
    await initializeDatabase();

    await sourceAll(source, 'BEGIN');
    const [sourceUsers, sourceMembers, sourceSessions, sourceAttendance, sourceAudit] = await Promise.all([
      tableRows(source, 'users'), tableRows(source, 'submissions'), tableRows(source, 'sessions'),
      tableRows(source, 'attendance'), tableRows(source, 'audit_logs')
    ]);
    await sourceAll(source, 'COMMIT');

    const users = sourceUsers.map(row => ({
      ...row,
      email: String(row.email || '').trim().toLowerCase(),
      active: booleanValue(row.active),
      must_change_password: booleanValue(row.must_change_password, true),
      password_changed_at: timestamp(row.password_changed_at),
      deleted_at: timestamp(row.deleted_at),
      created_at: timestamp(row.created_at) || new Date(), updated_at: timestamp(row.updated_at) || new Date()
    }));
    const members = sourceMembers.map(row => ({
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
      family_members_data: jsonArray(row.family_members_data),
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
      // Checking the target and copying rows must be one operation; a running
      // app or a second migration must not write between the check and inserts.
      await query(`LOCK TABLE users, submissions, sessions, attendance, audit_logs,
        staff_profiles, finance_records, carding_records, import_batches IN ACCESS EXCLUSIVE MODE`);
      const target = await query(`SELECT
        (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM submissions) +
        (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM attendance) +
        (SELECT COUNT(*) FROM audit_logs) + (SELECT COUNT(*) FROM staff_profiles) +
        (SELECT COUNT(*) FROM finance_records) + (SELECT COUNT(*) FROM carding_records) +
        (SELECT COUNT(*) FROM import_batches) AS total`);
      if (Number(target.rows[0].total) > 0) {
        throw new Error('PostgreSQL already contains application data. Use an empty target database for the migration.');
      }
      await insertRows(txRun, 'users', ['id', 'name', 'email', 'password_hash', 'role', 'active', 'must_change_password', 'password_changed_at', 'deleted_at', 'created_at', 'updated_at'], users);
      await insertRows(txRun, 'submissions', [
        'id', 'reference', 'reference_number', 'unhcr_status', 'unhcr_file_number', 'individual_number', 'fullname', 'father_name', 'mother_name',
        'email', 'phone', 'phone2', 'country', 'ethnicity', 'religion', 'gender', 'dob', 'arrival', 'address_state', 'photo_path',
        'family_members', 'vulnerability', 'consent', 'family_members_data', 'created_at', 'updated_at', 'updated_by'
      ], members);
      await insertRows(txRun, 'sessions', ['token_hash', 'user_id', 'expires_at', 'created_at'], sessions);
      await insertRows(txRun, 'attendance', ['id', 'user_id', 'work_date', 'clock_in', 'clock_out', 'created_at', 'updated_at'], attendance);
      await insertRows(txRun, 'audit_logs', ['id', 'user_id', 'actor_name', 'action', 'detail', 'entity_type', 'entity_id', 'ip_address', 'created_at'], audit);
      for (const table of ['users', 'submissions', 'attendance', 'audit_logs']) {
        await query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
      }
    });

    console.log(`Migration complete: ${users.length} users, ${members.length} members, ${attendance.length} attendance rows, ${audit.length} audit events.`);
  } finally {
    try { if (source) await closeSource(source); }
    finally { await closeDatabase(); }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, isoDate, timestamp, attendanceTimestamp, jsonArray, booleanValue, insertRows };
