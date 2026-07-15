import { createPasswordRecord } from '../../../auth/_password.mjs';
import { getSession, jsonResponse } from '../../../auth/_shared.mjs';

function normalizePassword(value) {
  return String(value || '').trim();
}

export async function onRequestPost({ env, request, params }) {
  const session = await getSession(env, request);
  if(!session) return jsonResponse({ error: '未登录' }, { status: 401 });
  if(session.role !== 'admin') return jsonResponse({ error: '权限不足' }, { status: 403 });

  const targetUsername = String(params?.username || '').trim();
  if(!targetUsername) return jsonResponse({ error: '用户名不能为空' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const newPassword = normalizePassword(body?.newPassword);
  const confirmPassword = normalizePassword(body?.confirmPassword);

  if(!newPassword || !confirmPassword) {
    return jsonResponse({ error: '请输入新密码' }, { status: 400 });
  }
  if(newPassword !== confirmPassword) {
    return jsonResponse({ error: '两次输入的新密码不一致' }, { status: 400 });
  }
  if(newPassword.length < 8) {
    return jsonResponse({ error: '新密码至少需要 8 个字符' }, { status: 400 });
  }

  const targetUser = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(targetUsername).first();
  if(!targetUser) return jsonResponse({ error: '目标账号不存在' }, { status: 404 });

  const passwordRecord = await createPasswordRecord(newPassword);
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, salt = ?, iterations = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?'
  ).bind(passwordRecord.hash, passwordRecord.salt, passwordRecord.iterations, targetUsername).run();
  await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(targetUsername).run();

  return jsonResponse({ ok: true, username: targetUsername, message: '已重置密码' });
}

export async function onRequestGet() {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
}
