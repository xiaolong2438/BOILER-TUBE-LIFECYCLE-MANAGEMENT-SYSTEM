const PUBLIC_PATHS = new Set(['/login', '/login.html', '/api/auth/login', '/api/auth/logout']);
const PUBLIC_PREFIXES = ['/assets/'];

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
  return header.split(';').map(part => part.trim()).reduce((found, part) => {
    if(found) return found;
    const index = part.indexOf('=');
    if(index < 0) return '';
    return part.slice(0, index) === name ? decodeURIComponent(part.slice(index + 1)) : '';
  }, '');
}

async function getSession(env, request) {
  const token = getCookie(request, 'bt_session');
  if(!token) return null;
  const row = await env.DB.prepare(
    'SELECT username, expires_at FROM sessions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP'
  ).bind(token).first();
  return row || null;
}

function wantsJson(pathname) {
  return pathname.startsWith('/api/');
}

export async function onRequest(context) {
  const { env, request, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
  const isLoginPage = pathname === '/login' || pathname === '/login.html';

  // 公开路径（静态资源、登录/登出接口）不需要会话信息：
  // 先放行，避免浏览器带 cookie 请求每个资源时都查一次 D1。
  if(!isLoginPage && (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix)))) {
    return next();
  }

  const session = await getSession(env, request);

  // 登录页：已登录直接回首页，未登录正常展示
  if(isLoginPage) {
    if(session) return Response.redirect(new URL('/', url.origin), 302);
    return next();
  }

  if(session) {
    return next();
  }

  if(wantsJson(pathname)) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', url.origin);
  loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
  return Response.redirect(loginUrl, 302);
}
