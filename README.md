# 锅炉炉管全生命周期管理系统

面向电站锅炉受热面炉管的台账、编码、检测数据、AI 分析与检修计划一体化管理平台（当前版本 v8.4）。
无构建纯静态前端 + Cloudflare Pages Functions 后端 + D1 数据库，推送即自动测试并部署。

## 功能特性

**总览监控**

- **总览**：风险驾驶舱，关键指标与风险分布一屏掌握
- **管段综合分析**：接入 AI，综合壁厚、材质、运行工况评估管段状态并可视化
- **检修模块**：检修计划编制与跟踪

**台账与编码**

- **数据录入**：基础信息与检测数据录入，支持批量导入
- **编码生成**：按新编码规则 `{机组}G-SYS-COMP-{方位}{三位排/屏/管号}…-Q{流水号}` 自动生成炉管部件编码
  （机组 1G/2G；系统 SLB/GZRQ/GGRQ/HPGRQ/DPGRQ/DGRQ/DZRQ/SMQ；部件 GQ/WB/SG/EXIN/EXOUT/LHD/RSQ；
  方位 A侧→R、B侧→L、炉左往右→L、炉右往左→R、炉前往后→F、炉后往前→B、下往上→D、上往下→U；
  无明确排/屏号用 000 占位，无明确方向默认 U，低过/低再默认第 1 检修空间可省略）
- **全量台账**：全量记录检索、筛选与 XLSX 导出
- **维护记录**：运行维护日志与系统操作留痕

**设备资料**

- **受热面材料库**：材料全字段行内编辑，顶栏演示数据三态开关
- **集箱库**：集箱设备台账
- **炉管分布图**：炉管位置可视化

**AI 与系统能力**

- 内置 AI 助手：文档识别入库（**图片拍照/截图批量识别**、PDF、Excel/CSV → 清洗 → 确认导入 → 撤销）、综合分析可视化、剩余寿命预测、维护建议
- 图片识别提炼层：多图合并去重、字段规范化（中文日期/单位/全角无损归一）、模型输出 JSON 自动修复、不确定单元格置空待人工核对
- 助手多轮对话：上传的图片/文件在会话内保留（最多 3 条，附件条可视化切换），支持"这张图/第二张图/这个表"指代追问、
  图片内容视觉追问（带多轮上下文）、追问回答不写库；已导入附件再次导入需显式确认，避免重复写库
- AI 输出可追溯：结论接地过滤 + 数值审计，无本地数据依据的模型数字会被标记
- LLM 密钥支持服务端代理（Pages secret）或浏览器本地配置
- 用户名密码登录（PBKDF2），会话存 D1；浅色/深色主题切换
- 业务数据 localStorage 与云端 KV 双写，多设备加载时自动备份防覆盖

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 原生 HTML/CSS/JS，无构建链；主页面为根目录 `炉管全生命周期管理系统.html` |
| 后端 | Cloudflare Pages Functions（`functions/api/*`：auth / storage / llm / admin） |
| 数据库 | Cloudflare D1（SQLite）：`users` / `sessions` / `app_kv`，见 `migrations/0001_init.sql` |
| 测试 | `tests/*.test.mjs`（Node）+ Python 单测，CI 逐个执行 |

## 目录结构

```
├── 炉管全生命周期管理系统.html   # 主页面（部署时复制为 dist/index.html）
├── login.html                   # 登录页
├── assets/app/                  # 样式与各模块 JS
├── functions/                   # Pages Functions（认证、云存储、LLM 代理）
├── migrations/                  # D1 初始化 SQL
├── scripts/                     # dist 同步、密码哈希、D1 ID 解析
├── tests/                       # 测试（提交前与 CI 均执行）
└── dist/                        # 部署产物，由脚本/CI 生成，勿手改
```

## 本地开发

要求：Node.js ≥ 18、Python 3。

```bash
git clone <repository-url>
cd 锅炉炉管全生命周期管理系统
node scripts/sync-dist.mjs      # 生成/同步 dist 产物
```

**完整本地运行**（含登录与云 API，D1 本地模拟）：

```bash
# 1. 项目根创建 wrangler.toml（本地调试用，勿提交）
cat > wrangler.toml <<'EOF'
name = "boiler-tube-lifecycle-system"
compatibility_date = "2026-07-14"
pages_build_output_dir = "dist"

[[d1_databases]]
binding = "DB"
database_name = "boiler_tube_lifecycle_management_system"
database_id = "local"
EOF

# 2. 初始化本地数据库并写入管理员（密码至少 8 位）
npx wrangler d1 execute DB --local --file=migrations/0001_init.sql
python scripts/hash_password_sql.py admin YourPassword123 admin > seed-admin.sql
npx wrangler d1 execute DB --local --file=seed-admin.sql

# 3. 启动本地 Pages 开发服务器
npx wrangler pages dev dist
```

> 若只调前端样式，可用任意静态服务器直接预览 `dist/`，但登录与云 API 不可用。

**提交前自检**：

```bash
node scripts/sync-dist.mjs --check               # dist 必须与源码逐字节一致
for t in tests/*.test.mjs; do node "$t" || break; done
python tests/resolve_d1_id.test.py
python tests/run-assistant-browser.py            # 可选：真实 Edge 冒烟测试
```

> **约定**：根目录 HTML 与 `assets/` 是唯一源码真相，改动后必须执行 `node scripts/sync-dist.mjs` 同步 `dist/`；CI 每次部署前会从零重建 `dist/`。详见 [docs/dev-workflow.md](docs/dev-workflow.md)。

## 部署（Cloudflare Pages）

推送到 `main` 分支即触发 GitHub Actions：运行全部测试 → 重建 `dist/` → 自动创建或复用 D1 数据库（`boiler_tube_lifecycle_management_system`）并执行迁移与管理员 seeding → 部署到 Cloudflare Pages 项目 `boiler-tube-lifecycle-system`。

在仓库 **Settings → Secrets and variables → Actions** 配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare API 令牌（含 Pages / D1 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare 账户 ID |
| `APP_ADMIN_USERNAME` | 建议 | 初始管理员用户名 |
| `APP_ADMIN_PASSWORD` | 建议 | 初始管理员密码（≥ 8 位，PBKDF2 哈希后写入 D1） |
| `LLM_API_KEY` | 否 | AI 服务端代理密钥；不配则需在页面内配置浏览器端密钥 |
| `LLM_BASE_URL` / `LLM_MODEL` | 否 | 自定义模型服务地址与模型名 |

未配置 Cloudflare 密钥时，工作流仅运行测试并跳过部署。部署完成后访问 Pages 分配的域名（或绑定自定义域名）即可登录使用。
