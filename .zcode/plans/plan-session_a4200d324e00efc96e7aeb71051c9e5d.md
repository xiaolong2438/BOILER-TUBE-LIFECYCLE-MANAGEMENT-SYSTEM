# 管序字母修正：受热面 U/D → F/B（省煤器保留 U/D）

## 规则基准（本轮确认）
- 高再/高过/大屏/后屏/低再/低过：屏序 L/R、管序 **F/B**，无 U/D；低过/低再检修空间已有
- **省煤器 SG/EXIN/EXOUT 保留 U/D**（用户确认）
- **删除"无明确方向默认U"**：方向字母必须来自实际计数方向，不明/非法 → 走既有"待确认+近似建议"流程明示，不猜（用户确认）；000 只作排/屏号占位
- GGRQ 每屏 24 根（2026-10-31 已确认）→ 台账 tMax 12→24，与 fieldTMax、12回路基准、GGRQ_LOOP_BASELINE 对齐
- Q/W 字母尾体系、SLB/RSQ/LHD 规则、屏序 R→L 镜像：全部不动

## 代码改动
1. **matrix**（app-v7.9.js:965-970）：
   - DPGRQ/HPGRQ/DGRQ/DZRQ：`dirs:['U','D']→['F','B']`
   - GGRQ：`dirs→['F','B']`、`tMax 12→24`、删 fieldDirs/fieldTMax/fieldDefault（F/B 成为主口径，B024≙F001 镜像由主分支 tMax+1-n 承担）
   - GZRQ：`dirs→['F']`（台账展开 F001–F007），**保留 fieldDirs:['F','B']**（每屏管数未确认：F008+ 走 fieldPosition 宽松校验、B 码保持原方向待核不镜像——与现状语义一致）
   - SMQ 三行：不动
2. **TUBE_RE**（app:1237、core:500）：F/B 宽松集合扩为 GGRQ|GZRQ|DPGRQ|HPGRQ|DGRQ|DZRQ（接受 [FBUD] 以兼容历史 U/D 码解析），SMQ 保持 [UD]；核心镜像逻辑（DIR_COMPLEMENT、canonicalTubeCode）不动
3. **生成器/文案**：GGRQ dir 下拉自动变 F/B；label"现场F/B 1~24；U/D管圈参考1~12"→"管序F/B 1~24"；matrixRowRangeText 高再分支文案标"管数待核"；codeDesc fieldPosition 文案微调
4. **演示数据**：LIFECYCLE_DATA U→F 码（名称"上往下第N根"→"炉前往后第N根"）、app 内 CSV/XLSX 模板示例行、HTML 演示任务卡（122-123）
5. **规则文案**：README:19-20、HTML:234-236、app:1224 注释——方位表 U/D 标注"仅省煤器"，删"默认U"改为"方向不明进待确认明示"
6. **docs**：ai-assistant.md 归一说明（去 U↔D 管序提法）、ai-assistant-spec.md:221 示例、import-ux-test-report.md 示例、演示数据-新编码规则.csv（~30 行 U→F，SMQ 行保留）
7. **scripts/clean_boiler_film_records.py:104**：CODE_RE [FBUD]→[FB]（包内数据已全 F/B）

## 测试同步
- **tube-part-identity**（真实矩阵）：F004 变主台账合法（不再标 fieldPosition）；B001→F024 落库不变；GZRQ B001→null 保持；D 镜像断言改写（GGRQ B003→F022、GZRQ D003→null）；总数 8519→8903（GGRQ +384）；W 行断言改为"位置存在（生成 Q 行）+ W 事件挂档案"
- 浏览器端到端 fixtures：assistant-browser-runtime、import-ux 乱序列、assistant-events-sample.csv、prediction-runtime 的 U 码→F 码
- import-ux-verification 本地 DIR_MATRIX 同构更新；assistant-core.test 本地 MATRIX dirs→F/B 并调整对应断言
- 全量 node tests + python 清洗测试 + sync-dist 后提交推送

## 副作用说明
- GGRQ 台账 384→768 根：超期未检统计、待处置任务、检修工作量分摊会随之变化——这是台账对齐真实几何的必然结果，页面自动反映
- 台账 F/B 化后，同位置 W 记录并入管行（Q/W 同管合并），数据不丢，档案页照常展示