import { endpoint, readWrite, snapshot, object, text, id, newId, boolean, epoch, fail, stmt, guard, pointGuard, audit, commit, findPoint, checkRevision, validateCore, core, filters, selectPoints, paginate } from './_shared.mjs';

const TYPES = new Set(['tube_wall', 'header_wall', 'steam', 'flue', 'other']);
function pointTag(value, fallback) {
  const raw = text(value, 'tag', 160) || fallback;
  // DCS Tag 是终身点位身份，统一大写避免同一点位因大小写分裂；内部编号保持原样。
  return /^INTERNAL-/i.test(raw) ? raw : raw.toUpperCase();
}
function nullableEpoch(value, label) {
  return value === undefined || value === null || value === '' ? null : epoch(value, label);
}
function commissionedEpoch(value, tx) {
  const at = nullableEpoch(value, 'commissionedAt');
  if (at !== null && at > tx.now) fail(422, 'INVALID_COMMISSIONED_AT', 'commissionedAt不能晚于当前时间');
  return at;
}
function pointInput(input, tx) {
  object(input, '测点');
  const pointId = input.id === undefined ? newId('tp') : id(input.id);
  if (input.unit !== '1' && input.unit !== '2') fail(422, 'INVALID_UNIT', 'unit必须为1或2');
  if (!TYPES.has(input.measurementType)) fail(422, 'INVALID_MEASUREMENT_TYPE', '测量类型无效');
  // An explicitly labelled internal number is not a fabricated DCS tag.
  const tag = pointTag(input.tag, `INTERNAL-${pointId}`);
  return { id: pointId, unit: input.unit, tag, name: text(input.name, 'name', 200, true), measurementType: input.measurementType, location: text(input.location, 'location', 1000), panel: text(input.panel, 'panel', 200), commissionedAt: commissionedEpoch(input.commissionedAt, tx), active: boolean(input.active, true, 'active'), revision: 1, createdAt: tx.now, updatedAt: tx.now, createdBy: tx.actor, updatedBy: tx.actor };
}
function configInput(input, point, configs, records, tx) {
  object(input, 'config');
  const config = {
    id: input.id === undefined ? newId('tc') : id(input.id), pointId: point.id,
    effectiveFrom: epoch(input.effectiveFrom, 'effectiveFrom'),
    revision: Math.max(0, ...configs.filter(item => item.pointId === point.id).map(item => item.revision)) + 1,
    regions: input.regions, mappingConfirmed: boolean(input.mappingConfirmed, false, 'mappingConfirmed'),
    mappingBasis: text(input.mappingBasis, 'mappingBasis', 4000), limitC: input.limitC,
    limitBasis: text(input.limitBasis, 'limitBasis', 4000), createdAt: tx.now, createdBy: tx.actor
  };
  if (config.limitC !== null && (typeof config.limitC !== 'number' || !Number.isFinite(config.limitC))) fail(422, 'INVALID_LIMIT', 'limitC必须为有限数值或null');
  if (!Array.isArray(config.regions) || config.regions.length > 100) fail(422, 'INVALID_REGIONS', 'regions必须是最多100个区域的数组');
  if (configs.some(item => item.id === config.id)) fail(409, 'CONFIG_EXISTS', '配置id已存在');
  const value = validateCore(core().validateConfig(config, point, configs, records));
  return { ...config, ...value, id: config.id, pointId: point.id, revision: config.revision, createdAt: tx.now, createdBy: tx.actor };
}
function insertPoint(db, point) {
  return stmt(db, 'INSERT INTO temperature_points (id, unit, tag, measurement_type, active, revision, records_version, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)', point.id, point.unit, point.tag, point.measurementType, Number(point.active), point.revision, point.createdAt, point.updatedAt, JSON.stringify(point));
}
function insertConfig(db, config) {
  return stmt(db, 'INSERT INTO temperature_configs (id, point_id, effective_from, revision, payload) VALUES (?, ?, ?, ?, ?)', config.id, config.pointId, config.effectiveFrom, config.revision, JSON.stringify(config));
}
function updatePoint(db, point, expected) {
  return stmt(db, 'UPDATE temperature_points SET tag = ?, active = ?, revision = ?, updated_at = ?, payload = ? WHERE id = ? AND revision = ?', point.tag, Number(point.active), point.revision, point.updatedAt, JSON.stringify(point), point.id, expected);
}
export const listPoints = endpoint(async context => {
  const filter = filters(context.request);
  const data = await snapshot(context.db);
  const page = await paginate(selectPoints(data, filter), filter);
  const ids = new Set(page.items.map(item => item.id));
  return { ...page, configs: data.configs.filter(config => ids.has(config.pointId)).sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.revision - b.revision), serverTime: context.now };
});
export const createPoints = endpoint(async context => {
  const tx = await readWrite(context);
  if (tx.previous) return tx.previous;
  if (!Array.isArray(tx.body.points) || !tx.body.points.length || tx.body.points.length > 100) fail(422, 'INVALID_BATCH', 'points必须包含1至100个测点');
  const data = await snapshot(tx.db);
  const items = [], configs = [], operations = [];
  const reason = text(tx.body.reason, 'reason', 2000) || '创建测点';
  for (const input of tx.body.points) {
    const point = pointInput(input, tx);
    const existing = [...data.points, ...items].find(item => item.id === point.id || (item.unit === point.unit && item.tag.toUpperCase() === point.tag.toUpperCase()));
    if (existing) fail(409, 'POINT_EXISTS', '测点id或同机组tag已存在', { current: existing });
    items.push(point);
    operations.push(...guard(tx.db, 'NOT EXISTS (SELECT 1 FROM temperature_points WHERE id = ? OR (unit = ? AND tag = ?))', [point.id, point.unit, point.tag]), insertPoint(tx.db, point), audit(tx, 'point', null, point, reason));
    if (input.config !== undefined) {
      const config = configInput(input.config, point, [...data.configs, ...configs], [], tx);
      configs.push(config);
      operations.push(insertConfig(tx.db, config), audit(tx, 'config', null, config, reason));
    }
  }
  return commit(tx, operations, { items, configs, serverTime: tx.now });
});
export const editPoint = endpoint(async context => {
  const tx = await readWrite(context);
  if (tx.previous) return tx.previous;
  const pointId = id(context.params.id);
  const data = await snapshot(tx.db);
  const { point, row } = findPoint(data, pointId);
  checkRevision(tx.body.revision, point);
  const body = tx.body;
  const reason = text(body.reason, 'reason', 2000, true);
  if ((body.unit !== undefined && body.unit !== point.unit) || (body.measurementType !== undefined && body.measurementType !== point.measurementType) || (body.id !== undefined && body.id !== point.id)) fail(422, 'IMMUTABLE_POINT_IDENTITY', '测点id、机组和测量类型不可更改；请新建测点以保留历史');
  if (body.config !== undefined) fail(422, 'USE_CONFIG_ENDPOINT', '请通过配置追加接口修改配置');
  const item = { ...point, revision: point.revision + 1, updatedAt: tx.now, updatedBy: tx.actor };
  if (body.tag !== undefined) {
    const tag = pointTag(body.tag, `INTERNAL-${point.id}`);
    if (tag !== point.tag) {
      if (data.configs.some(config => config.pointId === point.id)) fail(422, 'IMMUTABLE_POINT_TAG', '已有配置版本，DCS Tag 已作为终身点位身份，不可修改；请新建正确测点并停用旧点');
      item.tag = tag;
    }
  }
  if (body.name !== undefined) item.name = text(body.name, 'name', 200, true);
  if (body.location !== undefined) item.location = text(body.location, 'location', 1000);
  if (body.panel !== undefined) item.panel = text(body.panel, 'panel', 200);
  if (body.commissionedAt !== undefined) item.commissionedAt = commissionedEpoch(body.commissionedAt, tx);
  if (body.active !== undefined) item.active = boolean(body.active, true, 'active');
  const duplicate = data.points.find(other => other.id !== point.id && other.unit === item.unit && other.tag.toUpperCase() === item.tag.toUpperCase());
  if (duplicate) fail(409, 'TAG_EXISTS', '同机组tag已存在', { current: point });
  return commit(tx, [...pointGuard(tx.db, row), updatePoint(tx.db, item, point.revision), audit(tx, 'point', point, item, reason)], { item, serverTime: tx.now }, { pointId });
});
export const appendConfig = endpoint(async context => {
  const tx = await readWrite(context);
  if (tx.previous) return tx.previous;
  const pointId = id(context.params.id);
  const data = await snapshot(tx.db, true);
  const { point, row } = findPoint(data, pointId);
  checkRevision(tx.body.revision, point);
  const reason = text(tx.body.reason, 'reason', 2000, true);
  const config = configInput(tx.body.config, point, data.configs, data.records, tx);
  const item = { ...point, revision: point.revision + 1, updatedAt: tx.now, updatedBy: tx.actor };
  // records_version protects validateConfig's record snapshot against a
  // concurrent insert/correction/void while the immutable version is appended.
  return commit(tx, [...pointGuard(tx.db, row, true), insertConfig(tx.db, config), updatePoint(tx.db, item, point.revision), audit(tx, 'config', null, config, reason, 'append'), audit(tx, 'point', point, item, reason, 'config_append')], { item, config, serverTime: tx.now }, { pointId });
});
