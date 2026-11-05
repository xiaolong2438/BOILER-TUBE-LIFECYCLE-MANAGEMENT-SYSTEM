import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 录入模块契约：
 * - 管段编码示例必须是现行字母尾口径（无流水号）；
 * - 材质、炉号均为可选项，炉号留空时按编码前缀推断。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
const html = read('炉管全生命周期管理系统.html');
const app = read('assets/app/app-v7.9.js');

/* 1. 编码示例与现行规则一致（字母尾，不带流水号） */
assert.match(html, /id="dm-code" placeholder="例: 1G-SLB-WB-F000-R015-Q"/, '录入示例必须是字母尾编码');
assert.ok(!html.includes('R015-Q001'), '录入示例不应再出现流水号');
assert.match(html, /<label>新管段编码（同管位）<\/label>/, '更换登记应按同管位编码描述');
assert.ok(!html.includes('流水号'), '录入模块不应再出现流水号口径');

/* 2. 材质可选 */
assert.match(html, /<label>材质（可选）<\/label><input type="text" id="dm-material"/, '材质必须标注可选');
assert.match(app, /<label>材质（可选）<\/label><input type="text" id="de-material"/, '编辑弹窗材质同样可选');

/* 3. 炉号可选：录入与编辑都提供“未指定” */
assert.match(html, /<select id="dm-boiler"><option value="">未指定（按编码推断）<\/option>/, '录入表单炉号必须允许未指定');
assert.match(html, /<select id="dm-rep-boiler"><option value="">未指定（按编码推断）<\/option>/, '更换登记炉号必须允许未指定');
assert.match(app, /<option value="" \$\{unset \? 'selected' : ''\}>未指定（按编码推断）<\/option>/, '编辑弹窗炉号必须允许未指定');

/* 4. 保存逻辑：炉号不是必填，留空按编码推断，仅两侧都有值时校验一致性 */
const addEvent = app.slice(app.indexOf('function addUserEvent'), app.indexOf('function addReplacement'));
assert.ok(!/if\(!boiler \|\|/.test(addEvent), '炉号不应是必填项');
assert.match(addEvent, /const codeBoiler = getBoilerFromCode\(code\);/);
assert.match(addEvent, /if\(!boiler && codeBoiler\) boiler = codeBoiler;/, '炉号留空时必须按编码推断');
assert.match(addEvent, /if\(boiler && codeBoiler && codeBoiler !== boiler\)/, '仅在两侧都有值时才校验一致性');
const saveEdit = app.slice(app.indexOf('function saveEventEdit'), app.indexOf('function openEditReplacement') === -1 ? app.length : app.indexOf('function openEditReplacement'));
assert.match(saveEdit, /if\(!code \|\| !date \|\| !desc\)/, '编辑保存不应要求炉号');

/* 5. 下载模板示例同步为现行编码 */
assert.match(app, /'管段编码': '1G-SLB-WB-F000-R015-Q'/, 'Excel 模板示例必须是字母尾');
assert.match(app, /'1G-SLB-WB-F000-R015-Q','Φ63.5×7.5'/, 'CSV 模板示例必须是字母尾');
assert.ok(!app.includes("'1G-SLB-WB-F000-R015-Q001'"), '模板示例不应再出现流水号');
assert.ok(!app.includes("'2G-GGRQ-GQ-L012-F005-Q002'"), '模板示例不应再出现流水号');
assert.ok(!app.includes("'1G-DZRQ-GQ-4KJ-L065-Q002'"), '更换模板示例不应再出现流水号');

console.log('ok - entry form: letter-tail examples, optional material and boiler');
