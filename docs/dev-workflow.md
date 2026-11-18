# 开发与发布约定

> 本项目是无构建的静态站点：源码即产物，`dist/` 由脚本生成。
> 这份文档记录几条**必须遵守**的约定，避免出现"改了没生效 / 线上跑旧代码"这类难查的问题。

## 1. 改完源码必须同步 dist

```bash
node scripts/sync-dist.mjs          # 同步：复制改动 + 清理 dist 中已删除的文件
node scripts/sync-dist.mjs --check  # 只检查，有漂移时退出码 1（CI/提交前用）
```

同步范围（与 `.github/workflows/deploy-cloudflare-pages.yml` 一致，CI 直接调用本脚本）：

| 源 | 目标 |
| --- | --- |
| `炉管全生命周期管理系统.html` | `dist/index.html` |
| `login.html` | `dist/login.html` |
| `assets/**` | `dist/assets/**` |
| `_headers` | `dist/_headers` |
| `_routes.json` | `dist/_routes.json` |

为什么必须做：`tests/release-artifacts.test.mjs` 会逐字节比对 `dist` 与源码，部署工作流也会校验文件存在性。
手工 `cp` 漏一次，症状是"本地好好的，线上还是旧代码"，极难定位。

## 2. 提交前自检

```bash
node scripts/sync-dist.mjs --check
for t in tests/*.test.mjs; do node "$t" || break; done   # 包含超温模块与既有回归
python tests/run-assistant-browser.py                    # 真实 Edge 冒烟（7 项）
```

## 3. 模型配置的唯一真相是 localStorage

`boiler_llm_config` 是配置真相，表单只是编辑缓冲：

| 函数 | 用途 | 是否读 DOM |
| --- | --- | --- |
| `readLLMConfigFromStorage()` | 读已保存配置（含 `models` 列表） | 否 |
| `getLLMConfig()` | 业务逻辑判断"是否已配置" | 否 |
| `getLLMFormConfig()` | 面板内操作（识别模型、测试连接），允许使用未保存的输入 | 是 |
| `saveLLMConfig()` | 表单 → 存储 | 是（写入） |

**新增功能时不要用 `getLLMConfig()` 去读表单**——这正是之前"刷新后误判未配置"的根因。
INIT 时 `loadLLMConfigToForm()` 负责回填表单并刷新 `#llm-status` 状态文案。

## 4. AI 输出必须可追溯

两条链路、两种处理方式，但都不能让模型数字裸奔：

| 链路 | 处理方式 | 实现 |
| --- | --- | --- |
| 助手分析卡片 | **接地过滤**：结论必须引用给定向数据，否则整条丢弃并计数 | `parseModelAnalysis` / `isGrounded` |
| 页面深度分析、单管综合分析 | **数值审计**：只提示不改写，列出无本地依据的数值 | `auditLLMText` → `auditNumericClaims` |

审计只认「带小数或带计量单位」的数值（5.55mm、168HB、82%），建议里的纯数量（12 根）不报，
否则提示会被忽略。新增任何调用大模型的入口，都要接一次审计。

## 5. 多设备并发与覆盖保护

业务数据是 `localStorage` 缓存 + KV 云端，云端写入是整包覆盖，所以分两层防护。

### 5.1 启动载入（`bootstrapCloudStorage()`）

- 每次 `saveDB()` 会写 `boiler_user_db_local_at`（本机最后写入时间）。
- 启动时比较云端 `updated_at` 与本机时间：
  - 本机更新（`localAt > remoteAt + 2s`）：**保留本机**，排队上传，提示"本机数据比云端新"。
  - 云端更新：先把本机数据备份到 `boiler_user_db_backup`（材料库同理备份到
    `boiler_material_library_backup`），再载入云端版本，并在「维护记录」留一条系统日志。

### 5.2 页面打开后的并发保存（乐观版本 + 并集合并）

启动比较只管载入那一刻；页面打开后两端同时编辑必须另有机制：

- `PUT /api/storage/<key>` 支持可选 `baseUpdatedAt`，服务端与 `app_kv.updated_at` 精确比对，
  不匹配返回 `409 { error: 'conflict', updatedAt }`；不传则保持旧的**无条件写入**（其他键兼容）。
- 前端 `cloudStorageWrite()` / `saveCloudValueWithMerge()`：业务键
  （`boiler_user_db`、`boiler_material_library`、`boiler_design_drawings_meta`）带版本写入，
  冲突后拉取云端值、按业务键**并集合并**（同键保留本机），写回本地并重试，最多 3 次。
  - 事件：优先 `sourceId`，其次 `ts`，最后内容键；更换：`ts` 或旧码+新码+日期+原因。
  - 材料库：`materialKey()`；图纸：`id`。
  - 合并结果写入「维护记录」系统日志并 toast 提示"云端新增 N 条 / 同键冲突 M 条保留本机"。
  - 连续冲突仍失败时保留本机数据并提示导出备份后刷新，**绝不静默覆盖**。
- 说明：这是并集，不做删除传播——本机删除的记录可能在下次合并时被云端副本带回，
  这是"不丢记录"优先的既定取舍。

### 5.3 大值分块（`/api/storage/[key]`）

单张图纸上限 4MB，base64 后远超 D1 单条 SQL 100KB 语句上限，所以对大值按 UTF-8 字节分块：

- 分块行键 `key#v<gen>#pNNN`，主行存 `{__chunked,parts,size,gen}`；
- 写入顺序：先完整写入新代次分块 → 再原子切换主行指针 → 成功后清理旧代次；
  任一分块批次失败只删本代次，旧值仍可读；
- GET 同时兼容新格式与历史 `key#pNNN`，缺块返回 500，不拼半截值；
- 客户端键字符集中 `#` 保留给分块命名空间；
- `tests/storage-chunking.test.mjs` 覆盖往返、清理、缺块、条件冲突、跨批次失败与并发写入。

### 5.4 受热面图纸（元数据 / 内容分离）

- 元数据键 `boiler_design_drawings_meta`（不含 base64），内容键 `boiler_drawing_content:<id>`。
- 启动只拉元数据；旧键 `boiler_design_drawings` 仅在元数据键缺失时读取一次并逐张迁移，
  全部内容上传成功后才写元数据、清理本机旧键。
- 列表缩略图由 `IntersectionObserver` 按需拉取内容；查看器先校验 data URL 为
  `image/png|jpeg|webp` 或 `application/pdf`，再用 Blob URL 渲染。
- 元数据经 `normalizeDrawingMeta()` 校验（id 字符集/长度、类型、字符串截断）后才进入界面；
  卡片改用 `data-drawing-*` 事件委托，不再拼接内联 `onclick`。
- 上传只有在内容键与元数据都确认成功后才提示"已保存"；改名/删除失败回滚并提示。

### 5.5 跨设备读取速度（缩略图 / 存在性探测）

- 图纸内容按 id 不可变，而列表卡片只有 130px 高：上传时用 canvas 生成 480px、JPEG 0.72 的缩略图，
  单独存 `boiler_drawing_thumb:<id>`，列表每张卡只下 30–60KB，而不是整份最多 4MB 的原图。
- 进入图纸视图只预载**缩略图**（3 路并发）；原图不再随视图预载——一个系统二三十张图就是上百 MB。
- 查看器先用缩略图占位，原图到达后替换成完整内容；上线前上传的历史图纸没有缩略图，
  在首次打开原图时补生成并回传云端，下次进列表就快了。
- PDF 卡片只显示图标，不下载内容；缩略图键 `Cache-Control: private, max-age=604800`，内容键 1 天。
- `GET /api/storage/<key>?probe=1` 只回存在性与 `updatedAt`（`no-store`）。「同步到云端」用它逐张探测，
  避免为了确认“云端有没有”把整批原图重下一遍；缩略图则只用手头已有内容补齐，不额外下载。

### 5.6 “清理本机缓存”

`clearLocalData()` 只删 `boiler_user_db` / `boiler_user_db_local_at` / `boiler_user_db_backup`，
**不调用 `saveDB()`、不排队上传空库**；已登录云端时提示后刷新重新载入，未登录时明确告知无法恢复。
`tests/local-clear.test.mjs` 锁定该行为。


## 6. 超温模块的共享存储与验证

温度数据独立于上述 KV：`/api/temperature/…` 使用 D1 行级记录、乐观版本号和幂等请求 ID。不要调用 `saveDB()` 保存温度记录，也不要把本机草稿当作共享成功。配置版本只追加，更正/作废必须保留操作原因和审计前后值。

- 数据库初始化顺序为 `0001_init.sql`、`0002_temperature.sql`；CI 已显式执行两份文件。新增迁移时必须同步更新部署与保留数据测试，不能只新增 SQL。
- `overtemperature-core-v1.js` 是前后端共用的纯逻辑；编码归一复用 `assistant-core-v1.js`。温度矩阵镜像的结构与主 `matrix` 由测试校验，编码规则变动时应同步更新。
- 原始温度观察不产生时长；已核定超温区间按 `[startAt,endAt)` 合并，未结束事件不计入累计；统计窗口、限值版本及换管边界都要测试。
- 本机静态预览没有共享 API。验证共享能力应使用本地 D1 或隔离 SQLite 测试适配器；不得把模拟接口通过描述为真实云端部署完成。
- 运行 `node tests/overtemperature-core.test.mjs`、`node tests/overtemperature-api.test.mjs`、`node tests/overtemperature-evidence.test.mjs` 和 UI 接线测试；再同步 `dist` 并执行全量回归。
- 测试仅使用明确标注的合成测点和记录，不向生产数据库或用户业务库写验收数据。

## 7. 模块加载与缓存策略

首屏只加载核心模块，其他模块严格按用户操作加载（实现：`assets/app/lazy-v1.js`）：

| 时机 | 模块 |
| --- | --- |
| 首屏 `defer` | `lazy-v1.js`、`app-v7.9.js`、`maintenance-log-v1.js`、`ui-shell-v8.js`、`theme-toggle-v1.js`、`xlsx-export-v1.js`、`report-pro-v1.js` |
| 首屏编码领域核心 | `assistant-core-v1.js`，供编码归一/校验使用；懒加载器复用已就绪核心 |
| 点击助手或分析刷新 | AI 助手界面与分析模块 |
| 打开超温分析/温度证据 | 超温领域、界面与证据模块 |
| 点击超温导入 | `overtemperature-import` 组的导入解析模块 |
| 首次使用时加载 | SheetJS（Excel 导入/导出）、pdf.js（PDF 识别） |

约定：

- 新增助手/超温模块，必须登记到 `lazy-v1.js` 的 `GROUPS` 清单；顺序就是加载顺序，
  `assistant-core` 必须排在最前、`assistant-v1`（接线层 mount）排在最后，
  `overtemperature-core` 加载时会校验 `assistant-core` 已存在（否则抛错）。
- 新增内联 `onclick` 引用的全局函数，不能放在懒加载模块里；否则首次点击可能 ReferenceError。
  确需懒加载时，在 `switchView()` 或对应入口先用 `BTLazy.ensure(...)` 确保就绪。
- `tests/lazy-loader.test.mjs` 校验依赖顺序、按需注入、失败重试与零后台预载；`BTLazy.idle()`仅保留兼容空入口。
- `tests/performance-cache.test.mjs` 验证历史索引、分页结果复用和保存/云同步/原地编辑后的缓存失效；耗时测试不替代浏览器网络与绘制验证。

缓存与路由（`_headers` / `_routes.json` 是源码文件，由 sync-dist 复制进 dist）：

- `/assets/*` 走纯静态边缘服务，不再经过 `functions/_middleware.js`（登录态下也不查 D1）。
  浏览器缓存 `max-age=300, stale-while-revalidate=86400`：5 分钟内零请求，之后后台校验。
- **修改 `assets` 文件内容时建议递增文件名版本**（如 `app-v7.9.js` → `app-v8.0.js`）。
  版本号变化会立即击穿缓存；不递增则最多有 5 分钟的旧副本窗口。
- 入口页 `no-cache`，发版即时生效；`_routes.json` 只把 `/`、`/login*`、`/api/*` 交给 Functions，
  新增需要登录保护的页面路径时必须同步加入 `include`。
