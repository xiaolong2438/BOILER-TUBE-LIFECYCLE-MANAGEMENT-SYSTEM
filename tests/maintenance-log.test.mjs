import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * 维护记录（操作日志）单测：只测领域与存储行为，不依赖 DOM。
 * 另外做静态契约校验：主应用的写入点必须真的挂了日志钩子。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const logSource = readFileSync(resolve(root, "assets/app/maintenance-log-v1.js"), "utf8");
const appSource = readFileSync(resolve(root, "assets/app/app-v7.9.js"), "utf8");
const assistantSource = readFileSync(resolve(root, "assets/app/assistant-v1.js"), "utf8");
const html = readFileSync(resolve(root, "炉管全生命周期管理系统.html"), "utf8");

function boot() {
  const store = {};
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(logSource, sandbox);
  return { log: sandbox.BTMaintenanceLog, store, sandbox };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ---------------- 契约 ---------------- */

check("对外 API 齐全，且使用独立的 localStorage 键", () => {
  const { log } = boot();
  ["record", "hook", "list", "stats", "clear", "render", "exportCsv", "buildCsv", "withSource"].forEach((name) => {
    assert.equal(typeof log[name], "function", "缺少 " + name);
  });
  assert.equal(log.STORAGE_KEY, "boiler_maintenance_log");
  assert.equal(log.MAX_ENTRIES, 800);
  assert.ok(log.ACTION_META.create && log.ACTION_META.delete && log.ACTION_META.undo);
});

check("主应用的全部写入点都挂了日志钩子", () => {
  const kinds = ["create", "replace", "delete", "import", "update", "clear"];
  kinds.forEach((kind) => {
    assert.ok(appSource.includes("mlog('" + kind + "'") || appSource.includes('mlog("' + kind + '"'),
      "app-v7.9.js 缺少 mlog('" + kind + "') 调用");
  });
  // 材料库是三元分支：导入走 import，其余走 material
  assert.ok(appSource.includes("'import' : 'material'"), "材料库变更必须同时覆盖 import / material 两种动作");
  assert.ok(appSource.includes("window.BTMaintenanceLog"), "主应用必须调用日志模块");
  assert.ok(appSource.includes("mlog('import', { dataset: 'events'"), "批量导入必须留痕");
  assert.ok(appSource.includes("MLog") === false, "不应出现拼写错误");
});

check("助手写入会标记来源并记录撤销", () => {
  assert.ok(assistantSource.includes("withSource('assistant'"), "助手写入必须标记来源");
  assert.ok(assistantSource.includes("hook('undo'"), "助手撤销导入必须留痕");
  assert.ok(assistantSource.includes("reason: 'undo'"), "材料库撤销应记为撤销动作");
});

check("页面挂载了维护记录视图与资源", () => {
  assert.ok(html.includes('data-view="maintainlog"'), "缺少左侧导航项");
  assert.ok(html.includes('id="view-maintainlog"'), "缺少视图容器");
  assert.ok(html.includes('assets/app/maintenance-log-v1.js'), "缺少脚本引用");
  assert.ok(html.includes('assets/app/maintenance-log-v1.css'), "缺少样式引用");
  ["mlog-stats", "mlog-range", "mlog-action", "mlog-source", "mlog-keyword", "mlog-body", "mlog-export", "mlog-clear"]
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), "缺少控件 " + id));
  assert.ok(appSource.includes("maintainlog: '维护记录'"), "视图标题未登记");
  assert.ok(appSource.includes("BTMaintenanceLog.render()"), "切换视图时必须触发渲染");
});

/* ---------------- 记录 ---------------- */

check("record 自动补全 id / 时间 / 操作人 / 来源", () => {
  const { log } = boot();
  const entry = log.record({ action: "create", targetLabel: "1-WW-FR-008-0003-000", summary: "新增测厚" });
  assert.match(entry.id, /^log-/);
  assert.ok(entry.at > 0);
  assert.ok(entry.ts.includes("T"));
  assert.equal(entry.operator, "本机用户");
  assert.equal(entry.source, "manual");
  assert.equal(entry.action, "create");
});

check("hook(create) 生成可读摘要与对象标签", () => {
  const { log } = boot();
  const entry = log.hook("create", {
    record: { code: "1-WW-FR-008-0003-000", type: "测厚", date: "2026-03-01", thickness: "6.8" }
  });
  assert.equal(entry.action, "create");
  assert.match(entry.targetLabel, /1-WW-FR-008-0003-000/);
  assert.match(entry.targetLabel, /测厚/);
  assert.match(entry.summary, /新增测厚/);
  assert.match(entry.summary, /6.8mm/);
  assert.equal(entry.meta.code, "1-WW-FR-008-0003-000");
});

check("hook(update) 记录字段级前后值，值没变则不记录", () => {
  const { log } = boot();
  const record = { code: "1-WW-FR-008-0003-000", date: "2026-03-01" };
  const entry = log.hook("update", { record, field: "thickness", before: "6.8", after: "6.5" });
  assert.equal(entry.action, "update");
  assert.equal(entry.changes.length, 1);
  assert.equal(entry.changes[0].label, "厚度(mm)");
  assert.equal(entry.changes[0].before, "6.8");
  assert.equal(entry.changes[0].after, "6.5");
  assert.match(entry.summary, /厚度\(mm\)：6.8 → 6.5/);
  assert.equal(log.hook("update", { record, field: "thickness", before: "6.8", after: "6.8" }), null);
});

check("hook(delete) 保留被删记录快照，便于追溯", () => {
  const { log } = boot();
  const entry = log.hook("delete", {
    record: { code: "2-HSH-E-013-0006-W01", type: "测厚", date: "2025-02-11", thickness: "6.85", desc: "误录" }
  });
  assert.equal(entry.action, "delete");
  assert.match(entry.summary, /删除测厚/);
  assert.equal(entry.meta.snapshot.code, "2-HSH-E-013-0006-W01");
  assert.ok(entry.changes.length >= 3, "删除时应至少留下编码/日期/厚度快照");
});

check("hook(import) 汇总导入条数与跳过原因", () => {
  const { log } = boot();
  const entry = log.hook("import", {
    dataset: "events",
    fileName: "寿命数据.csv",
    stats: { importedEvents: 12, importedReplacements: 2, skippedDuplicates: 3, skippedMismatch: 1 }
  });
  assert.equal(entry.action, "import");
  assert.equal(entry.target, "events");
  assert.match(entry.summary, /事件 12 条/);
  assert.match(entry.summary, /更换 2 条/);
  assert.match(entry.summary, /跳过重复 3 条/);
  assert.match(entry.summary, /机组不匹配 1 条/);
  assert.equal(entry.meta.fileName, "寿命数据.csv");
  assert.equal(entry.source, "import");
  assert.equal(log.hook("import", { dataset: "events", stats: {} }), null, "空导入不应刷屏");
});

check("hook(material) 区分普通变更与撤销", () => {
  const { log } = boot();
  const normal = log.hook("material", { added: 2, updated: 1, removed: 0, sample: "高温过热器" });
  assert.equal(normal.action, "material");
  assert.match(normal.summary, /材料库变更/);
  assert.match(normal.summary, /新增 2 条/);
  assert.equal(normal.target, "material_library");

  const undo = log.hook("material", { added: 0, updated: 0, removed: 3, reason: "undo" });
  assert.equal(undo.action, "undo");
  assert.match(undo.summary, /撤销材料库导入/);
});

check("hook(replace) 记录新旧管码与原因", () => {
  const { log } = boot();
  const entry = log.hook("replace", {
    record: { oldCode: "1-WW-FR-008-0003-000", newCode: "1-WW-FR-008-0003-001", reason: "爆管", date: "2026-04-02" }
  });
  assert.equal(entry.action, "replace");
  assert.match(entry.targetLabel, /→/);
  assert.equal(entry.changes.length, 3);
  assert.deepEqual(Array.from(entry.changes.map((c) => c.field)), ["oldCode", "newCode", "reason"]);
});

check("hook(clear) 记为系统动作", () => {
  const { log } = boot();
  const entry = log.hook("clear", { total: 42 });
  assert.equal(entry.action, "system");
  assert.equal(entry.source, "system");
  assert.match(entry.summary, /42 条/);
});

/* ---------------- 查询与统计 ---------------- */

check("list 支持动作 / 来源 / 关键词 / 时间范围 / 条数过滤", () => {
  const { log } = boot();
  const now = Date.now();
  log.record({ action: "create", summary: "新增测厚", targetLabel: "1-WW-FR-008-0003-000", at: now });
  log.record({ action: "import", summary: "导入寿命事件", at: now - 10 * 86400000, targetLabel: "寿命事件" });
  log.record({ action: "update", summary: "厚度 6.8 → 6.5", targetLabel: "1-WW-FR-008-0003-000", at: now - 40 * 86400000 });
  const { log: sandboxed } = { log };
  void sandboxed;

  assert.equal(log.list({}).length, 3);
  assert.equal(log.list({ action: "import" }).length, 1);
  assert.equal(log.list({ keyword: "厚度" }).length, 1);
  assert.equal(log.list({ days: 30 }).length, 2, "40 天前的那条应被排除");
  assert.equal(log.list({ limit: 1 }).length, 1);
  assert.equal(log.list({ keyword: "1-WW" }).length, 2);
});

check("stats 汇总总量 / 今日 / 近 7 天 / 最近一次", () => {
  const { log } = boot();
  const now = Date.now();
  log.record({ action: "create", summary: "a", at: now });
  log.record({ action: "delete", summary: "b", at: now - 2 * 86400000 });
  log.record({ action: "import", summary: "c", at: now - 20 * 86400000 });
  const s = log.stats();
  assert.equal(s.total, 3);
  assert.equal(s.today, 1);
  assert.equal(s.week, 2);
  assert.equal(s.byAction.create, 1);
  assert.equal(s.byAction.delete, 1);
  assert.equal(log.formatDateTime(s.lastAt).length, 16);
});

check("超过上限时滚动保留最新的 800 条", () => {
  const { log } = boot();
  const base = Date.now() - 2000 * 1000;
  for (let i = 0; i < log.MAX_ENTRIES + 50; i += 1) {
    log.record({ action: "create", summary: "第 " + i + " 条", at: base + i * 1000 });
  }
  assert.equal(log.stats().total, log.MAX_ENTRIES);
  const rows = log.list({ limit: 500 });
  assert.equal(rows[0].summary, "第 849 条", "必须保留最新记录");
  assert.ok(!rows.some((row) => row.summary === "第 0 条"), "最早的记录应被清理");
});

check("记录落盘后重新加载仍然存在（localStorage 持久化）", () => {
  const { log, store } = boot();
  log.record({ action: "create", summary: "落盘测试", at: Date.now() });
  const raw = store["boiler_maintenance_log"];
  assert.ok(raw, "必须写入 localStorage");
  assert.equal(JSON.parse(raw).length, 1);
  log._reset();
  assert.equal(log.list({}).length, 1, "_reset 后应能从存储重新读回");
});

/* ---------------- 来源标注 ---------------- */

check("清空日志：登录态仅管理员可清，离线模式放行", () => {
  const offline = boot();
  assert.equal(offline.log.canClear(), true, "本地离线模式应允许清空");

  const userBox = boot();
  userBox.sandbox.currentAuthSession = { username: "zhongguoting", role: "user" };
  assert.equal(userBox.log.canClear(), false, "普通账号不允许清空");

  const adminBox = boot();
  adminBox.sandbox.currentAuthSession = { username: "admin", role: "admin" };
  assert.equal(adminBox.log.canClear(), true, "管理员允许清空");
});

check("withSource 标记助手来源，异常时也能还原", () => {
  const { log } = boot();
  assert.equal(log.currentSource(), "manual");
  const entry = log.withSource("assistant", function () {
    return log.record({ action: "create", summary: "助手写入" });
  });
  assert.equal(entry.source, "assistant");
  assert.equal(log.currentSource(), "manual", "作用域退出后必须还原");
  assert.throws(() => log.withSource("assistant", function () { throw new Error("boom"); }));
  assert.equal(log.currentSource(), "manual", "抛异常也要还原");
});

/* ---------------- 导出 ---------------- */

check("buildCsv 输出 BOM、表头与单元格转义", () => {
  const { log } = boot();
  const rows = [log.record({
    action: "update",
    summary: '厚度 6.8 → 6.5，"异常"',
    targetLabel: "1-WW-FR-008-0003-000",
    at: Date.now(),
    changes: [{ field: "thickness", label: "厚度(mm)", before: "6.8", after: "6.5" }]
  })];
  const csv = log.buildCsv(rows);
  assert.ok(csv.charCodeAt(0) === 0xfeff, "CSV 需要 BOM 以便 Excel 正常识别中文");
  assert.match(csv, /时间,动作,对象,变更内容,操作人,来源,备注,日志ID/);
  assert.match(csv, /修改/);
  assert.match(csv, /""异常""/, "引号必须转义");
});

/* ---------------- 差异工具 ---------------- */

check("diffFields / summarizeChanges 只输出真正变化的字段", () => {
  const { log } = boot();
  const changes = log.diffFields(
    { thickness: "7.0", hardness: "180", code: "1-WW-FR-008-0003-000" },
    { thickness: "6.5", hardness: "180", code: "1-WW-FR-008-0003-000" },
    ["thickness", "hardness", "code"]
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "thickness");
  assert.match(log.summarizeChanges(changes), /厚度\(mm\) 7.0 → 6.5/);
  assert.equal(log.fieldLabel("hardness"), "硬度(HB)");
  assert.equal(log.fieldLabel("unknownField"), "unknownField");
});

check("无变化时不产生日志（避免刷屏）", () => {
  const { log } = boot();
  assert.equal(log.hook("material", { added: 0, updated: 0, removed: 0 }), null);
  assert.equal(log.hook("update", { record: {}, field: "desc", before: "x", after: "x" }), null);
  assert.equal(log.stats().total, 0);
});

/* ---------------- run ---------------- */

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
console.log("ok - maintenance log: " + checks.length + "/" + checks.length + " checks passed");
