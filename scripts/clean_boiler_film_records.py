#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""保守清洗锅炉拍片记录；源文件只读，新包在全部核验通过后原子发布。

流水号是批次内事件清单序号，不是物理管号或弯头编号。多材质行不做
未经证实的 F/B 几何换算；源表仅有年份时保留年精度。旧版导入包不可
与本版叠加。默认发布至 data-cleaning/verified，已有不同内容一律拒绝覆盖。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import openpyxl
from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter

RULE_VERSION = "film-records-physical-codes-v9"
# 用户确认（2026-10-31，图纸148M211-0）：高过12回路材质分段基准。
# 每回路 = 前腿F00k（顶部入口联箱向下）+ 底部弯头 + 后腿F(25-k)（向上至顶部出口），
# 材质沿整个回路连续变化；W记录对应底弯件=前腿末段（回路8-11为12Cr1MoVGΦ51×9直接过弯）。
# front_segs沿蒸汽流程（顶→底），rear_segs沿蒸汽流程（底→顶），元素为(规格,材质)。
_LOOP2_4 = [("Φ51×9", "12Cr1MoVG"), ("Φ51×9", "SA-213T91"), ("Φ51×8", "SA-213TP304H")]
_LOOP5_7 = [("Φ51×9", "12Cr1MoVG"), ("Φ51×9", "SA-213T91"), ("Φ51×8", "SA-213T91")]
_LOOP8_11_FRONT = [("Φ51×9", "12Cr1MoVG")]
_LOOP8_11_REAR = [("Φ51×9", "SA-213T91"), ("Φ51×8", "SA-213T91"),
                  ("Φ51×11", "SA-213T91"), ("Φ51×11", "SA-213T22")]
_REAR_STD = [("Φ51×11", "SA-213T91"), ("Φ51×11", "SA-213T22")]
GGRQ_LOOP_SEGMENTS = [
    {"loop": 1, "front": (1,), "rear": (24,),
     "front_segs": [("Φ54×9", "12Cr1MoVG"), ("Φ54×9", "SA-213T91"), ("Φ54×7.5", "SA-213TP347H")],
     "rear_segs": [("Φ54×11", "SA-213T91"), ("Φ54×11", "SA-213T22")]},
    {"loop": 2, "front": (2,), "rear": (23,), "front_segs": _LOOP2_4, "rear_segs": _REAR_STD},
    {"loop": 3, "front": (3,), "rear": (22,), "front_segs": _LOOP2_4, "rear_segs": _REAR_STD},
    {"loop": 4, "front": (4,), "rear": (21,), "front_segs": _LOOP2_4, "rear_segs": _REAR_STD},
    {"loop": 5, "front": (5,), "rear": (20,), "front_segs": _LOOP5_7, "rear_segs": _REAR_STD},
    {"loop": 6, "front": (6,), "rear": (19,), "front_segs": _LOOP5_7, "rear_segs": _REAR_STD},
    {"loop": 7, "front": (7,), "rear": (18,), "front_segs": _LOOP5_7, "rear_segs": _REAR_STD},
    {"loop": 8, "front": (8,), "rear": (17,), "front_segs": _LOOP8_11_FRONT, "rear_segs": _LOOP8_11_REAR},
    {"loop": 9, "front": (9,), "rear": (16,), "front_segs": _LOOP8_11_FRONT, "rear_segs": _LOOP8_11_REAR},
    {"loop": 10, "front": (10,), "rear": (15,), "front_segs": _LOOP8_11_FRONT, "rear_segs": _LOOP8_11_REAR},
    {"loop": 11, "front": (11,), "rear": (14,), "front_segs": _LOOP8_11_FRONT, "rear_segs": _LOOP8_11_REAR},
    {"loop": 12, "front": (12,), "rear": (13,), "front_segs": _LOOP5_7, "rear_segs": _REAR_STD},
]


def ggrq_bottom_bend_attrs(tube_no: int) -> tuple[str, str]:
    """高过W记录（底部弯头件）的(规格,材质)：回路k=前腿F00k+后腿F(25-k)，底弯件=前腿末段。"""
    loop_no = tube_no if tube_no <= 12 else GGRQ_TUBES_PER_SCREEN + 1 - tube_no
    loop = next(l for l in GGRQ_LOOP_SEGMENTS if l["loop"] == loop_no)
    return loop["front_segs"][-1]
# 用户确认（2026-10-31）：12CrMoVG实为12Cr1MoVG；材质写法统一全称；检测月份见BATCH_META；
# 源2026第32行“第24屏”实为第27屏。
MATERIAL_NAME_MAP = {"304H": "SA-213TP304H", "TP347H": "SA-213TP347H",
                     "12CRMOVG": "12Cr1MoVG", "T91": "SA-213T91"}
SOURCE_ROW_CORRECTIONS = {
    ("2026年1号机C修", 32): {"replace": ("L024", "L027"),
                             "reason": "用户确认源表第32行“第24屏”实为第27屏（原表笔误）"},
    ("2026年1号机C修", 38): {"spec": "Φ51×8",
                             "reason": "图纸148M211-0（高温过热器材料分界图）确认SA-213TP304H规格为Φ51×8，源表Φ54×7.5为笔误"},
}
# 用户确认（2026-10-31）：2022/2021高再7弯头区带按炉前至炉后计数，对应F001–F007；
# 备注中“炉后往炉前数”为方向笔误。高过弯头材质不再用区带表，直接按12回路分段基准推导。
GZRQ_BAND_BY_FRONT = {
    1: "TP304H",
    **{k: "T91" for k in (2, 3, 4)},
    **{k: "12CrMoVG" for k in (5, 6, 7)},
}
FRONT_BAND_BATCHES = ("2022年1号机A修", "2021年2号机A修")
# 用户确认（2026-10-31）：高过每屏24根，F001–F024 ↔ B024–B001；L001–L032 ↔ R032–R001。
GGRQ_TUBES_PER_SCREEN = 24
BATCH_META = {
    "2026年1号机C修": {"year": 2026, "unit": 1, "date": "2026-04"},
    "2022年1号机A修": {"year": 2022, "unit": 1, "date": "2022-10"},
    "2021年2号机A修": {"year": 2021, "unit": 2, "date": "2021-11"},
}
SYS_MAP = {"高温过热器": "GGRQ", "高温再热器": "GZRQ"}
IMPORT_HEADERS = [
    "数据分类", "炉号", "日期", "管段编码", "规格", "材质", "厚度(mm)",
    "硬度(HB)", "事件类型/更换原因", "关联新管码", "详细描述/结论",
    "检修批次", "来源ID", "源工作表", "源表行号", "源展开序号",
    "批次流水号", "记录来源", "日期精度", "检测结果", "结果性质", "原始编码",
]
CODE_RE = re.compile(
    r"^(?P<unit>[12])G-(?P<sys>GGRQ|GZRQ)-GQ-"
    r"(?P<screen>[LR]\d{3})-(?P<tube>[FBUD]\d{3})-"
    r"(?P<kind>[QW])(?P<serial>\d{1,3})?$"
)
SUMMARY_RE = re.compile(
    r"(?P<start>\d+)\s*-\s*(?P<end>\d+)屏的?炉(?P<direction>前|后)"
    r"第(?P<tubes>\d+(?:/\d+)*)根共(?P<qty>\d+)个弯头"
)
MONTH_NOTE = "日期精度=月，日未提供（月份为用户确认的检修月份）"
OBSERVED_ANOMALY = "发现异物，割开检查为氧化皮"
FIXED_TIME = datetime(2000, 1, 1)


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def lines(value: Any) -> list[str]:
    return [part.strip() for part in text(value).splitlines() if part.strip()]


def normalize_spec(value: str) -> str:
    return re.sub(r"\s+", "", value).replace("mm", "").replace("MM", "").replace("φ", "Φ")


def normalize_material_name(value: str) -> str:
    text = value.strip()
    return MATERIAL_NAME_MAP.get(text.upper(), text)


def unique(values: list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


@dataclass
class Record:
    batch: str
    year: int
    unit: int
    source_row: int
    source_seq: str
    item_order: int
    source_order: int
    system: str
    location_key: str
    part_kind: str
    source_code: str
    source_code_line: int | None
    origin: str
    source_position: str
    position: str
    spec_candidates: tuple[str, ...]
    material_candidates: tuple[str, ...]
    spec: str
    material: str
    method: str
    source_result: str
    result: str
    result_nature: str
    remark: str
    spec_basis_note: str = ""
    material_basis_note: str = ""
    notes: list[str] = field(default_factory=list)
    import_serial: int | None = None
    code: str = ""
    disposition: str = "导入"
    duplicate_of: str = ""

    @property
    def source_id(self) -> str:
        return f"{self.batch}!R{self.source_row}#{self.item_order:03d}"

    @property
    def date(self) -> str:
        return BATCH_META[self.batch]["date"]

    @property
    def spec_basis(self) -> str:
        return self.spec_basis_note or ("源行单值，仅格式规范化" if self.spec else "多值或未提供，待确认；未按W流水号分配")

    @property
    def material_basis(self) -> str:
        return self.material_basis_note or ("源行单值，保留原牌号" if self.material else "多值或未提供，待确认；未按W流水号分配")

    @property
    def desc(self) -> str:
        """导入用「详细描述/结论」：只描述检测内容本身（方法/结果/待确认提示）。
        批次、来源ID、位置、依据注记、原备注等溯源信息一律走专属列与审计工作簿，不进描述。"""
        parts = [f"方法：{self.method or '未提供'}", f"结果：{self.result or '未提供'}"]
        if not self.material:
            parts.append("材质待确认；源候选：" + (" / ".join(self.material_candidates) or "未提供"))
        if not self.spec:
            parts.append("规格待确认；源候选：" + (" / ".join(self.spec_candidates) or "未提供"))
        return "；".join(parts)

    def import_row(self) -> list[Any]:
        if self.disposition != "导入" or not self.code:
            raise ValueError(f"隔离候选不可导入：{self.source_id}")
        return [
            "事件", self.unit, self.date, self.code, self.spec, self.material, "", "",
            "无损检测", "", self.desc, self.batch, self.source_id, self.batch,
            self.source_row, self.item_order, self.import_serial, self.origin, "月",
            self.result, self.result_nature, self.source_code,
        ]

    def duplicate_key(self) -> tuple[Any, ...]:
        # 只隔离同批次内事实内容完全相同、无独立来源序号区分的重复项。
        # 不跨批次查重；相同位置但不同结果/备注/来源序号保留为不同事件。
        return (
            self.batch, self.location_key, self.part_kind, self.origin, self.source_seq,
            self.source_code, self.source_position, self.spec_candidates,
            self.material_candidates, self.method, self.source_result, self.remark,
        )


@dataclass
class CleanResult:
    source_path: str
    source_sha256: str
    source_rules: str
    candidates: list[Record]
    source_rows: list[dict[str, Any]]
    issues: list[dict[str, Any]]

    @property
    def records(self) -> list[Record]:
        return [r for r in self.candidates if r.disposition == "导入"]

    @property
    def isolated(self) -> list[Record]:
        return [r for r in self.candidates if r.disposition != "导入"]

    @property
    def supplement(self) -> list[Record]:
        return [r for r in self.records if r.origin == "汇总展开"]

    def statistics(self) -> dict[str, Any]:
        return {
            "candidate_count": len(self.candidates),
            "import_count": len(self.records),
            "isolated_count": len(self.isolated),
            "summary_expanded_without_source_code": len(self.supplement),
            "confirmed_physical_tube_count": None,
            "by_batch": {
                batch: {
                    "candidates": sum(r.batch == batch for r in self.candidates),
                    "imported": sum(r.batch == batch for r in self.records),
                    "isolated": sum(r.batch == batch for r in self.isolated),
                    "summary_expanded": sum(r.batch == batch for r in self.supplement),
                } for batch in BATCH_META
            },
            "imported_by_system": dict(Counter(r.system for r in self.records)),
            "imported_by_result_nature": dict(Counter(r.result_nature for r in self.records)),
            "imported_material_unconfirmed": sum(not r.material for r in self.records),
            "imported_spec_unconfirmed": sum(not r.spec for r in self.records),
        }


def issue(code: str, level: str, batch: str, rows: list[int], problem: str,
          handling: str, confirmation: list[str] | None = None) -> dict[str, Any]:
    return {"id": code, "level": level, "batch": batch, "source_rows": rows,
            "problem": problem, "handling": handling,
            "requires_user_confirmation": confirmation or []}


def parse_source_code(raw: str, batch: str, system: str, position: str) -> tuple[str, str, list[str]]:
    clean = re.sub(r"[（(]异物[）)]\s*$", "", raw).strip()
    match = CODE_RE.fullmatch(clean)
    if not match or match["sys"] != SYS_MAP.get(system):
        raise ValueError(f"{batch} 编码无法按已知系统解析，拒绝丢弃或猜码：{raw}")
    notes = []
    unit = BATCH_META[batch]["unit"]
    if match["unit"] != str(unit):
        notes.append(f"机组按已确认批次修正：{match['unit']}G→{unit}G")
    screen = match["screen"]
    side = re.match(r"([AB])侧第(\d+)排", position)
    if side:
        if int(screen[1:]) != int(side[2]):
            raise ValueError(f"{batch} 编码排号与位置文字冲突，需先确认：{raw} / {position}")
        letter = "R" if side[1] == "A" else "L"
        if screen[0] != letter:
            notes.append(f"侧别按用户规则修正：{side[1]}侧→{letter}")
        screen = letter + screen[1:]
    return f"{unit}G-{match['sys']}-GQ-{screen}-{match['tube']}", match["kind"], notes


def expand_source_row(batch: str, row_num: int, raw: list[str], prior_count: int) -> list[Record]:
    seq, system, position, spec_raw, mat_raw, codes_raw, method, result_raw, remark = raw
    if system not in SYS_MAP:
        raise ValueError(f"{batch}!B{row_num} 未知系统，拒绝静默跳行：{system}")
    specs = unique([normalize_spec(v) for v in lines(spec_raw)])
    materials = unique(normalize_material_name(v) for v in lines(mat_raw))
    spec = specs[0] if len(specs) == 1 else ""
    material = materials[0] if len(materials) == 1 else ""
    codes = lines(codes_raw)
    atoms: list[dict[str, Any]] = []
    mirror_note = ""
    summary = SUMMARY_RE.fullmatch(position)
    if summary:
        if batch != "2026年1号机C修":
            raise ValueError("目前只证实2026批次的屏号汇总枚举口径；其他批次汇总需确认")
        start, end = int(summary["start"]), int(summary["end"])
        tubes = [int(v) for v in summary["tubes"].split("/")]
        qty = int(summary["qty"])
        if start < 1 or end < start or end > 999 or any(t < 1 or t > 999 for t in tubes):
            raise ValueError(f"汇总位置范围不合法：{batch}!C{row_num}")
        if len(set(tubes)) != len(tubes) or qty != (end - start + 1) * len(tubes):
            raise ValueError(f"汇总总量与位置枚举不一致：{batch}!C{row_num}")
        direction = "F" if summary["direction"] == "前" else "B"
        if direction == "B":
            if batch != "2026年1号机C修" or system != "高温过热器":
                raise ValueError("炉后计数目前仅2026高过已确认每屏24根；其他批次需先确认再镜像")
            tubes = [GGRQ_TUBES_PER_SCREEN + 1 - t for t in tubes]
            direction = "F"
            mirror_note = "用户已确认高过每屏24根（F001–F024↔B024–B001）：源“炉后第{0}根”≙F{1:03d}，编码落规范方向F".format(
                "+".join(str(GGRQ_TUBES_PER_SCREEN + 1 - t) for t in sorted(tubes, reverse=True)),
                min(tubes))
        locations = [f"{BATCH_META[batch]['unit']}G-{SYS_MAP[system]}-GQ-L{s:03d}-{direction}{t:03d}"
                     for s in range(start, end + 1) for t in tubes]
        anomalies: dict[str, tuple[str, int, list[str]]] = {}
        if codes and not ("其余合格" in result_raw and "割开" in result_raw and "氧化皮" in result_raw):
            raise ValueError(f"汇总异常/合格分组依据不足：{batch}!H{row_num}")
        for code_line, original in enumerate(codes, 1):
            loc, kind, notes = parse_source_code(original, batch, system, position)
            if kind != "W" or loc not in locations or loc in anomalies or "异物" not in original:
                raise ValueError(f"汇总异常位置不唯一或超出汇总范围：{batch}!F{row_num} {original}")
            anomalies[loc] = (original, code_line, notes)
        if not codes and result_raw != "合格":
            raise ValueError(f"无码汇总结果不明确，禁止默认合格：{batch}!H{row_num}")
        for loc in locations:
            original, code_line, notes = anomalies.get(loc, ("", None, []))
            abnormal = loc in anomalies
            atoms.append({
                "location": loc, "kind": "W", "code": original, "code_line": code_line,
                "origin": "原始编码" if abnormal else "汇总展开",
                "result": OBSERVED_ANOMALY if abnormal else "合格",
                "nature": "异常观察" if abnormal else "原文合格",
                "notes": notes + (["合格依据：源汇总行明确记载其余合格"] if codes and not abnormal else []),
            })
    else:
        if not codes:
            raise ValueError(f"无码且无法确定枚举位置，禁止猜测数量或位置：{batch}!F{row_num}")
        correction = SOURCE_ROW_CORRECTIONS.get((batch, row_num))
        for code_line, original in enumerate(codes, 1):
            loc, kind, notes = parse_source_code(original, batch, system, position)
            if correction:
                old_seg, new_seg = correction["replace"]
                assert old_seg in loc, f"行修正目标不存在：{batch}!F{row_num} {loc}"
                loc = loc.replace(old_seg, new_seg)
                notes = notes + [correction["reason"] + f"，编码按{new_seg}修正"]
            atoms.append({
                "location": loc, "kind": kind, "code": original, "code_line": code_line,
                "origin": "原始编码", "result": result_raw,
                "nature": "原文合格" if result_raw == "合格" else "源文结论" if result_raw else "未提供",
                "notes": notes,
            })
    records = []
    front_band = None
    if batch in FRONT_BAND_BATCHES and "炉后往炉前数" in remark and system == "高温再热器":
        front_band = GZRQ_BAND_BY_FRONT
    for i, atom in enumerate(atoms, 1):
        notes = list(atom["notes"])
        material_note = ""
        spec_note = ""
        if system == "高温过热器" and atom["kind"] == "W" and len(materials) > 1:
            match = re.fullmatch(r".*-F(\d{3})", atom["location"])
            leg = int(match[1]) if match else 0
            if leg:
                bend_spec, bend_mat = ggrq_bottom_bend_attrs(leg)
                full = next((c for c in materials if bend_mat.upper() in c.upper()), "")
                if full:
                    material = full
                    material_note = "按高过12回路分段基准映射（图纸148M211-0，用户确认）"
                    if bend_spec in specs:
                        spec = bend_spec
                        spec_note = "按回路底弯段规格（图纸148M211-0）"
                    else:
                        notes.append(f"回路底弯段规格{bend_spec}不在源行候选内，规格留待核")
                    loop_no = leg if leg <= 12 else GGRQ_TUBES_PER_SCREEN + 1 - leg
                    notes.append(f"材质按回路分段基准映射：F{leg:03d}=回路{loop_no}底弯段→{bend_spec} {bend_mat}")
                else:
                    notes.append(f"回路分段基准材质{bend_mat}不在源行候选内，保留源行材质")
        if front_band and atom["kind"] == "W":
            match = re.fullmatch(r".*-F(\d{3})", atom["location"])
            leg = int(match[1]) if match else 0
            shorthand = normalize_material_name(front_band.get(leg)) if leg else None
            full = next((c for c in materials if shorthand and shorthand.upper() in c.upper()), "") if shorthand else ""
            if full:
                material = full
                if len(specs) > 1:
                    spec = specs[min(materials.index(full), len(specs) - 1)]
                    spec_note = "按区带材质与源行规格-材质配对"
                material_note = "按用户确认F001起为炉前至炉后第1根与备注区带映射（备注“炉后往炉前数”为方向笔误）"
                notes.append(f"材质按管位区带映射：F{leg:03d}=第{leg}弯头→{shorthand}")
        if len(materials) > 1 and not material_note:
            notes.append("材质区带对应未确认，不按清单流水推断")
        if mirror_note:
            notes.append(mirror_note)
        row_correction = SOURCE_ROW_CORRECTIONS.get((batch, row_num))
        if row_correction and "spec" in row_correction:
            spec = row_correction["spec"]
            spec_note = row_correction["reason"]
            notes.append("规格按图纸148M211-0（高温过热器材料分界图）确认为Φ51×8；源表Φ54×7.5为笔误")
        records.append(Record(
            batch=batch, year=BATCH_META[batch]["year"], unit=BATCH_META[batch]["unit"],
            source_row=row_num, source_seq=seq, item_order=i, source_order=prior_count + i,
            system=system, location_key=atom["location"], part_kind=atom["kind"],
            source_code=atom["code"], source_code_line=atom["code_line"], origin=atom["origin"],
            source_position=position, position=atom["location"].split("-GQ-", 1)[1] + "；源位置：" + position,
            spec_candidates=specs, material_candidates=materials, spec=spec, material=material,
            method=method, source_result=result_raw, result=atom["result"],
            result_nature=atom["nature"], remark=remark,
            spec_basis_note=spec_note, material_basis_note=material_note, notes=notes,
        ))
    return records


def clean_source(path: Path | str) -> CleanResult:
    source = Path(path).resolve()
    source_bytes = source.read_bytes()
    workbook = openpyxl.load_workbook(io.BytesIO(source_bytes), read_only=True, data_only=False)
    candidates: list[Record] = []
    source_rows: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    try:
        missing = set(BATCH_META) - set(workbook.sheetnames)
        if missing:
            raise ValueError(f"缺少检修批次工作表：{sorted(missing)}")
        source_rules = text(workbook["编号说明"]["A3"].value) if "编号说明" in workbook.sheetnames else ""
        for batch in BATCH_META:
            sheet = workbook[batch]
            order = 0
            for row_num, cells in enumerate(sheet.iter_rows(min_row=4, max_col=9), 4):
                if any(cell.data_type == "f" for cell in cells):
                    raise ValueError(f"{batch}!{row_num} 包含公式，不能把未核验缓存当事实")
                raw = [text(c.value) for c in cells]
                if not any(raw):
                    continue
                records = expand_source_row(batch, row_num, raw, order)
                order += len(records)
                candidates.extend(records)
                source_rows.append({"batch": batch, "row": row_num, "raw_cells": dict(zip("ABCDEFGHI", raw)),
                                    "candidate_ids": [r.source_id for r in records], "expanded_count": len(records)})
                if not records[0].material or not records[0].spec:
                    issues.append(issue("UNCONFIRMED_ATTRIBUTES", "高", batch, [row_num],
                                        "多值材质/规格的逐管对应（12/7弯头区带与每屏24根的关系及计数方向）未确认",
                                        "材质规格留空；候选列表、原备注与依据注记保留在审计工作簿，导入描述只含方法/结果",
                                        ["2022/2021的12/7弯头区带对应前12根还是后12根、按哪个方向计数"]))
                if SUMMARY_RE.fullmatch(raw[2]):
                    issues.append(issue("SUMMARY_EXPANSION", "说明", batch, [row_num],
                                        f"汇总行展开{len(records)}条，含{sum(r.result_nature == '异常观察' for r in records)}条异常观察",
                                        "按本源行屏号/管位枚举；仅排除本批次本汇总的异常位置，不扣除其他年度检查"))
                    if "炉后" in raw[2]:
                        issues.append(issue("GEOMETRY_CONFIRMED", "说明", batch, [row_num],
                                            "高过每屏24根已由用户确认（F001–F024↔B024–B001、L001–L032↔R032–R001）",
                                            "炉后第N根镜像为F(25-N)规范方向；系统已启用同口径归一", []))
                    if records[0].spec == "Φ54×7.5" and records[0].material == "304H":
                        issues.append(issue("SOURCE_SPEC_REVIEW", "高", batch, [row_num],
                                            "本行明确规格Φ54×7.5、材质304H；材质304H与区带映射一致，Φ54×7.5与第4/5行配对(304H↔Φ51×8)不一致",
                                            "全64项一律保留本源行单值，不把59项擅改Φ51×8", ["该汇总行真实规格及牌号"]))
            issues.append(issue("MONTH_PRECISION", "说明", batch, [], "用户提供检修月份（2026-04/2022-10/2021-11），未提供具体“日”",
                                "日期写年月文本；每条描述注明日期精度=月；未生成01日", ["实际检测日（若可取得）"]))
    finally:
        workbook.close()

    seen: dict[tuple[Any, ...], Record] = {}
    for record in candidates:
        key = record.duplicate_key()
        if key in seen:
            original = seen[key]
            record.disposition = "隔离：源记录完全重复，位置待确认"
            record.duplicate_of = original.source_id
            record.notes.append("仅隔离重复候选，未改屏号；第27屏只能作为排列缺项的核对建议，不是事实")
            issues.append(issue("EXACT_DUPLICATE_QUARANTINED", "阻断候选", record.batch,
                                [original.source_row, record.source_row],
                                f"与{original.source_id}的原编码、位置、方法、结果、规格材质和备注完全相同",
                                "第一条保留，重复候选保留审计但不导入；未补造第27屏合格记录", ["重复第24屏是否应为第27屏或确为重复记录"]))
        else:
            seen[key] = record
    serials: Counter[str] = Counter()
    for record in candidates:
        if record.disposition == "导入":
            serials[record.batch] += 1
            if serials[record.batch] > 999:
                raise ValueError("批次流水号超过三位容量，必须先升级编码规则")
            record.import_serial = serials[record.batch]
            # 位置段唯一确定物理管/弯头；编码不带流水数字，跨批次同码=同部位历史复检。
            record.code = f"{record.location_key}-{record.part_kind}"
    result = CleanResult(str(source), digest(source_bytes), source_rules, candidates, source_rows, issues)
    errors = validate(result)
    if errors:
        raise ValueError("语义校验失败：" + "；".join(errors))
    if digest(source.read_bytes()) != result.source_sha256:
        raise ValueError("处理期间源文件改变，拒绝发布混合快照")
    return result


def validate(result: CleanResult) -> list[str]:
    errors: list[str] = []
    if len({r.source_id for r in result.candidates}) != len(result.candidates):
        errors.append("来源ID重复")
    if sum(row["expanded_count"] for row in result.source_rows) != len(result.candidates):
        errors.append("源行展开数量不守恒")
    by_id = {r.source_id: r for r in result.candidates}
    for batch, meta in BATCH_META.items():
        candidates = [r for r in result.candidates if r.batch == batch]
        records = [r for r in result.records if r.batch == batch]
        if [r.source_order for r in candidates] != list(range(1, len(candidates) + 1)):
            errors.append(f"{batch}候选源顺序不连续")
        if [(r.source_row, r.item_order) for r in candidates] != sorted((r.source_row, r.item_order) for r in candidates):
            errors.append(f"{batch}未遵循源清单顺序")
        if [r.import_serial for r in records] != list(range(1, len(records) + 1)):
            errors.append(f"{batch}流水号不连续或不唯一")
        if len({r.code for r in records}) != len(records):
            errors.append(f"{batch}导入编码重复")
        for r in candidates:
            if r.date != meta["date"]:
                errors.append(f"{r.source_id}日期精度丢失")
            if r.material and r.material not in r.material_candidates:
                errors.append(f"{r.source_id}材质不在源行候选内")
            if r.spec and r.spec not in r.spec_candidates and not r.spec_basis_note:
                errors.append(f"{r.source_id}规格不在源行候选内")
            if r.material and len(r.material_candidates) > 1 and not r.material_basis_note:
                errors.append(f"{r.source_id}多值材质行赋值必须有映射依据")
            if r.spec and len(r.spec_candidates) > 1 and not r.spec_basis_note:
                errors.append(f"{r.source_id}多值规格行赋值必须有映射依据")
            if r.disposition == "导入":
                match = CODE_RE.fullmatch(r.code)
                if not match or match["unit"] != str(meta["unit"]) or match["serial"] is not None:
                    errors.append(f"{r.source_id}编码必须是字母尾物理编码")
            else:
                prior = by_id.get(r.duplicate_of)
                if r.code or r.import_serial is not None or not prior or prior.duplicate_key() != r.duplicate_key():
                    errors.append(f"{r.source_id}隔离重复依据或导入状态错误")
    return errors


def load_style_base(root: Path | None) -> Any:
    """可选导入官方 templates/base.py；发布脚本无本机技能绝对路径依赖。"""
    if root is None:
        return None
    path = root / "templates" / "base.py"
    if not path.is_file():
        raise ValueError(f"样式根目录缺少templates/base.py：{root}")
    spec = importlib.util.spec_from_file_location("boiler_film_xlsx_base", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def style_sheet(sheet: Any, style: Any = None) -> None:
    # 导入器要求A1第一行就是表头，不能使用B2标题布局。
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.sheet_view.showGridLines = False
    sheet.print_title_rows = "1:1"
    if style is not None:
        style.style_header_row(sheet, 1, 1, sheet.max_column)
        for n in range(2, sheet.max_row + 1):
            style.style_data_row(sheet, n, 1, sheet.max_column, n - 2)
        style.auto_fit_columns(sheet, min_width=10, max_width=42, header_row=1, data_start_row=2)
    for row in sheet:
        for cell in row:
            cell.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
    wide = {"详细描述/结论": 95, "原备注": 80, "原始编码列": 48, "内容": 105,
            "问题": 70, "处理": 90, "位置": 65, "原位置": 65, "提示": 85,
            "管段编码": 37, "导入编码": 37, "原始编码": 40, "来源ID": 39,
            "原结果": 75, "日期": 12, "源文件": 95, "原始单元格": 95}
    sheet.column_dimensions["A"].width = 20
    for i, cell in enumerate(sheet[1], 1):
        if cell.value in wide:
            sheet.column_dimensions[get_column_letter(i)].width = wide[cell.value]
        elif style is None:
            sheet.column_dimensions[get_column_letter(i)].width = 22
        if cell.value == "日期":
            for row in sheet.iter_rows(min_row=2, min_col=i, max_col=i):
                row[0].number_format = "@"
    if style is not None:
        style.auto_fit_row_heights(sheet, header_row=1, data_start_row=2)
    # 自动换行须覆盖中英文、显式换行和表头，不能只根据单元格字符数缩减高度。
    for row in sheet:
        counts = []
        for cell in row:
            width = max(1, sheet.column_dimensions[cell.column_letter].width - 2)
            counts.append(sum(max(1, math.ceil(sum(2.3 if unicodedata.east_asian_width(ch) in 'WF' else 1.15 for ch in part) / width)) for part in str(cell.value or '').split('\n')))
        sheet.row_dimensions[row[0].row].height = min(409, max(sheet.row_dimensions[row[0].row].height or 0, 32, max(counts, default=1) * 19 + 12))
    sheet.page_setup.orientation = 'landscape'
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.fitToWidth = 1 if sheet.title == '导入数据' else 0
    sheet.page_setup.fitToHeight = 0


def append_table(workbook: Any, name: str, headers: list[str], rows: list[list[Any]], style: Any) -> None:
    sheet = workbook.create_sheet(name)
    for row in [headers, *rows]:
        sheet.append(["'" + value if isinstance(value, str) and value.startswith("=") else value for value in row])
    style_sheet(sheet, style)


def save_deterministic_workbook(path: Path, workbook: Any) -> None:
    """固定构建元数据/ZIP时间使同一输入重复构建字节一致；不写检测日期。"""
    workbook.properties.creator = "Z.ai"
    workbook.properties.created = FIXED_TIME
    workbook.properties.modified = FIXED_TIME
    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as source, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out:
        for name in sorted(source.namelist()):
            content = source.read(name)
            if name == "docProps/core.xml":
                root = ET.fromstring(content)
                for tag in ("created", "modified"):
                    node = root.find("{http://purl.org/dc/terms/}" + tag)
                    if node is not None:
                        node.text = "2000-01-01T00:00:00Z"
                content = ET.tostring(root, encoding="utf-8")
            entry = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(entry, content)


def write_import_workbook(path: Path, records: list[Record], style: Any = None) -> None:
    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    append_table(workbook, "导入数据", IMPORT_HEADERS, [r.import_row() for r in records], style)
    save_deterministic_workbook(path, workbook)


def release_notes(result: CleanResult) -> str:
    stats = result.statistics()
    details = "\n".join(f"- {b}：候选{v['candidates']}，隔离{v['isolated']}，正式导入{v['imported']}，其中汇总展开{v['summary_expanded']}。"
                        for b, v in stats["by_batch"].items())
    return (
        f"锅炉拍片记录保守清洗发布说明\n规则版本：{RULE_VERSION}\n源文件：{result.source_path}\n"
        f"源SHA256：{result.source_sha256}\n\n"
        f"一、总量（检查清单条次，不是独立物理管根数）\n"
        f"全量候选{len(result.candidates)}，正式导入{len(result.records)}（含用户确认修正的第27屏）。\n{details}\n"
        f"汇总展开{len(result.supplement)}条已经包含在全部批次及对应单批次文件，不要重复叠加。\n\n"
        "二、导入边界\n"
        "编码为位置物理身份，不带流水数字（例 1G-GGRQ-GQ-L002-F004-W）；批次流水号只保留在溯源列。\n"
        "同一根管不同年份的检查共用同一编码，历史按日期聚合检索；跨批次同码是正常复检，不是重复。\n"
        "不得与旧版373条或旧91条直接叠加；已导入旧包时必须先备份，"
        "由主系统按来源逐条迁移/替换并核验，不能只依赖编码查重。\n"
        "优先选择本包导入_全部批次.xlsx一次导入；单批次文件是其分片，不是额外数据。\n"
        "增量_2026年1号机C修_汇总展开文件仅用于本规则版本同源包的分阶段导入/追溯；"
        "其来源ID及编码与全部批次文件完全相同，不是旧包的兼容补丁。\n"
        "日期列为年份文本，不是假定01-01。目标导入器若不支持年精度，应停止导入并补真实日期，禁止自动补月日。\n"
        "结构校验/能读入文件不等于生命周期可用；目标系统仍须保留来源ID、日期精度、异常观察，"
        "按物理管身份关联W/Q部位与跨批次事件，不得把本批次流水号当永久管ID。\n\n"
        "三、已落实的规则\n"
        "机组：2026=1号机C修、2022=1号机A修、2021=2号机A修；A侧R、B侧L。\n"
        "自v9起导入「详细描述/结论」只含检测内容（方法/结果与待确认提示）；批次、来源ID、位置、"
        "依据注记、原备注等溯源信息全部在导入表专属列与审计工作簿，不再堆进描述。\n"
        "目标系统按来源ID识别同源记录：重导本包将更新既有记录的描述，不会产生重复。\n"
        "源2026第32行“第24屏”经用户确认实为第27屏，已按L027导入（第29行L024保留）。\n"
        "材质写法统一全称（SA-213TP304H/SA-213TP347H/SA-213T91）；12CrMoVG经用户确认实为12Cr1MoVG。\n"
        "高过弯头材质/规格按用户确认的12回路分段基准（图纸148M211-0）推导：回路=前腿F00k(向下)+"
        "后腿F(25-k)(向上)，底弯件=前腿末段——回路1=Φ54×7.5 TP347H、回路2-4=Φ51×8 TP304H、"
        "回路5-7及12=Φ51×8 T91、回路8-11=Φ51×9 12Cr1MoVG；据此T91底弯规格由配对的Φ51×9修正为Φ51×8。\n"
        "按源行及行内清单顺序展开，隔离项不占流水；批次流水号（溯源列）按各批次源行与行内展开顺序连续且唯一。"
        "source_order是含隔离项的候选顺序，import_serial是正式事件流水；两者均不代表物理弯头编号，且不进入编码。\n"
        "源2026第38行枚举1–32屏F002/F003共64项；5个原异常位置为L013-F002、L005-F002、"
        "L004-F003、L010-F002、L025-F002，仅写“发现异物，割开检查为氧化皮”，不新增不合格判定。"
        "其余59项按原文其余合格；64项规格经图纸148M211-0确认为Φ51×8（源表Φ54×7.5为笔误，已更正），"
        "与回路2-4底弯段Φ51×8 TP304H一致。\n"
        "源2026第39行展开32项，结果、Φ54×7.5和TP347H均来自本行；按确认几何编码落F024（B001≙F024），"
        "与回路1底弯段Φ54×7.5 TP347H一致。"
        "只排除同批本汇总的5异常，不因其他年度检查而删除本年度事件。\n\n"
        "四、仍需确认，未冒充事实\n"
        "高过弯头材质/规格已按12回路分段基准填入（2026第4/5行32条、2022/2021高过152条），"
        "高再仍按前7根区带映射（Φ60×4），依据逐条记录在材质/规格依据列。\n"
        "高再（7根）回路分段表待高再材料分界图提供后照此办理。"
        "仅实际检测“日”未提供（月份已确认），取得后可替换提升分析精度。\n"
        "五、追溯和验证\n"
        "manifest.json包含源文件/清洗器SHA256、规则版本、每条来源映射、问题清单、产物SHA256。"
        "审计工作簿保留全464个来源候选（当前附件），隔离表不可导入。\n"
        "仅在全部文件生成及回读核验通过后原子发布；已有不同内容/锁文件时拒绝覆盖。"
        "同输入及规则重跑验证现有包后不写入；新目录重建得到相同字节。\n"
        "所有表为可程序核验的静态事实/统计，无公式；工作簿构建元数据使用固定时间以保证字节可复现，"
        "不代表检修日期。\n"
    )


def write_audit(path: Path, result: CleanResult, style: Any) -> None:
    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    notes = [["规则版本", RULE_VERSION], ["源文件", result.source_path], ["源SHA256", result.source_sha256],
             ["发布边界", "全部批次包含汇总展开91项；本版不与旧373/91直接叠加；年精度须目标系统支持"],
             ["物理身份", "编码=位置+Q/W字母尾，永久唯一；流水号只在溯源列；高过每屏24根及F↔B、L↔R镜像为用户确认口径"],
             ["日期", MONTH_NOTE], ["原编号说明", result.source_rules]]
    append_table(workbook, "发布说明", ["项目", "内容"], notes, style)
    stats = result.statistics()
    append_table(workbook, "批次统计", ["检修批次", "候选条次", "隔离重复", "正式条次", "含汇总展开", "口径"],
                 [[b, v["candidates"], v["isolated"], v["imported"], v["summary_expanded"], "检查条次，非物理根数"]
                  for b, v in stats["by_batch"].items()], style)
    headers = ["来源ID", "检修批次", "源表行号", "原清单序号", "源展开序号", "批次候选顺序", "批次流水号",
               "状态", "重复来源ID", "原始编码", "导入编码", "位置", "规格", "材质", "源规格候选", "源材质候选",
               "规格依据", "材质依据", "日期", "日期精度", "方法", "检测结果", "结果性质", "原结果", "原备注", "提示"]
    def audit_row(r: Record) -> list[Any]:
        return [r.source_id, r.batch, r.source_row, r.source_seq, r.item_order, r.source_order, r.import_serial,
                r.disposition, r.duplicate_of, r.source_code, r.code, r.position, r.spec, r.material,
                " / ".join(r.spec_candidates), " / ".join(r.material_candidates), r.spec_basis, r.material_basis,
                r.date, "月", r.method, r.result, r.result_nature, r.source_result, r.remark, "；".join(r.notes)]
    append_table(workbook, "全量候选", headers, [audit_row(r) for r in result.candidates], style)
    append_table(workbook, "隔离重复不可导入", headers, [audit_row(r) for r in result.isolated], style)
    append_table(workbook, "汇总展开追溯", headers, [audit_row(r) for r in result.supplement], style)
    append_table(workbook, "来源行映射", ["检修批次", "源表行号", "展开数量", "原位置", "原始编码列", "原结果", "原备注", "原始单元格"],
                 [[r["batch"], r["row"], r["expanded_count"], r["raw_cells"]["C"], r["raw_cells"]["F"],
                   r["raw_cells"]["H"], r["raw_cells"]["I"], json.dumps(r["raw_cells"], ensure_ascii=False)] for r in result.source_rows], style)
    append_table(workbook, "问题清单", ["编号", "级别", "检修批次", "源表行号", "问题", "处理", "需用户确认"],
                 [[i["id"], i["level"], i["batch"], "/".join(map(str, i["source_rows"])), i["problem"],
                   i["handling"], " / ".join(i["requires_user_confirmation"])] for i in result.issues], style)
    append_table(workbook, "语义自检", ["检查", "结果", "说明"], [
        ["来源条次守恒", "通过", f"{len(result.candidates)}={len(result.records)}+{len(result.isolated)}"],
        ["批次流水唯一/顺序", "通过", "正式流水按各批次源行与行内展开顺序连续；不设物理弯头上限7/24"],
        ["材质规格不推断", "通过", "仅源行单值进入单值字段，多值候选留审计/描述"],
        ["日期不虚构月日", "通过", "文本YYYY；年精度逐行标明"],
        ["几何/根数", "未确认", "B001保持原计数；清单条次不是独立物理管数"],
        ["生命周期端到端", "不在本清洗包内证明", "需目标系统支持年精度、异常状态、部位/物理身份关联和来源追溯"],
    ], style)
    save_deterministic_workbook(path, workbook)


def verify_import_file(path: Path, records: list[Record]) -> None:
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        sheet = workbook.active
        actual = [["" if v is None else v for v in row] for row in sheet.values]
        if actual != [IMPORT_HEADERS, *[r.import_row() for r in records]]:
            raise ValueError(f"产物回读与内存语义不一致：{path.name}")
        for row in sheet.iter_rows(min_row=2):
            if row[2].data_type != "s" or row[2].value not in {"2026-04", "2022-10", "2021-11"}:
                raise ValueError("日期必须为年月文本，禁止Excel日期序号或虚构日期")
            if any(c.data_type in {"f", "e"} for c in row):
                raise ValueError(f"产物含公式或错误单元格：{path.name}")
    finally:
        workbook.close()


def semantic_payload(result: CleanResult) -> dict[str, Any]:
    imported_row = {r.source_id: i for i, r in enumerate(result.records, 2)}
    row_map = [{**asdict(r), "source_id": r.source_id, "date": r.date, "date_precision": "year",
                "all_batches_excel_row": imported_row.get(r.source_id)} for r in result.candidates]
    return {"statistics": result.statistics(), "row_map": row_map, "source_rows": result.source_rows, "issues": result.issues}


def verify_existing_package(path: Path, package_id: str) -> dict[str, Any]:
    manifest_path = path / "manifest.json"
    if not manifest_path.is_file():
        raise FileExistsError("目标目录已存在但没有本版manifest；拒绝覆盖，请指定新的空目录")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("package_id") != package_id:
        raise FileExistsError("目标已有不同源文件/规则/清洗器/样式版本；拒绝混写，请指定新目录")
    artifacts = manifest.get("artifacts", [])
    if not artifacts or {p.name for p in path.iterdir()} != {a["file"] for a in artifacts} | {"manifest.json"}:
        raise ValueError("已有包文件清单与manifest不符，拒绝将不完整包标为成功")
    for item in artifacts:
        if Path(item["file"]).name != item["file"] or digest((path / item["file"]).read_bytes()) != item["sha256"]:
            raise ValueError("已有产物SHA256不符，拒绝覆盖；请先核实是否被用户编辑")
    return manifest


def publish(result: CleanResult, outdir: Path | str, style_root: Path | None = None,
            font_name: str | None = None) -> dict[str, Any]:
    outdir = Path(outdir).resolve()
    source = Path(result.source_path)
    if source.is_relative_to(outdir):
        raise ValueError("输出目录不得包含源文件")
    if validate(result):
        raise ValueError("语义校验失败，禁止发布")
    style = load_style_base(style_root)
    if style is not None and font_name:
        style.FONT_NAME = font_name
    style_hash = digest(json_bytes([digest((style_root / "templates" / "base.py").read_bytes()) if style_root else "plain", font_name]))
    cleaner_hash = digest(Path(__file__).read_bytes())
    payload = semantic_payload(result)
    semantic_hash = digest(json_bytes(payload))
    package_id = digest(json_bytes([RULE_VERSION, result.source_sha256, cleaner_hash, semantic_hash, style_hash]))
    outdir.parent.mkdir(parents=True, exist_ok=True)
    lock = outdir.parent / ("." + outdir.name + ".publish.lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise FileExistsError("发布锁已存在；不得并发写入或擅自移除锁") from exc
    staging: Path | None = None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"pid": os.getpid(), "package_id": package_id}))
        if digest(source.read_bytes()) != result.source_sha256:
            raise ValueError("源文件已改变，拒绝发布旧快照")
        if outdir.exists():
            return verify_existing_package(outdir, package_id)
        staging = Path(tempfile.mkdtemp(prefix="." + outdir.name + ".staging-", dir=outdir.parent))
        imports: dict[str, list[Record]] = {"导入_全部批次.xlsx": result.records}
        imports.update({f"导入_{b}.xlsx": [r for r in result.records if r.batch == b] for b in BATCH_META})
        if result.supplement:
            imports[f"增量_2026年1号机C修_汇总展开{len(result.supplement)}.xlsx"] = result.supplement
        for filename, records in imports.items():
            write_import_workbook(staging / filename, records, style)
            verify_import_file(staging / filename, records)
        with (staging / "导入_全部批次.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(IMPORT_HEADERS)
            writer.writerows(r.import_row() for r in result.records)
        with (staging / "导入_全部批次.csv").open(encoding="utf-8-sig", newline="") as handle:
            if list(csv.reader(handle)) != [[str(v) if v is not None else "" for v in row]
                                            for row in [IMPORT_HEADERS, *[r.import_row() for r in result.records]]]:
                raise ValueError("CSV回读不一致")
        write_audit(staging / "数据清洗审计.xlsx", result, style)
        (staging / "导入发布说明.txt").write_text(release_notes(result), encoding="utf-8")
        artifacts = [{"file": p.name, "sha256": digest(p.read_bytes()), "bytes": p.stat().st_size,
                      "role": "import_subset_already_in_all" if p.name.startswith("增量_") else "import" if p.name in imports or p.suffix == ".csv" else "audit",
                      "records": len(imports[p.name]) if p.name in imports else len(result.records) if p.suffix == ".csv" else None}
                     for p in sorted(staging.iterdir())]
        manifest = {"package_id": package_id, "rule_version": RULE_VERSION,
                    "source": {"path": result.source_path, "sha256": result.source_sha256, "read_only": True},
                    "cleaner_sha256": cleaner_hash, "style_base_sha256": style_hash,
                    "semantic_sha256": semantic_hash, "artifacts": artifacts,
                    "import_warning": "字母尾物理编码；464条含91展开与确认的L027；月精度日期须目标系统支持；不得与旧版叠加",
                    **payload}
        (staging / "manifest.json").write_bytes(json_bytes(manifest))
        verify_existing_package(staging, package_id)
        if digest(source.read_bytes()) != result.source_sha256:
            raise ValueError("发布前源文件改变，拒绝发布")
        if outdir.exists():
            raise FileExistsError("发布时目标目录已出现，拒绝覆盖")
        os.rename(staging, outdir)
        staging = None
        return manifest
    finally:
        if staging is not None:
            shutil.rmtree(staging)
        lock.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path.home() / "Desktop" / "锅炉拍片记录1.xlsx")
    parser.add_argument("--outdir", type=Path, default=Path(__file__).resolve().parents[1] / "data-cleaning" / "verified")
    parser.add_argument("--style-root", type=Path, help="可选的官方xlsx技能根目录；从templates/base.py导入样式，不是运行依赖")
    parser.add_argument("--font-name", help="可选的已安装字体名称，用于显式加载的样式模板")
    parser.add_argument("--check-only", action="store_true", help="只读构建与语义校验，不发布任何文件")
    args = parser.parse_args(argv)
    try:
        result = clean_source(args.input)
        if not args.check_only:
            publish(result, args.outdir, args.style_root, args.font_name)
        print(json.dumps({"mode": "check-only" if args.check_only else "published-or-verified",
                          "source_sha256": result.source_sha256, **result.statistics()}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as exc:
        print(f"清洗未发布：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
