import { createPasswordRecord, verifyPassword } from './_password.mjs';
import { getSession, jsonResponse } from './_shared.mjs';

function normalizePassword(value) {
  return String(value || '').trim();
}

export async function onRequestPost({ env, request }) {
  const session = await getSession(env, request);
  if(!session) return jsonResponse({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const currentPassword = normalizePassword(body?.currentPassword);
  const newPassword = normalizePassword(body?.newPassword);
  const confirmPassword = normalizePassword(body?.confirmPassword);

  if(!currentPassword || !newPassword || !confirmPassword) {
    return jsonResponse({ error: '请输入旧密码和新密码' }, { status: 400 });
  }
  if(newPassword !== confirmPassword) {
    return jsonResponse({ error: '两次输入的新密码不一致' }, { status: 400 });
  }
  if(newPassword.length < 8) {
    return jsonResponse({ error: '新密码至少需要 8 个字符' }, { status: 400 });
  }

  const user = await env.DB.prepare(
    'SELECT username, password_hash, salt, iterations FROM users WHERE username = ?'
  ).bind(session.username).first();
  if(!user || !await verifyPassword(currentPassword, user)) {
    return jsonResponse({ error: '旧密码错误' }, { status: 401 });
  }

  const passwordRecord = await createPasswordRecord(newPassword);
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, salt = ?, iterations = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?'
  ).bind(passwordRecord.hash, passwordRecord.salt, passwordRecord.iterations, session.username).run();
  await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(session.username).run();

  return jsonResponse({ ok: true, message: '密码已更新，请重新登录' });
}

export async function onRequestGet() {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
}
