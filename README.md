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
- **编码生成**：按现行编码规则 `{机组}G-SYS-COMP-{位置段…}-Q/W`（字母尾，不带流水号）自动生成炉管部件编码；
  悬挂屏（高过/后屏/大屏）按统一回路编号：入口段 F00k、出口段 B00k、底弯 W 记入口段位 F00k-W（12/13/14 回路）。
  完整规则见下方「编码规则（现行口径）」章节
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

## 编码规则（现行口径）

```
编码规则：{机组}G-SYS-COMP-{位置段…}-{Q|W}
（Q=管子，W=弯头；部位尾为字母，不带流水序号——位置段已唯一确定物理部位；
历史数字尾如 -Q001/-W16 在导入、录入、编辑时自动归一为字母尾）

1、机组前缀：1号机用1G，2号机用2G。
2、系统码（SYS）：水冷壁 SLB，高温再热器 GZRQ，高温过热器 GGRQ，后屏过热器 HPGRQ，
   全大屏过热器 DPGRQ，低温过热器 DGRQ，低温再热器 DZRQ，省煤器 SMQ。
3、部件码（COMP）：管屏 GQ，水冷壁管 WB，燃烧器区域 RSQ，冷灰斗 LHD，
   省煤器蛇形管 SG，省煤器进口集箱 EXIN，省煤器出口集箱 EXOUT。
4、方位/方向：A侧→R，B侧→L；炉左往右→L，炉右往左→R；炉前往后→F，炉后往前→B；
   下往上→D，上往下→U。
   规范方向：受热面屏/片号一律落 L（炉左起算）；源记录的 A侧R屏号由系统按屏数自动镜像
   （高过32屏：R001≙L032；高再64片：R001≙L064）。方向不明不得臆造字母，保持原样进「待确认」。
5、统一回路编号（悬挂屏：高过/后屏/大屏）：回路k = 入口段F00k（顶入口向下）+ 底弯W(F00k-W)
   + 出口段B00k（向上至顶出口）。管号即回路号；底弯W统一记入口段位 F00k-W。
   旧腿号F013–F024按回路号自动迁移：管号 n > 回路数 N 时按 2N+1−n 归回路号
   （W落入口段位，Q换对侧腿B）。高过12回路、后屏13回路、大屏14回路。
6、占位：水冷壁/冷灰斗无排屏号概念，墙位段固定为 F000/B000/L000/R000。
   低过/低再未指明检修空间时默认第1空间、1KJ可省略。
7、各受热面位置段：
   全大屏过热器：{机组}G-DPGRQ-GQ-{片号L001–L006}-{小屏号F001–F004}-{F|B}{回路号001–014}-Q/W
       小屏号台账固定按炉前起算 F001–F004；现场炉后起算的 B001–B004 自动镜像为 F004–F001。
       示例：1G-DPGRQ-GQ-L001-F002-F007-Q（1号炉大屏第1片第2小屏回路7入口段）
   后屏过热器：{机组}G-HPGRQ-GQ-{屏号L001–L021}-{F|B}{回路号001–013}-Q/W
       示例：1G-HPGRQ-GQ-L010-F001-Q（第10屏回路1入口段）、…-B001-Q（回路1出口段）
   高温过热器：{机组}G-GGRQ-GQ-{屏号L001–L032}-{F|B}{回路号001–012}-Q/W
       示例：1G-GGRQ-GQ-L002-F004-W（第2屏回路4底弯）、1G-GGRQ-GQ-L002-B004-Q（回路4出口段）
   高温再热器：{机组}G-GZRQ-GQ-{片号L001–L064}-F00{1–7}-Q/W
       （每屏7根，炉前至炉后计数；现场按炉后起算记录的B管位保留原方向不换算）
   省煤器：{机组}G-SMQ-SG|EXIN|EXOUT-{排号L001–L124}-U|D001-Q/W
       （蛇形管/进口集箱/出口集箱，每排上下单管，U=下往上、D=上往下）
   低温再热器：{机组}G-DZRQ-GQ-{1–6KJ}-{L|R}{排号L001–L112}-{D|U}{001–006}-Q/W
       6根管圈自下而上 D001–D006；出口垂直段每两排合并为一排（56片），仍按水平段排号标识；管号可省略到排。
       示例：1G-DZRQ-GQ-4KJ-L065-Q（取样记录，第4空间第65排）
   低温过热器：{机组}G-DGRQ-GQ-{1–5KJ}-{L|R}{排号L001–L112}-{D|U}{001–005}-Q/W
       排号沿烟道宽度 L001–L112；5根蛇形管自下而上 D001–D005；反方向 R/U 由系统镜像归一。
       省略空间时按第1空间处理。示例：1G-DGRQ-GQ-2KJ-L045-D003-Q（第2检修空间第45排自下而上第3根）
   水冷壁管（WB）：{机组}G-SLB-WB-{F000|B000|L000|R000}-{方向}{三位管号}-Q
       前墙/后墙管号 R/L 001–192；左墙（B侧）/右墙（A侧）管号 F/B 001–169。
       示例：2G-SLB-WB-F000-R025-Q（2号炉水冷壁前墙，炉右往炉左数第25根，割管取样）
   燃烧器区域（RSQ）：{机组}G-SLB-RSQ-J{角号1–4}-{喷口层A–F}{喷口序号1–8}-Q
       示例：1G-SLB-RSQ-J2-C3-Q
   冷灰斗（LHD）：{机组}G-SLB-LHD-{F000|B000}-{L|R}{001–096}-Q
       示例：2G-SLB-LHD-F000-L016-Q（2号炉前坡冷灰斗，炉左往炉右数第16根）
8、唯一性与幂等：同一编码在不同年份出现多条记录=同一部位历年复检，正常；
   同回路底弯双侧拍摄各计一条（按来源ID区分）。带来源ID的记录重导时按来源ID原位更新，
   不产生重复；不带来源ID的手工录入按 编码+日期+内容 查重。
```

> 本节为现行实现的权威口径；调整规则时先改代码与测试，再同步本节。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 原生 HTML/CSS/JS，无构建链；主页面为根目录 `炉管全生命周期管理系统.html` |
| 后端 | Cloudflare Pages Functions（`functions/api/*`：auth / storage / llm / admin） |
| 数据库 | Cloudflare D1（SQLite）：`users` / `sessions` / `app_kv`，见 `migrations/0001_init.sql` |
| 测试 | `tests/*.test.mjs`（Node）+ Python 单测，CI 逐个执行 |

### 加载与缓存策略（首屏优化）

- 首屏只 `defer` 核心模块；AI 助手与超温分析由 `assets/app/lazy-v1.js` 在空闲时预载，用户点开时通常已就绪。
- SheetJS（Excel）与 pdf.js（PDF 识别）**首次使用时才从 CDN 加载**，首屏不再引用这两个库。
- `_routes.json` 让 `/assets/*` 直接走 Cloudflare 静态边缘服务，不再经过 Functions（登录态下每个资源省去一次 D1 会话查询）。
- `_headers` 为静态资源启用 `max-age=300, stale-while-revalidate=86400`，入口页 `no-cache`。
- 修改 `assets` 文件建议递增文件名版本号（如 `app-v7.9.js` → `app-v8.0.js`），可立即击穿缓存；新增模块的登记要求见 [docs/dev-workflow.md](docs/dev-workflow.md)。

## 目录结构

```
├── 炉管全生命周期管理系统.html   # 主页面（部署时复制为 dist/index.html）
├── login.html                   # 登录页
├── _headers                     # Cloudflare Pages 缓存策略（sync-dist 复制进 dist）
├── _routes.json                 # Functions 路由范围：/assets/* 走纯静态
├── assets/app/                  # 样式与各模块 JS（lazy-v1.js 管理按需加载清单）
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
npx wrangler d1 execute DB --local --file=migrations/0002_temperature.sql
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

> **约定**：根目录 HTML、`assets/`、`_headers`、`_routes.json` 是唯一源码真相，改动后必须执行 `node scripts/sync-dist.mjs` 同步 `dist/`；CI 每次部署前会从零重建 `dist/`。详见 [docs/dev-workflow.md](docs/dev-workflow.md)。

## 超温分析（手工登记 / 多设备共享）

在“超温分析”中先建测点，再配置实际生效时间、区域映射及限值依据。测点可批量编号建立，但不会把序号当成管排，也不会从截图自动生成温度或报警限值。

- **温度观察**只证明某一时刻的读数，不累计超温时长。
- **超温区间**必须登记实际起止时间、最高温度及核定依据。温度严格大于已确认限值，且整个区间经人工核定后才计入；未结束事件单列，不按当前时间自动扩展。
- 同测点重叠区间去重；多个关联测点的区域时长取时间并集，不简单相加。筛选窗口采用 `[开始, 结束)`，北京时间（UTC+08:00）；裁剪区间的整段峰值不会冒充窗口内峰值。
- 映射与限值新增版本，不覆盖历史；跨版本区间需拆分。配置不能回溯切入已有记录导致历史归属改变。
- 共享数据使用 D1 独立行级表，与检测事件及整包 KV 分开；并发修改返回冲突，草稿不会自动覆盖云端。更正、作废保留前后值、操作人及原因。
- 管段档案和综合分析显示温度辅助证据。已知换管日期时裁剪当前管统计；未知时只展示区域历史。**温度证据不改变原壁厚预测、剩余寿命或更换判定**，无记录不能解释为正常。

首次启用需在既有 `0001_init.sql` 之后执行 `migrations/0002_temperature.sql`，正常 CI 发布会按顺序执行；两份脚本可重复执行且不清除已有数据。仅静态预览无法保存共享温度记录，页面会说明接口不可用。详细业务口径见 [docs/overtemperature.md](docs/overtemperature.md)。

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
