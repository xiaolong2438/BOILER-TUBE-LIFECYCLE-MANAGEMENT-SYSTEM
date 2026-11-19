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
  /* Cloudflare Pages Functions 的 params.key 不做 URL 解码：客户端 fetch 对
     `boiler_drawing_content:<id>` 这类键 encodeURIComponent 后变成 `...%3A...`，
     不先解码就会因 `%` 不在合法字符集而被一律拒成 400 Invalid key。 */
  let key = String(rawKey || '').trim();
  try { key = decodeURIComponent(key).trim(); } catch { /* 非法百分号序列：保留原样交给正则拒绝 */ }
  if(!key || key.length > 128) return null;
  if(!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  /* `#` 保留给分块行命名空间（key#v<gen>#pNNN / 旧格式 key#pNNN），客户端键不允许使用 */
  if(key.includes('#')) return null;
  return key;
}

/* 图纸内容/缩略图按 id 写入后不再变更，可安全让浏览器缓存；元数据/业务键仍需每次取最新。
   内容 1 天、缩略图 7 天：缩略图小且要频繁用于列表，命中的价值更高。 */
const CACHEABLE_CONTENT_PREFIX = 'boiler_drawing_content:';
const CACHEABLE_THUMB_PREFIX = 'boiler_drawing_thumb:';
function contentCacheInit(key) {
  if(key.indexOf(CACHEABLE_THUMB_PREFIX) === 0) {
    return { headers: { 'Cache-Control': 'private, max-age=604800' } };
  }
  if(key.indexOf(CACHEABLE_CONTENT_PREFIX) === 0) {
    return { headers: { 'Cache-Control': 'private, max-age=86400' } };
  }
  return undefined;
}

/* D1 单条 SQL 语句上限 100KB：大值（如图纸 base64）按 UTF-8 字节切块后逐行存储。
   新格式把分块写在独立代次下（key#v<gen>#pNNN），先写完整分块、最后原子切换主行指针，
   因此任一中间批次失败都不会破坏上一次已提交的值。 */
const CHUNK_THRESHOLD = 45000;
const CHUNK_BATCH_SIZE = 20;
const CHUNK_GEN_RE = /^[a-f0-9]{8,32}$/;
const UPSERT_MAIN_SQL = 'INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
const UPDATE_MAIN_SQL = 'UPDATE app_kv SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?';
const INSERT_MAIN_SQL = 'INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING';
const UPSERT_CHUNK_SQL = 'INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP';
/* 分块行必须走主键范围查询：SQLite 的 LIKE 默认大小写不敏感，无法命中 key 的 BINARY
   主键索引，会全表扫描 app_kv（表内存放全部图纸 base64），读取会慢到不可用。 */
const DELETE_CHUNK_SQL = 'DELETE FROM app_kv WHERE key >= ? AND key < ?';
const SELECT_CHUNK_SQL = 'SELECT key, value FROM app_kv WHERE key >= ? AND key < ? ORDER BY key';
const SELECT_MAIN_SQL = 'SELECT key, value, updated_at FROM app_kv WHERE key = ?';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* 键字符集不含 # 与 $，因此下面三段区间只覆盖分块行、不触碰主行与业务键。 */
function legacyChunkRange(key) {
  return [key + '#p', key + '#q'];
}
function genChunkRange(key, gen) {
  return [key + '#v' + gen + '#p', key + '#v' + gen + '#q'];
}
function allChunkRange(key) {
  return [key + '#', key + '$'];
}
function chunkRowKey(key, gen, index) {
  return key + '#v' + gen + '#p' + String(index).padStart(3, '0');
}
function newGen() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
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

/* 兼容旧客户端：仍可直接 PUT 裸值；新客户端可附带 baseUpdatedAt 做乐观并发控制。 */
function readPayload(request) {
  return request.json().catch(() => null).then(body => {
    if(body && typeof body === 'object' && !Array.isArray(body)
      && Object.prototype.hasOwnProperty.call(body, 'value')) {
      return {
        value: body.value,
        baseProvided: Object.prototype.hasOwnProperty.call(body, 'baseUpdatedAt'),
        baseUpdatedAt: body.baseUpdatedAt === undefined ? null : body.baseUpdatedAt
      };
    }
    return { value: body, baseProvided: false, baseUpdatedAt: null };
  });
}
function parseSqlTimeMs(value) {
  const text = String(value || '').trim();
  if(!text) return 0;
  const iso = text.includes('T') ? text : text.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}
/* 毫秒级时间戳兼作版本号：同一秒内两次写入也能区分；旧行仍是 SQLite CURRENT_TIMESTAMP 格式。 */
function nextUpdatedAt(previous) {
  const previousMs = parseSqlTimeMs(previous);
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
}
function conflictResponse(updatedAt) {
  return jsonResponse({ error: 'conflict', updatedAt: updatedAt || null }, { status: 409 });
}
async function readMainRow(env, key) {
  return env.DB.prepare(SELECT_MAIN_SQL).bind(key).first();
}
async function readUpdatedAt(env, key) {
  const row = await readMainRow(env, key).catch(() => null);
  return row ? row.updated_at : null;
}

/* baseProvided 时按 updated_at 精确匹配提交；0 行变更说明并发写入已抢先，调用方返回 409。 */
async function writeMainRow(env, key, value, updatedAt, current, baseProvided) {
  if(!baseProvided) {
    await env.DB.prepare(UPSERT_MAIN_SQL).bind(key, value, updatedAt).run();
    return true;
  }
  if(current) {
    const result = await env.DB.prepare(UPDATE_MAIN_SQL)
      .bind(value, updatedAt, key, current.updated_at)
      .run();
    return Number(result?.meta?.changes || 0) === 1;
  }
  const result = await env.DB.prepare(INSERT_MAIN_SQL).bind(key, value, updatedAt).run();
  return Number(result?.meta?.changes || 0) === 1;
}

/* 只清理本次读取到的旧代次/旧格式分块，避免误删并发写入者刚提交的新代次。 */
async function cleanupObservedChunks(env, key, current) {
  if(!current) return;
  let parsed = null;
  try { parsed = JSON.parse(current.value); } catch { return; }
  if(!parsed || typeof parsed !== 'object' || parsed.__chunked !== true) return;
  const range = typeof parsed.gen === 'string' && CHUNK_GEN_RE.test(parsed.gen)
    ? genChunkRange(key, parsed.gen)
    : legacyChunkRange(key);
  await env.DB.prepare(DELETE_CHUNK_SQL).bind(...range).run().catch(() => null);
}
async function deleteChunks(env, key, range) {
  await env.DB.prepare(DELETE_CHUNK_SQL).bind(...range).run().catch(() => null);
}

export async function onRequestGet({ env, request, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  /* probe=1：只回存在性与版本，不下内容。同步图纸时用它避免把整批原图重下一遍。 */
  const probe = new URL(request.url).searchParams.get('probe') === '1';
  const row = probe
    ? await env.DB.prepare('SELECT key, updated_at FROM app_kv WHERE key = ?').bind(key).first()
    : await readMainRow(env, key);
  if(!row) return jsonResponse({ found: false, key }, { status: 404 });
  if(probe) return jsonResponse({ found: true, key, updatedAt: row.updated_at }, { headers: { 'Cache-Control': 'no-store' } });
  let parsed = null;
  try { parsed = JSON.parse(row.value); } catch { parsed = null; }
  if(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.__chunked === true && Number.isInteger(parsed.parts) && parsed.parts > 0) {
    let range;
    if(parsed.gen !== undefined) {
      if(typeof parsed.gen !== 'string' || !CHUNK_GEN_RE.test(parsed.gen)) {
        return jsonResponse({ error: 'Chunked value corrupted', key, found: true }, { status: 500 });
      }
      range = genChunkRange(key, parsed.gen);
    } else {
      range = legacyChunkRange(key);
    }
    const chunkRows = await env.DB.prepare(SELECT_CHUNK_SQL)
      .bind(...range)
      .all()
      .catch(() => null);
    const chunks = ((chunkRows && chunkRows.results) || []).map(r => {
      try { return JSON.parse(r.value); } catch { return null; }
    });
    if(chunks.length !== parsed.parts || chunks.some(piece => typeof piece !== 'string')) {
      return jsonResponse({ error: 'Chunked value incomplete', key, found: true }, { status: 500 });
    }
    try {
      return jsonResponse({ found: true, key, value: JSON.parse(chunks.join('')), updatedAt: row.updated_at }, contentCacheInit(key));
    } catch {
      return jsonResponse({ error: 'Chunked value corrupted', key, found: true }, { status: 500 });
    }
  }
  return jsonResponse({ found: true, key, value: parsed, updatedAt: row.updated_at }, contentCacheInit(key));
}

export async function onRequestPut({ env, request, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  const { value, baseProvided, baseUpdatedAt } = await readPayload(request);
  if(value === undefined) return jsonResponse({ error: 'Missing value' }, { status: 400 });
  const serialized = JSON.stringify(value);
  if(serialized === undefined) return jsonResponse({ error: 'Invalid value' }, { status: 400 });
  const byteLength = textEncoder.encode(serialized).length;

  const current = await readMainRow(env, key);
  const currentUpdatedAt = current ? current.updated_at : null;
  if(baseProvided) {
    const expected = baseUpdatedAt === null || baseUpdatedAt === undefined ? null : String(baseUpdatedAt);
    if(current ? expected !== currentUpdatedAt : expected !== null) {
      return conflictResponse(currentUpdatedAt);
    }
  }

  const updatedAt = nextUpdatedAt(currentUpdatedAt);

  if(byteLength <= CHUNK_THRESHOLD) {
    const committed = await writeMainRow(env, key, serialized, updatedAt, current, baseProvided);
    if(!committed) return conflictResponse(await readUpdatedAt(env, key));
    await cleanupObservedChunks(env, key, current);
    return jsonResponse({ ok: true, key, updatedAt });
  }

  const gen = newGen();
  const pieces = splitUtf8ByBytes(serialized, CHUNK_THRESHOLD);
  const statements = pieces.map((piece, index) =>
    env.DB.prepare(UPSERT_CHUNK_SQL).bind(chunkRowKey(key, gen, index), JSON.stringify(piece))
  );
  try {
    for(let i = 0; i < statements.length; i += CHUNK_BATCH_SIZE) {
      await env.DB.batch(statements.slice(i, i + CHUNK_BATCH_SIZE));
    }
  } catch {
    await deleteChunks(env, key, genChunkRange(key, gen));
    return jsonResponse({ error: 'Chunk write failed' }, { status: 500 });
  }

  const meta = JSON.stringify({ __chunked: true, parts: pieces.length, size: byteLength, gen });
  let committed = false;
  try {
    committed = await writeMainRow(env, key, meta, updatedAt, current, baseProvided);
  } catch (error) {
    await deleteChunks(env, key, genChunkRange(key, gen));
    throw error;
  }
  if(!committed) {
    await deleteChunks(env, key, genChunkRange(key, gen));
    return conflictResponse(await readUpdatedAt(env, key));
  }
  await cleanupObservedChunks(env, key, current);
  return jsonResponse({ ok: true, key, chunked: true, parts: pieces.length, updatedAt });
}

export async function onRequestDelete({ env, params }) {
  const key = safeKey(params.key);
  if(!key) return jsonResponse({ error: 'Invalid key' }, { status: 400 });
  const current = await readMainRow(env, key);
  await env.DB.prepare('DELETE FROM app_kv WHERE key = ?').bind(key).run();
  if(current) {
    await cleanupObservedChunks(env, key, current);
  } else {
    await deleteChunks(env, key, allChunkRange(key));
  }
  return jsonResponse({ ok: true, key });
}
