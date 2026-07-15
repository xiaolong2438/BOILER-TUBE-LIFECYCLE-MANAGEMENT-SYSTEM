function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hashPassword(password, saltBase64, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64ToBytes(saltBase64), iterations },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ''));
  const right = new TextEncoder().encode(String(b || ''));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for(let index = 0; index < length; index++) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

function sessionCookie(token, expiresAt) {
  return [
    `bt_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`
  ].join('; ');
}

function sqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function onRequestPost({ env, request }) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if(!username || !password) return jsonResponse({ error: '请输入账号和密码' }, { status: 400 });

  const user = await env.DB.prepare(
    'SELECT username, password_hash, salt, iterations FROM users WHERE username = ?'
  ).bind(username).first();
  if(!user) return jsonResponse({ error: '账号或密码错误' }, { status: 401 });

  const passwordHash = await hashPassword(password, user.salt, Number(user.iterations || 210000));
  if(!timingSafeEqual(passwordHash, user.password_hash)) {
    return jsonResponse({ error: '账号或密码错误' }, { status: 401 });
  }

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = bytesToBase64(tokenBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12);

  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
  await env.DB.prepare(
    'INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.username, sqliteTimestamp(expiresAt)).run();

  return jsonResponse(
    { ok: true, username: user.username, expiresAt: expiresAt.toISOString() },
    { headers: { 'Set-Cookie': sessionCookie(token, expiresAt) } }
  );
}

export async function onRequestGet() {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
}
