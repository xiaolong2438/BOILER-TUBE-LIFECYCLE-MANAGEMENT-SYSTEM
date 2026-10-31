import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
import sys

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('clean_boiler_film_records', ROOT / 'scripts/clean_boiler_film_records.py')
clean = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = clean
SPEC.loader.exec_module(clean)


def fixture(path):
    wb = openpyxl.Workbook()
    wb.active.title = '编号说明'
    wb.active['A3'] = 'W是弯头；序号是批次流水号。'
    headers = ['序号', '系统', '具体位置', '规格', '材质', '编码', '检测方法', '检测结果', '备注']
    for batch in clean.BATCH_META:
        ws = wb.create_sheet(batch)
        ws.append([])
        ws.append([])
        ws.append(headers)
        if batch.startswith('2026'):
            ws.append([1, '高温过热器', '炉左至炉右第2屏第4根', 'Φ54×7.5mm\nΦ51×8mm', 'TP347H\n304H', '1G-GGRQ-GQ-L002-F004-W01', '射线', '合格', '炉后往炉前数第1弯头为TP347H'])
            row = [None, '高温过热器', '炉左至炉右第24屏第1根', 'Φ54×7.5mm', 'TP347H', '1G-GGRQ-GQ-L024-F001-W01', '射线', '合格', None]
            ws.append(row)
            ws.append(row)
            ws.append([None, '高温过热器', '1-3屏的炉前第2/3根共6个弯头', 'Φ54×7.5mm', '304H', '1G-GGRQ-GQ-L002-F002-W05（异物）', '射线', '第2屏第2根发现异物，割开检查为氧化皮，其余合格', None])
            ws.append([None, '高温过热器', '1-3屏的炉后第1根共3个弯头', 'Φ54×7.5mm', 'TP347H', None, '射线', '合格', None])
        else:
            # Deliberately reuse the 2026 position and the wrong boiler/side to
            # prove a different overhaul is not mistaken for a duplicate.
            wrong = 2 if batch.startswith('2022') else 1
            ws.append([1, '高温再热器', 'B侧第1排炉前至炉后第2根', 'Φ60×4mm', 'T91\n12CrMoVG', f'{wrong}G-GZRQ-GQ-R001-F002-W01', '射线', '合格', '炉后往炉前数第1弯头为TP304H'])
    wb.save(path)
    wb.close()


class CleaningSemanticsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.xlsx'
        fixture(self.source)
        self.before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.result = clean.clean_source(self.source)

    def tearDown(self):
        self.temp.cleanup()

    def test_source_totals_and_unique_batch_serials(self):
        self.assertEqual(len(self.result.candidates), 14)
        self.assertEqual(len(self.result.records), 13)
        self.assertEqual(len(self.result.isolated), 1)
        self.assertEqual(len(self.result.supplement), 8)
        for batch in clean.BATCH_META:
            records = [r for r in self.result.records if r.batch == batch]
            self.assertEqual([r.import_serial for r in records], list(range(1, len(records) + 1)))
            self.assertEqual([r.import_serial for r in records], list(range(1, len(records) + 1)))
            self.assertTrue(all(r.code == f"{r.location_key}-{r.part_kind}" for r in records),
                            "编码必须是字母尾物理编码，不含流水数字")
            self.assertTrue(all(r.code.startswith(f"{clean.BATCH_META[batch]['unit']}G-") for r in records))
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.before)

    def test_unknown_material_and_physical_location_are_not_guessed(self):
        first = self.result.records[0]
        self.assertEqual(first.spec, '')
        self.assertEqual(first.material, '')
        self.assertEqual(first.material_candidates, ('SA-213TP347H', 'SA-213TP304H'),
                        '材质候选统一全称（含用户确认的12Cr1MoVG归一）')
        self.assertIn('L002-F004', first.code)
        self.assertFalse(any('L027-' in r.code for r in self.result.records))
        self.assertIn('L024-F001', self.result.isolated[0].location_key)
        reheater = [r for r in self.result.records if r.system == '高温再热器']
        self.assertTrue(all(r.spec == 'Φ60×4' and r.material == 'SA-213T91' for r in reheater),
                        '前7根区带：F002→SA-213T91（用户确认炉前起算，材质统一全称）')
        self.assertTrue(all(r.material_basis_note for r in reheater), '区带映射必须留依据')
        self.assertTrue(all('-L001-F002-' in r.code for r in reheater))

    def test_summary_preserves_source_spec_and_anomaly(self):
        summary = [r for r in self.result.records if r.source_row == 7 and r.batch.startswith('2026')]
        self.assertEqual(len(summary), 6)
        self.assertTrue(all(r.spec == 'Φ54×7.5' and r.material == 'SA-213TP304H' for r in summary),
                        '第38行材质统一全称SA-213TP304H（304H确认口径），规格保留源值待材料单确认')
        anomalies = [r for r in summary if r.result_nature == '异常观察']
        self.assertEqual(len(anomalies), 1)
        self.assertIn('L002-F002', anomalies[0].code)
        self.assertEqual(anomalies[0].result, clean.OBSERVED_ANOMALY)
        self.assertFalse(any(r.origin == '汇总展开' and r.location_key == anomalies[0].location_key for r in summary))
        self.assertTrue(all('-F024-' in r.code for r in self.result.records if r.source_row == 8),
                        '炉后第1根按确认几何镜像为F024')
        self.assertTrue(all(r.date in ('2026-04', '2022-10', '2021-11') and clean.MONTH_NOTE in r.desc for r in self.result.records))

    def test_every_record_pairing_matches_drawing_or_library(self):
        # 图纸148M211-0确认的高过四组配对 + 系统高再材料库Φ60×4档配对。
        confirmed = {
            ('Φ54×7.5', 'SA-213TP347H'),
            ('Φ51×8', 'SA-213TP304H'),
            ('Φ51×9', 'SA-213T91'),
            ('Φ51×9', '12Cr1MoVG'),
            ('Φ60×4', 'SA-213TP304H'),
            ('Φ60×4', 'SA-213T91'),
            ('Φ60×4', '12Cr1MoVG'),
        }
        for r in self.result.records:
            # 区带映射的记录必须落在确认配对内；源行单值（含Φ54×7.5+304H疑点行）按源保留。
            if '区带映射' not in r.material_basis_note:
                continue
            self.assertIn((r.spec, r.material), confirmed,
                          f'{r.source_id} 的规格/材质配对无出处')

    def test_reproducible_package_integrity_and_no_partial_overwrite(self):
        a, b = self.root / 'package-a', self.root / 'package-b'
        manifest = clean.publish(self.result, a)
        clean.publish(self.result, b)
        for path in a.iterdir():
            self.assertEqual(path.read_bytes(), (b / path.name).read_bytes(), path.name)
        self.assertEqual(manifest['statistics']['import_count'], 13)
        self.assertEqual(clean.publish(self.result, a)['package_id'], manifest['package_id'])
        rows = openpyxl.load_workbook(a / '导入_全部批次.xlsx', read_only=True)
        try:
            self.assertEqual(rows.active['C2'].data_type, 's')
            self.assertEqual(rows.active['C2'].value, '2026-04')
        finally:
            rows.close()
        artifact = a / '导入_全部批次.csv'
        artifact.write_text('user edited', encoding='utf-8')
        with self.assertRaises(ValueError):
            clean.publish(self.result, a)
        self.assertEqual(artifact.read_text(encoding='utf-8'), 'user edited')
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.before)

    def test_unknown_source_structure_fails_closed(self):
        wb = openpyxl.load_workbook(self.source)
        wb['2026年1号机C修']['C7'] = '1-3屏的炉前第2/3根共7个弯头'
        wb.save(self.source)
        wb.close()
        with self.assertRaisesRegex(ValueError, '总量'):
            clean.clean_source(self.source)
        self.assertFalse((self.root / 'package').exists())


if __name__ == '__main__':
    unittest.main()
