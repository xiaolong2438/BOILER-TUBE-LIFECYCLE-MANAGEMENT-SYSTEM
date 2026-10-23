# 开发与发布约定

> 本项目是无构建的静态站点：源码即产物，`dist/` 由脚本生成。
> 这份文档记录几条**必须遵守**的约定，避免出现"改了没生效 / 线上跑旧代码"这类难查的问题。

## 1. 改完源码必须同步 dist

```bash
node scripts/sync-dist.mjs          # 同步：复制改动 + 清理 dist 中已删除的文件
node scripts/sync-dist.mjs --check  # 只检查，有漂移时退出码 1（CI/提交前用）
```

同步范围（与 `.github/workflows/deploy-cloudflare-pages.yml` 一致）：

| 源 | 目标 |
| --- | --- |
| `炉管全生命周期管理系统.html` | `dist/index.html` |
| `login.html` | `dist/login.html` |
| `assets/**` | `dist/assets/**` |

为什么必须做：`tests/release-artifacts.test.mjs` 会逐字节比对 `dist` 与源码，部署工作流也会校验文件存在性。
手工 `cp` 漏一次，症状是"本地好好的，线上还是旧代码"，极难定位。

## 2. 提交前自检

```bash
node scripts/sync-dist.mjs --check
for t in tests/*.test.mjs; do node "$t" || break; done   # 25 个测试文件
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

## 5. 多设备覆盖保护

业务数据是 `localStorage` + KV，云端写入是 last-write-wins，所以加载时必须防"静默覆盖"：

- 每次 `saveDB()` 会写 `boiler_user_db_local_at`（本机最后写入时间）。
- 启动时 `bootstrapCloudStorage()` 比较云端 `updated_at` 与本机时间：
  - 本机更新（`localAt > remoteAt + 2s`）：**保留本机**，排队上传，提示"本机数据比云端新"。
  - 云端更新：先把本机数据备份到 `boiler_user_db_backup`（材料库同理备份到
    `boiler_material_library_backup`），再载入云端版本，并在「维护记录」留一条系统日志。
- 注意：这是**防丢保护**，不是合并。真要做多端协作，得改成按 `ts` 增量合并或服务端版本号。
