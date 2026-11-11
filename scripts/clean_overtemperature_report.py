#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""清洗 DCS 月度超温报表。

超温模块只要求：每个月哪些点超温、超温多长时间，并累加到点；
管屏对应关系尚未确认，本脚本保留空列，待机组检修时再补。

输入：DCS 导出的 .xls / .xlsx / .csv（列含 点位、描述、限值、最值、
      开始时间、结束时间、总时长(秒) 等）。
输出：
  data/temperature-points/月度超温报表_<月>_<机组>号机.csv/.xlsx  标准导入表
  data/temperature-points/月度超温点位累计_<月>_<机组>号机.csv/.xlsx 点位累计
  data/temperature-points/月度超温清洗审计_<月>_<机组>号机.json      清洗留痕

用法：
  python scripts/clean_overtemperature_report.py "D:/路径/result.xls"
"""

import csv
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "temperature-points"

REPORT_COLUMNS = ["点位", "描述", "班组", "限值", "最值", "均值", "越限类型", "开始时间", "结束时间", "总时长(秒)"]
SUMMARY_COLUMNS = ["月份", "机组", "点位", "描述", "超温次数", "累计超温时长(秒)", "累计超温时长",
                   "最长单次(秒)", "最长单次", "峰值温度(℃)", "限值(℃)", "管屏"]

ALIASES = {
    "tag": ["点位", "dcstag", "点位编号", "测点编号", "tag"],
    "name": ["描述", "测点名称", "名称", "name"],
    "crew": ["班组", "crew"],
    "limit": ["限值", "限值(℃)", "limitc"],
    "peak": ["最值", "最高温度", "温度", "temperaturec"],
    "mean": ["均值", "meanc"],
    "over": ["越限类型", "类型", "overtype"],
    "start": ["开始时间", "起始时间", "startat"],
    "end": ["结束时间", "endat"],
    "duration": ["总时长(秒)", "总时长", "时长", "duration"],
}


def header_key(value):
    return re.sub(r"[?？\s]+$", "", str(value or "").replace("（", "(").replace("）", ")").replace("／", "/").strip()).lower()


def load_matrix(path):
    suffix = path.suffix.lower()
    if suffix == ".csv":
        raw = path.read_bytes()
        for encoding in ("utf-8-sig", "gbk", "utf-8"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise SystemExit("无法识别 CSV 编码")
        return [row for row in csv.reader(text.splitlines())]
    if suffix == ".xls":
        import xlrd
        sheet = xlrd.open_workbook(str(path)).sheet_by_index(0)
        return [[sheet.cell_value(r, c) for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    if suffix in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        sheet = load_workbook(str(path), data_only=True, read_only=True).worksheets[0]
        return [list(row) for row in sheet.iter_rows(values_only=True)]
    raise SystemExit("仅支持 .xls / .xlsx / .csv")


def pick(row, key):
    for alias in ALIASES[key]:
        value = row.get(header_key(alias))
        if value is not None and str(value).strip() != "":
            return value
    return ""


def number(value):
    text = str(value or "").replace(",", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_time(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime(1899, 12, 30) + timedelta(days=float(value))
    text = str(value).strip().replace("/", "-")
    match = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$", text)
    if not match:
        return None
    return datetime(*(int(part or 0) for part in match.groups()))


def parse_seconds(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(round(float(value) * 86400)) if 0 < float(value) <= 1 else int(round(float(value)))
    text = str(value).strip()
    match = re.match(r"^(\d+):(\d{1,2})(?::(\d{1,2}))?$", text)
    if match:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3) or 0)
    try:
        return int(round(float(text)))
    except ValueError:
        return None


def clock(seconds):
    seconds = max(0, int(seconds or 0))
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def unit_from_tag(tag):
    match = re.match(r"^DCS([12])_", str(tag or ""), re.I)
    return match.group(1) if match else ""


def merge_seconds(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return int(sum((end - start).total_seconds() for start, end in merged))


def read_rows(matrix):
    if not matrix:
        return []
    headers = [header_key(value) for value in matrix[0]]
    rows = []
    for index, source in enumerate(matrix[1:], start=2):
        values = list(source) + [""] * max(0, len(headers) - len(source))
        row = {headers[i]: values[i] for i in range(len(headers)) if headers[i]}
        if not any(str(value).strip() for value in row.values()):
            continue
        rows.append({"row": index, **row})
    return rows


def normalize(raw_rows):
    events, warnings = [], []
    seen = {}
    for row in raw_rows:
        tag = str(pick(row, "tag") or "").strip()
        name = str(pick(row, "name") or "").strip()
        start = parse_time(pick(row, "start"))
        end = parse_time(pick(row, "end"))
        limit = number(pick(row, "limit"))
        peak = number(pick(row, "peak"))
        seconds = parse_seconds(pick(row, "duration"))
        issues = []
        if not tag:
            issues.append("缺少点位")
        if start is None:
            issues.append("开始时间无效")
        if end is None:
            issues.append("结束时间无效")
        if start and end and end <= start:
            issues.append("结束时间必须晚于开始时间")
        if peak is None:
            issues.append("最值无效")
        if limit is None or limit <= 0:
            issues.append("限值无效")
        if seconds is None and start and end:
            seconds = int((end - start).total_seconds())
        if start and end and seconds is not None:
            diff = abs(seconds - int((end - start).total_seconds()))
            if diff > 5:
                issues.append(f"总时长与起止差 {diff} 秒")
        if issues:
            warnings.append({"row": row["row"], "tag": tag, "issues": issues})
            continue
        key = (tag, start, end)
        if key in seen:
            warnings.append({"row": row["row"], "tag": tag, "issues": ["重复区间，已跳过"]})
            continue
        seen[key] = True
        events.append({
            "row": row["row"],
            "tag": tag,
            "name": name,
            "crew": str(pick(row, "crew") or "").strip(),
            "limitC": limit,
            "peakC": peak,
            "meanC": number(pick(row, "mean")),
            "overType": str(pick(row, "over") or "").strip() or "越高限",
            "startAt": start,
            "endAt": end,
            "seconds": int(seconds),
            "unit": unit_from_tag(tag),
        })
    return events, warnings


def aggregate(events):
    groups = defaultdict(list)
    for event in events:
        groups[(event["startAt"].strftime("%Y-%m"), event["unit"], event["tag"])].append(event)
    summary = []
    for (month, unit, tag), items in sorted(groups.items()):
        durations = [int((item["endAt"] - item["startAt"]).total_seconds()) for item in items]
        summary.append({
            "month": month,
            "unit": unit,
            "tag": tag,
            "name": items[0]["name"],
            "count": len(items),
            "seconds": merge_seconds([(item["startAt"], item["endAt"]) for item in items]),
            "longestSeconds": max(durations),
            "peakC": max(item["peakC"] for item in items),
            "limitC": items[0]["limitC"],
            "panel": "",
        })
    return summary


def write_csv(path, columns, rows):
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def style_sheet(sheet, widths):
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.freeze_panes = "A2"


def write_xlsx(path, report_rows, summary_rows):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "月度报表"
    sheet.append(REPORT_COLUMNS)
    for row in report_rows:
        sheet.append([row[column] for column in REPORT_COLUMNS])
    style_sheet(sheet, [21, 26, 9, 9, 10, 10, 10, 21, 21, 13])

    sheet2 = workbook.create_sheet("点位月累计")
    sheet2.append(SUMMARY_COLUMNS)
    for row in summary_rows:
        sheet2.append([row[column] for column in SUMMARY_COLUMNS])
    style_sheet(sheet2, [10, 7, 21, 26, 10, 16, 14, 13, 13, 13, 10, 18])
    workbook.save(path)


def write_summary_xlsx(path, summary_rows):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "点位月累计"
    sheet.append(SUMMARY_COLUMNS)
    for row in summary_rows:
        sheet.append([row[column] for column in SUMMARY_COLUMNS])
    style_sheet(sheet, [10, 7, 21, 26, 10, 16, 14, 13, 13, 13, 10, 18])
    workbook.save(path)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python scripts/clean_overtemperature_report.py <超温表路径>")
    source = Path(sys.argv[1])
    if not source.exists():
        raise SystemExit(f"找不到文件：{source}")

    events, warnings = normalize(read_rows(load_matrix(source)))
    if not events:
        raise SystemExit("没有清洗出有效事件，请检查表头与时间格式")

    months = sorted({event["startAt"].strftime("%Y-%m") for event in events})
    units = sorted({event["unit"] for event in events if event["unit"]})
    unit_label = "、".join(f"{unit}号机" for unit in units) or "未识别机组"
    if len(months) != 1:
        raise SystemExit(f"本次文件跨 {len(months)} 个月（{', '.join(months)}），请按月拆分后再运行")
    month = months[0]

    report_rows = [{
        "点位": event["tag"],
        "描述": event["name"],
        "班组": event["crew"],
        "限值": event["limitC"],
        "最值": event["peakC"],
        "均值": event["meanC"] if event["meanC"] is not None else "",
        "越限类型": event["overType"],
        "开始时间": event["startAt"].strftime("%Y-%m-%d %H:%M:%S"),
        "结束时间": event["endAt"].strftime("%Y-%m-%d %H:%M:%S"),
        "总时长(秒)": clock(event["seconds"]),
    } for event in events]
    summary = aggregate(events)
    summary_rows = [{
        "月份": item["month"],
        "机组": item["unit"],
        "点位": item["tag"],
        "描述": item["name"],
        "超温次数": item["count"],
        "累计超温时长(秒)": item["seconds"],
        "累计超温时长": clock(item["seconds"]),
        "最长单次(秒)": item["longestSeconds"],
        "最长单次": clock(item["longestSeconds"]),
        "峰值温度(℃)": item["peakC"],
        "限值(℃)": item["limitC"],
        "管屏": "",
    } for item in summary]

    suffix = f"{month}_{'-'.join(units) or '未识别'}号机"
    report_csv = OUT_DIR / f"月度超温报表_{suffix}.csv"
    report_xlsx = OUT_DIR / f"月度超温报表_{suffix}.xlsx"
    summary_csv = OUT_DIR / f"月度超温点位累计_{suffix}.csv"
    summary_xlsx = OUT_DIR / f"月度超温点位累计_{suffix}.xlsx"
    audit_json = OUT_DIR / f"月度超温清洗审计_{suffix}.json"

    write_csv(report_csv, REPORT_COLUMNS, report_rows)
    write_csv(summary_csv, SUMMARY_COLUMNS, summary_rows)
    write_xlsx(report_xlsx, report_rows, summary_rows)
    write_summary_xlsx(summary_xlsx, summary_rows)
    audit = {
        "source": source.name,
        "sourcePath": str(source),
        "month": month,
        "unit": unit_label,
        "events": len(events),
        "points": len(summary_rows),
        "totalSeconds": sum(item["seconds"] for item in summary),
        "warnings": warnings,
        "note": "管屏未确认，保持空列；待机组检修时按现场实际补填。",
        "outputs": [path.name for path in (report_csv, report_xlsx, summary_csv, summary_xlsx)],
    }
    audit_json.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"月份：{month} · 机组：{unit_label}")
    print(f"有效事件 {len(events)} 条 · 超温点 {len(summary_rows)} 个 · 累计 {clock(sum(item['seconds'] for item in summary))}")
    print(f"需处理 {len(warnings)} 条")
    for path in (report_csv, report_xlsx, summary_csv, summary_xlsx, audit_json):
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
