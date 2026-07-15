function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for(const part of header.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if(index > 0 && trimmed.slice(0, index) === name) return decodeURIComponent(trimmed.slice(index + 1));
  }
  return '';
}

export async function onRequestGet({ env, request }) {
  const token = getCookie(request, 'bt_session');
  if(!token) return jsonResponse({ authenticated: false }, { status: 401 });
  const session = await env.DB.prepare(
    'SELECT username, expires_at FROM sessions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP'
  ).bind(token).first();
  if(!session) return jsonResponse({ authenticated: false }, { status: 401 });
  return jsonResponse({
    authenticated: true,
    username: session.username,
    expiresAt: session.expires_at
  });
}
