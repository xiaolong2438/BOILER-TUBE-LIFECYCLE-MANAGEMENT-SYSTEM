import { endpoint, readWrite, snapshot, object, text, id, newId, boolean, epoch, fail, stmt, guard, pointGuard, audit, commit, findPoint, checkRevision, validateCore, core, filters, selectPoints, selectRecords, paginate, rows, bounded, MAX_ROWS } from './_shared.mjs';

function recordInput(input, existing, data, point, tx) {
  object(input, 'record');
  if (existing && ((input.id !== undefined && input.id !== existing.id) || (input.pointId !== undefined && input.pointId !== existing.pointId))) fail(422, 'IMMUTABLE_RECORD_IDENTITY', '记录id与pointId不可更改；请作废后新增正确记录');
  const raw = { ...(existing || {}), ...input };
  const startAt = epoch(raw.startAt, 'startAt');
  const endAt = epoch(raw.endAt === undefined ? null : raw.endAt, 'endAt', true);
  const config = core().resolveConfig(data.configs, point.id, startAt);
  const candidate = {
    id: existing?.id || (input.id === undefined ? newId('tr') : id(input.id)), pointId: point.id,
    configId: raw.configId === undefined ? config?.id : id(raw.configId, 'configId'),
    kind: raw.kind, startAt, endAt, temperatureC: raw.temperatureC,
    verified: boolean(raw.verified, false, 'verified'), note: text(raw.note, 'note', 8000),
    status: raw.status === undefined ? 'active' : raw.status, revision: existing ? existing.revision + 1 : 1,
    createdAt: existing?.createdAt ?? tx.now, updatedAt: tx.now, createdBy: existing?.createdBy ?? tx.actor, updatedBy: tx.actor
  };
  if (candidate.status !== 'active' && candidate.status !== 'void') fail(422, 'INVALID_STATUS', 'status必须为active或void');
  if (!existing && candidate.status !== 'active') fail(422, 'INVALID_STATUS', '新记录必须为active');
  if (!candidate.configId || !data.configs.some(item => item.id === candidate.configId && item.pointId === point.id)) fail(422, 'CONFIG_NOT_FOUND', '记录必须对应此测点的有效配置');
  const value = validateCore(core().validateRecord(candidate, point, data.configs, tx.now));
  return { ...candidate, ...value, id: candidate.id, pointId: point.id, revision: candidate.revision, createdAt: candidate.createdAt, updatedAt: tx.now, createdBy: candidate.createdBy, updatedBy: tx.actor };
}
function touchRecordSet(tx, row) {
  return stmt(tx.db, 'UPDATE temperature_points SET records_version = records_version + 1 WHERE id = ? AND revision = ?', row.id, row.revision);
}
export const listRecords = endpoint(async context => {
  const filter = filters(context.request);
  const data = await snapshot(context.db, true);
  const points = selectPoints(data, filter);
  const page = await paginate(selectRecords(data, points, filter), filter);
  const pointIds = new Set(page.items.map(item => item.pointId));
  return { ...page, points: points.filter(point => pointIds.has(point.id)), configs: data.configs.filter(config => pointIds.has(config.pointId)), serverTime: context.now };
});
export const createRecord = endpoint(async context => {
  const tx = await readWrite(context);
  if (tx.previous) return tx.previous;
  object(tx.body.record, 'record');
  const data = await snapshot(tx.db, true);
  const { point, row } = findPoint(data, tx.body.record.pointId);
  const item = recordInput(tx.body.record, null, data, point, tx);
  const existing = data.records.find(record => record.id === item.id);
  if (existing) fail(409, 'RECORD_EXISTS', '记录id已存在', { current: existing });
  const reason = text(tx.body.reason, 'reason', 2000) || '创建超温记录';
  const operations = [
    ...pointGuard(tx.db, row),
    stmt(tx.db, 'INSERT INTO temperature_records (id, point_id, config_id, kind, start_at, end_at, status, revision, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', item.id, item.pointId, item.configId, item.kind, item.startAt, item.endAt, item.status, item.revision, item.createdAt, item.updatedAt, JSON.stringify(item)),
    touchRecordSet(tx, row), audit(tx, 'record', null, item, reason)
  ];
  return commit(tx, operations, { item, serverTime: tx.now }, { pointId: point.id, recordId: item.id });
});
export const editRecord = endpoint(async context => {
  const tx = await readWrite(context);
  if (tx.previous) return tx.previous;
  const recordId = id(context.params.id);
  const data = await snapshot(tx.db, true);
  const existing = data.records.find(record => record.id === recordId);
  if (!existing) fail(404, 'RECORD_NOT_FOUND', '记录不存在');
  checkRevision(tx.body.revision, existing);
  const reason = text(tx.body.reason, 'reason', 2000, true);
  const { point, row } = findPoint(data, existing.pointId);
  const item = recordInput(tx.body.record, existing, data, point, tx);
  const operations = [
    ...pointGuard(tx.db, row),
    ...guard(tx.db, 'EXISTS (SELECT 1 FROM temperature_records WHERE id = ? AND revision = ?)', [recordId, existing.revision]),
    stmt(tx.db, 'UPDATE temperature_records SET config_id = ?, kind = ?, start_at = ?, end_at = ?, status = ?, revision = ?, updated_at = ?, payload = ? WHERE id = ? AND revision = ?', item.configId, item.kind, item.startAt, item.endAt, item.status, item.revision, item.updatedAt, JSON.stringify(item), item.id, existing.revision),
    touchRecordSet(tx, row), audit(tx, 'record', existing, item, reason, item.status === 'void' && existing.status !== 'void' ? 'void' : 'update')
  ];
  return commit(tx, operations, { item, serverTime: tx.now }, { pointId: point.id, recordId });
});
export const getSummary = endpoint(async context => {
  const filter = filters(context.request);
  const data = await snapshot(context.db, true);
  const points = selectPoints(data, filter);
  const pointIds = new Set(points.map(point => point.id));
  const configs = data.configs.filter(config => pointIds.has(config.pointId));
  // Core applies the window; retain full history so summarizeTube can also
  // return the area's lifetime evidence alongside the installed tube window.
  const records = selectRecords(data, points, { ...filter, from: undefined, to: undefined, includeVoid: false });
  const window = { from: filter.from, to: filter.to };
  const summary = core().summarize(records, configs, window);
  const byPoint = points.map(point => {
    const versions = configs.filter(config => config.pointId === point.id);
    return { point, configs: versions, summary: core().summarize(records.filter(record => record.pointId === point.id), versions, window) };
  });
  const tubeEvidence = filter.tubeCode ? core().summarizeTube(filter.tubeCode, points, configs, records, { ...window, installedAt: filter.installedAt }) : undefined;
  return { summary, byPoint, ...(tubeEvidence ? { tubeEvidence } : {}), durationSemantics: 'union_across_points_not_sum', serverTime: context.now };
});
export const listHistory = endpoint(async context => {
  const filter = filters(context.request);
  const entityId = id(filter.url.searchParams.get('entityId'), 'entityId');
  // A point timeline includes its configuration and record events; an exact
  // config/record ID returns that entity's own immutable audit trail.
  const result = await stmt(context.db, 'SELECT * FROM temperature_audit WHERE entity_id = ? OR point_id = ? ORDER BY at DESC, id DESC LIMIT ?', entityId, entityId, MAX_ROWS + 1).all();
  const items = bounded(rows(result)).map(row => ({
    id: row.id, entityId: row.entity_id, pointId: row.point_id, entityType: row.entity_type, action: row.action,
    before: row.before_json === null ? null : JSON.parse(row.before_json), after: JSON.parse(row.after_json),
    reason: row.reason, actor: row.actor, at: row.at, requestId: row.request_id
  }));
  return { ...await paginate(items, filter, true), serverTime: context.now };
});
