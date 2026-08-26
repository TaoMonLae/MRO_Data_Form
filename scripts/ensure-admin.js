#!/usr/bin/env node

require('dotenv').config();
const crypto = require('crypto');
const { initializeDatabase, get, run, closeDatabase } = require('../database');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

async function main() {
  const name = String(process.env.INITIAL_ADMIN_NAME || 'MRO Administrator').trim();
  const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
  if (!email.includes('@') || password.length < 8) {
    throw new Error('Set INITIAL_ADMIN_EMAIL and an INITIAL_ADMIN_PASSWORD of at least 8 characters in .env.');
  }

  await initializeDatabase();
  const existing = await get('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (existing) {
    await run(`UPDATE users SET name = ?, password_hash = ?, role = 'admin', active = TRUE, updated_at = NOW() WHERE id = ?`,
      [name, hashPassword(password), existing.id]);
    console.log(`Administrator access refreshed for ${email}.`);
  } else {
    await run(`INSERT INTO users (name, email, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', TRUE, NOW(), NOW())`, [name, email, hashPassword(password)]);
    console.log(`Administrator account created for ${email}.`);
  }
}

main().catch(error => {
  console.error(`Admin setup failed: ${error.message}`);
  process.exitCode = 1;
}).finally(closeDatabase);
