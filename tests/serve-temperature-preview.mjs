import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1 } from './fixtures/temperature/d1-adapter.mjs';

// Local UI acceptance only. This server owns a fresh temporary database and two
// synthetic sessions. It never reads deployment credentials or production D1.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'boiler-temperature-preview-'));
const db = new D1(resolve(temporary, 'synthetic.sqlite'));
for (const name of ['0001_init.sql', '0002_temperature.sql']) db.sql.exec(await readFile(resolve(root, 'migrations', name), 'utf8'));
for (const label of ['a', 'b']) {
  db.sql.prepare('INSERT INTO users(username,role,password_hash,salt,iterations) VALUES (?,?,?,?,?)').run('synthetic-reviewer-' + label, 'user', 'not-a-real-password', 'synthetic', 1);
  db.sql.prepare('INSERT INTO sessions(token,username,expires_at) VALUES (?,?,?)').run('synthetic-preview-' + label, 'synthetic-reviewer-' + label, '2099-01-01 00:00:00');
}
const modules = new Map();
async function moduleAt(relative) {
  if (!modules.has(relative)) modules.set(relative, await import(pathToFileURL(resolve(root, relative)).href));
  return modules.get(relative);
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
let closing = false;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    let response;
    const requestHeaders = new Headers(req.headers);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: requestHeaders, body });
    const env = { DB: db };
    if (pathname.startsWith('/api/temperature/')) {
      let file = '', params = {};
      if (pathname === '/api/temperature/points') file = 'points.js';
      else if (/^\/api\/temperature\/points\/[^/]+\/configs$/.test(pathname)) { file = 'points/[id]/configs.js'; params.id = pathname.split('/')[4]; }
      else if (/^\/api\/temperature\/points\/[^/]+$/.test(pathname)) { file = 'points/[id].js'; params.id = pathname.split('/')[4]; }
      else if (pathname === '/api/temperature/records') file = 'records.js';
      else if (/^\/api\/temperature\/records\/[^/]+$/.test(pathname)) { file = 'records/[id].js'; params.id = pathname.split('/')[4]; }
      else if (pathname === '/api/temperature/summary') file = 'summary.js';
      else if (pathname === '/api/temperature/history') file = 'history.js';
      if (!file) response = json({ error: 'Not found in isolated preview' }, 404);
      else {
        const api = await moduleAt('functions/api/temperature/' + file);
        const method = 'onRequest' + req.method[0] + req.method.slice(1).toLowerCase();
        response = api[method] ? await api[method]({ env, request, params }) : json({ error: 'Method not available' }, 405);
      }
    } else if (pathname === '/api/auth/session') {
      const api = await moduleAt('functions/api/auth/session.js');
      response = await api.onRequestGet({ env, request });
    } else if (pathname.startsWith('/api/storage/')) {
      // Existing business stores are isolated, too. Never import browser data to a
      // real account during acceptance. Responses stay in this temporary DB.
      const api = await moduleAt('functions/api/storage/[key].js');
      const method = 'onRequest' + req.method[0] + req.method.slice(1).toLowerCase();
      response = api[method] ? await api[method]({ env, request, params: { key: pathname.slice('/api/storage/'.length) } }) : json({}, 405);
    } else if (pathname === '/api/llm/status') response = json({ serverKey: false, configured: false });
    else if (pathname.startsWith('/api/llm/')) response = json({ error: '外部模型在隔离验收中关闭' }, 503);
    else {
      const client = pathname === '/client-b' ? 'b' : 'a';
      const isPage = ['/', '/client-a', '/client-b', '/login'].includes(pathname);
      const file = isPage ? resolve(root, '炉管全生命周期管理系统.html') : resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep)) response = new Response('Not found', { status: 404 });
      else if (!isPage && !pathname.startsWith('/assets/')) response = new Response('Not found', { status: 404 });
      else {
        let content = await readFile(file);
        if (isPage) {
          // The new module uses no CDN library. Remove unrelated remote assets so
          // this preview cannot publish test records or depend on internet access.
          const html = content.toString('utf8').replace(/<script\b[^>]*src="https?:[^>]*><\/script>/g, '').replace(/<link\b[^>]*href="https?:[^>]*>/g, '')
            .replace('<body>', '<body><div role="note" style="padding:9px 16px;background:#92400e;color:white;font:13px sans-serif;text-align:center">隔离验收环境 · 所有记录均为合成测试数据 · 非生产 D1</div>')
            .replace('</head>', '<script>localStorage.removeItem("boiler_llm_config");localStorage.setItem("boiler_demo_data_mode","off");</script></head>');
          content = Buffer.from(html);
        }
        response = new Response(content, { headers: { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...(isPage ? { 'Set-Cookie': 'bt_session=synthetic-preview-' + client + '; Path=/; HttpOnly; SameSite=Lax' } : {}) } });
      }
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
const port = Number(process.env.TEMPERATURE_PREVIEW_PORT || 8796);
server.listen(port, '127.0.0.1', () => {
  console.log('Isolated synthetic temperature preview: http://127.0.0.1:' + port + '/#view-overtemperature');
  console.log('Second local client: http://localhost:' + port + '/client-b#view-overtemperature');
  console.log('Temporary SQLite (not production D1): ' + temporary);
});
function close() {
  if (closing) return;
  closing = true;
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
