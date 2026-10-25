import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");

// 材料库：每行所有字段可单独编辑（部件/系统/位置/结构形式/规格/材质/库存/预留/备注），不再只能 CSV 往返。
assert.match(js, /function openEditMaterialStock\(encodedKey\)/);
assert.match(js, /function saveMaterialStockEdit\(encodedKey\)/);
assert.match(js, /onclick="openEditMaterialStock\('\$\{encodeURIComponent\(materialKey\(item\)\)\}'\)"/);
assert.match(js, /<th>库存根数<\/th><th>库存总长度\(m\)<\/th><th>备注<\/th><th>操作<\/th>/);
assert.match(js, /页面编辑 \/ CSV 导入导出/);

// 全字段编辑表单：工程参数 + 库存参数都在弹窗内；管径/壁厚由规格派生只读展示。
["ms-component", "ms-sys", "ms-position", "ms-shape", "ms-spec", "ms-material", "ms-stock", "ms-length", "ms-reserve", "ms-remark"]
  .forEach((id) => assert.ok(js.indexOf(`id="${id}"`) > 0, `缺少输入 ${id}`));
assert.match(js, /function syncMaterialEditSpec\(\)/, "规格变化应联动管径/壁厚预览");
assert.match(js, /readonly style="opacity:.75;" value="\$\{escapeHTML\(materialEditSpecPreview\(item\.spec\)\)\}"/);

// 保存契约：必填校验、系统代码白名单、数值校验，走统一 saveMaterialLibrary（落盘+云同步+维护日志）。
assert.match(js, /部件名称、分段\/位置、规格型号不能为空/);
assert.match(js, /系统代码请从列表选择/);
assert.match(js, /库存根数请填数字（如 120），或留空/);
assert.match(js, /库存总长度请填数字（米，如 360），或留空/);
assert.match(js, /saveMaterialLibrary\(next, \{ reason: 'manual' \}\);/);

// 合并契约：页面编辑过的行（_edited）全量覆盖标准行；CSV 导入的旧行仍只回读库存三字段。
assert.match(js, /item\._edited\s*\?\s*\{ \.\.\.standard, \.\.\.item \}/);

// 只读角色禁止修改：入口隐藏 + 保存双重拦截。
assert.match(js, /getAssistantRole\(\) === 'viewer' \? '' : `<button[^`]*openEditMaterialStock/);
assert.match(js, /if\(getAssistantRole\(\) === 'viewer'\) \{ showToast\('当前为只读账号，不能修改材料记录。', 'warn'\); return; \}/);

console.log("ok - material rows are fully editable in-page with derived spec size, audit logging and viewer gating");
