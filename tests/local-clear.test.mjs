import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const rest = app.slice(start);
  const firstLine = rest.split('\n')[0].trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  const end = /^}/m.exec(rest);
  assert.ok(end, `${name} must have a closing brace`);
  return rest.slice(0, end.index + 1);
}

function harness({ cloud = true, events = [{ ts: 1 }], replacements = [{ ts: 2 }] } = {}) {
  const calls = { confirms: [], toasts: [], removed: [], reloads: 0, backups: 0, logs: [], timers: [] };
  const ctx = vm.createContext({
    console,
    localStorage: {
      removeItem: key => calls.removed.push(key),
      setItem: () => {}
    },
    confirm: message => { calls.confirms.push(String(message)); return true; },
    backupLocalData: () => { calls.backups += 1; },
    showToast: (message, tone) => calls.toasts.push({ message: String(message), tone }),
    invalidateTubeViews: () => {},
    mlog: (kind, payload) => calls.logs.push({ kind, payload }),
    cloudStorageEnabled: () => cloud,
    location: { reload: () => { calls.reloads += 1; } },
    setTimeout: (fn, delay) => { calls.timers.push({ fn, delay }); },
    JSON, Date, Array
  });
  vm.runInContext(`var userDB = ${JSON.stringify({ events, replacements })}; var currentAuthSession = ${cloud ? "{ username: 'tester' }" : 'null'};`, ctx);
  vm.runInContext("const LOCAL_DB_AT_KEY = 'boiler_user_db_local_at'; const DB_BACKUP_KEY = 'boiler_user_db_backup';", ctx);
  vm.runInContext(functionSource('clearLocalData'), ctx);
  return { ctx, calls };
}

test('已连接云端：只清理本机缓存，不写云端，随后重新载入', () => {
  const h = harness({ cloud: true });
  vm.runInContext('clearLocalData()', h.ctx);
  assert.equal(h.calls.backups, 1, '清理前必须下载备份');
  assert.equal(h.calls.confirms.length, 2, '需要两次确认');
  assert.match(h.calls.confirms[0], /云端共享数据不受影响/);
  assert.match(h.calls.confirms[1], /仅清理本机缓存/);
  assert.deepEqual(h.calls.removed.sort(), ['boiler_user_db', 'boiler_user_db_backup', 'boiler_user_db_local_at']);
  assert.equal(h.ctx.userDB.events.length, 0);
  assert.equal(h.ctx.userDB.replacements.length, 0);
  assert.equal(h.calls.logs[0].kind, 'clear');
  assert.equal(h.calls.logs[0].payload.scope, 'local-cache');
  assert.equal(h.calls.timers.length, 1, '应安排从云端重新载入');
  h.calls.timers[0].fn();
  assert.equal(h.calls.reloads, 1);
});

test('未连接云端：明确告知无法恢复，不清空共享数据也不自动刷新', () => {
  const h = harness({ cloud: false });
  vm.runInContext('clearLocalData()', h.ctx);
  assert.match(h.calls.confirms[0], /无法恢复/);
  assert.equal(h.calls.removed.includes('boiler_user_db'), true);
  assert.equal(h.calls.timers.length, 0, '未连接云端不应自动刷新');
  assert.equal(h.calls.toasts[0].tone, 'warn');
  assert.match(h.calls.toasts[0].message, /无法恢复/);
});

test('没有本机缓存时直接提示，不弹二次确认', () => {
  const h = harness({ cloud: true, events: [], replacements: [] });
  vm.runInContext('clearLocalData()', h.ctx);
  assert.equal(h.calls.confirms.length, 0);
  assert.equal(h.calls.backups, 0);
  assert.match(h.calls.toasts[0].message, /没有可清理的本机缓存/);
});

test('源码不再从清空流程调用 saveDB 或云端排队上传', () => {
  const source = functionSource('clearLocalData');
  assert.doesNotMatch(source, /saveDB\s*\(/);
  assert.doesNotMatch(source, /queueCloudStorageSave\s*\(/);
});
