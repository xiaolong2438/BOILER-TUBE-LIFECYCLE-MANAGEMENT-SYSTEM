#!/usr/bin/env node
/**
 * dist 产物同步工具
 * ------------------------------------------------------------
 * 背景：本项目无构建链，dist/ 是手工产物，但集成测试要求它与源码逐字节一致。
 * 手工 cp 极易漏抄，所以收敛成一条命令。
 *
 * 用法：
 *   node scripts/sync-dist.mjs            # 同步（复制 + 清理 dist 中已删除的文件）
 *   node scripts/sync-dist.mjs --check    # 只检查，不写盘；有差异时退出码 1
 *
 * 同步范围（与 .github/workflows/deploy-cloudflare-pages.yml 保持一致）：
 *   炉管全生命周期管理系统.html → dist/index.html
 *   login.html                  → dist/login.html
 *   assets/**                   → dist/assets/**
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CHECK_ONLY = process.argv.includes('--check');

const HTML_PAIRS = [
  ['炉管全生命周期管理系统.html', 'dist/index.html'],
  ['login.html', 'dist/login.html']
];

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

const actions = [];

/* 1. 两个入口页面 */
for (const [from, to] of HTML_PAIRS) {
  const src = join(ROOT, from);
  const dst = join(ROOT, to);
  if (!existsSync(src)) {
    actions.push({ kind: 'missing-source', path: from });
    continue;
  }
  if (sameFile(src, dst)) continue;
  actions.push({ kind: existsSync(dst) ? 'update' : 'create', path: to, from });
  if (!CHECK_ONLY) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

/* 2. assets 目录整体同步 */
const srcAssets = join(ROOT, 'assets');
const dstAssets = join(DIST, 'assets');
const srcFiles = walk(srcAssets);
const dstFiles = walk(dstAssets);

for (const rel of srcFiles) {
  const src = join(srcAssets, rel);
  const dst = join(dstAssets, rel);
  if (sameFile(src, dst)) continue;
  actions.push({ kind: existsSync(dst) ? 'update' : 'create', path: 'dist/assets/' + rel, from: 'assets/' + rel });
  if (!CHECK_ONLY) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

/* 3. 清理 dist 里已被删除的旧文件（只动 dist/assets，避免误删） */
const srcSet = new Set(srcFiles);
for (const rel of dstFiles) {
  if (srcSet.has(rel)) continue;
  actions.push({ kind: 'delete', path: 'dist/assets/' + rel });
  if (!CHECK_ONLY) rmSync(join(dstAssets, rel), { force: true });
}

/* 4. 输出 */
const created = actions.filter((a) => a.kind === 'create');
const updated = actions.filter((a) => a.kind === 'update');
const deleted = actions.filter((a) => a.kind === 'delete');
const broken = actions.filter((a) => a.kind === 'missing-source');

for (const item of actions) {
  if (item.kind === 'create') console.log('  新增  ' + item.path);
  else if (item.kind === 'update') console.log('  更新  ' + item.path);
  else if (item.kind === 'delete') console.log('  删除  ' + item.path);
  else console.log('  缺失源文件  ' + item.path);
}

if (broken.length) {
  console.error('\n错误：源文件缺失，无法同步。');
  process.exit(2);
}

if (CHECK_ONLY) {
  if (actions.length) {
    console.error(`\ndist 与源码不一致：${created.length} 个新增、${updated.length} 个变更、${deleted.length} 个多余文件。`);
    console.error('请运行：node scripts/sync-dist.mjs');
    process.exit(1);
  }
  console.log('dist 与源码一致（' + srcFiles.length + ' 个资源 + 2 个页面）。');
  process.exit(0);
}

if (!actions.length) console.log('dist 已是最新，无需改动（' + srcFiles.length + ' 个资源）。');
else console.log(`\n同步完成：新增 ${created.length}、更新 ${updated.length}、删除 ${deleted.length}。`);
