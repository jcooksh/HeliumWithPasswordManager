// Encrypted vault. Runs in the background service worker only.
//
// Key hierarchy
//   master password --PBKDF2-SHA256 (600k)--> wrapping key
//   wrapping key --AES-GCM--> random 256-bit vault key (stored wrapped)
//   vault key --HKDF--> encKey (AES-256-GCM)  +  macKey (HMAC-SHA256, site index)
//
// On disk (chrome.storage.local) there is only ciphertext. Each login is two
// separately encrypted blobs:
//   meta   { url, username, title, timestamps }  -> decrypted to show suggestions
//   secret { password, notes }                   -> decrypted only at fill/copy time
// Sites are indexed by HMAC(site), so the list of sites isn't readable either.
//
// While unlocked, the raw vault key sits in chrome.storage.session, which is
// RAM-only (never written to disk), wiped when the browser closes, and not
// readable by content scripts. Decrypted logins are never cached.

import * as c from './crypto.js';
import { parseSite } from './url.js';

const HEADER = 'vault.header';
const INDEX = 'vault.index';
const NEVER = 'vault.never';
const FAILURES = 'vault.failures';
const SESSION_KEY = 'session.vaultKey';
const WRAP_AAD = 'helium-vault/v1/vault-key';
const entryKey = (id) => 'entry.' + id;

export class VaultLockedError extends Error {
  constructor() {
    super('Helium Vault is locked.');
    this.locked = true;
  }
}

let keys = null; // { encKey, macKey } — non-extractable CryptoKeys

// Serialise read-modify-write operations on the index.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const local = chrome.storage.local;
const session = chrome.storage.session;

async function getLocal(key) {
  return (await local.get(key))[key];
}

async function loadKeys() {
  if (keys) return keys;
  const raw = (await session.get(SESSION_KEY))[SESSION_KEY];
  if (!raw) return null;
  const bytes = c.fromB64(raw);
  try {
    keys = await c.importVaultKey(bytes);
  } finally {
    bytes.fill(0);
  }
  return keys;
}

async function requireKeys() {
  const k = await loadKeys();
  if (!k) throw new VaultLockedError();
  return k;
}

async function activate(raw) {
  await session.set({ [SESSION_KEY]: c.toB64(raw) });
  keys = await c.importVaultKey(raw);
  raw.fill(0);
}

export async function status() {
  if (!(await getLocal(HEADER))) return 'uninitialized';
  return (await loadKeys()) ? 'unlocked' : 'locked';
}

export async function create(password) {
  if (await getLocal(HEADER)) throw new Error('A vault already exists.');
  checkMasterPassword(password);
  const salt = c.randomBytes(16);
  const wrappingKey = await c.deriveWrappingKey(password, salt, c.KDF_ITERATIONS);
  const raw = c.randomBytes(c.KEY_BYTES);
  const wrappedKey = await c.encryptBytes(wrappingKey, raw, WRAP_AAD);
  await local.set({
    [HEADER]: {
      version: 1,
      kdf: { name: 'PBKDF2-SHA256', iterations: c.KDF_ITERATIONS, salt: c.toB64(salt) },
      wrappedKey,
      createdAt: Date.now(),
    },
    [INDEX]: {},
  });
  await activate(raw);
  await setNeverList([]);
}

export function checkMasterPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('Master password must be at least 10 characters.');
  }
}

async function unwrap(header, password) {
  const wrappingKey = await c.deriveWrappingKey(password, c.fromB64(header.kdf.salt), header.kdf.iterations);
  try {
    return await c.decryptBytes(wrappingKey, header.wrappedKey, WRAP_AAD);
  } catch {
    return null;
  }
}

// Slows down guessing through the UI: after 3 wrong tries, wait 1s, 2s, 4s…(max 5 min).
async function checkThrottle() {
  const f = (await getLocal(FAILURES)) ?? { count: 0, until: 0 };
  if (Date.now() < f.until) {
    const s = Math.ceil((f.until - Date.now()) / 1000);
    throw new Error(`Too many wrong attempts. Try again in ${s}s.`);
  }
  return f;
}

async function recordFailure(f) {
  const count = f.count + 1;
  const until = count >= 3 ? Date.now() + Math.min(1000 * 2 ** (count - 3), 300_000) : 0;
  await local.set({ [FAILURES]: { count, until } });
}

export async function unlock(password) {
  const header = await getLocal(HEADER);
  if (!header) throw new Error('No vault yet.');
  const f = await checkThrottle();
  const raw = await unwrap(header, String(password ?? ''));
  if (!raw) {
    await recordFailure(f);
    throw new Error('Wrong master password.');
  }
  await local.remove(FAILURES);
  await activate(raw);
}

// Verifies the master password without changing lock state (for re-auth).
export async function verify(password) {
  const header = await getLocal(HEADER);
  const f = await checkThrottle();
  const raw = await unwrap(header, String(password ?? ''));
  if (!raw) {
    await recordFailure(f);
    throw new Error('Wrong master password.');
  }
  raw.fill(0);
  await local.remove(FAILURES);
}

export async function lock() {
  keys = null;
  const all = await session.get(null);
  const sensitive = Object.keys(all).filter((k) => k === SESSION_KEY || k.startsWith('pending.'));
  await session.remove(sensitive);
}

export async function changeMasterPassword(current, next) {
  checkMasterPassword(next);
  const header = await getLocal(HEADER);
  const f = await checkThrottle();
  const raw = await unwrap(header, current);
  if (!raw) {
    await recordFailure(f);
    throw new Error('Current master password is wrong.');
  }
  const salt = c.randomBytes(16);
  const wrappingKey = await c.deriveWrappingKey(next, salt, c.KDF_ITERATIONS);
  const wrappedKey = await c.encryptBytes(wrappingKey, raw, WRAP_AAD);
  raw.fill(0);
  await local.set({
    [HEADER]: { ...header, kdf: { name: 'PBKDF2-SHA256', iterations: c.KDF_ITERATIONS, salt: c.toB64(salt) }, wrappedKey },
  });
}

export async function destroy(password) {
  await verify(password);
  keys = null;
  await local.clear();
  await session.clear();
}

// ---- Logins -------------------------------------------------------------

function cleanLogin(input) {
  const site = parseSite(input.url);
  if (!site) throw new Error('Enter a valid http(s) website address.');
  if (!input.password) throw new Error('Password is required.');
  return {
    site,
    meta: {
      url: input.url.trim(),
      username: String(input.username ?? '').slice(0, 500),
      title: String(input.title ?? '').slice(0, 200),
    },
    secret: { password: String(input.password), notes: String(input.notes ?? '').slice(0, 10_000) },
  };
}

async function sealEntry(k, id, site, meta, secret) {
  return {
    tag: await c.indexTag(k.macKey, site.matchKey),
    entry: {
      id,
      meta: await c.encryptJSON(k.encKey, meta, `meta:${id}`),
      secret: await c.encryptJSON(k.encKey, secret, `secret:${id}`),
    },
  };
}

async function readEntries(ids) {
  if (!ids.length) return [];
  const got = await local.get(ids.map(entryKey));
  return ids.map((id) => got[entryKey(id)]).filter(Boolean);
}

async function openMeta(k, entry) {
  return { id: entry.id, ...(await c.decryptJSON(k.encKey, entry.meta, `meta:${entry.id}`)) };
}

export function addLogin(input) {
  return exclusive(async () => {
    const k = await requireKeys();
    const { site, meta, secret } = cleanLogin(input);
    const now = Date.now();
    const id = crypto.randomUUID();
    const sealed = await sealEntry(k, id, site, { ...meta, created: now, updated: now, lastUsed: 0 }, secret);
    const index = (await getLocal(INDEX)) ?? {};
    index[id] = sealed.tag;
    await local.set({ [entryKey(id)]: sealed.entry, [INDEX]: index });
    return id;
  });
}

export function updateLogin(id, changes) {
  return exclusive(async () => {
    const k = await requireKeys();
    const [entry] = await readEntries([id]);
    if (!entry) throw new Error('Login not found.');
    const meta = await openMeta(k, entry);
    const secret = await c.decryptJSON(k.encKey, entry.secret, `secret:${id}`);
    const merged = cleanLogin({ ...meta, ...secret, ...changes });
    const sealed = await sealEntry(
      k, id, merged.site,
      { ...merged.meta, created: meta.created, updated: Date.now(), lastUsed: meta.lastUsed ?? 0 },
      merged.secret,
    );
    const index = (await getLocal(INDEX)) ?? {};
    index[id] = sealed.tag;
    await local.set({ [entryKey(id)]: sealed.entry, [INDEX]: index });
  });
}

export function markUsed(id) {
  return exclusive(async () => {
    const k = await requireKeys();
    const [entry] = await readEntries([id]);
    if (!entry) return;
    const { id: _id, ...meta } = await openMeta(k, entry);
    const sealedMeta = await c.encryptJSON(k.encKey, { ...meta, lastUsed: Date.now() }, `meta:${id}`);
    await local.set({ [entryKey(id)]: { ...entry, meta: sealedMeta } });
  });
}

export function deleteLogin(id) {
  return exclusive(async () => {
    await requireKeys();
    const index = (await getLocal(INDEX)) ?? {};
    delete index[id];
    await local.set({ [INDEX]: index });
    await local.remove(entryKey(id));
  });
}

// All logins without passwords (for the manager page).
export async function listLogins() {
  const k = await requireKeys();
  const index = (await getLocal(INDEX)) ?? {};
  const entries = await readEntries(Object.keys(index));
  return Promise.all(entries.map((e) => openMeta(k, e)));
}

// Logins saved for the same site as `url`, without passwords.
export async function findLogins(url) {
  const k = await requireKeys();
  const site = parseSite(url);
  if (!site) return [];
  const tag = await c.indexTag(k.macKey, site.matchKey);
  const index = (await getLocal(INDEX)) ?? {};
  const ids = Object.keys(index).filter((id) => index[id] === tag);
  const metas = await Promise.all((await readEntries(ids)).map((e) => openMeta(k, e)));
  return metas.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.username.localeCompare(b.username));
}

// Full login including the password. Callers must only use this for an
// explicit user action (fill / copy / reveal).
export async function getLogin(id) {
  const k = await requireKeys();
  const [entry] = await readEntries([id]);
  if (!entry) throw new Error('Login not found.');
  const meta = await openMeta(k, entry);
  const secret = await c.decryptJSON(k.encKey, entry.secret, `secret:${id}`);
  return { ...meta, ...secret };
}

export async function importLogins(logins, { overwrite = false } = {}) {
  const result = { added: 0, updated: 0, duplicates: 0, conflicts: 0, invalid: 0 };
  return exclusive(async () => {
    const k = await requireKeys();
    const index = (await getLocal(INDEX)) ?? {};
    // Existing logins keyed by site+username, so imports can be de-duplicated.
    const existing = new Map();
    for (const e of await readEntries(Object.keys(index))) {
      const meta = await openMeta(k, e);
      const site = parseSite(meta.url);
      if (site) existing.set(`${site.matchKey}\n${meta.username}`, { entry: e, meta });
    }
    const writes = {};
    const now = Date.now();
    for (const input of logins) {
      let clean;
      try {
        clean = cleanLogin(input);
      } catch {
        result.invalid++;
        continue;
      }
      const key = `${clean.site.matchKey}\n${clean.meta.username}`;
      const prev = existing.get(key);
      if (prev) {
        const prevSecret = await c.decryptJSON(k.encKey, prev.entry.secret, `secret:${prev.entry.id}`);
        if (prevSecret.password === clean.secret.password) {
          result.duplicates++;
          continue;
        }
        if (!overwrite) {
          result.conflicts++;
          continue;
        }
        const id = prev.entry.id;
        const sealed = await sealEntry(k, id, clean.site,
          { ...clean.meta, created: prev.meta.created, updated: now, lastUsed: prev.meta.lastUsed ?? 0 },
          { ...clean.secret, notes: clean.secret.notes || prevSecret.notes });
        writes[entryKey(id)] = sealed.entry;
        index[id] = sealed.tag;
        existing.set(key, { entry: sealed.entry, meta: clean.meta });
        result.updated++;
      } else {
        const id = crypto.randomUUID();
        const sealed = await sealEntry(k, id, clean.site, { ...clean.meta, created: now, updated: now, lastUsed: 0 }, clean.secret);
        writes[entryKey(id)] = sealed.entry;
        index[id] = sealed.tag;
        existing.set(key, { entry: sealed.entry, meta: clean.meta });
        result.added++;
      }
    }
    writes[INDEX] = index;
    await local.set(writes);
    return result;
  });
}

export async function exportLogins() {
  const k = await requireKeys();
  const index = (await getLocal(INDEX)) ?? {};
  const out = [];
  for (const e of await readEntries(Object.keys(index))) {
    const meta = await openMeta(k, e);
    const secret = await c.decryptJSON(k.encKey, e.secret, `secret:${e.id}`);
    out.push({ ...meta, ...secret });
  }
  return out;
}

// Encrypted backup: the raw on-disk records, still protected by the master password.
export async function exportBackup() {
  await requireKeys();
  const all = await local.get(null);
  const data = {};
  for (const [key, v] of Object.entries(all)) {
    if (key === HEADER || key === INDEX || key === NEVER || key.startsWith('entry.')) data[key] = v;
  }
  return { format: 'helium-vault-backup', version: 1, exportedAt: new Date().toISOString(), data };
}

export async function restoreBackup(backup, password) {
  if (backup?.format !== 'helium-vault-backup' || !backup.data?.[HEADER]) {
    throw new Error('Not a Helium Vault backup file.');
  }
  const raw = await unwrap(backup.data[HEADER], password);
  if (!raw) throw new Error('Wrong master password for this backup.');
  for (const key of Object.keys(backup.data)) {
    if (key !== HEADER && key !== INDEX && key !== NEVER && !key.startsWith('entry.')) {
      throw new Error('Backup contains unexpected data.');
    }
  }
  await exclusive(async () => {
    const settings = await getLocal('settings');
    await local.clear();
    await local.set({ ...backup.data, ...(settings ? { settings } : {}) });
  });
  await activate(raw);
}

// ---- "Never save" sites (stored encrypted) --------------------------------

async function getNeverList() {
  const k = await requireKeys();
  const box = await getLocal(NEVER);
  return box ? c.decryptJSON(k.encKey, box, 'never') : [];
}

async function setNeverList(list) {
  const k = await requireKeys();
  await local.set({ [NEVER]: await c.encryptJSON(k.encKey, [...new Set(list)].sort(), 'never') });
}

export async function neverSites() {
  return getNeverList();
}

export async function isNeverSave(url) {
  const site = parseSite(url);
  return !!site && (await getNeverList()).includes(site.matchKey);
}

export function addNeverSave(url) {
  return exclusive(async () => {
    const site = parseSite(url);
    if (site) await setNeverList([...(await getNeverList()), site.matchKey]);
  });
}

export function removeNeverSave(matchKeyValue) {
  return exclusive(async () => setNeverList((await getNeverList()).filter((m) => m !== matchKeyValue)));
}
