function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

function safeKey(rawKey) {
  const key = String(rawKey || '').trim();
  if(!key || key.length > 128) return null;
  if(!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  return key;
}

async function readBodyValue(request) {
  const body = await request.json().catch(() => null);
  if(body && Object.prototype.hasOwnProperty.call(body, 'value')) return body.value;
  return body;
}

export async function onRequestGet({ env, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  const row = await env.DB.prepare('SELECT key, value, updated_at FROM app_kv WHERE key = ?')
    .bind(key)
    .first();
  if(!row) return jsonResponse({ found: false, key }, { status: 404 });
  return jsonResponse({
    found: true,
    key: row.key,
    value: JSON.parse(row.value),
    updatedAt: row.updated_at
  });
}

export async function onRequestPut({ env, request, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  const value = await readBodyValue(request);
  if(value === undefined) return jsonResponse({ error: 'Missing value' }, { status: 400 });
  const serialized = JSON.stringify(value);
  await env.DB.prepare(
    'INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).bind(key, serialized).run();
  return jsonResponse({ ok: true, key });
}

export async function onRequestDelete({ env, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  await env.DB.prepare('DELETE FROM app_kv WHERE key = ?').bind(key).run();
  return jsonResponse({ ok: true, key });
}
