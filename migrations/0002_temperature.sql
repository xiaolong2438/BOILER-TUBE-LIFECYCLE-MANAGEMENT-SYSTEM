-- Additive and rerunnable. All timestamps are epoch milliseconds.
CREATE TABLE IF NOT EXISTS temperature_points (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL CHECK (unit IN ('1', '2')),
  tag TEXT NOT NULL CHECK (length(trim(tag)) > 0),
  measurement_type TEXT NOT NULL CHECK (measurement_type IN ('tube_wall','header_wall','steam','flue','other')),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  records_version INTEGER NOT NULL DEFAULT 0 CHECK (records_version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  UNIQUE (unit, tag)
);
CREATE TABLE IF NOT EXISTS temperature_configs (
  id TEXT PRIMARY KEY,
  point_id TEXT NOT NULL REFERENCES temperature_points(id),
  effective_from INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  UNIQUE (point_id, revision),
  UNIQUE (point_id, effective_from),
  UNIQUE (id, point_id)
);
CREATE TABLE IF NOT EXISTS temperature_records (
  id TEXT PRIMARY KEY,
  point_id TEXT NOT NULL REFERENCES temperature_points(id),
  config_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('observation','interval')),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','void')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  CHECK (end_at IS NULL OR end_at >= start_at),
  FOREIGN KEY (config_id, point_id) REFERENCES temperature_configs(id, point_id)
);
CREATE TABLE IF NOT EXISTS temperature_audit (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  point_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('point','config','record')),
  action TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS temperature_requests (
  request_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  status INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- A failed guard is a constraint error, so D1 rolls back the entire batch,
-- including audits and the idempotency response. Successful guards are removed.
CREATE TABLE IF NOT EXISTS temperature_tx_guard (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT temperature_revision_guard CHECK (ok = 1)
);
CREATE INDEX IF NOT EXISTS idx_temperature_points_unit_active ON temperature_points(unit, active, id);
CREATE INDEX IF NOT EXISTS idx_temperature_configs_point_time ON temperature_configs(point_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_temperature_records_point_time ON temperature_records(point_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_temperature_records_status_id ON temperature_records(status, id);
CREATE INDEX IF NOT EXISTS idx_temperature_audit_entity_time ON temperature_audit(entity_id, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_temperature_audit_point_time ON temperature_audit(point_id, at DESC, id DESC);
