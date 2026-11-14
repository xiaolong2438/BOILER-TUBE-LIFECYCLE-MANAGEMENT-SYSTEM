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
  /* `#` 保留给分块行命名空间（key#pNNN），客户端键不允许使用 */
  if(key.includes('#')) return null;
  return key;
}

/* D1 单条 SQL 语句上限 100KB：大值（如图纸 base64）按 UTF-8 字节切块后逐行存储，
   主行存 {__chunked,parts,size} 元数据，GET 时按序拼回，对客户端完全透明。 */
const CHUNK_THRESHOLD = 45000;
const CHUNK_BATCH_SIZE = 20;
const UPSERT_SQL = 'INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP';
const DELETE_CHUNK_SQL = "DELETE FROM app_kv WHERE key LIKE ? ESCAPE '\\'";
const SELECT_CHUNK_SQL = "SELECT key, value FROM app_kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function chunkRowKey(key, index) {
  return key + '#p' + String(index).padStart(3, '0');
}
/* LIKE 通配符转义（键字符集中 `_` 是通配符） */
function chunkLikePattern(key) {
  return key.replace(/[\\%_]/g, '\\$&') + '#p%';
}
/* 按 UTF-8 字节切块；回退到序列起点，避免截断多字节字符 */
function splitUtf8ByBytes(text, maxBytes) {
  const bytes = textEncoder.encode(text);
  if(bytes.length <= maxBytes) return [text];
  const pieces = [];
  let start = 0;
  while(start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if(end < bytes.length) {
      while(end > start && (bytes[end] & 0xC0) === 0x80) end -= 1;
      if(end === start) end = Math.min(start + maxBytes, bytes.length);
    }
    pieces.push(textDecoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return pieces;
}
async function clearChunkRows(db, key) {
  await db.prepare(DELETE_CHUNK_SQL).bind(chunkLikePattern(key)).run();
}

function readBodyValue(request) {
  return request.json().catch(() => null).then(body => {
    if(body && Object.prototype.hasOwnProperty.call(body, 'value')) return body.value;
    return body;
  });
}

export async function onRequestGet({ env, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  const row = await env.DB.prepare('SELECT key, value, updated_at FROM app_kv WHERE key = ?')
    .bind(key)
    .first();
  if(!row) return jsonResponse({ found: false, key }, { status: 404 });
  let parsed = null;
  try { parsed = JSON.parse(row.value); } catch { parsed = null; }
  if(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.__chunked === true && Number.isInteger(parsed.parts) && parsed.parts > 0) {
    const chunkRows = await env.DB.prepare(SELECT_CHUNK_SQL)
      .bind(chunkLikePattern(key))
      .all()
      .catch(() => null);
    const chunks = ((chunkRows && chunkRows.results) || []).map(r => {
      try { return JSON.parse(r.value); } catch { return null; }
    });
    if(chunks.length !== parsed.parts || chunks.some(piece => typeof piece !== 'string')) {
      return jsonResponse({ error: 'Chunked value incomplete', key, found: true }, { status: 500 });
    }
    try {
      return jsonResponse({ found: true, key, value: JSON.parse(chunks.join('')), updatedAt: row.updated_at });
    } catch {
      return jsonResponse({ error: 'Chunked value corrupted', key, found: true }, { status: 500 });
    }
  }
  return jsonResponse({ found: true, key, value: parsed, updatedAt: row.updated_at });
}

export async function onRequestPut({ env, request, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  const value = await readBodyValue(request);
  if(value === undefined) return jsonResponse({ error: 'Missing value' }, { status: 400 });
  const serialized = JSON.stringify(value);
  const byteLength = textEncoder.encode(serialized).length;
  /* 先清旧分块行，主行最后写：小值覆盖旧分块版本、分块行数变化都不留垃圾 */
  const statements = [env.DB.prepare(DELETE_CHUNK_SQL).bind(chunkLikePattern(key))];
  if(byteLength <= CHUNK_THRESHOLD) {
    statements.push(env.DB.prepare(UPSERT_SQL).bind(key, serialized));
  } else {
    const pieces = splitUtf8ByBytes(serialized, CHUNK_THRESHOLD);
    pieces.forEach((piece, index) => {
      statements.push(env.DB.prepare(UPSERT_SQL).bind(chunkRowKey(key, index), JSON.stringify(piece)));
    });
    statements.push(env.DB.prepare(UPSERT_SQL).bind(key, JSON.stringify({ __chunked: true, parts: pieces.length, size: byteLength })));
  }
  for(let i = 0; i < statements.length; i += CHUNK_BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + CHUNK_BATCH_SIZE));
  }
  return jsonResponse(byteLength > CHUNK_THRESHOLD
    ? { ok: true, key, chunked: true, parts: statements.length - 2 }
    : { ok: true, key });
}

export async function onRequestDelete({ env, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  await env.DB.prepare("DELETE FROM app_kv WHERE key = ? OR (key LIKE ? ESCAPE '\\')")
    .bind(key, chunkLikePattern(key))
    .run();
  return jsonResponse({ ok: true, key });
}
