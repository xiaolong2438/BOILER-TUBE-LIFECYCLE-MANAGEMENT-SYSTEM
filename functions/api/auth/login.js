import { verifyPassword } from './_password.mjs';
import { jsonResponse, sessionCookie, sqliteTimestamp } from './_shared.mjs';

function base64(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export async function onRequestPost({ env, request }) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '').trim();
  if(!username || !password) return jsonResponse({ error: '请输入账号和密码' }, { status: 400 });

  const user = await env.DB.prepare(
    'SELECT username, role, password_hash, salt, iterations FROM users WHERE username = ?'
  ).bind(username).first();
  if(!user) return jsonResponse({ error: '账号或密码错误' }, { status: 401 });

  if(!await verifyPassword(password, user)) {
    return jsonResponse({ error: '账号或密码错误' }, { status: 401 });
  }

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = base64(tokenBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12);

  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
  await env.DB.prepare(
    'INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.username, sqliteTimestamp(expiresAt)).run();

  return jsonResponse(
    { ok: true, username: user.username, role: user.role || 'user', expiresAt: expiresAt.toISOString() },
    { headers: { 'Set-Cookie': sessionCookie(token, expiresAt) } }
  );
}

export async function onRequestGet() {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
}
