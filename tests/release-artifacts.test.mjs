import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 发布产物一致性：dist/ 必须与源码逐字节一致。
 * 这类问题在浏览器里表现为「改了没生效 / 线上跑旧代码」，肉眼极难发现，
 * 所以钉一条测试，并提供 scripts/sync-dist.mjs 一键修复。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(resolve(root, p));

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

check("dist 与源码一致（sync-dist --check 退出码为 0）", () => {
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [resolve(root, "scripts/sync-dist.mjs"), "--check"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").slice(0, 1200);
    assert.fail("dist 与源码不一致，请运行 node scripts/sync-dist.mjs 后再提交。\n" + detail);
  }
  assert.match(stdout, /一致/);
});

check("两个入口页面与源码逐字节相同", () => {
  assert.ok(read("dist/index.html").equals(read("炉管全生命周期管理系统.html")), "dist/index.html 与源页面不一致");
  assert.ok(read("dist/login.html").equals(read("login.html")), "dist/login.html 与 login.html 不一致");
});

check("assets 全量同步，且 dist 没有残留旧文件", () => {
  const srcFiles = walk(resolve(root, "assets"));
  const dstFiles = walk(resolve(root, "dist/assets"));
  assert.ok(srcFiles.length > 10, "assets 文件数异常");
  const srcSet = new Set(srcFiles);
  const missing = srcFiles.filter((rel) => !existsSync(resolve(root, "dist/assets", rel)));
  assert.deepEqual(missing, [], "dist 缺少资源：" + missing.join(", "));
  const extra = dstFiles.filter((rel) => !srcSet.has(rel));
  assert.deepEqual(extra, [], "dist 存在源码中已删除的旧文件：" + extra.join(", "));
  for (const rel of srcFiles) {
    assert.ok(
      read("assets/" + rel).equals(read("dist/assets/" + rel)),
      "dist/assets/" + rel + " 与源码不一致"
    );
  }
});

check("dist 根目录只有部署需要的入口文件", () => {
  const entries = readdirSync(resolve(root, "dist")).sort();
  assert.deepEqual(entries, ["assets", "index.html", "login.html"], "dist 根目录出现意外文件：" + entries.join(", "));
});

check("同步脚本自身可解析且支持 --check", () => {
  execFileSync(process.execPath, ["--check", resolve(root, "scripts/sync-dist.mjs")], { stdio: "pipe" });
  const source = readFileSync(resolve(root, "scripts/sync-dist.mjs"), "utf8");
  assert.ok(source.includes("--check"), "必须支持 --check 只检查模式");
  assert.ok(source.includes("dist/index.html"), "必须同步首页");
  assert.ok(source.includes("assets"), "必须同步 assets");
});

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
console.log("ok - release artifacts: " + checks.length + "/" + checks.length + " checks passed");
