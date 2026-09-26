// Cryptographic primitives for Helium Vault.
// Only the browser's built-in WebCrypto is used: no third-party crypto code.

const te = new TextEncoder();
const td = new TextDecoder();

// OWASP (2023+) recommendation for PBKDF2-HMAC-SHA256.
export const KDF_ITERATIONS = 600_000;
export const KEY_BYTES = 32;

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Master password -> key-encryption key. Non-extractable: it can only be used,
// never read back out of WebCrypto.
export async function deriveWrappingKey(password, salt, iterations = KDF_ITERATIONS) {
  const pwBytes = te.encode(password.normalize('NFKC'));
  try {
    const material = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    pwBytes.fill(0);
  }
}

// Random vault key -> independent sub-keys for encryption and for the blind
// site index, so the index HMAC key is never the same as the cipher key.
export async function importVaultKey(raw) {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const params = (info) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32),
    info: te.encode(info),
  });
  const encKey = await crypto.subtle.deriveKey(
    params('helium-vault/v1/enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const macKey = await crypto.subtle.deriveKey(
    params('helium-vault/v1/index'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  );
  return { encKey, macKey };
}

// AES-256-GCM with a fresh 96-bit IV per message. `aad` binds a ciphertext to
// its slot (e.g. entry id + field) so blobs cannot be swapped between entries.
export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes,
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptBytes(key, box, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(box.iv), additionalData: te.encode(aad) }, key, fromB64(box.ct),
  );
  return new Uint8Array(pt);
}

export async function encryptJSON(key, value, aad) {
  const bytes = te.encode(JSON.stringify(value));
  try {
    return await encryptBytes(key, bytes, aad);
  } finally {
    bytes.fill(0);
  }
}

export async function decryptJSON(key, box, aad) {
  const bytes = await decryptBytes(key, box, aad);
  try {
    return JSON.parse(td.decode(bytes));
  } finally {
    bytes.fill(0);
  }
}

// Keyed hash of a site key. Lets us find the logins for a site without
// storing the list of sites you have accounts on in plaintext.
export async function indexTag(macKey, value) {
  const sig = await crypto.subtle.sign('HMAC', macKey, te.encode(value));
  return toB64(new Uint8Array(sig));
}
