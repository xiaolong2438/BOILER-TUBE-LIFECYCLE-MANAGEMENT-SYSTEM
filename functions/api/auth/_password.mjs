export const PASSWORD_ITERATIONS = 210_000;
const SALT_BYTES = 16;

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function getCrypto() {
  if(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues) return globalThis.crypto;
  throw new Error('Web Crypto API is not available in this runtime.');
}

export async function hashPassword(password, saltBase64, iterations = PASSWORD_ITERATIONS) {
  const cryptoApi = await getCrypto();
  const key = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await cryptoApi.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64ToBytes(saltBase64), iterations },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ''));
  const right = new TextEncoder().encode(String(b || ''));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for(let index = 0; index < length; index++) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

export async function createPasswordRecord(password, iterations = PASSWORD_ITERATIONS) {
  const cryptoApi = await getCrypto();
  const salt = new Uint8Array(SALT_BYTES);
  cryptoApi.getRandomValues(salt);
  const saltBase64 = bytesToBase64(salt);
  const hash = await hashPassword(password, saltBase64, iterations);
  return { hash, salt: saltBase64, iterations };
}

export async function verifyPassword(password, record) {
  const passwordHash = await hashPassword(password, record.salt, Number(record.iterations || PASSWORD_ITERATIONS));
  return timingSafeEqual(passwordHash, record.password_hash ?? record.hash);
}
