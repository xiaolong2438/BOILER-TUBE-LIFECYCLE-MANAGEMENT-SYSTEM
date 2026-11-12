#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成基础温度测点台账（两台机组，共 204 个测点）。

数据来源：用户 2026-11-05 提供的 1 号机组 8 组 DCS 点位与限值；
2 号机组按同一描述与限值，仅将 DCS1 前缀替换为 DCS2。
输出：data/temperature-points/基础温度测点台账.xlsx 与 .csv
"""

import csv
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = Path(
    r"C:/Users/DLX/.zcode/cli/plugins/cache/zcode-plugins-official/spreadsheets/0.2.1/skills/xlsx"
)
sys.path[:0] = [str(SKILL_DIR), str(SKILL_DIR / "templates")]
import base  # noqa: E402

OUT_DIR = ROOT / "data" / "temperature-points"
XLSX_PATH = OUT_DIR / "基础温度测点台账.xlsx"
CSV_PATH = OUT_DIR / "基础温度测点台账.csv"
SOURCE_NOTE = "用户提供（2026-11-05）"
LIMIT_BASIS = "用户提供的机组温度限值（2026-11-05）；正式定值单待复核"

FAMILIES = [
    {"key": "HAH50", "name": "低温过热器出口集箱管壁温度", "count": 18, "limit": 472,
     "type": "header_wall", "type_label": "集箱壁温", "system": "DGRQ",
     "surface": "低温过热器", "equipment": "出口集箱"},
    {"key": "HAH61", "name": "全大屏过热器出口壁温", "count": 12, "limit": 498,
     "type": "tube_wall", "type_label": "管壁温度", "system": "DPGRQ",
     "surface": "全大屏过热器", "equipment": "出口管壁"},
    {"key": "HAH70", "name": "后屏过热器管壁温度", "count": 12, "limit": 498,
     "type": "tube_wall", "type_label": "管壁温度", "system": "PSGRQ",
     "surface": "后屏过热器", "equipment": "管壁"},
    {"key": "HAH80", "name": "高温过热器出口集箱管壁温度", "count": 16, "limit": 568,
     "type": "header_wall", "type_label": "集箱壁温", "system": "GGRQ",
     "surface": "高温过热器", "equipment": "出口集箱"},
    {"key": "HAJ10", "name": "低温再热器出口集箱管壁温度", "count": 18, "limit": 522,
     "type": "header_wall", "type_label": "集箱壁温", "system": "DZRQ",
     "surface": "低温再热器", "equipment": "出口集箱"},
    {"key": "HAJ15", "name": "高温再热器出口集箱管壁温度", "count": 20, "limit": 578,
     "type": "header_wall", "type_label": "集箱壁温", "system": "GZRQ",
     "surface": "高温再热器", "equipment": "出口集箱"},
    {"key": "LBA10", "name": "过热蒸汽温度", "count": 3, "limit": 546,
     "type": "steam", "type_label": "蒸汽温度", "system": "",
     "surface": "主蒸汽", "equipment": "过热蒸汽管道"},
    {"key": "HAJ03", "name": "再热蒸汽温度", "count": 3, "limit": 551,
     "type": "steam", "type_label": "蒸汽温度", "system": "",
     "surface": "再热蒸汽", "equipment": "再热蒸汽管道"},
]

COLUMNS = [
    ("序号", 6),
    ("机组", 9),
    ("测点分组", 26),
    ("DCS Tag", 21),
    ("测点名称", 30),
    ("测量类型", 11),
    ("测量类型代码", 15),
    ("系统码", 9),
    ("受热面/设备", 17),
    ("安装位置", 24),
    ("温度限值(℃)", 12),
    ("限值依据", 38),
    ("启用状态", 10),
    ("备注", 30),
]


def build_rows():
    rows = []
    seq = 0
    for unit in ("1", "2"):
        for family in FAMILIES:
            for index in range(1, family["count"] + 1):
                seq += 1
                tag = "DCS%s_%sCT%03d" % (unit, family["key"], index)
                name = "%s%d" % (family["name"], index)
                rows.append([
                    seq,
                    "%s号机组" % unit,
                    family["name"],
                    tag,
                    name,
                    family["type_label"],
                    family["type"],
                    family["system"],
                    family["surface"],
                    "%s号机组 · %s" % (unit, family["equipment"]),
                    family["limit"],
                    LIMIT_BASIS,
                    "启用",
                    "",
                ])
    return rows


def build_summary():
    rows = []
    for family in FAMILIES:
        rows.append([
            family["name"],
            "DCS1_%sCT / DCS2_%sCT" % (family["key"], family["key"]),
            "%s1-%s%d" % (family["name"], family["name"], family["count"]),
            family["count"],
            family["count"],
            family["count"] * 2,
            family["limit"],
            family["type_label"],
            family["system"] or "-",
            family["surface"],
        ])
    rows.append([
        "合计", "-", "-", 102, 102, 204, "-", "-", "-", "-",
    ])
    return rows


def write_xlsx(rows, summary):
    wb = Workbook()
    ws = wb.active
    ws.title = "测点台账"

    title = "基础温度测点台账（1#/2# 机组）"
    ws.cell(row=1, column=1, value=title)
    ws.cell(row=1, column=1).font = base.font_title()
    ws.cell(row=1, column=1).alignment = base.align_title()
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(COLUMNS))
    ws.row_dimensions[1].height = 28

    subtitle = "共 %d 个测点（单台机组 102 个）· 数据来源：%s · 限值依据：%s" % (
        len(rows), SOURCE_NOTE, LIMIT_BASIS,
    )
    ws.cell(row=2, column=1, value=subtitle)
    ws.cell(row=2, column=1).font = base.font_caption()
    ws.cell(row=2, column=1).alignment = Alignment(vertical="center", wrap_text=True)
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(COLUMNS))
    ws.row_dimensions[2].height = 30

    header_row = 3
    for col, (name, width) in enumerate(COLUMNS, 1):
        cell = ws.cell(row=header_row, column=col, value=name)
        ws.column_dimensions[get_column_letter(col)].width = width
    base.style_header_row(ws, header_row, 1, len(COLUMNS))
    ws.row_dimensions[header_row].height = 24

    for row_index, values in enumerate(rows):
        excel_row = header_row + 1 + row_index
        for col, value in enumerate(values, 1):
            cell = ws.cell(row=excel_row, column=col, value=value)
            cell.font = base.font_body()
            cell.alignment = base.align_text() if col not in (1, 11) else base.align_number()
        base.style_data_row(ws, excel_row, 1, len(COLUMNS), row_index)

    last_row = header_row + len(rows)
    ws.auto_filter.ref = "A%d:N%d" % (header_row, last_row)
    ws.freeze_panes = "A%d" % (header_row + 1)
    for excel_row in range(header_row + 1, last_row + 1):
        ws.row_dimensions[excel_row].height = 21
    for col in (3, 5, 10, 12, 14):
        for excel_row in range(header_row + 1, last_row + 1):
            ws.cell(row=excel_row, column=col).alignment = Alignment(
                vertical="center", wrap_text=True
            )

    summary_ws = wb.create_sheet("分类汇总")
    headers = [
        ("测点分组", 30), ("DCS 前缀", 28), ("测点名称范围", 34),
        ("1号机数量", 11), ("2号机数量", 11), ("合计", 9),
        ("温度限值(℃)", 12), ("测量类型", 11), ("系统码", 9), ("受热面/设备", 17),
    ]
    summary_ws.cell(row=1, column=1, value="温度测点分组汇总")
    summary_ws.cell(row=1, column=1).font = base.font_title()
    summary_ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    summary_ws.row_dimensions[1].height = 28

    for col, (name, width) in enumerate(headers, 1):
        summary_ws.cell(row=3, column=col, value=name)
        summary_ws.column_dimensions[get_column_letter(col)].width = width
    base.style_header_row(summary_ws, 3, 1, len(headers))

    for row_index, values in enumerate(summary):
        excel_row = 4 + row_index
        for col, value in enumerate(values, 1):
            cell = summary_ws.cell(row=excel_row, column=col, value=value)
            cell.font = base.font_body()
            cell.alignment = base.align_number() if col in (4, 5, 6, 7) else base.align_text()
        if row_index == len(summary) - 1:
            base.style_total_row(summary_ws, excel_row, 1, len(headers))
        else:
            base.style_data_row(summary_ws, excel_row, 1, len(headers), row_index)

    note_row = 5 + len(summary)
    summary_ws.cell(row=note_row, column=1, value="说明：同一测点每月可上传多条越限事件；累计时按事件区间并集计算，避免重叠时段重复计时。")
    summary_ws.cell(row=note_row, column=1).font = base.font_caption()
    summary_ws.merge_cells(start_row=note_row, start_column=1, end_row=note_row, end_column=len(headers))

    wb.properties.creator = "Z.ai"
    wb.save(XLSX_PATH)


def write_csv(rows):
    with CSV_PATH.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([name for name, _ in COLUMNS])
        writer.writerows(rows)


def main():
    rows = build_rows()
    summary = build_summary()
    assert len(rows) == 204, len(rows)
    assert len({row[3] for row in rows}) == 204, "DCS Tag 必须唯一"
    assert sum(row[0] == 0 for row in rows) == 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_xlsx(rows, summary)
    write_csv(rows)
    print("rows=%d units=%d" % (len(rows), len({row[1] for row in rows})))
    print(XLSX_PATH)
    print(CSV_PATH)


if __name__ == "__main__":
    main()
