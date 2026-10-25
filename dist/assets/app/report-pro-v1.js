/* 专业分析报告 Pro：可视化入报告 + 内容编辑 + 保存 + 导出 Word(docx)/PDF 协同。
 * 纯浏览器实现，无第三方依赖：
 *   - BTDocx   ：ZIP(stored) + 最小 WordprocessingML 生成器（段落/标题/列表/表格/图片）
 *   - BTReportPro：报告编辑、脏标记、localStorage 保存/恢复、导出守卫、SVG 栅格化
 * 依赖宿主页面的全局：showToast / downloadBlob / escapeHTML（均有降级）。 */
(function () {
  'use strict';

  /* ---------------- 0. 宿主全局兜底 ---------------- */
  const esc = (text) => (typeof escapeHTML === 'function' ? escapeHTML(String(text == null ? '' : text)) :
    String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  const toast = (msg, type, ms) => { if (typeof showToast === 'function') showToast(msg, type, ms); };
  const saveBlob = (filename, bytes, mime) => {
    if (typeof downloadBlob === 'function') { downloadBlob(filename, bytes, mime); return; }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  /* ---------------- 1. 打印配色（白底纸面，覆盖深浅主题的 CSS 变量） ---------------- */
  const PRINT_VARS = {
    '--accent': '#0f766e', '--danger': '#dc2626', '--warn': '#d97706', '--ok': '#16a34a',
    '--info-violet': '#7c3aed', '--line': '#94a3b8', '--line-subtle': '#cbd5e1',
    '--surface-sunken': '#f1f5f9', '--text-dim': '#475569', '--text-faint': '#64748b',
    '--text-ghost': '#94a3b8', '--text-hi': '#0f172a', '--text-mid': '#334155'
  };
  const printVarsCss = () => ':root{' + Object.entries(PRINT_VARS).map(([k, v]) => `${k}:${v};`).join('') + '}';

  /* ---------------- 2. ZIP（stored，无压缩）与 CRC32 ---------------- */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function dosDateTime(date) {
    const d = date instanceof Date ? date : new Date();
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, day };
  }
  function zipStored(files) {
    const enc = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    files.forEach(file => {
      const nameBytes = enc.encode(file.name);
      /* 不用 instanceof：跨 realm（vm/iframe）下会误判 */
      const looksBinary = file.data && typeof file.data === 'object' &&
        typeof file.data.length === 'number' && typeof file.data.byteOffset === 'number' && !!file.data.buffer;
      const data = looksBinary ? file.data : enc.encode(String(file.data));
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, day, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);
      const entry = new Uint8Array(46 + nameBytes.length);
      const ev = new DataView(entry.buffer);
      ev.setUint32(0, 0x02014b50, true);
      ev.setUint16(4, 20, true);
      ev.setUint16(6, 20, true);
      ev.setUint16(8, 0, true);
      ev.setUint16(10, 0, true);
      ev.setUint16(12, time, true);
      ev.setUint16(14, day, true);
      ev.setUint32(16, crc, true);
      ev.setUint32(20, data.length, true);
      ev.setUint32(24, data.length, true);
      ev.setUint16(28, nameBytes.length, true);
      ev.setUint32(42, offset, true);
      entry.set(nameBytes, 46);
      central.push(entry);
      offset += local.length + data.length;
    });
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + centralSize + 22);
    let pos = 0;
    for (const part of [...chunks, ...central, eocd]) { out.set(part, pos); pos += part.length; }
    return out;
  }

  /* ---------------- 3. WordprocessingML 片段 ---------------- */
  const xmlEsc = (text) => String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const runXml = (text, opts = {}) => {
    const rpr = [
      opts.bold ? '<w:b/>' : '',
      opts.color ? `<w:color w:val="${opts.color}"/>` : '',
      opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : ''
    ].join('');
    return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
  };
  const paraXml = (runs, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs}</w:p>`;
  const headingXml = (text) => paraXml(runXml(text, { bold: true, color: '0F766E', size: '30' }), '<w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="260" w:after="100"/>');
  const metaXml = (text) => paraXml(runXml(text, { color: '64748B', size: '18' }));
  const bulletXml = (text) => paraXml(runXml('• ' + text), '<w:ind w:left="425" w:hanging="212"/>');
  const tableXml = (headers, rows) => {
    const colCount = Math.max(1, headers.length, ...(rows.map(r => r.length)));
    const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>`).join('') + '</w:tblBorders>';
    const tcPr = (isHeader) => `<w:tcPr><w:tcW w:w="0" w:type="auto"/>${isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="EAF5F2"/>' : ''}</w:tcPr>`;
    const cellBlock = (text, isHeader) => `<w:tc>${tcPr(isHeader)}${paraXml(runXml(text, { bold: !!isHeader, size: '19' }))}</w:tc>`;
    const headRow = headers.length
      ? `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map(h => cellBlock(h, true)).join('')}</w:tr>` : '';
    const bodyRows = rows.map(r => `<w:tr>${Array.from({ length: colCount }, (_, i) => cellBlock(r[i] == null ? '' : r[i], false)).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>` +
      `<w:tblGrid>${Array.from({ length: colCount }, () => '<w:gridCol/>').join('')}</w:tblGrid>` +
      headRow + bodyRows + '</w:tbl>' + paraXml('');
  };
  const PX_TO_EMU = 9525;
  const imageXml = (relId, docId, widthPx, heightPx) => {
    const cx = Math.round(widthPx * PX_TO_EMU);
    const cy = Math.round(heightPx * PX_TO_EMU);
    return paraXml(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${docId}" name="图表 ${docId}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${docId}" name="image${docId}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      '<w:jc w:val="center"/>');
  };
  function decodeBase64(base64) {
    const bin = atob(String(base64).replace(/^data:[^,]*,/, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const CONTENT_TYPES_BASE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';
  const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Microsoft YaHei"/>' +
    '<w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="1F2937"/>' +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>';
  function buildDocumentXml(model) {
    const body = [];
    body.push(paraXml(runXml(model.title || '专业分析报告', { bold: true, color: '0F766E', size: '40' }), '<w:jc w:val="center"/><w:spacing w:after="120"/>'));
    (model.metaLines || []).forEach(line => body.push(metaXml(line)));
    body.push(paraXml(runXml('', {}), '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="0F766E"/></w:pBdr><w:spacing w:after="200"/>'));
    const imageRels = [];
    let imageDocId = 0;
    (model.blocks || []).forEach(block => {
      if (!block) return;
      if (block.t === 'h2' && block.text) body.push(headingXml(block.text));
      else if (block.t === 'p' && block.text) body.push(paraXml(runXml(block.text)));
      else if (block.t === 'meta' && block.text) body.push(metaXml(block.text));
      else if (block.t === 'bullets') (block.items || []).forEach(item => body.push(bulletXml(item)));
      else if (block.t === 'table') body.push(tableXml(block.headers || [], block.rows || []));
      else if (block.t === 'image' && block.pngBase64) {
        imageDocId += 1;
        const relId = 'rId' + (9 + imageDocId);
        imageRels.push({ relId, target: `media/image${imageDocId}.png` });
        body.push(imageXml(relId, imageDocId, block.widthPx || 620, block.heightPx || 320));
      }
    });
    body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>');
    const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      imageRels.map(rel => `<Relationship Id="${rel.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${rel.target}"/>`).join('') +
      '</Relationships>';
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<w:body>' + body.join('') + '</w:body></w:document>';
    return { documentXml, documentRels, imageRels };
  }
  function buildDocx(model) {
    const { documentXml, documentRels, imageRels } = buildDocumentXml(model);
    const files = [
      { name: '[Content_Types].xml', data: new TextEncoder().encode(CONTENT_TYPES_BASE) },
      { name: '_rels/.rels', data: new TextEncoder().encode(ROOT_RELS) },
      { name: 'word/document.xml', data: new TextEncoder().encode(documentXml) },
      { name: 'word/_rels/document.xml.rels', data: new TextEncoder().encode(documentRels) },
      { name: 'word/styles.xml', data: new TextEncoder().encode(STYLES_XML) }
    ];
    imageRels.forEach((rel, index) => {
      const block = (model.blocks || []).filter(b => b && b.t === 'image')[index];
      files.push({ name: 'word/' + rel.target, data: decodeBase64(block.pngBase64) });
    });
    return zipStored(files);
  }
  window.BTDocx = { crc32, zipStored, buildDocx, buildDocumentXml, xmlEsc, PRINT_VARS, printVarsCss };

  /* ---------------- 4. SVG 栅格化（白底打印配色） ---------------- */
  function svgIntrinsicSize(svgEl) {
    const viewBox = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const width = parseFloat(svgEl.getAttribute('width')) || (viewBox.length === 4 ? viewBox[2] : 0);
    const height = parseFloat(svgEl.getAttribute('height')) || (viewBox.length === 4 ? viewBox[3] : 0);
    const w = width > 0 ? width : 900;
    const h = height > 0 ? height : Math.round(w * 0.5);
    return { width: w, height: h };
  }
  async function rasterizeSvg(svgEl) {
    if (typeof document === 'undefined' || !svgEl) return null;
    try {
      const { width, height } = svgIntrinsicSize(svgEl);
      const clone = svgEl.cloneNode(true);
      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      clone.removeAttribute('style');
      /* 打印配色注入为根元素内联自定义属性，序列化后仍然生效 */
      const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      styleEl.textContent = 'svg{' + Object.entries(PRINT_VARS).map(([k, v]) => `${k}:${v};`).join('') + '}';
      clone.insertBefore(styleEl, clone.firstChild);
      const xml = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      try {
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
        const scale = Math.max(1, Math.min(2, 1400 / width));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(img, 0, 0, width, height);
        const pngBase64 = canvas.toDataURL('image/png').split(',')[1];
        const outWidth = Math.min(620, Math.round(width));
        return { pngBase64, widthPx: outWidth, heightPx: Math.max(1, Math.round(outWidth * height / width)) };
      } finally { URL.revokeObjectURL(url); }
    } catch (err) { return null; }
  }

  /* ---------------- 5. 报告状态：编辑 / 保存 / 守卫 ---------------- */
  const STORE_KEY = 'blcms-pro-report-v1';
  const PLACEHOLDER_HINT = '会整理成报告显示在这里';
  const state = { dirty: false, editing: false };
  const reportView = () => document.getElementById('llm-report-view');
  const isPlaceholderText = (text) => !text || String(text).includes(PLACEHOLDER_HINT);
  function updateUI() {
    const saveBtn = document.getElementById('llm-save-btn');
    if (saveBtn) {
      saveBtn.classList.toggle('is-dirty', state.dirty);
      saveBtn.textContent = state.dirty ? '保存 ●' : '保存';
    }
    const editTab = document.getElementById('llm-edit-tab');
    if (editTab) {
      editTab.classList.toggle('active', state.editing);
      editTab.textContent = state.editing ? '完成编辑' : '编辑';
    }
  }
  function markDirty() { state.dirty = true; updateUI(); }
  function readSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (err) { return null; }
  }
  window.toggleLLMReportEdit = function () {
    const view = reportView();
    if (!view) return;
    if (isPlaceholderText(view.textContent)) { toast('请先生成或恢复分析报告，再进入编辑。', 'warn'); return; }
    state.editing = !state.editing;
    view.setAttribute('contenteditable', state.editing ? 'true' : 'false');
    view.classList.toggle('is-editing', state.editing);
    updateUI();
    if (state.editing) { view.focus(); toast('编辑模式：直接修改文字/表格内容，改完点「保存」。', 'info'); }
    else toast('已退出编辑。', 'info');
  };
  window.saveLLMReportPro = function () {
    const view = reportView();
    if (!view) return;
    if (isPlaceholderText(view.textContent)) { toast('暂无可保存的报告内容。', 'warn'); return; }
    const record = {
      savedAt: new Date().toISOString(),
      provider: document.getElementById('llm-provider')?.value || '',
      model: document.getElementById('llm-model')?.value || '',
      prompt: document.getElementById('llm-prompt')?.value || '',
      html: view.innerHTML
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(record)); }
    catch (err) { toast('保存失败：' + (err && err.message ? err.message : err), 'error'); return; }
    state.dirty = false;
    updateUI();
    toast('报告已保存，可随时导出 PDF / Word。', 'ok');
  };
  function guardExport(kind) {
    const view = reportView();
    if (!view || isPlaceholderText(view.textContent)) { toast('请先生成结构化分析报告，再导出 ' + kind + '。', 'warn'); return false; }
    if (state.dirty) { toast('报告有未保存的修改：请先点「保存」，再导出 ' + kind + '。', 'warn'); return false; }
    return true;
  }
  function onReportReplaced(cleared) {
    state.dirty = false;
    const view = reportView();
    if (!cleared && view && !isPlaceholderText(view.textContent)) state.dirty = true;
    updateUI();
  }
  /* 可视化图表加入报告（同名可视化替换旧图，避免重复堆积） */
  const attrSelectorValue = (title) => {
    try { return (window.CSS && CSS.escape) ? CSS.escape(title) : title.replace(/"/g, '\\"'); }
    catch (err) { return title.replace(/"/g, '\\"'); }
  };
  window.addLLMVizToReport = function () {
    const viz = document.getElementById('llm-viz-view');
    const view = reportView();
    if (!viz || !view) return;
    const svg = viz.querySelector('svg');
    const metrics = Array.from(viz.querySelectorAll('.llm-viz-metric'));
    const insights = Array.from(viz.querySelectorAll('.llm-viz-insights > li'));
    if (!svg && metrics.length === 0 && insights.length === 0) {
      toast('当前没有可视化结果，请先在上方生成图表。', 'warn');
      return;
    }
    const title = (viz.querySelector('.llm-viz-title')?.textContent || document.getElementById('llm-viz-type')?.value || '可视化分析').trim();
    /* 首次加入内容时清掉占位提示行，否则占位文案会让保存/导出守卫误判为空报告 */
    Array.from(view.childNodes)
      .filter(node => node.textContent && node.textContent.includes(PLACEHOLDER_HINT))
      .forEach(node => node.remove());
    const section = document.createElement('div');
    section.className = 'llm-report-section llm-report-viz';
    section.setAttribute('data-viz-title', title);
    const parts = ['<h4>可视化分析 · ' + esc(title) + '</h4>'];
    if (metrics.length) parts.push('<div class="llm-viz-metrics">' + metrics.map(m => m.outerHTML).join('') + '</div>');
    if (svg) parts.push('<figure class="llm-viz-chart">' + svg.outerHTML + '</figure>');
    if (insights.length) parts.push('<ul class="llm-viz-insights">' + insights.map(li => '<li>' + esc(li.textContent) + '</li>').join('') + '</ul>');
    section.innerHTML = parts.join('');
    const existing = view.querySelectorAll('.llm-report-viz');
    for (const node of existing) {
      if ((node.getAttribute('data-viz-title') || '') === title) node.remove();
    }
    view.appendChild(section);
    markDirty();
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('已加入「' + title + '」到报告，可继续编辑或直接保存。', 'ok');
  };

  /* ---------------- 6. 报告 DOM → DOCX 模型 ---------------- */
  function tableFromDom(table) {
    const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
      Array.from(tr.querySelectorAll('th,td')).map(tc => tc.textContent.replace(/\s+/g, ' ').trim()));
    if (rows.length === 0) return null;
    const hasHeader = table.querySelector('th') !== null;
    return {
      t: 'table',
      headers: hasHeader ? rows[0] : [],
      rows: hasHeader ? rows.slice(1) : rows
    };
  }
  async function convertElement(el, blocks) {
    const cls = el.classList;
    const tag = el.tagName;
    if (cls && cls.contains('llm-audit-note')) {
      const text = el.textContent.trim();
      if (text) blocks.push({ t: 'meta', text });
      return;
    }
    if (cls && cls.contains('llm-report-grid')) {
      for (const card of Array.from(el.children)) await convertElement(card, blocks);
      return;
    }
    if (cls && cls.contains('llm-report-card')) {
      const label = el.querySelector(':scope > .k');
      if (label && label.textContent.trim()) blocks.push({ t: 'h2', text: label.textContent.trim() });
      const body = el.querySelector(':scope > .v');
      if (body) for (const child of Array.from(body.children)) await convertElement(child, blocks);
      else if (el.textContent.trim()) blocks.push({ t: 'p', text: el.textContent.trim() });
      return;
    }
    if (cls && cls.contains('llm-report-section')) {
      const heading = el.querySelector(':scope > h4, :scope > h3, :scope > .llm-viz-title');
      if (heading && heading.textContent.trim()) blocks.push({ t: 'h2', text: heading.textContent.trim() });
      for (const child of Array.from(el.children)) {
        if (child === heading) continue;
        await convertElement(child, blocks);
      }
      return;
    }
    if (cls && cls.contains('llm-viz-metrics')) {
      for (const metric of Array.from(el.querySelectorAll('.llm-viz-metric'))) {
        const k = metric.querySelector('.k')?.textContent.trim() || '';
        const v = metric.querySelector('.v')?.textContent.trim() || '';
        if (k || v) blocks.push({ t: 'p', text: (k ? k + '：' : '') + v });
      }
      return;
    }
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') {
      const text = el.textContent.trim();
      if (text) blocks.push({ t: 'h2', text });
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(el.querySelectorAll(':scope > li')).map(li => li.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (items.length) blocks.push({ t: 'bullets', items });
      return;
    }
    if (tag === 'TABLE') {
      const table = tableFromDom(el);
      if (table) blocks.push(table);
      return;
    }
    if (tag === 'svg' || tag === 'SVG') {
      const image = await rasterizeSvg(el);
      if (image) blocks.push({ t: 'image', ...image });
      return;
    }
    if (tag === 'FIGURE') {
      const svg = el.querySelector('svg');
      if (svg) { const image = await rasterizeSvg(svg); if (image) { blocks.push({ t: 'image', ...image }); return; } }
      for (const child of Array.from(el.children)) await convertElement(child, blocks);
      return;
    }
    if (el.children.length > 0) {
      for (const child of Array.from(el.children)) await convertElement(child, blocks);
      const stray = Array.from(el.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim());
      stray.forEach(text => blocks.push({ t: 'p', text }));
      return;
    }
    const text = el.textContent.trim();
    if (text) {
      text.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(line => blocks.push({ t: 'p', text: line }));
    }
  }

  /* ---------------- 7. 导出 Word ---------------- */
  const todayStamp = () => new Date().toISOString().slice(0, 10);
  window.exportLLMReportDOCX = async function () {
    const view = reportView();
    if (!view) return;
    if (!guardExport('Word')) return;
    toast('正在生成 Word 文档…', 'info');
    const saved = readSaved();
    const blocks = [];
    try {
      for (const child of Array.from(view.children)) await convertElement(child, blocks);
    } catch (err) {
      toast('解析报告内容失败：' + (err && err.message ? err.message : err), 'error');
      return;
    }
    const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    const metaLines = [
      '系统：锅炉炉管全生命周期管理系统',
      '报告类型：AI 专业分析报告（含可视化分析）',
      exportedAt ? '导出时间：' + exportedAt : ''
    ].filter(Boolean);
    const provider = saved?.provider || document.getElementById('llm-provider')?.value || '';
    const model = saved?.model || document.getElementById('llm-model')?.value || '';
    if (provider || model) metaLines.push('模型：' + [provider, model].filter(Boolean).join(' / '));
    const prompt = saved?.prompt || document.getElementById('llm-prompt')?.value || '';
    if (prompt) metaLines.push('分析问题：' + prompt);
    const docModel = { title: '锅炉炉管 · 专业分析报告', metaLines, blocks };
    try {
      const bytes = buildDocx(docModel);
      saveBlob('专业分析报告_' + todayStamp() + '.docx', bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      toast('Word 报告已导出：专业分析报告_' + todayStamp() + '.docx', 'ok', 5000);
    } catch (err) {
      toast('导出 Word 失败：' + (err && err.message ? err.message : err), 'error', 7000);
    }
  };

  /* ---------------- 8. 初始化：恢复已保存报告 + 脏标记监听 ---------------- */
  function init() {
    const view = reportView();
    if (!view) return;
    view.addEventListener('input', () => { if (!state.dirty) markDirty(); });
    const saved = readSaved();
    if (saved && saved.html && isPlaceholderText(view.textContent)) {
      view.innerHTML = saved.html;
      toast('已恢复上次保存的分析报告（' + (saved.savedAt || '').replace('T', ' ').slice(0, 16) + '）。', 'info');
    }
    updateUI();
  }
  window.BTReportPro = {
    guardExport,
    onReportReplaced,
    rasterizeSvg,
    convertElement,
    readSaved,
    state,
    STORE_KEY
  };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
