const MAX_APP_KV_BYTES = 1_500_000;

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
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

function bodyError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function readBodyValue(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if(Number.isFinite(declared) && declared > MAX_APP_KV_BYTES) {
    throw bodyError(413, 'PAYLOAD_TOO_LARGE', `存储内容超过单键上限 ${MAX_APP_KV_BYTES} 字节，请拆分后再保存`);
  }
  const raw = await request.text();
  if(new TextEncoder().encode(raw).length > MAX_APP_KV_BYTES) {
    throw bodyError(413, 'PAYLOAD_TOO_LARGE', `存储内容超过单键上限 ${MAX_APP_KV_BYTES} 字节，请拆分后再保存`);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw bodyError(400, 'INVALID_JSON', '请求内容不是有效 JSON');
  }
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
  let value;
  try {
    value = await readBodyValue(request);
  } catch (error) {
    const payload = { error: error.message, code: error.code || 'INVALID_JSON' };
    if(error.code === 'PAYLOAD_TOO_LARGE') payload.limitBytes = MAX_APP_KV_BYTES;
    return jsonResponse(payload, { status: error.status || 400 });
  }
  if(value === undefined) return jsonResponse({ error: 'Missing value', code: 'MISSING_VALUE' }, { status: 400 });
  const serialized = JSON.stringify(value);
  if(new TextEncoder().encode(serialized).length > MAX_APP_KV_BYTES) {
    return jsonResponse({
      error: `存储内容超过单键上限 ${MAX_APP_KV_BYTES} 字节，请拆分后再保存`,
      code: 'PAYLOAD_TOO_LARGE',
      limitBytes: MAX_APP_KV_BYTES
    }, { status: 413 });
  }
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
