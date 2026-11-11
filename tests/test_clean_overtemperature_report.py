# -*- coding: utf-8 -*-
"""清洗脚本回归：只按"每月哪些点超温、超温多久"的口径，管屏留空待检修确认。"""
import importlib.util
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('clean_overtemperature_report', ROOT / 'scripts/clean_overtemperature_report.py')
clean = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = clean
SPEC.loader.exec_module(clean)


class HeaderAndValueTests(unittest.TestCase):
    def test_header_key_strips_question_marks_and_fullwidth(self):
        self.assertEqual(clean.header_key('限值 ？'), '限值')
        self.assertEqual(clean.header_key('总时长（秒）'), '总时长(秒)')
        self.assertEqual(clean.header_key(' DCS Tag '), 'dcs tag')

    def test_parse_seconds_clock_and_numbers(self):
        self.assertEqual(clean.parse_seconds('00:01:23'), 83)
        # 两位时钟按 H:MM 解析，与 overtemperature-import 的 JS 解析约定一致
        self.assertEqual(clean.parse_seconds('01:10'), 4200)
        self.assertEqual(clean.parse_seconds(90), 90)
        self.assertEqual(clean.parse_seconds(0.5), 43200)  # Excel 时间分数
        self.assertIsNone(clean.parse_seconds('abc'))
        self.assertIsNone(clean.parse_seconds(''))

    def test_parse_time_accepts_strings_datetime_and_serial(self):
        self.assertEqual(clean.parse_time('2026-10-09 12:59:19'), datetime(2026, 10, 9, 12, 59, 19))
        self.assertEqual(clean.parse_time('2026/10/09 12:59'), datetime(2026, 10, 9, 12, 59))
        self.assertEqual(clean.parse_time(datetime(2026, 10, 9, 0, 0)), datetime(2026, 10, 9, 0, 0))
        self.assertEqual(clean.parse_time(45000.5), datetime(1899, 12, 30) + timedelta(days=45000.5))
        self.assertIsNone(clean.parse_time('不是时间'))
        self.assertIsNone(clean.parse_time(''))

    def test_unit_from_tag(self):
        self.assertEqual(clean.unit_from_tag('DCS1_LBA10CT001'), '1')
        self.assertEqual(clean.unit_from_tag('dcs2_hah61ct008'), '2')
        self.assertEqual(clean.unit_from_tag('OTHER'), '')

    def test_clock_formats(self):
        self.assertEqual(clean.clock(83), '00:01:23')
        self.assertEqual(clean.clock(2800), '00:46:40')
        self.assertEqual(clean.clock(0), '00:00:00')


class MergeTests(unittest.TestCase):
    def test_overlapping_intervals_count_once(self):
        start = datetime(2026, 10, 1, 10, 0)
        seconds = clean.merge_seconds([
            (start, start + timedelta(minutes=10)),
            (start + timedelta(minutes=5), start + timedelta(minutes=20)),
        ])
        self.assertEqual(seconds, 1200)  # 并集 20 分钟，不是 30 分钟相加

    def test_adjacent_intervals_merge(self):
        start = datetime(2026, 10, 1, 0, 0)
        seconds = clean.merge_seconds([
            (start, start + timedelta(minutes=1)),
            (start + timedelta(minutes=1), start + timedelta(minutes=2)),
        ])
        self.assertEqual(seconds, 120)

    def test_disjoint_intervals_sum(self):
        start = datetime(2026, 10, 1, 0, 0)
        seconds = clean.merge_seconds([
            (start, start + timedelta(seconds=60)),
            (start + timedelta(hours=2), start + timedelta(hours=2, seconds=30)),
        ])
        self.assertEqual(seconds, 90)


class NormalizeTests(unittest.TestCase):
    def row(self, **overrides):
        base = {
            'row': 2,
            '点位': 'DCS1_LBA10CT001', '描述': '过热蒸汽温度1', '班组': '丙班',
            '限值': 546, '最值': 546.9, '均值': 546.6, '越限类型': '越高限',
            '开始时间': '2026-10-16 00:22:10', '结束时间': '2026-10-16 00:23:32',
            '总时长(秒)': '00:01:22',
        }
        base.update(overrides)
        return base

    def test_valid_row_becomes_event(self):
        events, warnings = clean.normalize([self.row()])
        self.assertEqual(len(events), 1)
        self.assertEqual(warnings, [])
        event = events[0]
        self.assertEqual(event['tag'], 'DCS1_LBA10CT001')
        self.assertEqual(event['unit'], '1')
        self.assertEqual(event['seconds'], 82)
        self.assertEqual(event['limitC'], 546.0)
        self.assertEqual(event['peakC'], 546.9)
        self.assertEqual(event['overType'], '越高限')

    def test_duration_mismatch_beyond_tolerance_is_warning(self):
        events, warnings = clean.normalize([self.row(**{'总时长(秒)': '00:09:22'})])
        self.assertEqual(events, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn('总时长与起止差', warnings[0]['issues'][0])

    def test_small_drift_within_five_seconds_passes(self):
        events, warnings = clean.normalize([self.row(**{'总时长(秒)': '00:01:27'})])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['seconds'], 87)  # 偏差≤5秒保留报表申报时长，与导入侧口径一致
        self.assertEqual(warnings, [])

    def test_duplicate_interval_is_skipped(self):
        row = self.row()
        events, warnings = clean.normalize([row, dict(row, row=3)])
        self.assertEqual(len(events), 1)
        self.assertEqual(warnings[0]['issues'], ['重复区间，已跳过'])

    def test_end_not_after_start_is_rejected(self):
        events, warnings = clean.normalize([self.row(结束时间='2026-10-16 00:22:10')])
        self.assertEqual(events, [])
        self.assertIn('结束时间必须晚于开始时间', warnings[0]['issues'])

    def test_missing_limit_or_peak_is_rejected(self):
        events, warnings = clean.normalize([self.row(限值=''), self.row(row=3, 最值='')])
        self.assertEqual(events, [])
        self.assertEqual({warnings[0]['issues'][0], warnings[1]['issues'][0]}, {'限值无效', '最值无效'})


class AggregateTests(unittest.TestCase):
    def events(self):
        start = datetime(2026, 10, 16, 0, 22, 10)
        return [
            {'row': 2, 'tag': 'DCS1_LBA10CT001', 'name': '过热蒸汽温度1', 'crew': '丙班', 'limitC': 546.0,
             'peakC': 546.9, 'meanC': 546.6, 'overType': '越高限', 'startAt': start,
             'endAt': start + timedelta(seconds=60), 'seconds': 60, 'unit': '1'},
            {'row': 3, 'tag': 'DCS1_LBA10CT001', 'name': '过热蒸汽温度1', 'crew': '丙班', 'limitC': 546.0,
             'peakC': 547.1, 'meanC': 546.6, 'overType': '越高限', 'startAt': start + timedelta(seconds=30),
             'endAt': start + timedelta(seconds=120), 'seconds': 90, 'unit': '1'},
            {'row': 4, 'tag': 'DCS1_HAH61CT008', 'name': '全大屏过热器出口壁温8', 'crew': '丁班', 'limitC': 498.0,
             'peakC': 499.4, 'meanC': None, 'overType': '越高限', 'startAt': datetime(2026, 10, 16, 0, 48, 59),
             'endAt': datetime(2026, 10, 16, 0, 50, 4), 'seconds': 65, 'unit': '1'},
        ]

    def test_one_row_per_point_with_union_seconds_and_blank_panel(self):
        summary = clean.aggregate(self.events())
        self.assertEqual(len(summary), 2)
        first = summary[0]
        self.assertEqual((first['month'], first['unit'], first['tag']), ('2026-10', '1', 'DCS1_HAH61CT008'))
        steam = summary[1]
        self.assertEqual(steam['tag'], 'DCS1_LBA10CT001')
        self.assertEqual(steam['count'], 2)
        self.assertEqual(steam['seconds'], 120)  # 重叠 30 秒只计一次：60+90-30
        self.assertEqual(steam['longestSeconds'], 90)
        self.assertEqual(steam['peakC'], 547.1)
        self.assertEqual(steam['limitC'], 546.0)
        self.assertEqual(steam['panel'], '')  # 管屏留空，待机组检修确认


if __name__ == '__main__':
    unittest.main()
