# -*- coding: utf-8 -*-
"""清洗「锅炉管硬度及厚度检测记录」工作簿（2026年1号机C修）为系统导入包。

约定（与 data-cleaning/verified 拍片包 v10 口径一致）：
- 检修时间统一 2026-04，日期精度=月（不虚构日）；
- 事件类型统一「无损检测」（命中 AI 检查模式，方法细节放描述）；
- 描述瘦身=方法/结果，五点硬度取均值入 硬度(HB) 列，明细全列在描述；
- 来源ID = {批次}!硬度{表}R{源行}#{表内序}，与拍片包（!R{n}#）命名空间隔离；
- 检测结果=源表备注原文（硬度偏低/壁厚偏低/换管），不做推断性合格判定；
- 炉内表屏1的24行编码 L002 与屏2撞码：按同表屏31→L031/屏32→L032、
  炉顶大包全表 L{屏}-B{根}、屏式/全大屏偏移0的强一致证据修正为 L001，
  原始编码留档（记录来源=位置修正）。
"""
import json
import re
import statistics
import sys
from pathlib import Path

import openpyxl

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Users\DLX\Desktop\锅炉管硬度及厚度检测记录 (1).xlsx")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "data-cleaning" / "hardness-thickness-2026-04"

BATCH = "2026年1号机C修"
DATE = "2026-04"
PRECISION = "月"
BOILER = "1"

SYS_CODE = {"高温过热器": "GGRQ", "全大屏过热器": "DPGRQ", "屏式过热器": "PSGRQ",
            "低温过热器": "DGRQ", "低温再热器": "DZRQ", "高温再热器": "GZRQ",
            "水冷壁": "SLB", "省煤器": "SMQ", "后屏过热器": "HPGRQ"}

IMPORT_HEADERS = ["数据分类", "炉号", "日期", "管段编码", "规格", "材质", "厚度(mm)", "硬度(HB)",
                  "事件类型/更换原因", "关联新管码", "详细描述/结论", "检修批次", "来源ID",
                  "源工作表", "源表行号", "源展开序号", "批次流水号", "记录来源", "日期精度",
                  "检测结果", "结果性质", "原始编码"]

SHEETS = [
    ("2026年5月-1号机C修(炉内)", "炉内", "hardness"),
    ("2026年5月-1号机C修(炉顶大包)", "大包", "hardness_thickness"),
    ("2026年5月-1号机C修（全大屏过热器）", "全大屏", "hardness"),
    ("2026年5月-1号机C修（屏式过热器）", "屏式", "hardness"),
]


def sheet_rows(ws):
    it = ws.iter_rows(values_only=True)
    headers = [str(c).strip() if c is not None else "" for c in next(it)]
    rows = []
    for idx, r in enumerate(it, start=2):
        if not any(c is not None and str(c).strip() for c in r):
            continue
        rows.append((idx, dict(zip(headers, [str(c).strip() if c is not None else "" for c in r]))))
    return rows


def col(r, prefix):
    for k, v in r.items():
        if k.startswith(prefix):
            return v
    return ""


def trim_spec(text):
    return re.sub(r"(Φ[\d.]+×[\d.]+)mm", r"\1", text.strip())


def numeric(text):
    t = str(text).strip()
    return t if re.fullmatch(r"\d+(\.\d+)?", t) else ""


def screen_tube_from_position(text):
    m = re.match(r"1号炉炉左至炉右第(\d+)屏炉后往炉前第(\d+)根", text)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    out_rows, audit_rows, corrections, flags = [], [], [], []
    seq = 0

    for sheet_name, tag, kind in SHEETS:
        rows = sheet_rows(wb[sheet_name])
        fixed_in_sheet = 0
        for local_no, (row_no, r) in enumerate(rows, start=1):
            records = []
            code = r["编码"].strip().upper()
            raw_code = code
            system = r["系统"].strip()
            sys_seg = code.split("-")[1] if "-" in code else ""
            assert sys_seg == SYS_CODE[system], f"[{tag}] R{row_no} 系统列({system})与编码SYS段({sys_seg})不一致"
            assert code.startswith("1G-"), f"[{tag}] R{row_no} 编码非1号机: {code}"

            spec = trim_spec(r["规格"])
            material = r["材质"].strip()
            remark = r.get("备注", "").strip()
            method = r["检测方法"].strip()

            if kind == "hardness":
                screen, tube = screen_tube_from_position(r["具体位置"])
                sheet_screen = int(re.sub(r"\D", "", r["第几屏"]) or 0)
                sheet_tube = int(re.sub(r"\D", "", r["第几根"]) or 0)
                assert screen == sheet_screen and tube == sheet_tube, \
                    f"[{tag}] R{row_no} 位置文本(屏{screen}根{tube})与列(屏{sheet_screen}根{sheet_tube})不一致"
                parts = code.split("-")
                l_seg, b_seg = parts[3], parts[4]
                # 炉内表屏1块 24 行抄错为 L002（与屏2撞码），按全表偏移0规律修正
                if tag == "炉内" and screen == 1 and l_seg == "L002":
                    parts[3] = f"L{screen:03d}"
                    code = "-".join(parts)
                    corrections.append((sheet_name, row_no, raw_code, code))
                    fixed_in_sheet += 1
                assert f"-L{screen:03d}-B{tube:03d}-" in code, \
                    f"[{tag}] R{row_no} 编码({code})与屏{screen}根{tube}不符"

                points = [numeric(r.get(f"检测结果{i}", "")) for i in range(1, 6)]
                points = [p for p in points if p]
                assert points, f"[{tag}] R{row_no} 无有效硬度测点"
                label = {3: "三点", 4: "四点", 5: "五点"}.get(len(points), f"{len(points)}点")
                hardness = str(int(round(statistics.mean(float(p) for p in points))))
                records.append({
                    "type": "硬度",
                    "hardness": hardness,
                    "thickness": "",
                    "desc": f"方法：{method}；结果：{label}" + "/".join(points),
                    "result": remark,
                    "result_kind": "原文备注" if remark else "",
                })
            else:
                screen, tube = int(r["第几屏"]), int(r["第几根"])
                side = r["集箱进出口"].strip()
                # 出口集箱侧 EXOUT 用出口段位 B{根}，入口集箱侧 EXIN 用入口段位 F{根}（v10 口径）
                seg_letter, comp = ("B", "EXOUT") if side == "出口" else ("F", "EXIN")
                assert f"-{comp}-L{screen:03d}-{seg_letter}{tube:03d}-" in code, \
                    f"[{tag}] R{row_no} 编码({code})与屏{screen}根{tube}/{side}不符"
                hardness_raw = numeric(r["硬度检测结果"])
                thickness_raw = numeric(col(r, "厚度标准") and r["厚度检测结果"])
                replaced = "换管" in (r["硬度检测结果"] + r["厚度检测结果"])
                if replaced:
                    assert not hardness_raw and not thickness_raw, f"[{tag}] R{row_no} 换管行却带数值"
                    # 源表标注换管：按系统「更换」分类登记（旧码=新码同位置，原因=换管），
                    # 导入时自动生成报废更换+安装投运事件并把该管当前证据边界重置到本检修日期
                    records.append({
                        "type": "换管",
                        "hardness": "",
                        "thickness": "",
                        "desc": "",
                        "result": "换管",
                        "result_kind": "原文结果",
                    })
                else:
                    assert hardness_raw, f"[{tag}] R{row_no} 硬度结果非数字: {r['硬度检测结果']}"
                    assert thickness_raw, f"[{tag}] R{row_no} 厚度结果非数字: {r['厚度检测结果']}"
                    hard_remark = "硬度偏低" if remark == "硬度偏低" else ""
                    thick_remark = "壁厚偏低" if remark == "壁厚偏低" else ""
                    records.append({
                        "type": "硬度",
                        "hardness": hardness_raw,
                        "thickness": "",
                        "desc": f"方法：硬度计；结果：{hardness_raw}" + (f"；{hard_remark}" if hard_remark else ""),
                        "result": hard_remark,
                        "result_kind": "原文备注" if hard_remark else "",
                    })
                    records.append({
                        "type": "测厚",
                        "hardness": "",
                        "thickness": thickness_raw,
                        "desc": f"方法：超声波测厚；结果：{thickness_raw}" + (f"；{thick_remark}" if thick_remark else ""),
                        "result": thick_remark,
                        "result_kind": "原文备注" if thick_remark else "",
                    })

            for sub, rec in enumerate(records, start=1):
                seq += 1
                source_id = f"{BATCH}!硬度{tag}R{row_no}#{sub}"
                category = "更换" if rec["type"] == "换管" else "事件"
                out_rows.append([ category, BOILER, DATE, code, spec, material, rec["thickness"], rec["hardness"],
                                  rec["type"], code if category == "更换" else "", rec["desc"], BATCH, source_id,
                                  sheet_name, row_no, sub, seq,
                                  "位置修正" if code != raw_code else "原始编码",
                                  PRECISION, rec["result"], rec["result_kind"], raw_code ])
                audit_rows.append([ sheet_name, row_no, rec["type"], code, raw_code,
                                    "位置修正" if code != raw_code else "", spec, material,
                                    rec["hardness"], rec["thickness"], rec["result"], source_id ])

        print(f"[{tag}] {len(rows)} 行，修正编码 {fixed_in_sheet} 行")

    # 汇总校验
    assert seq == len(out_rows) == 1349, f"总行数异常: {seq}"
    ids = [row[12] for row in out_rows]
    assert len(set(ids)) == len(ids), "来源ID存在重复"
    assert not any(i.startswith(f"{BATCH}!R") for i in ids), "来源ID与拍片包命名空间冲突"
    type_counts = {}
    for row in out_rows:
        type_counts[row[8]] = type_counts.get(row[8], 0) + 1
    assert type_counts == {"硬度": 733, "测厚": 614, "换管": 2}, f"类型分布异常: {type_counts}"
    pairs = {}
    for row in out_rows:
        key = (row[3], row[8])  # 同码可拆"硬度+测厚"两条，但同码同类型只允许一条
        pairs[key] = pairs.get(key, 0) + 1
    dup = {k: v for k, v in pairs.items() if v > 1}
    assert not dup, f"清洗后同码同类型重复: {dup}"

    OUT.mkdir(parents=True, exist_ok=True)
    # 导入 CSV（UTF-8 BOM，与拍片包一致）
    csv_path = OUT / "导入_2026年1号机C修_硬度厚度检测.csv"
    lines = [",".join(IMPORT_HEADERS)]
    for row in out_rows:
        cells = []
        for v in row:
            s = str(v)
            cells.append(f'"{s}"' if ("," in s or '"' in s or "\n" in s) else s)
        lines.append(",".join(cells))
    csv_path.write_text("\ufeff" + "\n".join(lines) + "\n", encoding="utf-8")

    # 导入 XLSX（模板列序）与审计 XLSX
    wb_out = openpyxl.Workbook()
    ws = wb_out.active
    ws.title = "导入_硬度厚度检测"
    ws.append(IMPORT_HEADERS)
    for row in out_rows:
        ws.append(row)
    wb_audit = openpyxl.Workbook()
    ws1 = wb_audit.active
    ws1.title = "清洗明细"
    ws1.append(["源工作表", "源表行号", "事件类型", "清洗后编码", "原始编码", "编码修正", "规格", "材质",
                "硬度均值HB", "厚度mm", "检测结果", "来源ID"])
    for row in audit_rows:
        ws1.append(row)
    ws2 = wb_audit.create_sheet("汇总")
    ws2.append(["项目", "数值"])
    for k, v in [("源文件", SRC.name), ("检修批次", BATCH), ("记录日期", DATE), ("日期精度", PRECISION),
                 ("总记录数", len(out_rows)),
                 ("硬度（事件）", type_counts["硬度"]),
                 ("测厚（事件）", type_counts["测厚"]),
                 ("换管（更换分类）", type_counts["换管"]),
                 ("炉内(硬度)", sum(1 for a in audit_rows if a[0].endswith("炉内)"))),
                 ("炉顶大包(硬度+厚度拆分)", sum(1 for a in audit_rows if "炉顶大包" in a[0])),
                 ("全大屏(硬度)", sum(1 for a in audit_rows if "全大屏" in a[0])),
                 ("屏式(硬度)", sum(1 for a in audit_rows if "屏式" in a[0])),
                 ("编码修正(炉内屏1 L002→L001)", len(corrections)),
                 ("换管记录", sum(1 for a in audit_rows if a[2] == "换管")),
                 ("硬度偏低(原文)", sum(1 for a in audit_rows if a[10] == "硬度偏低")),
                 ("壁厚偏低(原文)", sum(1 for a in audit_rows if a[10] == "壁厚偏低"))]:
        ws2.append([k, v])
    xlsx_path = OUT / "导入_2026年1号机C修_硬度厚度检测.xlsx"

    def save_book(book, path):
        """目标被 WPS/Excel 占用时改写 v2 后缀，避免覆盖失败丢交付物。"""
        try:
            book.save(path)
            return path
        except PermissionError:
            alt = path.with_name(path.stem + "_v2" + path.suffix)
            book.save(alt)
            print(f"[warn] {path.name} 被占用，已写入 {alt.name}")
            return alt

    xlsx_path = save_book(wb_out, xlsx_path)
    audit_path = save_book(wb_audit, OUT / "数据清洗审计.xlsx")

    notes = [
        "硬度及厚度检测记录清洗包（2026年1号机C修）",
        f"源文件：{SRC.name}",
        f"总记录 {len(out_rows)} 条（炉内96 / 炉顶大包616→拆1230 / 全大屏2 / 屏式21）。",
        "事件类型按系统既有分类统一：厚度=测厚、硬度=硬度、换管=更换分类（原因写换管，旧码=新码同位置，导入自动生成报废更换+安装投运事件并重置当前管证据边界）。",
        "同一源行同时含硬度与厚度时拆分两条（来源ID 展开序号 #1 硬度 / #2 测厚），一条记录只带一个检测类型与一个数值。",
        "检修时间统一 2026-04，日期精度=月（不虚构日，与拍片包口径一致）。月精度记录进档案时间线，不进硬度/厚度趋势曲线（系统仅认完整日期）。",
        "五点硬度取整数均值写入 硬度(HB)，五点明细在描述；厚度为源表读数；检测结果=源表备注原文（硬度偏低/壁厚偏低/换管），未做推断性判定。",
        f"编码修正 {len(corrections)} 行：炉内表屏1块 24 行 L002→L001（源表与屏2撞码；同表屏31→L031、屏32→L032，炉顶大包全表、屏式、全大屏表均为 L{{屏}}-B{{根}} 偏移0），原始编码留档审计。",
        "换管 2 行：1G-GGRQ-EXOUT-L013-B001-SQ-U/D（第13屏第1根上下部），按更换登记（同位置换管）。",
        f"来源ID命名空间：{BATCH}!硬度{{表}}R{{源行}}#{{展开序}}，与拍片包(!R{{n}}#)隔离，可重复导入幂等更新。",
        "导入路径：系统「数据录入与管理」→ Excel 批量导入，选择 导入_2026年1号机C修_硬度厚度检测.xlsx（若存在 _v2 后缀版本，用 v2）。",
    ]
    (OUT / "清洗说明.txt").write_text("\n".join(notes) + "\n", encoding="utf-8")
    print(json.dumps({"total": len(out_rows), "corrections": len(corrections), "types": type_counts,
                      "xlsx": str(xlsx_path), "audit": str(audit_path), "out": str(OUT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
