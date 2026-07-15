export function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  return header.split(';').map(part => part.trim()).reduce((found, part) => {
    if(found) return found;
    const index = part.indexOf('=');
    if(index < 0) return '';
    return part.slice(0, index) === name ? decodeURIComponent(part.slice(index + 1)) : '';
  }, '');
}

export function sessionCookie(token, expiresAt) {
  return [
    `bt_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`
  ].join('; ');
}

export function sqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function getSession(env, request) {
  const token = getCookie(request, 'bt_session');
  if(!token) return null;
  const row = await env.DB.prepare(
    'SELECT sessions.username, users.role, sessions.expires_at FROM sessions JOIN users ON users.username = sessions.username WHERE token = ? AND expires_at > CURRENT_TIMESTAMP'
  ).bind(token).first();
  return row || null;
}
