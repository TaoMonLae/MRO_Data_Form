#!/usr/bin/env node

require('dotenv').config();
const crypto = require('crypto');
const { initializeDatabase, transaction, closeDatabase } = require('../database');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

async function main() {
  const name = String(process.env.INITIAL_ADMIN_NAME || 'MRO Administrator').trim();
  const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
  if (!name || name.length > 160 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
    throw new Error('Set a valid INITIAL_ADMIN_NAME, INITIAL_ADMIN_EMAIL and an INITIAL_ADMIN_PASSWORD of 12–128 characters in .env.');
  }

  await initializeDatabase();
  const passwordHash = hashPassword(password);
  await transaction(async ({ get, run }) => {
    await get('SELECT pg_advisory_xact_lock(771462, 2)');
    const account = await get(`INSERT INTO users (name, email, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', TRUE, TRUE, NOW(), NOW())
      ON CONFLICT (LOWER(email)) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
        role = 'admin', active = TRUE, must_change_password = TRUE,
        password_changed_at = NULL, deleted_at = NULL, updated_at = NOW()
      RETURNING id`, [name, email, passwordHash]);
    // Resetting credentials must also remove access held by existing sessions.
    await run('DELETE FROM sessions WHERE user_id = ?', [account.id]);
    await run(`INSERT INTO audit_logs (actor_name, action, detail, entity_type, entity_id)
      VALUES ('System', 'Administrator credentials reset', 'Administrator recovery command completed; all prior sessions revoked.', 'user', ?)`, [String(account.id)]);
  });
  console.log(`Administrator access configured for ${email}; existing sessions ended. A password change is required at sign-in.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Admin setup failed: ${error.message}`);
    process.exitCode = 1;
  }).finally(closeDatabase);
}

module.exports = { main };
