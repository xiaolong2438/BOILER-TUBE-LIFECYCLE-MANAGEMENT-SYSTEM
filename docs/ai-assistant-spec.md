# AI 数据助手 —— 本项目落地方案与接口契约（v1）

> 迁移来源：`D:\\employee-growth-map`（员工成长地图）的「AI 数据助手」。
> 本项目：锅炉炉管全生命周期管理系统（静态 HTML + 原生 JS + Cloudflare Pages Functions + D1）。
> 本文件是并行开发的唯一契约：**先改本文件，再改代码**。

## 0. 目标与边界

在现有系统里新增一个「AI 数据助手」：右下角悬浮入口 + 对话面板，用一句中文完成
**清洗 / 导入 / 导出 / 撤销导入 / 查询 / 统计问答 / 分析可视化 / 单条记录修改 / 帮助**。

结合本项目实际情况的调整（与源项目的差异）：

| 维度 | 源项目（员工成长地图） | 本项目（炉管全生命周期） |
| --- | --- | --- |
| 技术栈 | TypeScript + Vite + vitest | 原生 JS 经典脚本（无构建）+ Node 断言脚本 |
| 数据位置 | 服务端 D1 业务表 | 浏览器 `localStorage` + `/api/storage` KV 云同步 |
| 权限 | viewer / editor / admin（服务端强制） | `/api/auth/session` 的 role（admin / user），本地离线模式视为 editor |
| 数据集 | 员工、证件、技能、绩效、荣誉… | 寿命事件/检测记录、受热面材料库 |
| 大模型 | 服务端 key + 服务端代理 | 复用页面已有的「模型接口配置」（`boiler_llm_config`，浏览器直连） |
| 会话历史 | D1 表 + 跨设备 | `localStorage`（本浏览器），最多 20 个会话 |

**不做的事**（明确边界，避免口径分裂）：
- 不在服务端新增业务写入接口：导入/修改仍复用页面现有的本地 + KV 同步链路。
- 不复制源项目的「维护审批、证件删除」等员工域功能。
- 模型只负责「听懂话」（把自然语言解析成结构化意图 JSON），**执行动作仍由前端校验后完成**。

## 1. 文件与分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 领域（纯函数） | `assets/app/assistant-core-v1.js` | 数据集注册、工具目录、意图解析、查询解析、编辑解析、清洗规则、统计汇总。无 DOM、无 IO、无存储。 |
| 分析（纯函数） | `assets/app/assistant-analysis-v1.js` | 分析意图解析、快照聚合、洞察生成、图表 SVG 渲染。无 DOM、无 IO、无存储；只读不写。 |
| UI（纯渲染 + 面板 DOM） | `assets/app/assistant-ui-v1.js` | i18n 文案渲染函数（返回字符串）+ 面板挂载/事件委托/状态机。只依赖 DOM，不依赖业务。 |
| 接线（编排） | `assets/app/assistant-v1.js` | 读页面全局数据、调用既有导入/导出/修改函数、可选 LLM 解析、会话历史、权限、审计提示。 |
| 样式 | `assets/app/assistant-v1.css` | `assistant-*` 前缀样式，只用 `app-v8.0.css` 已有设计令牌，自动跟随深浅主题。 |
| 既有应用 | `assets/app/app-v7.9.js` | 仅做少量「可复用化」改造：抽出 import 行处理、单字段修改、LLM 原始对话调用、快照/角色读取。 |
| 页面 | `炉管全生命周期管理系统.html` | 追加 1 个 `<link>` 与 3 个 `<script defer>`。 |
| 文档 | `docs/ai-assistant.md` | 使用说明（功能、示例问法、权限、LLM 配置、脱敏、测试命令）。 |

加载顺序（defer，按文档顺序执行）：`app-v7.9.js` → `xlsx-export-v1.js` → `assistant-core-v1.js` → `assistant-analysis-v1.js` → `assistant-ui-v1.js` → `assistant-v1.js`。

### 全局命名（挂到 `window`，经典脚本，无模块系统）

- `window.BTAssistantCore`：领域 API（见 §2）。
- `window.BTAssistantAnalysis`：分析 API（见 §2.10）。
- `window.BTAssistantUI`：渲染与面板 API（见 §6）。
- `window.BTAssistant`：接线后的门面（见 §7），HTML/其它脚本只通过它打开助手。

所有文件用 IIFE 包裹；末尾同时挂 `module.exports`（若存在 `module`）以便 Node 测试：

```js
(function (global) { 'use strict'; /* ... */ global.BTAssistantCore = api; if (typeof module !== 'undefined' && module.exports) module.exports = api; })(typeof window !== 'undefined' ? window : globalThis);
```

## 2. 领域层 `BTAssistantCore`

### 2.1 数据集（可导入）

```js
// 导入数据集类型
type AssistantDatasetType = "events" | "material_library" | "unknown";
```

注册表字段：`{ type, label, keywords: string[], headers: string[], requiredHeaders: string[], businessKey: string[], dateColumns: string[], typeColumn?: string }`。

- `events`：寿命事件 / 检测记录（页面「数据录入」的 CSV 模板，11 列）。
  - 列：`数据分类,炉号,日期,管段编码,规格,材质,厚度(mm),硬度(HB),事件类型/更换原因,关联新管码,详细描述/结论`
  - 必需列（表头级）：`日期`、`管段编码`（别名见下）。
  - 行级必需：`日期` 与 `管段编码` 非空；`数据分类=更换` 时还要求 `关联新管码` 非空。
- `material_library`：受热面材料库（`MATERIAL_COLUMNS` 12 列）。
  - 行级必需：`部件名称`、`规格型号`、`材质`（与 `importMaterialCSV` 的 `if(!component || !spec || !material) continue` 对齐）。

表头别名（大小写/全角/空格不敏感，比较前先 `normalizeText`）：
`日期`←日期/检测日期/时间/date；`管段编码`←管段编码/管码/编码/管段编号/code；`炉号`←炉号/机组/boiler；
`规格`←规格/规格型号/spec；`材质`←材质/材料/material；`厚度(mm)`←厚度(mm)/厚度/壁厚/实测壁厚/thickness；
`硬度(HB)`←硬度(HB)/硬度/hardness；`事件类型/更换原因`←事件类型/更换原因/事件类型/类型/检测类型；
`关联新管码`←关联新管码/新管码/新管段编码；`详细描述/结论`←详细描述/结论/详细描述/详细数据/结论/描述/备注。

### 2.2 工具目录

```js
type AssistantToolName =
  | "assistant.clean" | "data.import" | "data.export" | "data.query"
  | "data.edit" | "data.stats" | "data.analyze" | "data.undo" | "assistant.help";
type AssistantToolRole = "viewer" | "editor" | "admin";
```

| 工具 | minRole | requiresConfirm | runnableWithoutFile |
| --- | --- | --- | --- |
| assistant.clean | viewer | false | false |
| data.import | editor | true | false |
| data.export | viewer | false | true |
| data.query | viewer | false | true |
| data.edit | editor | true | true |
| data.stats | viewer | false | true |
| data.analyze | viewer | false | true |
| data.undo | editor | true | true |
| assistant.help | viewer | false | true |

```js
toolCatalog(): AssistantToolSpec[]
toolsForRole(role): AssistantToolSpec[]
requiredRole(tool, datasetType?) : AssistantToolRole
toolRank(role): number        // viewer=1, editor=2, admin=3
roleLabel(role): string       // 只读 / 编辑 / 管理员
```

### 2.3 意图解析

```js
parseIntent(message, context) => {
  intent: "clean"|"import"|"export"|"query"|"edit"|"stats"|"analyze"|"undo"|"help"|"unknown",
  datasetType: "events"|"material_library"|"unknown",
  tool: AssistantToolName,
  params: {                    // 只放执行参数；没有的键不出现
    datasetType?, expectHeader?, exportScope?: "current_filter"|"all", format?: "csv"|"xlsx",
    queryDataset?, note?
  },
  confidence: number,          // 0~1
  reply: string,               // 中文回复
  source: "rules"|"llm",
  needsFile: boolean,
  needsConfirm: boolean
}

context = {
  role, currentView?, activeDatasetType?, fileName?, headers?: string[],
  hasPendingFile?: boolean, hasPendingRows?: boolean
}
```

规则：中文关键词打分（`权重 3=明确动作 / 2=常见说法 / 1=弱线索`），同分按下表优先级取更「危险」的一侧：
`undo > clean > export > import > edit > query > analyze > stats > help > unknown`。
「改成/改为/更正为/应该是」等搭配字段词才算 edit；「多少/几条/统计/概览」算 stats；
「导出/下载/另存为」算 export（但「下载模板」不算）；「导入/入库/录入」算 import；
「清洗/检查/能不能导入/去重」算 clean；「帮助/怎么用/能做什么」算 help。
「趋势/走势/分布/排行/排名/对比/比较/相关性/散点/画像/图表/可视化/异常值」等强分析词出现时，
即使句子里同时有「统计/多少」，也优先判为 analyze（强分析词额外计 6 分）；但出现「导出/下载/另存为」时不做分析判定，仍走 export。
任何输入都不抛异常；识别不到返回 `intent:"unknown"` + 引导性 `reply`（列 3 条示例）。
角色不足时仍返回意图，但 `reply` 明确「需要编辑权限」。

### 2.4 清洗

```js
cleanRows(input) => { report, cleanRows, preview }
input = {
  rows: string[][],                  // 含表头，第一行为表头
  fileName?, sheetName?,
  datasetType?,                      // 不传则自动识别
  knownCodes?: string[],             // 已录入过的管段编码（可选，用于提示「新管码」）
  retiredCodes?: string[],           // 已报废管码（可选）
  matrixRows?: Array<{sys, zone, pMin, pMax, tMin, tMax}>, // 台账矩阵（可选，用于编码范围校验）
  units?: string[]                   // 默认 ["1","2"]
}
report = {
  datasetType, fileName, sheetName,
  summary: { totalRows, cleanRows, issueCount, duplicateRows, errorCount, warningCount, importable },
  checks: [{ id, severity:"info"|"warning"|"error", title, detail, rows: number[], suggestion?, sample?: string[] }],
  normalizations: string[],
  rowIndexes: number[]               // rowIndexes[i] 对应 cleanRows[i+1] 的原始数据行号（1 基）
}
```

检查项 id：`missing_required | invalid_date | invalid_number | unknown_type | duplicate_rows | unmatched_code | retired_code | boiler_mismatch | extra_columns | out_of_range`。

口径（必须与 `importCSV` / `importMaterialCSV` 一致）：
1. `totalRows` = 表头之后的数据行数（含空行）；行号 1 基、从表头后第一条算起。
2. `errorCount`/`warningCount` = **涉及行数**（同一行同类问题只计一次）；`issueCount = errorCount + warningCount`；`duplicateRows` = 被丢弃的重复行数。
3. `cleanRows` 只放「能直接交给导入函数」的行：`missing_required` / `boiler_mismatch` / `unknown_type`（分类既不是事件也不是更换）的行**不进** cleanRows；其余 warning 行保留原文（交给导入函数按既有规则处理）。
4. 日期归一为 `YYYY-MM-DD`；无法解析时保留原文并给 `invalid_date`(warning)。
5. 重复行业务键（events）：`数据分类 + 管段编码 + 日期 + 事件类型 + 详细描述 + 厚度 + 硬度`（与 `isEventExist` 一致）；变更类行：`炉号+旧管码+新管码+日期+原因`。material_library：`部件名称+分段/位置+规格型号+材质`（与 `materialKey` 一致）。
6. `unmatched_code`：管段编码不符合 `^[12]-[A-Z]{2,3}-[A-Z]{1,3}-\d{3}-\d{4}-[A-Z0-9]{3}(?:-R\d+)?$` → warning（不阻断）。
7. `boiler_mismatch`：编码首位与「炉号」列（或选项）不一致 → error（与 `codeMismatch` 一致，该行不进 cleanRows）。
8. `retired_code`：编码在 `retiredCodes` 中 → warning。
9. `out_of_range`：编码可落入 `matrixRows` 的 sys/zone 但屏/管圈超范围 → warning。
10. 空行丢弃并记入 `normalizations`；多余空列给 `extra_columns`(info)。
11. `importable = 数据集识别成功 && errorCount === 0 && cleanRows > 0`。
12. 数据集识别失败：`datasetType:"unknown"`，只做通用清洗（去空行、去完全重复、trim），`importable:false`，并给一条 `unknown_type`(warning, 标题「未识别数据集」)。

`preview` = 清洗后前 5 条**数据行**（不含表头；表头见 `cleanRows[0]`）。

### 2.5 查询解析

```js
parseQuery(message, context) => {
  dataset: "events"|"replacements"|"material_library"|"tube_ledger"|"warnings"|"maintenance"|"unknown",
  filters: {
    code?, unit?:"1"|"2", sys?, zone?, type?, keyword?,
    dateFrom?, dateTo?, minThickness?, maxThickness?,
    riskLevel?:"HIGH"|"MEDIUM"|"LOW", overdueYears?, neverInspected?:boolean
  },
  description: string   // 条件复述，用于结果卡片标题，如「查「HSH」、类型「测厚」的寿命事件」
}
```

识别要点：
- 机组：`1号炉/1#机组/一号炉` → `unit:"1"`；`2号` 同理；`全厂/全部` → 不设。
- 受热面：水冷壁/省煤器/过热器/再热器/高过/高再/低过/低再/屏过/大屏/顶棚/包墙 → 映射到 `sys` 集合（`sys` 可为数组，用 `sysLabel` 复述）。
- 管码：正则 `[12]-[A-Z]{2,3}-[A-Z]{1,3}-\d{3}-\d{4}-[A-Z0-9]{3}(?:-R\d+)?` 或 `包含 X` 片段。
- 类型：测厚/金相/无损/割管/检修/更换/报废/安装 → `type`。
- 日期：`2024年`、`2022-2024`、`近一年`、`最近3个月` → `dateFrom/dateTo`。
- 厚度：`壁厚小于6.5`、`低于理论厚度` → `maxThickness`。
- 风险：`高风险/严重/预警` → `riskLevel`。
- 超期：`超过10年没检查` → `dataset:"maintenance", overdueYears:10`；`从未检查` → `neverInspected:true`。
- 纯计数问法（含「多少/几条」且无名单词）由 wiring 走 stats 概览，不返回列表。
- 查不到数据集时 `dataset:"unknown"`，`description` 为空。

### 2.6 编辑解析（单条事件、单字段）

```js
parseEdit(message, context) => null | {
  targetCode: string,          // 管段编码
  recordHint: "latest"|"oldest"|"date",  // 默认 latest
  targetDate?: string,         // recordHint === "date" 时使用
  field: "date"|"code"|"type"|"desc"|"thickness"|"hardness"|"spec"|"material",
  value: string,
  reply: string
}
```
支持问法：`把 1-WW-FR-008-0003-000 的最新测厚记录厚度改成 6.8`、`2-HSH-E-012-0005-W02 的硬度改为 190`。
字段词：日期/时间→date、管码/编码→code、类型→type、描述/结论→desc、厚度/壁厚→thickness、硬度→hardness、规格→spec、材质→material。
无法定位管码或字段 → 返回 `null`（wiring 回落到 query/help）。
校验：`date` 须可归一为 `YYYY-MM-DD`；`thickness`/`hardness` 须为正数；`code` 须符合编码正则。数值范围：厚度 0.1~100 mm、硬度 1~600 HB。

### 2.7 统计

```js
buildStats(snapshot) => {
  intro: string,
  metrics: [{ label, value, hint? }],      // 4~8 个
  issues: [{ severity, title, detail, rows?: number[] }]
}
snapshot = { events, replacements, materialLibrary, matrix, retiredCodes, now? }
```
指标：事件总数、涉及管码数、更换记录数、材料库记录数、最近 30 天新增事件数。
问题：缺厚度/硬度的检测事件、业务键重复事件、编码不在台账矩阵的事件、已报废管码仍有新事件、材料库缺库存信息、材料库理论厚度未匹配。
wiring 可再追加「预警条数 / 超期未检条数」两项指标。

### 2.8 通用工具函数

```js
normalizeText(value)        // 去首尾空白、全角转半角、字母小写、去空格
escapeHtml(value)
normalizeDateText(value)    // "2024/1/5" -> "2024-01-05"；失败 -> null
normalizeEventType(raw)     // { type, known } ；known 集合见 §2.9
normalizeCode(value)        // trim + 大写
validateTubeCode(code, matrixRows?) // { valid, reason?, matched? }
formatNumber(value)         // 千分位
```

### 2.9 枚举口径

- 事件类型（与页面 `dm-type` 对齐）：`测厚、金相分析、无损检测、割管取样、检修维护`，另有导入可能出现的 `报废更换、安装投运`。
- 数据分类：`事件 / event`、`更换 / replacement`（大小写不敏感）。
- 受热面系统代码：`WW、RSH、WSH、LSH、PSH、ISH、HSH、LRH、HRH、ECO`（显示名与页面 `CODE_SYSTEMS` 一致：水冷壁、顶棚过热器、包墙过热器、低温过热器、全大屏过热器、屏式过热器、高温过热器、低温再热器、高温再热器、省煤器）。

### 2.10 分析与可视化（§2.10）

只读能力，与查询共用同一套过滤口径（内部直接调用 `parseQuery` 的 `filters`）。

```js
parseAnalysis(message, context) => null | {
  kind: "trend"|"distribution"|"ranking"|"compare"|"correlation"|"outlier"|"profile"|"overview",
  metric: "count"|"thickness"|"hardness"|"replacements",
  dimension: "month"|"quarter"|"year"|"unit"|"sys"|"zone"|"type"|"code"|"thicknessBin"|"hardnessBin",
  dataset: "events"|"replacements",
  filters: object,        // 与 parseQuery 完全一致
  limit: number,          // 排行取前 N（3~20，默认 8）
  order: "asc"|"desc",    // 最薄/最低 → asc
  chartType: "line"|"bar"|"hbar"|"donut"|"scatter",
  title: string,          // 中文卡片标题
  description: string,    // 条件复述
  confidence: number
}

runAnalysis(spec, snapshot) => {
  ok: boolean,
  kind, kindLabel, title, description,
  metrics: [{ label, value, tone? }],
  insights: string[],                       // 3~5 条中文结论（含数据依据）
  chart: ChartSpec | null,
  table: { columns: string[], rows: object[] },   // 可导出明细
  sampleSize: number,
  message?: string                          // ok=false 时的可执行提示
}

chartSvg(chart, { width?, height?, emptyText? }) => string   // 纯 SVG 字符串

// 大模型增强（可选，见 §8.2）
buildEvidence(question, spec, result) => { payload, numbers }
buildAnalysisMessages(evidence) => [{role:"system"}, {role:"user"}]
parseModelAnalysis(rawText, evidence) => { ok, insights, dropped, specPatch?, title?, risk?, advice?, reason? }
mergeAnalysisSpec(spec, patch) => { spec, changed }
isGrounded(line, numbers) => boolean
maskPii(text) => string
```

`ChartSpec = { type, categories?, series?: [{name, values}], points?: [{x,y}], threshold?: {value,label}, xLabel?, yLabel?, scale?: "zero"|"auto", ariaLabel? }`

八类分析的判定要点：

| kind | 触发词 | 默认口径 | 图形 |
| --- | --- | --- | --- |
| trend | 趋势/走势/逐月/逐年/按月/按年/环比/同比 | 按月聚合；count 或壁厚/硬度均值 + 最低值 | 折线 |
| distribution | 分布/直方图/构成/占比/按类型/按系统/按机组 | 数值型自动分箱（壁厚 0.5mm 级、硬度 10HB 级取 nice step）；类别型出占比 | 柱状 / 环形 |
| ranking | 排行/排名/TOP/前 N 名/最多/最薄/最厚 | 默认按受热面分组、降序；「最薄/最低」转升序 | 横向条 |
| compare | 对比/比较/相比/差异 | 机组（默认）、受热面或年度；metric 为均值或记录数 | 柱状 |
| correlation | 相关性/相关系数/散点/线性关系 | 壁厚 × 硬度，皮尔逊 r；样本 < 3 直接拒绝 | 散点 |
| outlier | 异常值/离群/超标/减薄严重/异常记录 | 壁厚 IQR 下界（Q1-1.5IQR）+ 名义壁厚减薄率 ≥20% | 散点 + 阈值线 |
| profile | 剖面/变化曲线/单管/该管段 | 单管壁厚按日期升序，画 80% 名义壁厚阈值线 | 折线 + 阈值线 |
| overview | 画像/整体分析/综合/体检 | 事件数、管段数、更换数、平均壁厚、超期未检、预警条数 + 类型构成 | 环形 |

口径约束（必须遵守）：

1. **按机组做对比/排行/分布时，自动放开 `filters.unit`**，否则「1 号和 2 号炉对比」只会剩一台机组。
2. **名义壁厚取自 `spec` 列的「Φ×壁厚」**，解析失败则不算减薄率，只提示补规格。
3. 折线图按数据量级取轴域（不从 0 起算），计数类图表才从 0 起算；否则 7.4→6.9 的趋势会被压成平线。
4. 样本不足时返回 `ok:false` 并给出可执行提示（如「至少需要 3 条才能算相关性」），不返回误导性结论。
5. 分析层**不写入任何数据**，也不新增 localStorage 键；导出走既有 `downloadBlob`。

## 3. 服务端 / 存储

**不新增后端接口。** 复用：
- 数据落盘：`saveDB()`（localStorage `boiler_user_db` + `/api/storage/boiler_user_db`）、`saveMaterialLibrary()`（`boiler_material_library`）。
- 权限：`/api/auth/session` → `currentAuthSession.role`。
- 模型配置：localStorage `boiler_llm_config`（沿用页面「模型接口配置与深度分析」）。

助手自身只新增这些 localStorage 键：
| 键 | 内容 | 上限 |
| --- | --- | --- |
| `boiler_assistant_history` | `[{id,title,updatedAt,messages:[{id,role:"user"|"assistant",text,createdAt}]}]` | 20 个会话 / 每个 60 条 |
| `boiler_assistant_last_import` | `{createdAt, kind:"events"|"material_library", eventTs:number[], replacementTs:number[]}` | 1 条 |
| `boiler_assistant_last_edit` | `{ts, field, before, after, code, createdAt}` | 1 条 |
| `boiler_assistant_panel` | `{open?:boolean}`（可选） | — |

## 4. 权限

| 角色 | 来源 | 可用工具 |
| --- | --- | --- |
| viewer | `session.role === "viewer"`（预留）或 URL `?assistantRole=viewer` | clean / export / query / stats / help |
| editor | 已登录非 admin，或本地离线模式（无会话） | 全部（不含 admin 专属） |
| admin | `session.role === "admin"` | 全部 |

角色不足时：不执行、不写入；回复「该操作需要编辑权限，请联系管理员」，并在卡片上标注。所有写操作（import / edit / undo）**必须**二次确认。

## 5. 数据快照与执行

wiring 通过 `collectAssistantSnapshot()`（新增到 app-v7.9.js）读取当前数据，避免直接散访问全局：

```js
collectAssistantSnapshot() => {
  events, replacements, materialLibrary,
  matrix, retiredCodes, ledgerRows,     // ledgerRows = getGeneratedTubeLedgerRows('all')（按需缓存）
  warnings,                             // collectDashboardWarnings({ limit: 500 })
  overdueRows,                          // buildMaintenanceOverdueRows(当前基准年, 'all')
  role, session, now
}
```

执行语义：
1. **清洗**：文件 → `parseTableRows(file)`（CSV 用 `parseCSVLine`；xlsx 用 SheetJS `XLSX.read` + `sheet_to_json({header:1})`）→ `BTAssistantCore.cleanRows` → 渲染清洗卡片（动作：确认导入 / 导出清洗后数据 / 导出问题明细）。
2. **导入（确认后）**：`importLifecycleRows(cleanRows, {batchFilter:'all'})` 或 `importMaterialRows(cleanRows)` → 记录 `boiler_assistant_last_import` → 提示「导入完成：…」→ 清空待处理数据。
3. **撤销导入**：只在 `last_import` 存在时可用；二次确认后按 `eventTs/replacementTs` 精确移除 + `saveDB()`，并清空 `last_import`。只回滚助手自己的最近一次导入，不碰页面既有导入。
4. **导出**：`exportScope` 默认 `current_filter`（读页面 `dm-batch-boiler` / 检修页筛选；没有筛选语义的数据集视为 all）。格式 `csv`（默认，走 `downloadBlob`）或 `xlsx`（有 `window.XLSX` 时；否则降级 CSV 并在回复里说明）。复用既有导出函数时不要改动其行为。
5. **查询**：wiring 在快照上执行 `filters`，返回 `{dataset, rows, total, columns, description}`；卡片显示最多 12 条 + 总数 + 「导出查询结果」按钮（导出完整结果）。
6. **修改**：`updateEventRecord(ts, field, value)` → 返回 `{ok, error?, before, after}`；成功后写 `last_edit`，卡片给「撤销这次修改」；撤销 = 再调用一次 `updateEventRecord` 写回原值（同样二次确认）。
7. **统计**：`buildStats` + 追加预警/超期指标，渲染指标卡 + 问题列表。
8. **分析**：`BTAssistantAnalysis.parseAnalysis` → `runAnalysis(snapshot)` → `chartSvg` → 推送 `analysis` 卡片；
   卡片「导出分析明细」把 `result.table` 走 `downloadCsv` 导出（完整明细，不是页面上那 6 行预览）。
9. **帮助**：渲染能力清单 + 示例问法 + 权限说明 + 当前模型状态。

每次写操作成功后在对话里给出「已写入本地并同步云端（若已登录）」的一句话回执；失败给出可操作原因。

## 6. UI 契约 `BTAssistantUI`

纯渲染函数（返回字符串，无 DOM 副作用）：

```js
escapeHtml(value)
launcherMarkup({ unread })                       // 悬浮按钮
panelMarkup({ configured })                      // 面板骨架（默认 hidden）
messageMarkup(message)                           // {id, role, text, createdAt, attachment?, cleaning?, operation?, analysis?}
cleaningMarkup(report)                           // 清洗报告卡片
operationMarkup(card)                            // 操作卡片
analysisMarkup(card)                             // 分析卡片（指标 + SVG 图表 + 结论 + 明细）
tableMarkup(table, limit)                        // 明细表（分析卡与后续卡片复用）
quickPromptMarkup(prompts)                       // 快捷指令 chips（string[]）
historyMarkup(conversations, activeId)           // 历史抽屉
```

`operationCard = {
  tool, datasetType, title, detail,
  metrics: [{label,value}], warnings: string[],
  status: "pending"|"ready"|"running"|"done"|"error",
  primaryAction?: {id,label}, secondaryActions: [{id,label}],
  resultTone?: "success"|"warning"|"error", summaryText?
}`

`analysisCard = {
  kind, kindLabel, title, metrics: [{label,value,tone?}], insights: string[],
  chart: ChartSpec, chartSvg: string,          // chartSvg 由分析层渲染后传入，UI 不再计算图表几何
  table: {columns, rows}, sampleSize,
  source: "rules"|"llm",                       // llm = 模型参与分析（卡片显示「模型解读」徽标）
  note?: string,                               // 降级说明 / 被过滤条数 / 口径变更说明
  advice?: string,                             // 模型给的一句可执行建议
  tone?: "warn", tool: "data.analyze",
  actions: [{id:"export-analysis", label:"导出分析明细", tone:"ghost"}]
}`

固定 DOM 契约（测试会钉住）：
- 悬浮入口：`#assistantLauncher`（`class="assistant-launcher"`，`aria-label="打开 AI 数据助手"`）
- 面板：`#assistantPanel`（`class="assistant-panel"`，`hidden`，`role="dialog"`，`aria-label="AI 数据助手"`）
- 头部：`#assistantClose`、`#assistantHistoryBtn`、`#assistantNewChat`、`#assistantTitle`、`#assistantStatus`
- 消息区：`#assistantMessages`（`class="assistant-messages"`，`role="log"`，`aria-live="polite"`）
- 快捷指令：`#assistantQuick`（`class="assistant-quick"`）
- 输入区：`#assistantInput`（textarea）、`#assistantSend`、`#assistantAttach`（`<label>`）、`#assistantFile`（`input[type=file]`，`accept=".csv,.xlsx,.xls"`）
- 历史：`#assistantHistory`（`class="assistant-history"`）
- 模型状态：`#assistantModelHint`（点击 → 切到总览并展开模型配置）
- 忙碌：`#assistantTyping`（`class="assistant-typing"`，三点动效）

面板控制器（挂载 + 事件委托）：

```js
mount({ root, state, dispatch }) => {
  open(), close(), toggle(), isOpen(),
  render(), setBusy(busy), focusInput(), scrollToBottom(), destroy()
}
// state() => { messages, busy, quickPrompts, conversations, activeConversationId, historyOpen, configured, role }
// dispatch({ kind:"send"|"file"|"action"|"toggle-history"|"select-history"|"delete-history"|"new-chat"|"open-settings", text?, file?, actionId?, tool?, conversationId? })
```

交互约定：Esc 或点标题栏关闭按钮关闭；回车发送（Shift+Enter 换行）；点快捷指令直接发送；
文件选择后清空 input.value 以便重选同一文件；忙碌时禁用输入/发送/附件/快捷指令；
只有用户本来就在底部时才自动滚动；同一 root 重复 mount 先解绑再绑定。

## 7. 接线契约 `BTAssistant`

```js
window.BTAssistant = {
  mount(), open(), close(), toggle(), isOpen(),
  send(text), handleFile(file), refresh()
}
```
`assistant-v1.js` 在 `DOMContentLoaded` 时自动 `mount()`（幂等）。

### app-v7.9.js 允许的最小改造（其它地方不动）

```js
// 1) 抽出 CSV 行处理，供既有 importCSV 与助手共用（口径必须完全不变）
importLifecycleRows(rawRows, options) => { importedEvents, importedReplacements, skippedDuplicates, skippedMismatch, errors: string[] }
// rawRows 含表头；options = { batchFilter?: "all"|"1"|"2" }
importMaterialRows(rawRows) => { imported }

// 2) 单字段修改（带校验与审计字段式回执）
updateEventRecord(ts, field, value) => { ok, error?, before?, after?, record? }

// 3) 结构化对话调用（供助手解析意图；不改变 runLLMAnalysis 行为）
callAssistantChatCompletions(messages, maxTokens) => string
// 内部抽公共 sendLLMMessages(messages, maxTokens)，callLLMChatCompletions 改为调用它

// 4) 快照/角色
collectAssistantSnapshot() => {...}   // 见 §5
getAssistantRole() => "viewer"|"editor"|"admin"
```

要求：`importCSV` / `importMaterialCSV` / `callLLMChatCompletions` 的行为、提示文案、去重口径保持 100% 不变
（回归测试 `tests/page-regression.test.mjs` 等必须仍通过）。

## 8. 大模型接入（可选，复用现有配置）

- 未配置 `boiler_llm_config.apiKey`/`model` 时：纯规则引擎，**不联网**；面板状态显示「规则引擎（离线）」。
- 已配置：`send` 时先尝试模型解析（超时 8s，`AbortController`）：
  - 请求体：`[{role:"system", content: <意图 JSON 规范>}, {role:"user", content: JSON.stringify({message, context:{role,currentView,headers,counts}})}]`
  - 只发送：用户这句话 + 列名 + 统计数字；**不发送原始数据行**；身份证/手机号/邮箱/API Key 发送前脱敏。
  - 回复必须是 JSON：`{intent, datasetType, params, reply, confidence}`；解析失败/超时/网络错误 → 规则结果 + 回复里标注「模型调用失败：<原因>（已降级为规则解析）」。
  - 校验：工具名必须在 `toolCatalog()` 内、数据集必须在注册表内、角色不足直接拒绝。
- 面板「模型设置」入口跳到总览页 `#llm-provider` 配置区（不重复实现配置表单）。

### 8.2 分析增强（可选，配置模型后自动生效）

分析采用**两段式**：规则版秒出，模型版异步升级。

1. 规则 `parseAnalysis` → `runAnalysis` → 立即推送 `source:"rules"` 的卡片（用户不用等网络）。
2. 若 `boiler_llm_config` 已配置，构造**证据包**并发一次模型调用（`max_tokens=700`，超时 9s）：
   ```js
   {
     question,                                   // 已脱敏（管码/证件/手机/邮箱）
     rule: { kind, metric, dimension, chartType, title },
     scope: { unit, sys, dateFrom, dateTo, sampleSize },
     sampleSize,
     metrics: [{label, value}],                  // 已格式化，最多 8 个
     insights: [...],                            // 规则基线，最多 5 条
     categories: [...],                          // 最多 24 个（均匀抽样）
     series: [{name, values:[...]}],             // 最多 3 条 × 24 点，2 位小数
     points: [{x, y}],                           // 散点类最多 60 个
     allowed: { kinds, metrics, dimensions, chartTypes }
   }
   ```
   **只发聚合结果，不发原始行、不发明细表、不发管段编码。**
3. 模型返回严格 JSON：`{spec?, title?, insights[], risk?, advice?}`。本地校验：
   - `insights` 每条必须包含证据包（指标 / 序列 / 规则基线）里出现过的数字，否则**整条丢弃**并计数；
     百分比支持 `0.054 ↔ 5.4%` 换算，避免误杀。
   - `spec` 只接受白名单取值，非法值忽略；全部非法视为没有建议。
   - 最多保留 5 条，单条截断到 180 字。
4. 若模型建议了不同口径（`mergeAnalysisSpec().changed`），**本地按新口径重新 `runAnalysis`**，
   图表与指标随之重算，模型无法绕过本地计算。
5. 结果写回同一条消息（`updateMessage`）：`source:"llm"`、`insights` 用模型结论、`advice` 单独展示、
   `note` 记录「过滤了 N 条」或「按模型建议改用 X 口径」。
6. 降级：未配置模型直接跳过；超时 / 网络错误 / 非 JSON / 结论全被过滤 → 保留规则卡片，
   `note` 写明 `模型分析未采用：<原因>（已保留规则结论）`。

## 9. 验收

1. `node tests/assistant-core.test.mjs`、`node tests/assistant-analysis.test.mjs`、`node tests/assistant-ui.test.mjs`、`node tests/assistant-wiring.test.mjs`、`node tests/assistant-integration.test.mjs` 全绿。
2. 既有全部 `tests/*.test.mjs`、`tests/run-prediction-browser.py` 仍通过（页面行为不得回归）。
3. `node --check` 对四个助手 JS 与维护记录 JS 全部通过；CSS 大括号配平。
4. 手工冒烟：打开页面 → 右下角 AI 入口 → 「帮助」有回复 →「现在数据质量怎么样」有指标 →「近两年壁厚趋势」出图 →
   上传 `tests/fixtures/assistant-events-sample.csv` 出清洗报告 → 确认导入 → 数据录入表出现新行 → 撤销导入后消失。
5. 部署工作流新增文件存在性校验，`dist` 与源码一致。

## 10. 分工与写入范围

| 任务 | 所有者 | 写入范围 |
| --- | --- | --- |
| 领域层 + 单测 | core-dev | `assets/app/assistant-core-v1.js`、`tests/assistant-core.test.mjs` |
| UI 层 + 样式 + 单测 | ui-dev | `assets/app/assistant-ui-v1.js`、`assets/app/assistant-v1.css`、`tests/assistant-ui.test.mjs` |
| 接线 + app-v7.9.js 改造 + 单测 | wiring-dev | `assets/app/assistant-v1.js`、`assets/app/app-v7.9.js`、`tests/assistant-wiring.test.mjs`、`tests/fixtures/assistant-*.csv` |
| 页面挂载 + 工作流 + 集成测试 + 文档 | lead | `炉管全生命周期管理系统.html`、`.github/workflows/deploy-cloudflare-pages.yml`、`tests/assistant-integration.test.mjs`、`docs/ai-assistant.md`、`dist/` |

约定：**不要跨范围改文件**；需要改契约先改本文件并通知 lead。
