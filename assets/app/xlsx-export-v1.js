/* XLSX export helpers for BOILER-TUBE LCMS. Requires SheetJS CE window.XLSX. */
(function () {
  'use strict';

  const today = () => new Date().toISOString().slice(0, 10);
  const safeCell = value => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    const text = String(value).replace(/\r?\n/g, ' ').trim();
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  };
  const safeRows = rows => rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, safeCell(value)])
  ));

  function requireXLSX() {
    if (typeof XLSX !== 'undefined') return true;
    showToast('Excel 组件加载失败，请检查网络后刷新页面。', 'error', 6000);
    return false;
  }

  function makeSheet(rows, headers, widths = []) {
    const normalized = safeRows(rows);
    const sheet = normalized.length
      ? XLSX.utils.json_to_sheet(normalized, { header: headers })
      : XLSX.utils.aoa_to_sheet([headers]);
    sheet['!cols'] = headers.map((_, index) => ({ wch: widths[index] || 16 }));
    sheet['!autofilter'] = { ref: sheet['!ref'] || `A1:${XLSX.utils.encode_col(headers.length - 1)}1` };
    return sheet;
  }

  function appendSheet(workbook, name, rows, headers, widths) {
    XLSX.utils.book_append_sheet(workbook, makeSheet(rows, headers, widths), name.slice(0, 31));
  }

  function writeWorkbook(workbook, filename) {
    if (!requireXLSX()) return;
    workbook.Props = {
      Title: filename,
      Subject: '锅炉炉管全生命周期管理系统导出数据',
      Author: 'BOILER-TUBE LCMS',
      CreatedDate: new Date()
    };
    XLSX.writeFile(workbook, `${filename}.xlsx`, { compression: true });
    showToast(`Excel 已导出：${filename}.xlsx`, 'ok', 5000);
  }

  function surfaceLabel(sys) {
    const item = CODE_SYSTEMS.find(entry => entry.sys === String(sys || '').toUpperCase());
    return item ? item.label : String(sys || '');
  }

  window.exportMaterialLibraryToXLSX = function () {
    if (!requireXLSX()) return;
    const rows = getMaterialLibrary();
    const wb = XLSX.utils.book_new();
    const headers = ['部件名称', '系统代码', '分段/位置', '结构形式', '规格型号', '管径(mm)', '壁厚(mm)', '材质', '库存根数', '库存总长度(m)', '预留位置', '备注'];
    const mapRow = item => ({
      '部件名称': item.component,
      '系统代码': item.sys,
      '分段/位置': item.position,
      '结构形式': item.shape,
      '规格型号': item.spec,
      '管径(mm)': item.diameter,
      '壁厚(mm)': item.wallThickness,
      '材质': item.material,
      '库存根数': item.stockQty,
      '库存总长度(m)': item.totalLengthM,
      '预留位置': item.reserveLocation,
      '备注': item.remark
    });
    appendSheet(wb, '材料库明细', rows.map(mapRow), headers, [18, 12, 26, 14, 16, 12, 12, 18, 12, 16, 18, 42]);
    const groups = [...new Set(rows.map(item => item.sys))];
    groups.forEach(sys => appendSheet(wb, `${sys}-${surfaceLabel(sys)}`, rows.filter(item => item.sys === sys).map(mapRow), headers, [18, 12, 26, 14, 16, 12, 12, 18, 12, 16, 18, 42]));
    const summary = groups.map(sys => {
      const items = rows.filter(item => item.sys === sys);
      return {
        '系统代码': sys,
        '受热面': surfaceLabel(sys),
        '规格记录数': items.length,
        '已维护库存根数记录': items.filter(item => item.stockQty !== '').length,
        '已维护总长度记录': items.filter(item => item.totalLengthM !== '').length,
        '库存总长度(m)': items.reduce((sum, item) => sum + (Number(item.totalLengthM) || 0), 0)
      };
    });
    appendSheet(wb, '库存汇总', summary, ['系统代码', '受热面', '规格记录数', '已维护库存根数记录', '已维护总长度记录', '库存总长度(m)'], [12, 18, 14, 20, 20, 18]);
    writeWorkbook(wb, `受热面材料库_${today()}`);
  };

  window.exportLifecycleDataToXLSX = function () {
    if (!requireXLSX()) return;
    const filter = getBatchBoilerFilter();
    const events = userDB.events.filter(item => filter === 'all' || eventBoiler(item) === filter).map(item => ({
      '炉号': eventBoiler(item), '日期': item.date, '管段编码': item.code, '规格': item.spec,
      '材质': item.material, '厚度(mm)': item.thickness, '硬度(HB)': item.hardness,
      '事件类型': item.type, '详细描述/结论': item.desc
    }));
    const replacements = userDB.replacements.filter(item => filter === 'all' || replacementBoiler(item) === filter).map(item => ({
      '炉号': replacementBoiler(item), '更换日期': item.date, '旧管段编码': item.oldCode,
      '新管段编码': item.newCode, '更换原因': item.reason
    }));
    const wb = XLSX.utils.book_new();
    appendSheet(wb, '检测检修事件', events, ['炉号', '日期', '管段编码', '规格', '材质', '厚度(mm)', '硬度(HB)', '事件类型', '详细描述/结论'], [10, 14, 28, 18, 18, 14, 14, 16, 46]);
    appendSheet(wb, '更换记录', replacements, ['炉号', '更换日期', '旧管段编码', '新管段编码', '更换原因'], [10, 14, 28, 28, 46]);
    const scope = filter === 'all' ? '全厂' : `${filter}号机组`;
    writeWorkbook(wb, `锅炉寿命数据_${scope}_${today()}`);
  };

  window.exportInventoryToXLSX = function (boiler = 'all') {
    if (!requireXLSX()) return;
    const normalized = boiler === 0 || boiler === 'all' ? 'all' : String(boiler);
    const rows = getGeneratedTubeLedgerRows(normalized).map(item => ({
      '炉号': item.boiler, '管段编码': item.code, '系统代码': item.sys, '受热面': item.label,
      '区域位置': item.location, '规格': item.spec, '材质': item.material
    }));
    const wb = XLSX.utils.book_new();
    appendSheet(wb, '全量管段台账', rows, ['炉号', '管段编码', '系统代码', '受热面', '区域位置', '规格', '材质'], [10, 30, 12, 20, 26, 42, 24]);
    const summary = CODE_SYSTEMS.map(item => ({
      '系统代码': item.sys,
      '受热面': item.label,
      '管段数量': rows.filter(row => row['系统代码'] === item.sys).length
    })).filter(item => item['管段数量'] > 0);
    appendSheet(wb, '台账汇总', summary, ['系统代码', '受热面', '管段数量'], [12, 20, 16]);
    const scope = normalized === 'all' ? '全厂合并' : `${normalized}号炉`;
    writeWorkbook(wb, `全量管段台账_${scope}_${today()}`);
  };

  window.exportMaintenanceOverdueXLSX = function () {
    if (!requireXLSX()) return;
    const year = Number(document.getElementById('maintenanceCycleStart')?.value) || new Date().getFullYear();
    const boiler = document.getElementById('maintenanceBoiler')?.value || 'all';
    const threshold = document.getElementById('maintenanceOverdueThreshold')?.value || '6';
    const surface = document.getElementById('maintenanceSurfaceFilter')?.value || 'all';
    const rows = filterMaintenanceOverdueRows(buildMaintenanceOverdueRows(year, boiler), threshold, surface).map(row => ({
      '优先级': row.priority, '炉号': row.boiler, '管段编码': row.code, '受热面代码': row.sys,
      '受热面': row.label, '位置': row.location, '规格': row.spec, '材质': row.material,
      '上次检查日期': row.lastDate || '未见记录', '上次检查类型': row.lastType,
      '记录来源': row.lastSource, '距今年限': row.hasRecord ? Number(row.yearsSince.toFixed(1)) : '未见记录',
      '分层': row.bucket, '建议动作': row.action
    }));
    const wb = XLSX.utils.book_new();
    const headers = ['优先级', '炉号', '管段编码', '受热面代码', '受热面', '位置', '规格', '材质', '上次检查日期', '上次检查类型', '记录来源', '距今年限', '分层', '建议动作'];
    appendSheet(wb, '超期漏检清单', rows, headers, [10, 8, 30, 12, 18, 26, 40, 24, 16, 18, 18, 12, 14, 60]);
    writeWorkbook(wb, `漏检超期炉管清单_${year}_${today()}`);
  };

  window.exportMaintenancePlanToXLSX = function () {
    if (!requireXLSX()) return;
    const year = Number(document.getElementById('maintenanceCycleStart')?.value) || new Date().getFullYear();
    const boiler = document.getElementById('maintenanceBoiler')?.value || 'all';
    const plan = buildMaintenanceOutagePlan(year, boiler);
    const planRows = plan.flatMap(outage => outage.surfaces.map(surface => ({
      '停炉序号': outage.outageNo, '周期年': outage.cycleYear, '计划年份': outage.year,
      '检修类型': outage.type, '工期(天)': outage.durationDays, '工作量占比(%)': outage.workloadShare,
      '系统代码': surface.sys, '受热面': surface.label, '台账管数': surface.ledgerCount,
      '执行项目': outage.items.join('、'), '历史风险分': surface.historyScore,
      '重点与扩大检查范围': surface.antiWearExpansion, '综合计划依据': surface.focus
    })));
    const coverageRows = plan.flatMap(outage => outage.surfaces.map(surface => ({
      '系统代码': surface.sys, '受热面': surface.label, '计划年份': outage.year, '检修类型': outage.type,
      '割管取样': '已覆盖', '射线': '已覆盖', '测厚': '已覆盖', '硬度': '已覆盖', '防磨防爆检查': '已覆盖'
    })));
    const wb = XLSX.utils.book_new();
    appendSheet(wb, 'A-C-C检修计划', planRows, ['停炉序号', '周期年', '计划年份', '检修类型', '工期(天)', '工作量占比(%)', '系统代码', '受热面', '台账管数', '执行项目', '历史风险分', '重点与扩大检查范围', '综合计划依据'], [12, 12, 14, 12, 12, 18, 12, 20, 14, 34, 14, 70, 70]);
    appendSheet(wb, '受热面覆盖矩阵', coverageRows, ['系统代码', '受热面', '计划年份', '检修类型', '割管取样', '射线', '测厚', '硬度', '防磨防爆检查'], [12, 20, 14, 12, 14, 12, 12, 12, 18]);
    writeWorkbook(wb, `检修模块_A-C-C计划_${year}_${today()}`);
  };

  window.exportLLMReportXLSX = function () {
    if (!requireXLSX()) return;
    const report = document.getElementById('llm-report-view');
    const raw = document.getElementById('llm-raw-view');
    const reportText = report?.innerText?.trim() || '';
    const rawText = raw?.innerText?.trim() || '';
    if (!reportText || /会整理成报告显示在这里/.test(reportText)) {
      showToast('请先生成大模型分析报告。', 'warn');
      return;
    }
    const wb = XLSX.utils.book_new();
    const lines = reportText.split(/\n+/).map(item => item.trim()).filter(Boolean).map((item, index) => ({ '序号': index + 1, '结构化报告内容': item }));
    appendSheet(wb, '结构化报告', lines, ['序号', '结构化报告内容'], [8, 100]);
    if (rawText && !/模型返回原文会显示在这里/.test(rawText)) {
      appendSheet(wb, '模型原文', [{ '模型返回原文': rawText }], ['模型返回原文'], [120]);
    }
    appendSheet(wb, '导出信息', [{
      '服务商': document.getElementById('llm-provider')?.value || '',
      '模型': document.getElementById('llm-model')?.value || '',
      '分析问题': document.getElementById('llm-prompt')?.value || '',
      '导出时间': new Date().toLocaleString('zh-CN')
    }], ['服务商', '模型', '分析问题', '导出时间'], [18, 28, 80, 24]);
    writeWorkbook(wb, `LLM分析报告_${today()}`);
  };
})();
