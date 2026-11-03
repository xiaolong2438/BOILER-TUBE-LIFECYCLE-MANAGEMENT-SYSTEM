import { getSession, jsonResponse } from '../auth/_shared.mjs';
import '../../../assets/app/assistant-core-v1.js';
import '../../../assets/app/overtemperature-core-v1.js';

export const MAX_ROWS = 20000;
const MAX_BODY_BYTES = 512 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const core = () => {
  if (!globalThis.BTOvertemperatureCore) throw new ApiError(503, 'CORE_UNAVAILABLE', '超温计算模块不可用');
  return globalThis.BTOvertemperatureCore;
};
export class ApiError extends Error {
  constructor(status, code, message, detail = {}) {
    super(message); this.status = status; this.code = code; this.detail = detail;
  }
}
export const fail = (status, code, message, detail) => { throw new ApiError(status, code, message, detail); };
export function endpoint(fn) {
  return async context => {
    const work = { ...context };
    try {
      if (!context.env?.DB?.prepare || !context.env.DB.batch) fail(503, 'DATABASE_UNAVAILABLE', '超温数据库未配置');
      const session = await getSession(context.env, context.request);
      if (!session?.username) fail(401, 'UNAUTHORIZED', '请先登录');
      Object.assign(work, { db: context.env.DB, actor: session.username, now: Date.now() });
      const result = await fn(work);
      return jsonResponse(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      // The identical request may commit after the first idempotency lookup
      // but before snapshot validation (not just while committing the batch).
      if (work.writeAttempt && error instanceof ApiError) {
        try {
          const previous = await replay(work.writeAttempt);
          if (previous) return jsonResponse(previous, { headers: { 'Cache-Control': 'no-store' } });
        } catch (replayError) { error = replayError; }
      }
      if (error instanceof ApiError) return jsonResponse({ error: error.message, code: error.code, ...error.detail }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
      if (/query (?:result|response).*(?:too large|size|limit)|response too large|query.*timed out|SQLITE_TOOBIG/i.test(String(error?.message))) {
        return jsonResponse({ error: '查询超过数据库处理上限，未返回不完整统计；请使用分批分析', code: 'DATASET_TOO_LARGE' }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
      }
      if (/no such table|no such column|database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED|D1.*(?:unavailable|overloaded)/i.test(String(error?.message))) {
        return jsonResponse({ error: '超温数据库不可用，请确认迁移已执行后重试', code: 'DATABASE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      console.error('temperature API failed', error?.message);
      return jsonResponse({ error: '超温请求未完成，请重试', code: 'INTERNAL_ERROR' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
export function rows(result) {
  if (result?.success === false) throw new Error(result.error || 'D1 query failed');
  return result?.results || [];
}
export function bounded(list) {
  if (list.length > MAX_ROWS) fail(422, 'DATASET_TOO_LARGE', `超温查询超过 ${MAX_ROWS} 条的安全处理上限，未生成不完整结果；请联系管理员使用分批分析`, { limit: MAX_ROWS });
  return list;
}
export async function snapshot(db, withRecords = false) {
  // D1 batch is transactional: points, all immutable configurations, and records
  // are read from one snapshot. Never calculate statistics from a page.
  const tables = ['temperature_points', 'temperature_configs', ...(withRecords ? ['temperature_records'] : [])];
  const results = await db.batch(tables.map(table => stmt(db, `SELECT * FROM ${table} LIMIT ?`, MAX_ROWS + 1)));
  const sets = results.map(result => bounded(rows(result)));
  return {
    pointRows: sets[0], points: sets[0].map(row => JSON.parse(row.payload)),
    configs: sets[1].map(row => JSON.parse(row.payload)),
    recordRows: sets[2] || [], records: (sets[2] || []).map(row => JSON.parse(row.payload))
  };
}
export function object(value, label = '请求') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, 'INVALID_INPUT', `${label}必须是对象`);
  return value;
}
export function text(value, label, max = 200, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(422, 'INVALID_INPUT', `${label}格式不正确`);
  return value.trim();
}
export function id(value, label = 'id') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(422, 'INVALID_INPUT', `${label}格式不正确`);
  return value;
}
export const newId = prefix => `${prefix}-${crypto.randomUUID()}`;
export function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(422, 'INVALID_REVISION', '必须提供当前revision');
  return value;
}
export function epoch(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail(422, 'INVALID_TIME', `${label}必须是epoch毫秒整数`);
  return value;
}
export function boolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(422, 'INVALID_INPUT', `${label}必须是布尔值`);
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export async function readWrite(context) {
  const length = Number(context.request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) fail(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  const raw = await context.request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) fail(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  let body;
  try { body = JSON.parse(raw); } catch { fail(400, 'INVALID_JSON', '请求不是有效JSON'); }
  object(body);
  const requestId = id(body.requestId, 'requestId');
  const fingerprint = await digest({ actor: context.actor, method: context.request.method, path: new URL(context.request.url).pathname, body });
  const tx = { ...context, body, requestId, fingerprint };
  context.writeAttempt = tx;
  const previous = await replay(tx);
  return { ...tx, previous };
}
export async function replay(tx) {
  const row = await stmt(tx.db, 'SELECT actor, fingerprint, response_json FROM temperature_requests WHERE request_id = ?', tx.requestId).first();
  if (!row) return null;
  if (row.actor !== tx.actor || row.fingerprint !== tx.fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'requestId已用于不同请求，请勿复用');
  return JSON.parse(row.response_json);
}
export function guard(db, condition, args = []) {
  const guardId = newId('guard');
  return [
    stmt(db, `INSERT INTO temperature_tx_guard (id, ok) SELECT ?, CASE WHEN (${condition}) THEN 1 ELSE 0 END`, guardId, ...args),
    stmt(db, 'DELETE FROM temperature_tx_guard WHERE id = ?', guardId)
  ];
}
export function pointGuard(db, row, includeRecords = false) {
  return guard(db, `EXISTS (SELECT 1 FROM temperature_points WHERE id = ? AND revision = ?${includeRecords ? ' AND records_version = ?' : ''})`, [row.id, row.revision, ...(includeRecords ? [row.records_version] : [])]);
}
export async function commit(tx, operations, response, conflicts = {}) {
  try {
    const result = await tx.db.batch([
      stmt(tx.db, 'INSERT INTO temperature_requests (request_id, actor, fingerprint, response_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', tx.requestId, tx.actor, tx.fingerprint, JSON.stringify(response), 200, tx.now),
      ...operations
    ]);
    result.forEach(rows);
    return response;
  } catch (error) {
    const previous = await replay(tx);
    if (previous) return previous;
    if (/constraint|UNIQUE|temperature_revision_guard/i.test(String(error?.message))) {
      const detail = {};
      if (conflicts.pointId) {
        const current = await stmt(tx.db, 'SELECT payload FROM temperature_points WHERE id = ?', conflicts.pointId).first();
        detail.currentPoint = current ? JSON.parse(current.payload) : null;
        detail.current = detail.currentPoint;
      }
      if (conflicts.recordId) {
        const current = await stmt(tx.db, 'SELECT payload FROM temperature_records WHERE id = ?', conflicts.recordId).first();
        detail.current = current ? JSON.parse(current.payload) : null;
      }
      fail(409, 'WRITE_CONFLICT', '数据或配置已变更，或编号重复；请刷新后重新提交', detail);
    }
    throw error;
  }
}
export function audit(tx, type, before, after, reason, action = before ? 'update' : 'create') {
  return stmt(tx.db, 'INSERT INTO temperature_audit (id, entity_id, point_id, entity_type, action, before_json, after_json, reason, actor, at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId('audit'), after.id, type === 'point' ? after.id : after.pointId, type, action, before ? JSON.stringify(before) : null, JSON.stringify(after), reason, tx.actor, tx.now, tx.requestId);
}
export function findPoint(data, pointId) {
  id(pointId, 'pointId');
  const index = data.pointRows.findIndex(row => row.id === pointId);
  if (index < 0) fail(404, 'POINT_NOT_FOUND', '测点不存在');
  return { point: data.points[index], row: data.pointRows[index] };
}
export function checkRevision(expected, current) {
  revision(expected);
  if (expected !== current.revision) fail(409, 'REVISION_CONFLICT', '数据版本已更新，请刷新后重试', { current });
}
export function validateCore(result) {
  if (!result?.ok) fail(422, 'VALIDATION_FAILED', '超温业务校验未通过', { errors: result?.errors || ['未知校验错误'] });
  return result.value;
}
export function filters(request) {
  const url = new URL(request.url);
  const p = url.searchParams;
  const unit = p.get('unit') || null;
  if (unit !== null && unit !== '1' && unit !== '2') fail(400, 'INVALID_FILTER', 'unit必须为1或2');
  const pointIds = [...new Set(p.getAll('pointId').flatMap(value => value.split(',')).filter(Boolean))];
  if (pointIds.length > 100) fail(400, 'INVALID_FILTER', '一次最多筛选100个测点');
  pointIds.forEach(value => id(value, 'pointId'));
  const readEpoch = key => p.has(key) ? epoch(p.get(key)?.trim() ? Number(p.get(key)) : NaN, key) : undefined;
  const from = readEpoch('from'), to = readEpoch('to'), installedAt = readEpoch('installedAt');
  if (from !== undefined && to !== undefined && from >= to) fail(400, 'INVALID_RANGE', 'from必须早于to');
  const flag = (key, fallback) => {
    if (!p.has(key)) return fallback;
    const value = p.get(key);
    if (value !== 'true' && value !== 'false' && value !== '1' && value !== '0') fail(400, 'INVALID_FILTER', `${key}必须为true或false`);
    return value === 'true' || value === '1';
  };
  const limit = p.has('limit') ? Number(p.get('limit')) : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_LIMIT', 'limit必须为1至100');
  return { url, unit, pointIds, sys: text(p.get('sys') ?? undefined, 'sys', 100), q: text(p.get('q') ?? undefined, 'q', 200).toLowerCase(), from, to, installedAt, active: flag('active', undefined), includeVoid: flag('includeVoid', false), limit, tubeCode: text(p.get('tubeCode') ?? undefined, 'tubeCode', 200) };
}
export function selectPoints(data, filter) {
  const systemPoints = filter.sys ? new Set(data.configs.filter(config => config.regions.some(region => region.sys === filter.sys)).map(config => config.pointId)) : null;
  return data.points.filter(point => (!filter.unit || point.unit === filter.unit) && (!filter.pointIds.length || filter.pointIds.includes(point.id)) && (!systemPoints || systemPoints.has(point.id)) && (filter.active === undefined || point.active === filter.active) && (!filter.q || [point.id, point.tag, point.name, point.location].some(value => String(value || '').toLowerCase().includes(filter.q))));
}
export function selectRecords(data, points, filter) {
  const ids = new Set(points.map(point => point.id));
  const cfgs = new Map(data.configs.map(config => [config.id, config]));
  return data.records.filter(record => ids.has(record.pointId) && (filter.includeVoid || record.status === 'active') && (!filter.sys || cfgs.get(record.configId)?.regions.some(region => region.sys === filter.sys)) && (filter.to === undefined || record.startAt < filter.to) && (filter.from === undefined || (record.kind === 'observation' ? record.startAt >= filter.from : record.endAt === null || record.endAt > filter.from)));
}
export async function paginate(items, filter, history = false) {
  const scope = await digest({ path: filter.url.pathname, query: [...filter.url.searchParams.entries()].filter(([key]) => key !== 'cursor' && key !== 'limit').sort() });
  let cursor;
  const raw = filter.url.searchParams.get('cursor');
  if (raw) {
    try { cursor = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))); } catch { fail(400, 'INVALID_CURSOR', '分页游标无效'); }
    if (cursor?.v !== 1 || cursor.scope !== scope || !ID_PATTERN.test(cursor.id || '') || (history && !Number.isSafeInteger(cursor.at))) fail(400, 'INVALID_CURSOR', '分页游标与筛选条件不匹配');
  }
  const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const sorted = [...items].sort(history ? (a, b) => b.at - a.at || -compareId(a, b) : compareId);
  const rest = cursor ? sorted.filter(item => history ? item.at < cursor.at || (item.at === cursor.at && item.id < cursor.id) : item.id > cursor.id) : sorted;
  const page = rest.slice(0, filter.limit);
  const last = page[page.length - 1];
  const nextCursor = rest.length > filter.limit ? btoa(JSON.stringify({ v: 1, scope, id: last.id, ...(history ? { at: last.at } : {}) })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') : null;
  return { items: page, nextCursor, total: items.length };
}
