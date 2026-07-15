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

function expiredCookie() {
  return 'bt_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export async function onRequestPost({ env, request }) {
  const token = getCookie(request, 'bt_session');
  if(token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': expiredCookie() } });
}

export async function onRequestGet({ env, request }) {
  return onRequestPost({ env, request });
}
