# 维护记录（操作日志）模块

> 文件：`assets/app/maintenance-log-v1.js`（领域 + 渲染）、`assets/app/maintenance-log-v1.css`（样式）
> 视图：左侧导航「台账与编码 → 维护记录」（`#view-maintainlog`）
> 定位：回答「这条数据是谁、什么时候、改了什么」——只记录**数据维护动作**，不记录浏览与查询。

## 0. 记什么

| 动作 | 触发来源 | 记录内容 |
| --- | --- | --- |
| 新增 | 数据录入页「保存记录」 | 管段编码、类型、日期、厚度、硬度 |
| 修改 | AI 助手改单条字段（含撤销修改） | 字段名、变更前、变更后 |
| 删除 | 数据录入页「删除」 | 被删记录的编码/日期/类型/厚度/描述快照 |
| 导入 | 页面 CSV 导入、AI 助手确认导入 | 文件名、事件/更换条数、跳过重复、机组不匹配 |
| 更换登记 | 数据录入页「更换登记」 | 旧码 → 新码、更换原因、日期 |
| 材料库 | 材料库编辑/导入/撤销 | 新增/更新/移除条数、示例部件名 |
| 系统 | 清空本地数据、清空日志 | 条数、说明 |

每条记录包含：`时间 / 动作 / 对象 / 变更内容 / 操作人 / 来源 / 字段级差异`。来源分四类：手工操作、AI 助手、文件导入、系统。

## 1. 数据模型

```js
{
  id: "log-<base36 时间>-<随机>",
  at: 1761200000000,          // epoch ms
  ts: "2026-10-23T07:33:20.000Z",
  action: "create|update|delete|import|undo|replace|material|system",
  target: "event|replacement|material_library|dataset|log",
  targetKey: "1G-SLB-WB-F000-R003-Q001",     // 主键（管码 / 文件名）
  targetLabel: "1G-SLB-WB-F000-R003-Q001 · 测厚 · 2026-03-01",
  summary: "厚度(mm)：6.85 → 6.62",
  changes: [{ field, label, before, after }],   // 最多 12 条
  meta: { code, date, fileName, counts, snapshot, ... },
  operator: "zhongguoting",   // 有登录态取 username，否则「本机用户」
  role: "admin|user|local",
  source: "manual|assistant|import|system",
  note: ""
}
```

## 2. 存储与合并

| 项 | 说明 |
| --- | --- |
| localStorage | `boiler_maintenance_log`，与业务数据（`boiler_user_db`）完全分开，互不影响 |
| 云端 KV | 同一个键，走既有 `/api/storage/boiler_maintenance_log` 与 `queueCloudStorageSave` |
| 上限 | 最近 800 条，超出后滚动清理最旧的（写入时按 `at` 排序截断） |
| 合并策略 | **按 id 求并集**：启动时 GET 云端与本机合并，只有云端有新记录才回写。避免 last-write-wins 把另一台机器的历史冲掉 |
| 失败处理 | localStorage 配额写满时退半再试一次；云端失败静默；日志写入本身异常绝不影响业务写入 |

## 3. 接线点（改代码前先看这里）

日志不在 `saveDB()` 里做「猜变更」，而是挂在**明确的业务写入点**上，保证摘要可读、差异准确：

| 业务函数 | 动作 | 说明 |
| --- | --- | --- |
| `addUserEvent()` | create | 新建对象后再记录，避免记到未入库的数据 |
| `addReplacement()` | replace | 同时派生 2 条事件（报废更换 / 安装投运），日志只记一条更换登记 |
| `deleteEvent(ts)` | delete | 删除前先取快照，日志里保留被删内容 |
| `importLifecycleRows(rows, options)` | import | 页面导入与助手导入共用此函数，`options.fileName` 带文件名 |
| `saveMaterialLibrary(items, options)` | material / import / undo | 先取旧快照算差异，再落盘；`options.reason` 决定动作类型 |
| `updateEventRecord(ts, field, value)` | update | 值没变化时直接返回，不产生日志 |
| `clearLocalData()` | system | 清空本地数据 |
| AI 助手 `undoLastImport()` | undo | 直接改 db，需显式留痕 |

### 新增一个记录点

```js
mlog('update', {                      // 主应用里已有这个帮助函数
  record: target,                     // 业务对象（取 code/date 用于标签）
  field: 'thickness',
  before: '6.8',
  after: '6.5'
});
```

- `mlog()` 内部 try/catch，日志模块缺失或抛错都不影响主流程。
- 需要标来源时用作用域包装：`BTMaintenanceLog.withSource('assistant', fn)`，异常也会还原。
- 值没变化时 `hook()` 返回 `null`，不会刷屏。

## 4. 权限

| 角色 | 查看 | 导出 CSV | 清空日志 |
| --- | --- | --- | --- |
| 本地离线模式（无会话） | ✅ | ✅ | ✅（二次确认） |
| 登录普通账号 | ✅ | ✅ | ❌ 提示需要管理员 |
| 管理员 | ✅ | ✅ | ✅（二次确认） |

日志是只读视图，任何角色都不能在这里改数据；清空只清日志，不动业务数据。

## 5. 交互

- 筛选：时间范围（全部/今天/7/30/90 天）、动作、来源、关键词（管码 / 字段名 / 操作人），输入即筛选（160ms 防抖）。
- 「详情」展开字段级差异表：字段 / 变更前 / 变更后，并附日志 ID 与记录时间。
- 「导出 CSV」按**当前筛选结果**导出，带 BOM，Excel 直接打开不乱码。
- 表格最多渲染 200 条，超出提示用筛选收窄；导出不受 200 条限制（最多 800）。

## 6. 校验

```bash
node tests/maintenance-log.test.mjs        # 21 项：记录/钩子/过滤/统计/上限/持久化/来源/导出/权限
python tests/run-assistant-browser.py      # 真实 Edge：含「maintenance log records and renders operations」
node tests/assistant-integration.test.mjs  # 资源、dist 同步、部署工作流校验
```

## 7. 已知边界

- 只记录本系统内的数据维护动作，不记录登录、查询、导出等只读行为。
- 日志按浏览器 + 云端并集保存，不做审计级不可篡改（本地用户可清空自己的日志；如需合规审计，应改造为服务端 append-only 表）。
- 不含「谁在什么设备上」：只记 username 与 role，不采集 UA / IP。
- 清空后不可恢复，建议先导出 CSV。
