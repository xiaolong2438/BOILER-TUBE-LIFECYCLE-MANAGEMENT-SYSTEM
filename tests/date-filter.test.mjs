import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import vm from "node:vm";

const app = readFileSync(new URL("../assets/app/app-v7.9.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../炉管全生命周期管理系统.html", import.meta.url), "utf8");
const xlsx = readFileSync(new URL("../assets/app/xlsx-export-v1.js", import.meta.url), "utf8");

function functionSource(name) {
  const start = app.indexOf("function " + name + "(");
  assert.ok(start >= 0, name);
  const end = /^}/m.exec(app.slice(start));
  assert.ok(end, name);
  return app.slice(start, start + end.index + 1);
}

let range = { from: "", to: "" };
const ctx = vm.createContext({ getDmDateFilter: () => range });
for (const name of ["dmDateKey", "dmDateFilterActive", "dmDateInScope"]) {
  vm.runInContext(functionSource(name), ctx);
}

assert.equal(ctx.dmDateKey("2026-04-15"), "2026-04-15");
assert.equal(ctx.dmDateKey("2026/4/5"), "2026-04-05");
assert.equal(ctx.dmDateKey("2026.4.5"), "2026-04-05");
assert.equal(ctx.dmDateKey("2026年4月5日"), "2026-04-05");
assert.equal(ctx.dmDateKey("2026-04"), "2026-04-01", "月份粒度按当月首日参与比较");
assert.equal(ctx.dmDateKey(""), "");

assert.equal(ctx.dmDateInScope(""), true, "未设置日期时不过滤任何记录");
range = { from: "2026-04-01", to: "" };
assert.equal(ctx.dmDateInScope("2026-04-01"), true);
assert.equal(ctx.dmDateInScope("2026-04-30"), true);
assert.equal(ctx.dmDateInScope("2026-03-31"), false, "只填开始日期时较早记录被排除");
range = { from: "", to: "2026-04-30" };
assert.equal(ctx.dmDateInScope("2026-03-31"), true);
assert.equal(ctx.dmDateInScope("2026-05-01"), false, "只填结束日期时较晚记录被排除");
range = { from: "2026-04-01", to: "2026-04-30" };
assert.equal(ctx.dmDateInScope("2026-04-01"), true, "开始日期为闭区间");
assert.equal(ctx.dmDateInScope("2026-04-30"), true, "结束日期为闭区间");
assert.equal(ctx.dmDateInScope("2026-04"), true, "月份粒度记录落在范围内");
assert.equal(ctx.dmDateInScope("2026-03-31"), false);
assert.equal(ctx.dmDateInScope("2026-05-01"), false);
assert.equal(ctx.dmDateInScope(""), false, "日期筛选生效时无日期记录不纳入");

// 页面控件与联动：开始/结束日期 + 清除按钮，刷新后记忆。
assert.match(html, /id="dm-date-from"[^>]*aria-label="开始日期"[^>]*onchange="onDmDateFilterChange\(\)"/);
assert.match(html, /id="dm-date-to"[^>]*aria-label="结束日期"[^>]*onchange="onDmDateFilterChange\(\)"/);
assert.match(html, /onclick="clearDmDateFilter\(\)"/);
assert.match(html, /<label for="dm-date-from">日期范围<\/label>/);
assert.match(app, /function onDmDateFilterChange\(\)/);
assert.match(app, /function clearDmDateFilter\(\)/);
assert.match(app, /开始日期晚于结束日期，已自动对调/);
assert.match(app, /localStorage\.setItem\('boiler_dm_date_from', fromEl\?\.value \|\| ''\)/);
assert.match(app, /fromEl\.value = localStorage\.getItem\('boiler_dm_date_from'\) \|\| ''/, "日期筛选刷新后恢复");
assert.match(app, /dmDateInScope\(r\.date, dateRange\) && dmTypeInScope\(r\.type\) && dmRowInScope\(eventBoiler\(r\)/, "事件表应用日期筛选");
assert.match(app, /dmDateInScope\(r\.date, dateRange\) && !typeFilter && dmRowInScope\(replacementBoiler\(r\)/, "更换表应用日期筛选");
assert.match(app, /dmDateInScope\(r\.date, dateRange\) && dmTypeInScope\(r\.type\) && dmRowInScope\(eventBoiler\(r\), \[r\.code\], filter, sys, codeQuery\)\);\s*\n\s*const groups = dmDuplicateGroups/, "批量去重按当前日期范围计算");
assert.match(app, /dmDateInScope\(e\.date, dateRange\) && dmTypeInScope\(e\.type\) && dmRowInScope\(eventBoiler\(e\)/, "CSV 导出应用日期筛选");
assert.match(xlsx, /dmDateInScope\(item\.date, dateRange\) && dmTypeInScope\(item\.type\) && dmRowInScope\(eventBoiler\(item\)/, "XLSX 导出应用日期筛选");
assert.match(xlsx, /dmDateInScope\(item\.date, dateRange\) && !typeFilter && dmRowInScope\(replacementBoiler\(item\)/, "XLSX 更换记录应用日期筛选");

console.log("ok - batch data date range filter is inclusive, persistent and wired to tables/exports");
