const DB_NAME = 'mro-offline-registrations';
const VERIFIER = 'mro-offline-vault-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function database() {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('vaults', { keyPath: 'userId' });
    request.result.createObjectStore('records', { keyPath: 'id' });
  };
  return requestResult(request);
}

async function inStore(name, mode, action) {
  const db = await database();
  try {
    const transaction = db.transaction(name, mode);
    const result = await requestResult(action(transaction.objectStore(name)));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  } finally { db.close(); }
}

function bytesToBase64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encrypt(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decrypt(key, value) {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(value.iv) }, key, base64ToBytes(value.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

export async function listVaults() {
  return (await inStore('vaults', 'readonly', store => store.getAll())).map(({ userId, email }) => ({ userId, email }));
}

export async function createVault(user, passphrase) {
  if (!user?.permissions?.includes('members:edit')) throw new Error('This account cannot create member records.');
  if (passphrase.length < 16) throw new Error('Use an offline passphrase of at least 16 characters.');
  const userId = String(user.id);
  if (await inStore('vaults', 'readonly', store => store.get(userId))) throw new Error('This account already has an offline vault on this device.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const check = await encrypt(key, VERIFIER);
  await inStore('vaults', 'readwrite', store => store.add({ userId, email: user.email, salt: bytesToBase64(salt), check }));
  const persistent = navigator.storage?.persist ? await navigator.storage.persist().catch(() => false) : false;
  return { userId, key, persistent: Boolean(persistent) };
}

export async function unlockVault(userId, passphrase) {
  const vault = await inStore('vaults', 'readonly', store => store.get(String(userId)));
  if (!vault) throw new Error('No offline vault is set up for this account on this device.');
  try {
    const key = await deriveKey(passphrase, base64ToBytes(vault.salt));
    if (await decrypt(key, vault.check) !== VERIFIER) throw new Error();
    const persistent = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    return { userId: String(userId), key, persistent: Boolean(persistent) };
  } catch { throw new Error('The offline passphrase is incorrect.'); }
}

export async function saveOfflineRecord(userId, key, fields) {
  const id = crypto.randomUUID();
  const encrypted = await encrypt(key, fields);
  await inStore('records', 'readwrite', store => store.add({ id, userId: String(userId), createdAt: new Date().toISOString(), ...encrypted }));
  return id;
}

export async function replaceOfflineRecord(id, userId, key, fields) {
  const existing = await inStore('records', 'readonly', store => store.get(id));
  if (!existing || existing.userId !== String(userId)) throw new Error('This offline registration is no longer available.');
  const encrypted = await encrypt(key, fields);
  await inStore('records', 'readwrite', store => store.put({ ...existing, ...encrypted }));
}

export async function readOfflineRecords(userId, key) {
  const rows = await inStore('records', 'readonly', store => store.getAll());
  return Promise.all(rows.filter(row => row.userId === String(userId)).map(async row => ({
    id: row.id, createdAt: row.createdAt, fields: await decrypt(key, row)
  })));
}

export async function deleteOfflineRecord(id) {
  await inStore('records', 'readwrite', store => store.delete(id));
}
