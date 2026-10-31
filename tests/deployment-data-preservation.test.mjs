import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPassword } from "../functions/api/auth/_password.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(root, ".github/workflows/deploy-cloudflare-pages.yml"), "utf8").replace(/\r\n/g, "\n");
const schema = readFileSync(resolve(root, "migrations/0001_init.sql"), "utf8");
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `缺少部署步骤 ${name}`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  const block = workflow.slice(start, end < 0 ? undefined : end);
  const marker = "        run: |\n";
  assert.ok(block.includes(marker), `${name} 必须包含 shell 脚本`);
  const script = block.slice(block.indexOf(marker) + marker.length).split("\n").map(line => {
    assert.ok(!line.trim() || line.startsWith("          "), `${name} 的脚本缩进无效`);
    return line.slice(10);
  }).join("\n");
  return { block, script };
}

const prepare = step("Prepare Cloudflare config and D1");
const smoke = step("Smoke test deployed login");

check("普通部署不包含数据库重置、全表删除或覆盖账号", () => {
  const destructive = /\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|reset[-_]schema|\bd1\s+(?:delete|restore|time-travel\s+restore)\b|PRAGMA\s+(?:writable_schema|foreign_keys\s*=\s*(?:OFF|0))/i;
  assert.doesNotMatch(workflow, destructive);
  assert.doesNotMatch(schema, destructive);
  assert.doesNotMatch(prepare.script, /\b(?:INSERT\s+OR\s+REPLACE|REPLACE\s+INTO|DO\s+UPDATE)\b/i);
  assert.doesNotMatch(prepare.script, /python\s+scripts\/hash_password_sql\.py\b/, "部署不得调用会覆盖密码的手动重置入口");
  assert.match(prepare.script, /d1 execute DB --remote --file=migrations\/0001_init\.sql/);
  assert.match(prepare.script, /WHERE NOT EXISTS \(SELECT 1 FROM users WHERE role = 'admin'\)/);
  assert.match(prepare.script, /ON CONFLICT\(username\) DO NOTHING/);
  assert.match(prepare.block, /id: database/);
  assert.match(smoke.block, /if: steps\.cloudflare\.outputs\.ready == 'true' && steps\.database\.outputs\.admin_seeded == 'true'/);
  assert.ok(workflow.includes("for f in tests/*.test.mjs"), "部署必须运行新增回归测试");
});

check("部署不打印凭据、SQL seed、响应体或会话 cookie", () => {
  assert.doesNotMatch(workflow, /\b(?:set|bash)\s+-[a-zA-Z]*x|\bset\s+-o\s+xtrace|^\s*(?:printenv|env)\s*$/m);
  assert.doesNotMatch(workflow, /\b(?:cat|tee|head|tail)\s+[^\n]*(?:seed-admin(?:-result)?\.(?:sql|json)|(?:login|session)-response\.json|login-cookies\.txt)/);
  assert.doesNotMatch(smoke.script, /\bcurl\b[^\n]*(?:--verbose|--trace|-v\b)/);
  for (const line of workflow.split("\n")) {
    if (!/^\s*(?:echo|printf)\b/.test(line)) continue;
    if (!/\$\{?(?:APP_ADMIN_(?:USERNAME|PASSWORD)|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|LLM_API_KEY|payload)\b/.test(line)) continue;
    assert.match(line, /\|\s*npx --yes wrangler@latest pages secret put \w+ --project-name=boiler-tube-lifecycle-system\s*$/, "敏感值只能经 stdin 传入 secret put，不能写入日志");
  }
  assert.match(prepare.script, /--file=seed-admin\.sql --json > seed-admin-result\.json 2>&1/);
  for (const script of [prepare.script, smoke.script]) {
    assert.match(script, /umask 077/);
    assert.match(script, /trap 'rm -f [^']+' EXIT/);
  }
});

check("实际部署与 smoke 脚本的 Bash 语法有效", () => {
  for (const script of [prepare.script, smoke.script]) {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8", cwd: root });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});

// Run the actual workflow shell against SQLite and offline command stubs. All
// generated files live in a system temp directory; no Wrangler, network or dist
// synchronization command is executed by this test. Python is already used in CI.
const exerciseDeployment = String.raw`
import base64
from contextlib import closing
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile

config = json.load(sys.stdin)
root = pathlib.Path(config["root"])
schema = (root / "migrations/0001_init.sql").read_text(encoding="utf-8")
password = "existing-admin-password"
seed_password = "bootstrap-password-'private"
seed_username = "first'admin"

stub = r'''
import json
import os
import pathlib
import sqlite3
import sys

tool, *args = sys.argv[1:]
with open("commands.jsonl", "a", encoding="utf-8") as log:
    log.write(json.dumps([tool, args]) + "\n")
if tool == "curl":
    endpoint = args[-1].rsplit("/", 1)[-1]
    assert endpoint in ("login", "session"), args
    if endpoint == "login":
        payload = json.loads(args[args.index("-d") + 1])
        assert payload == {"username": os.environ["APP_ADMIN_USERNAME"], "password": os.environ["APP_ADMIN_PASSWORD"]}
        pathlib.Path(args[args.index("-c") + 1]).write_text("private-session-cookie")
    else:
        assert pathlib.Path(args[args.index("-b") + 1]).read_text() == "private-session-cookie"
    pathlib.Path(args[args.index("-o") + 1]).write_text("private-" + endpoint + "-response")
    print(os.environ.get("STATUS_" + endpoint.upper(), "200"), end="")
    raise SystemExit(0)
assert tool == "npx" and args[:2] == ["--yes", "wrangler@latest"], args
args = args[2:]
info = {"name": "boiler_tube_lifecycle_management_system", "uuid": "b184c2f1-1111-4444-8888-abcdef123456"}
if args == ["d1", "list", "--json"]:
    print(json.dumps([] if os.environ.get("NEW_DATABASE") else [info]))
elif args == ["d1", "create", info["name"]]:
    print(json.dumps(info))
elif args == ["pages", "project", "create", "boiler-tube-lifecycle-system", "--production-branch=main"]:
    pass
else:
    assert args[:3] == ["d1", "execute", "DB"] and "--remote" in args, args
    db = sqlite3.connect("database.sqlite")
    db.execute("PRAGMA foreign_keys = ON")
    db.row_factory = sqlite3.Row
    files = [arg.removeprefix("--file=") for arg in args if arg.startswith("--file=")]
    if files:
        assert files in (["migrations/0001_init.sql"], ["seed-admin.sql"]), files
        sql = pathlib.Path(files[0]).read_text(encoding="utf-8")
        if files == ["seed-admin.sql"] and os.environ.get("SEED_FAILURE"):
            # A CLI error can echo generated SQL; the workflow must suppress it.
            print(sql)
            print(sql, file=sys.stderr)
            raise SystemExit(1)
        if files == ["seed-admin.sql"] and os.environ.get("CONCURRENT_ADMIN"):
            db.execute("INSERT INTO users (username, role, password_hash, salt, iterations) VALUES ('concurrent-admin', 'admin', 'preserve-hash', 'preserve-salt', 100000)")
            db.commit()
        before = db.total_changes
        db.executescript(sql)
        # Remote --file returns import-summary rows and meta.changes, not SQL
        # RETURNING rows. Include SQL to detect accidental logging as well.
        print(json.dumps([{"success": True, "results": [{"Total queries executed": 1}], "meta": {"changes": db.total_changes - before}, "query": sql}]))
    else:
        commands = [arg.removeprefix("--command=") for arg in args if arg.startswith("--command=")]
        assert len(commands) == 1 and commands[0].startswith("SELECT COUNT(*) AS admin_user_count FROM users WHERE role = 'admin'"), args
        result = [dict(row) for row in db.execute(commands[0])]
        print(json.dumps([{"success": True, "results": [] if os.environ.get("BAD_COUNT") else result}]))
    db.close()
'''

with tempfile.TemporaryDirectory(prefix="deployment-data-preservation-") as temp:
    base = pathlib.Path(temp)
    stub_path = base / "commands.py"
    stub_path.write_text(stub, encoding="utf-8")

    def fixture(name, users=(), initialized=True):
        work = base / name
        (work / "scripts").mkdir(parents=True)
        (work / "migrations").mkdir()
        for script in ("resolve_d1_id.py", "hash_password_sql.py"):
            shutil.copyfile(root / "scripts" / script, work / "scripts" / script)
        (work / "migrations/0001_init.sql").write_text(schema, encoding="utf-8")
        if initialized:
            with closing(sqlite3.connect(work / "database.sqlite")) as db:
                db.executescript(schema)
                db.execute("INSERT INTO app_kv VALUES (?, ?, ?)", ("inspection-records", '{"records":[{"tube":"A-01","thickness":4.2}]}', "2025-01-01 00:00:00"))
                for username, role in users:
                    salt = base64.b64encode(os.urandom(16)).decode("ascii")
                    digest = base64.b64encode(hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), 100000)).decode("ascii")
                    db.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", (username, role, digest, salt, 100000, "2025-01-01 00:00:00", "2025-01-02 00:00:00"))
                    db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", ("session-" + username, username, "2099-01-01 00:00:00", "2025-01-02 00:00:00"))
                db.commit()
        return work

    def snapshot(work):
        with closing(sqlite3.connect(work / "database.sqlite")) as db:
            db.row_factory = sqlite3.Row
            return {table: [dict(row) for row in db.execute("SELECT * FROM " + table + " ORDER BY 1")] for table in ("app_kv", "users", "sessions")}

    def run(work, kind="prepare", username=seed_username, secret=seed_password, **extra):
        output = work / "github-output.txt"
        output.write_text("")
        (work / "commands.jsonl").write_text("")
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "DEPLOY_TEST_STUB": stub_path.as_posix(), "GITHUB_OUTPUT": output.as_posix(), "APP_ADMIN_USERNAME": username, "APP_ADMIN_PASSWORD": secret, "CLOUDFLARE_API_TOKEN": "private-cloudflare-token", "CLOUDFLARE_ACCOUNT_ID": "private-cloudflare-account", **extra}
        prelude = 'npx() { python "$DEPLOY_TEST_STUB" npx "$@"; }\ncurl() { python "$DEPLOY_TEST_STUB" curl "$@"; }\n'
        result = subprocess.run(["bash", "-c", prelude + config[kind]], cwd=work, env=env, encoding="utf-8", capture_output=True, timeout=30)
        logs = result.stdout + result.stderr
        for value in (seed_password, password, "private-cloudflare-token", "private-cloudflare-account", "private-session-cookie", "private-login-response", "private-session-response"):
            assert value not in logs, "Sensitive data leaked to deployment logs"
        for name in ("seed-admin.sql", "seed-admin-result.json", "login-response.json", "session-response.json", "login-cookies.txt"):
            assert not (work / name).exists(), "Credential file was not cleaned up: " + name
        calls = [json.loads(line) for line in (work / "commands.jsonl").read_text().splitlines()]
        return result.returncode, output.read_text(), calls, logs

    fresh = fixture("fresh", initialized=False)
    code, output, calls, logs = run(fresh, NEW_DATABASE="1")
    assert code == 0, logs
    assert output.splitlines() == ["admin_seeded=false", "admin_seeded=true"]
    assert any(args[2:4] == ["d1", "create"] for _, args in calls)
    seeded = snapshot(fresh)
    assert seeded["app_kv"] == [] and seeded["sessions"] == []
    assert len(seeded["users"]) == 1 and seeded["users"][0]["username"] == seed_username
    seed_record = seeded["users"][0]
    assert seed_record["role"] == "admin" and seed_record["password_hash"] not in logs and seed_record["salt"] not in logs
    # Repeated schema application and stale/bootstrap secrets must not rotate passwords.
    for username, secret in ((seed_username, seed_password), (seed_username, "stale-bootstrap-password"), ("different-admin", "short")):
        code, output, calls, logs = run(fresh, username=username, secret=secret)
        assert code == 0 and output.strip() == "admin_seeded=false", logs
        assert snapshot(fresh) == seeded
        assert not any("--file=seed-admin.sql" in args for _, args in calls)

    existing = fixture("existing", (("original-admin", "admin"), ("operator", "user")))
    original = snapshot(existing)
    for username, secret in (("original-admin", "replacement-password"), ("different-admin", seed_password), ("", ""), ("original-admin", ""), ("", seed_password), (" \t", seed_password), ("original-admin", " \t")):
        code, output, calls, logs = run(existing, username=username, secret=secret)
        assert code == 0 and output.strip() == "admin_seeded=false", logs
        assert snapshot(existing) == original, "Business data, users or active sessions changed on redeploy"
        assert not any("--file=seed-admin.sql" in args for _, args in calls)

    collision = fixture("collision", ((seed_username, "user"),))
    before = snapshot(collision)
    code, output, calls, logs = run(collision)
    assert code == 0 and output.strip() == "admin_seeded=false", logs
    assert snapshot(collision) == before, "Bootstrap must not promote or overwrite an existing username"

    partial = fixture("partial", (("operator", "user"),))
    before = snapshot(partial)
    code, output, calls, logs = run(partial)
    after = snapshot(partial)
    assert code == 0 and output.splitlines()[-1] == "admin_seeded=true", logs
    assert after["app_kv"] == before["app_kv"] and after["sessions"] == before["sessions"]
    assert [row for row in after["users"] if row["username"] == "operator"] == before["users"]

    concurrent = fixture("concurrent")
    code, output, calls, logs = run(concurrent, CONCURRENT_ADMIN="1")
    assert code == 0 and output.strip() == "admin_seeded=false", logs
    assert [row["username"] for row in snapshot(concurrent)["users"]] == ["concurrent-admin"], "The SQL guard must handle an admin created after the preflight count"

    for flag in ("SEED_FAILURE", "BAD_COUNT"):
        failure = fixture(flag)
        before = snapshot(failure)
        code, output, calls, logs = run(failure, **{flag: "1"})
        assert code != 0 and "admin_seeded=true" not in output
        assert "INSERT INTO users" not in logs, "CLI SQL diagnostics leaked"
        assert snapshot(failure) == before

    no_secrets = fixture("fresh-no-secrets", initialized=False)
    code, output, calls, logs = run(no_secrets, username="", secret="", NEW_DATABASE="1")
    assert code == 0 and output.strip() == "admin_seeded=false", logs
    assert snapshot(no_secrets) == {"app_kv": [], "users": [], "sessions": []}
    assert "first installation still needs an admin" in logs

    smoke_dir = fixture("smoke", initialized=False)
    for username, secret in (("", ""), (seed_username, ""), ("", seed_password), (" \t", seed_password), (seed_username, " \t")):
        code, output, calls, logs = run(smoke_dir, "smoke", username=username, secret=secret)
        assert code == 0 and calls == [], "Missing seed secrets must never trigger login requests"
    for login_status, session_status in (("200", "200"), ("401", "200"), ("200", "401")):
        code, output, calls, logs = run(smoke_dir, "smoke", STATUS_LOGIN=login_status, STATUS_SESSION=session_status)
        assert (code == 0) == (login_status == session_status == "200"), logs
        assert len(calls) == (1 if login_status != "200" else 2)
        assert all(tool == "curl" for tool, _ in calls)

    print(json.dumps({"seedRecord": seed_record, "oldRecord": next(row for row in original["users"] if row["role"] == "admin")}))
`;

check("离线执行真实 workflow，保护检修数据、已有用户和会话并验证 seed/smoke 分支", async () => {
  const result = spawnSync("python", ["-c", exerciseDeployment], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ root, prepare: prepare.script, smoke: smoke.script }),
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { seedRecord, oldRecord } = JSON.parse(result.stdout);
  assert.ok(await verifyPassword("bootstrap-password-'private", seedRecord), "首次 seed 必须兼容实际登录密码校验");
  assert.ok(await verifyPassword("existing-admin-password", oldRecord), "缺少 seed secrets 不能使旧管理员密码失效");
  assert.ok(!await verifyPassword("replacement-password", oldRecord), "普通部署不能替换已有密码");
});

for (const [name, fn] of checks) {
  await fn();
  console.log("ok - " + name);
}
console.log("ok - deployment data preservation: " + checks.length + "/" + checks.length + " checks passed");
