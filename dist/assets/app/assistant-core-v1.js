/* ============================================================
 * AI 数据助手 · 领域层（纯函数）v1
 * 契约：docs/ai-assistant-spec.md §2
 *
 * 约束：
 *   1) 无 DOM、无浏览器存储、无网络请求，可在 Node 中直接加载；
 *   2) 任何输入都不抛异常（内部全部 try/catch，返回结构化结果）；
 *   3) 经典脚本（IIFE），挂 window.BTAssistantCore，同时兼容 module.exports。
 *
 * 加载顺序：app-v7.9.js -> xlsx-export-v1.js -> assistant-core-v1.js
 * ============================================================ */
(function (global) {
  'use strict';

  var VERSION = 'v1';
  var DEFAULT_UNITS = ['1', '2'];

  /* 新编码规则：{机组}G-SYS-COMP-位置-Q流水号，示例 2G-SLB-WB-F000-R025-Q16 / 1G-DZRQ-GQ-4KJ-L065-Q001 */
  var TUBE_CODE_SOURCE = '[12]G-(?:SLB|GZRQ|GGRQ|HPGRQ|DPGRQ|DGRQ|DZRQ|SMQ)-(?:GQ|WB|SG|EXIN|EXOUT|LHD|RSQ)-(?:[FBLR]000-[FBLR]\\d{3}|J\\d{1,2}-[A-Z]\\d{1,2}|[FBLR]\\d{3}-[FBLR]\\d{3}-[UD]\\d{3}|[FBLR]\\d{3}-[UD]\\d{3}|(?:[1-9]\\d?KJ-)?[FBLR]\\d{3}(?:-[UD]\\d{3})?)-Q\\d{1,3}';
  var TUBE_CODE_PATTERN = new RegExp('^' + TUBE_CODE_SOURCE + '$');

  /* 受热面系统代码（与页面 CODE_SYSTEMS 一致） */
  var CODE_SYSTEMS = [
    { sys: 'SLB', label: '水冷壁', comps: ['WB', 'LHD', 'RSQ'] },
    { sys: 'GZRQ', label: '高温再热器', comps: ['GQ'] },
    { sys: 'GGRQ', label: '高温过热器', comps: ['GQ'] },
    { sys: 'HPGRQ', label: '后屏过热器', comps: ['GQ'] },
    { sys: 'DPGRQ', label: '全大屏过热器', comps: ['GQ'] },
    { sys: 'DGRQ', label: '低温过热器', comps: ['GQ'] },
    { sys: 'DZRQ', label: '低温再热器', comps: ['GQ'] },
    { sys: 'SMQ', label: '省煤器', comps: ['SG', 'EXIN', 'EXOUT'] },
    /* 顶棚/包墙仅存在于材料库，不参与新编码，但查询/展示仍需标签 */
    { sys: 'RSH', label: '顶棚过热器', comps: [] },
    { sys: 'WSH', label: '包墙过热器', comps: [] }
  ];
  var COMPONENT_LABELS = { GQ: '管屏', WB: '水冷壁管', SG: '省煤器蛇形管', EXIN: '省煤器进口集箱', EXOUT: '省煤器出口集箱', LHD: '冷灰斗', RSQ: '燃烧器区域' };
  var SYSTEM_LABEL_MAP = {};
  var SYSTEM_LABEL_MAP = {};
  CODE_SYSTEMS.forEach(function (item) { SYSTEM_LABEL_MAP[item.sys] = item.label; });

  var ZONE_LABELS = {
    F: '炉前', B: '炉后', L: '炉左', R: '炉右',
    U: '上往下', D: '下往上', F000: '前墙/坡', B000: '后墙/坡', L000: '左墙/坡', R000: '右墙/坡'
  };

  /* 事件类型口径（与页面 dm-type + 导入类型对齐） */
  var EVENT_TYPES = ['测厚', '金相分析', '无损检测', '割管取样', '检修维护', '报废更换', '安装投运'];
  var EVENT_TYPE_ALIASES = [
    { type: '测厚', patterns: ['测厚', '壁厚测量', '测厚检测', '厚度检测'] },
    { type: '金相分析', patterns: ['金相分析', '金相检测', '金相'] },
    { type: '无损检测', patterns: ['无损检测', '无损探伤', '探伤', '无损'] },
    { type: '割管取样', patterns: ['割管取样', '割管', '取样'] },
    { type: '检修维护', patterns: ['检修维护', '检修', '维修', '维护'] },
    { type: '报废更换', patterns: ['报废更换', '报废', '更换'] },
    { type: '安装投运', patterns: ['安装投运', '安装', '投运', '新装'] }
  ];

  /* 数据分类（事件/更换） */
  var CATEGORY_EVENT_KEYS = ['事件', 'event'];
  var CATEGORY_REPLACEMENT_KEYS = ['更换', 'replacement'];

  /* ---------------- 数据集注册表 ---------------- */

  var EVENT_HEADERS = ['数据分类', '炉号', '日期', '管段编码', '规格', '材质', '厚度(mm)', '硬度(HB)', '事件类型/更换原因', '关联新管码', '详细描述/结论'];
  var MATERIAL_HEADERS = ['部件名称', '系统代码', '分段/位置', '结构形式', '规格型号', '管径', '壁厚', '材质', '库存根数', '库存总长度(m)', '预留位置', '备注'];

  var HEADER_ALIASES = {
    events: {
      '数据分类': ['数据分类', '分类', '类别', 'category'],
      '炉号': ['炉号', '机组', '机组号', '锅炉', 'boiler'],
      '日期': ['日期', '检测日期', '检查日期', '检测时间', '时间', 'date'],
      '管段编码': ['管段编码', '管码', '编码', '管段编号', '管段代码', 'code'],
      '规格': ['规格', '规格型号', '尺寸', 'spec'],
      '材质': ['材质', '材料', '钢种', 'material'],
      '厚度(mm)': ['厚度(mm)', '厚度', '壁厚', '实测壁厚', '厚度mm', '壁厚(mm)', 'thickness'],
      '硬度(HB)': ['硬度(HB)', '硬度', '布氏硬度', '硬度hb', 'hardness'],
      '事件类型/更换原因': ['事件类型/更换原因', '事件类型', '检测类型', '类型', '更换原因'],
      '关联新管码': ['关联新管码', '新管码', '新管段编码', '新编码'],
      '详细描述/结论': ['详细描述/结论', '详细描述', '详细数据', '结论', '描述', '备注']
    },
    material_library: {
      '部件名称': ['部件名称', '部件', '组件名称', 'component'],
      '系统代码': ['系统代码', '系统', 'sys'],
      '分段/位置': ['分段/位置', '分段', '位置', 'position'],
      '结构形式': ['结构形式', '结构', 'shape'],
      '规格型号': ['规格型号', '规格', 'spec'],
      '管径': ['管径', '直径', 'diameter'],
      '壁厚': ['壁厚', '厚度', 'wallthickness', 'wall'],
      '材质': ['材质', '材料', 'material'],
      '库存根数': ['库存根数', '库存', 'stockqty'],
      '库存总长度(m)': ['库存总长度(m)', '库存总长度', '总长度', 'totallengthm'],
      '预留位置': ['预留位置', '预留', 'reservelocation'],
      '备注': ['备注', '说明', 'remark']
    }
  };

  var DATASET_REGISTRY = {
    events: {
      type: 'events',
      label: '寿命事件/检测记录',
      keywords: ['寿命', '事件', '检测', '测厚', '管段', '炉管', '记录'],
      headers: EVENT_HEADERS.slice(),
      requiredHeaders: ['日期', '管段编码'],
      rowRequired: ['日期', '管段编码'],
      businessKey: ['数据分类', '管段编码', '日期', '事件类型/更换原因', '详细描述/结论', '厚度(mm)', '硬度(HB)'],
      dateColumns: ['日期'],
      typeColumn: '数据分类'
    },
    material_library: {
      type: 'material_library',
      label: '受热面材料库',
      keywords: ['材料库', '材料', '备件', '库存', '受热面'],
      headers: MATERIAL_HEADERS.slice(),
      requiredHeaders: ['部件名称', '规格型号', '材质'],
      rowRequired: ['部件名称', '规格型号', '材质'],
      businessKey: ['部件名称', '分段/位置', '规格型号', '材质'],
      dateColumns: [],
      typeColumn: null
    }
  };
  var DATASET_TYPES = { EVENTS: 'events', MATERIAL_LIBRARY: 'material_library', UNKNOWN: 'unknown' };
  var DATASET_LIST = [DATASET_REGISTRY.events, DATASET_REGISTRY.material_library];

  /* 表头别名索引：normalizeText(alias) -> canonical */
  var ALIAS_LOOKUP = {};
  Object.keys(HEADER_ALIASES).forEach(function (datasetType) {
    var lookup = {};
    var group = HEADER_ALIASES[datasetType];
    Object.keys(group).forEach(function (canonical) {
      lookup[normalizeText(canonical)] = canonical;
      group[canonical].forEach(function (alias) { lookup[normalizeText(alias)] = canonical; });
    });
    ALIAS_LOOKUP[datasetType] = lookup;
  });

  /* ---------------- 智能表头匹配（模糊兜底） ----------------
   * 精确别名未命中时按两级兜底：包含关系（「实测壁厚值」含「壁厚」）→
   * 编辑距离相似度。同一原始列匹配到多个标准列且得分并列时不映射，
   * 宁可不映射（列原样保留）也不错误归并。 */

  var HEADER_AGGRESSIVE_STRIP_RE = /[^a-z0-9\u4e00-\u9fa5]/g;
  var FUZZY_CONTAIN_MIN_LEN = 2;
  var FUZZY_CONTAIN_MIN_SCORE = 0.5;
  var FUZZY_EDIT_MIN_SCORE = 0.6;

  /* 激进归一：先常规 normalizeText，再去括号单位（厚度(mm)→厚度）与全部标点/空白 */
  function aggressiveHeaderKey(value) {
    return normalizeText(value)
      .replace(/[（(][^（）()]*[）)]/g, '')
      .replace(HEADER_AGGRESSIVE_STRIP_RE, '');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [];
    for (var j = 0; j <= b.length; j += 1) prev.push(j);
    for (var i = 1; i <= a.length; i += 1) {
      var current = [i];
      for (var k = 1; k <= b.length; k += 1) {
        var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
        current[k] = Math.min(current[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      prev = current;
    }
    return prev[b.length];
  }

  function stringSimilarity(a, b) {
    if (!a && !b) return 1;
    var longer = a.length >= b.length ? a : b;
    var shorter = a.length >= b.length ? b : a;
    if (!longer.length) return 1;
    return 1 - levenshtein(shorter, longer) / longer.length;
  }

  /* 收集某数据集全部「标准列 → 别名列表」，供模糊匹配遍历 */
  function headerAliasPairs(datasetType) {
    var group = HEADER_ALIASES[datasetType];
    var pairs = [];
    if (!group) return pairs;
    Object.keys(group).forEach(function (canonical) {
      group[canonical].forEach(function (alias) {
        pairs.push({ canonical: canonical, alias: alias });
      });
    });
    return pairs;
  }

  /* 在候选里挑唯一最高分：并列或低于阈值返回 null，避免歧义误映射 */
  function pickBestCandidate(candidates, minScore) {
    var best = null;
    var bestScore = 0;
    var tie = false;
    candidates.forEach(function (candidate) {
      if (candidate.score > bestScore) { best = candidate; bestScore = candidate.score; tie = false; }
      else if (candidate.score === bestScore && best && candidate.canonical !== best.canonical) tie = true;
    });
    if (!best || tie || bestScore < minScore) return null;
    return best;
  }

  function fuzzyMatchHeader(datasetType, rawHeader) {
    var headerKey = aggressiveHeaderKey(rawHeader);
    if (!headerKey) return null;
    var pairs = headerAliasPairs(datasetType);
    var strippedHits = [];
    var candidates = [];
    pairs.forEach(function (pair) {
      var aliasKey = aggressiveHeaderKey(pair.alias);
      if (!aliasKey) return;
      /* 剥掉括号单位/标点后与别名完全一致：精确层因单位未剥离漏掉的形态
         （如「管径(mm)」→「管径」、「壁厚（mm）」→「壁厚」），直接命中。
         多个标准列剥后同形时不映射，保持宁缺勿错。 */
      if (aliasKey === headerKey) {
        if (strippedHits.indexOf(pair.canonical) < 0) strippedHits.push(pair.canonical);
        return;
      }
      var shorter = Math.min(aliasKey.length, headerKey.length);
      var longer = Math.max(aliasKey.length, headerKey.length);
      if (longer && (headerKey.indexOf(aliasKey) >= 0 || aliasKey.indexOf(headerKey) >= 0)) {
        if (shorter >= FUZZY_CONTAIN_MIN_LEN) {
          var containScore = shorter / longer;
          if (containScore >= FUZZY_CONTAIN_MIN_SCORE) {
            candidates.push({ canonical: pair.canonical, score: containScore });
          }
        }
      }
      if (headerKey.length >= 3 && aliasKey.length >= 3) {
        var editScore = stringSimilarity(aliasKey, headerKey);
        if (editScore >= FUZZY_EDIT_MIN_SCORE) {
          candidates.push({ canonical: pair.canonical, score: editScore });
        }
      }
    });
    if (strippedHits.length === 1) return { canonical: strippedHits[0], level: 'fuzzy', score: 1 };
    if (strippedHits.length > 1) return null;
    /* 两级候选合并后取全局最高分：避免「包含 0.5」压过「编辑距离 0.75」这类更近的匹配
       （如「事件类别」应归到「事件类型」而不是「数据分类」）；最高分仍并列时不映射。 */
    var best = pickBestCandidate(candidates, Math.min(FUZZY_CONTAIN_MIN_SCORE, FUZZY_EDIT_MIN_SCORE));
    if (best) return { canonical: best.canonical, level: 'fuzzy', score: best.score };
    return null;
  }

  /* 表头归一（带层级）：override（模型映射结果）> 精确别名 > 模糊匹配 > 原样 */
  function canonicalHeaderWithLevel(datasetType, rawHeader, override) {
    var raw = String(rawHeader === null || rawHeader === undefined ? '' : rawHeader).replace(/^\uFEFF/, '').trim();
    if (!raw) return { canonical: '', level: 'exact' };
    var type = normalizeDatasetType(datasetType);
    if (type !== 'unknown' && override && typeof override === 'object') {
      var mapped = override[normalizeText(raw)];
      if (mapped && DATASET_REGISTRY[type].headers.indexOf(mapped) >= 0) {
        return { canonical: mapped, level: 'model' };
      }
    }
    var lookup = ALIAS_LOOKUP[type];
    if (!lookup) return { canonical: raw, level: 'none' };
    var key = normalizeText(raw);
    if (lookup[key]) return { canonical: lookup[key], level: 'exact' };
    var fuzzy = fuzzyMatchHeader(type, raw);
    if (fuzzy) return { canonical: fuzzy.canonical, level: 'fuzzy' };
    return { canonical: raw, level: 'none' };
  }

  /* ---------------- 工具目录 ---------------- */

  var TOOL_SPECS = [
    { name: 'assistant.clean', label: '清洗检查', minRole: 'viewer', requiresConfirm: false, runnableWithoutFile: false, intent: 'clean' },
    { name: 'data.import', label: '导入数据', minRole: 'editor', requiresConfirm: true, runnableWithoutFile: false, intent: 'import' },
    { name: 'data.export', label: '导出数据', minRole: 'viewer', requiresConfirm: false, runnableWithoutFile: true, intent: 'export' },
    { name: 'data.query', label: '查询数据', minRole: 'viewer', requiresConfirm: false, runnableWithoutFile: true, intent: 'query' },
    { name: 'data.edit', label: '修改记录', minRole: 'editor', requiresConfirm: true, runnableWithoutFile: true, intent: 'edit' },
    { name: 'data.stats', label: '统计概览', minRole: 'viewer', requiresConfirm: false, runnableWithoutFile: true, intent: 'stats' },
    {
      name: 'data.analyze',
      label: '分析可视化',
      minRole: 'viewer',
      requiresConfirm: false,
      runnableWithoutFile: true,
      intent: 'analyze',
      examples: ['近两年壁厚趋势', '各受热面事件数排行', '1、2 号炉壁厚对比']
    },
    { name: 'data.undo', label: '撤销导入', minRole: 'editor', requiresConfirm: true, runnableWithoutFile: true, intent: 'undo' },
    { name: 'assistant.help', label: '使用帮助', minRole: 'viewer', requiresConfirm: false, runnableWithoutFile: true, intent: 'help' }
  ];
  var TOOL_MAP = {};
  TOOL_SPECS.forEach(function (spec) { TOOL_MAP[spec.name] = spec; });

  var ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };
  var ROLE_LABELS = { viewer: '只读', editor: '编辑', admin: '管理员' };

  var INTENT_PRIORITY = ['undo', 'clean', 'export', 'import', 'edit', 'query', 'analyze', 'stats', 'help', 'unknown'];
  var INTENT_TOOL = {
    clean: 'assistant.clean',
    import: 'data.import',
    export: 'data.export',
    query: 'data.query',
    edit: 'data.edit',
    analyze: 'data.analyze',
    stats: 'data.stats',
    undo: 'data.undo',
    help: 'assistant.help',
    unknown: 'assistant.help'
  };

  /* 意图打分表：权重 3=明确动作 / 2=常见说法 / 1=弱线索（这里用加权分值表达） */
  var INTENT_PATTERNS = [
    { intent: 'undo', weight: 6, re: /撤销(?:这次|刚才|上一次|上次|此次)?的?导入|取消导入|回滚导入|恢复导入前|撤销导入操作|撤回导入/ },
    { intent: 'undo', weight: 4, re: /撤销|回滚|撤回|反悔/ },
    { intent: 'clean', weight: 6, re: /能不能导入|能否导入|能导入吗|可以导入吗|可不可以导入|能入库吗|能不能入库|可不可以入库/ },
    { intent: 'clean', weight: 5, re: /清洗|去重|查重|数据质检|质检/ },
    { intent: 'clean', weight: 4, re: /数据质量|数据检查|检查数据|校验|核对|核对数据/ },
    { intent: 'clean', weight: 3, re: /检查(?:一下|下|这个|这批|文件|表格|数据)?|看看(?:这个|这批|文件|数据|表)/ },
    { intent: 'clean', weight: 2, re: /重复|格式|缺字段|空值|异常|对不对|有没有问题/ },
    { intent: 'export', weight: 5, re: /导出|另存为|保存为|导出成|保存成|存成/ },
    { intent: 'export', weight: 3, re: /下载/ },
    { intent: 'import', weight: 5, re: /导入|入库|录入/ },
    { intent: 'import', weight: 3, re: /上传|加到|计入|新增到/ },
    { intent: 'query', weight: 5, re: /查询|查一下|查找|查查|找出|列出|检索|搜一下|搜索/ },
    { intent: 'query', weight: 3, re: /有哪些|查看|显示|看看|给我看|列一下/ },
    { intent: 'query', weight: 1, re: /具体|详细|明细/ },
    { intent: 'stats', weight: 6, re: /数据质量(?:怎么样|如何|情况)|整体(?:情况|怎么样|如何)|统计|概览|概况|汇总|分布/ },
    { intent: 'stats', weight: 5, re: /数据(?:怎么样|如何|情况|状态)|质量(?:怎么样|如何|情况)/ },
    { intent: 'stats', weight: 4, re: /多少|几条|几个|多少个|总数|数量/ },
    { intent: 'stats', weight: 1, re: /怎么样|如何|情况/ },
    { intent: 'analyze', weight: 6, re: /趋势|走势|逐月|逐年|按月|按年|分布图|直方图|分布|排行|排名|对比|比较|相关性|相关系数|散点图|异常值|离群|画像|图表|可视化|柱状图|折线图|饼图|环形图|构成/ },
    { intent: 'analyze', weight: 5, re: /top\s*\d+|前\s*\d+\s*名|前\s*\d+\s*个|最薄|最厚|变化情况|变化曲线|历史曲线|剖面|环比|同比/ },
    { intent: 'analyze', weight: 4, re: /分析|异常|可疑|看一下|帮我看看/ },
    { intent: 'help', weight: 6, re: /怎么用|怎么使用|能做什么|会做什么|能干什么|有什么功能|使用说明|使用帮助/ },
    { intent: 'help', weight: 5, re: /帮助|帮助文档|教程|你是谁|怎么操作/ },
    { intent: 'help', weight: 2, re: /功能|介绍|说明/ }
  ];

  var EDIT_VERB_RE = /改成|改为|改到|更正为|修正为|修改为|更新为|调整为|调成|设为|设置为|写成|应该是|应为|换成/;
  var EDIT_FIELD_RE = /日期|时间|管码|管段编码|编码|类型|描述|结论|厚度|壁厚|硬度|规格|材质|材料/;

  var TEMPLATE_RE = /下载模板|模板下载|模板文件|模板在哪|模板哪里|要模板|给我模板|发我模板|获取模板|模板怎么|怎么下载.*模板|模板.*下载|模板.*(?:给我|发我|在哪|哪里|获取)|(?:给我|发我|来一份|来个|要个|要一份)[^，。；]{0,8}模板/;
  var CANNOT_IMPORT_RE = /能不能导入|能否导入|能导入吗|可以导入吗|可不可以导入|能不能入库|能否入库|能入库吗|可以入库吗|可不可以入库/;
  var COUNTING_RE = /多少|几条|几个|多少个|总数|统计|概览/;
  var LISTING_RE = /有哪些|列出|找出|查询|查一下|查找|显示/;
  /* 强分析词：出现这些词时以「分析」为准，避免被「统计/多少」抢走 */
  var STRONG_ANALYSIS_RE = /趋势|走势|排行|排名|对比|比较|相关性|相关系数|散点|直方图|分布图|分布|画像|异常值|异常记录|离群|剖面|图表|可视化|环比|同比/;

  /* ============================================================
   * 通用工具函数（§2.8）
   * ============================================================ */

  function normalizeText(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    text = text.replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    text = text.replace(/\u3000/g, ' ');
    text = text.replace(/\uFEFF/g, '');
    return text.replace(/\s+/g, '').toLowerCase();
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad2(value) {
    var n = Number(value);
    if (!isFinite(n)) return '00';
    return n < 10 ? '0' + n : String(n);
  }

  function pad4(value) {
    var n = Number(value);
    if (!isFinite(n)) return '0000';
    var text = String(Math.trunc(n));
    while (text.length < 4) text = '0' + text;
    return text;
  }

  function pad3(value) {
    var n = Number(value);
    if (!isFinite(n)) return '000';
    var text = String(Math.trunc(n));
    while (text.length < 3) text = '0' + text;
    return text;
  }

  function formatDateParts(year, month, day) {
    return pad4(year) + '-' + pad2(month) + '-' + pad2(day);
  }

  function buildDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (year < 1900 || year > 2200) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    var check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return formatDateParts(year, month, day);
  }

  function normalizeDateText(value) {
    try {
      if (value === null || value === undefined || value === '') return null;
      if (Object.prototype.toString.call(value) === '[object Date]') {
        if (!isFinite(value.getTime())) return null;
        return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
      }
      if (typeof value === 'number' && isFinite(value)) {
        if (Number.isInteger(value)) {
          var digits = String(Math.abs(value));
          if (digits.length === 8 && /^(19|20)\d{6}$/.test(digits)) {
            return buildDate(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)));
          }
        }
        if (value > 20000 && value < 90000) {
          var serial = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
          return buildDate(serial.getUTCFullYear(), serial.getUTCMonth() + 1, serial.getUTCDate());
        }
        return null;
      }
      var text = String(value).trim();
      if (!text) return null;
      text = text.replace(/^\uFEFF/, '');
      text = text.split(/[T\s]+/)[0] || '';
      text = text.replace(/[年月]/g, '-').replace(/[日号]/g, '');
      text = text.replace(/[／\/.]/g, '-');
      text = text.replace(/-+/g, '-').replace(/^-|-$/g, '');
      var match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (match) return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
      match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (match) return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
      return null;
    } catch (err) {
      return null;
    }
  }

  function normalizeEventType(raw) {
    var text = normalizeText(raw);
    if (!text) return { type: '', known: false };
    for (var i = 0; i < EVENT_TYPE_ALIASES.length; i += 1) {
      var item = EVENT_TYPE_ALIASES[i];
      for (var j = 0; j < item.patterns.length; j += 1) {
        var pattern = normalizeText(item.patterns[j]);
        if (pattern && (text === pattern || text.indexOf(pattern) >= 0)) {
          return { type: item.type, known: true };
        }
      }
    }
    return { type: String(raw === null || raw === undefined ? '' : raw).trim(), known: false };
  }

  function normalizeCode(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/^\uFEFF/, '').trim().toUpperCase();
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var num = Number(value);
    return isFinite(num) ? num : null;
  }

  function isNumericText(value) {
    var text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return false;
    return /^[-+]?\d+(?:\.\d+)?$/.test(text);
  }

  function formatNumber(value) {
    if (value === null || value === undefined || value === '') return '-';
    var num = Number(value);
    if (!isFinite(num)) return String(value);
    var negative = num < 0;
    var abs = Math.abs(num);
    var fixed = Math.abs(abs - Math.round(abs)) > 1e-9 ? abs.toFixed(2) : String(Math.round(abs));
    var pieces = fixed.split('.');
    var grouped = pieces[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (negative ? '-' : '') + grouped + (pieces[1] ? '.' + pieces[1] : '');
  }

  /* 新编码解析（与页面 parseTubeCode 同构）：结构合法返回 parts，否则 valid=false */
  function parseTubeCodeParts(code) {
    var raw = normalizeCode(code);
    var head = raw.match(/^([12])G-(SLB|GZRQ|GGRQ|HPGRQ|DPGRQ|DGRQ|DZRQ|SMQ)-(GQ|WB|SG|EXIN|EXOUT|LHD|RSQ)(?:-(.*))?$/);
    if (!head) return null;
    var parsed = { unit: head[1] + 'G', boiler: head[1], sys: head[2], comp: head[3], space: null, pos: '', posNum: null, pos2: '', pos2Num: null, corner: null, layer: '', nozzle: null, dir: '', tube: null, seq: null };
    var parts = head[4] ? head[4].split('-') : [];
    var tail = parts.length && /^Q\d{1,3}$/.test(parts[parts.length - 1]) ? parts.pop() : null;
    if (!tail) return null;
    parsed.seq = Number(tail.slice(1));
    var POS_RE = /^([FBLR])(\d{3})$/;
    var TUBE_RE = /^([UD])(\d{3})$/;
    var WALL_RE = /^([FBLR])000$/;
    if (parsed.sys === 'SLB' && (parsed.comp === 'WB' || parsed.comp === 'LHD')) {
      if (parts.length !== 2) return null;
      var pm = parts[0].match(WALL_RE), tm = parts[1].match(/^([FBLR])(\d{3})$/);
      if (!pm || !tm) return null;
      parsed.pos = parts[0]; parsed.dir = tm[1]; parsed.tube = Number(tm[2]);
      return parsed;
    }
    if (parsed.sys === 'SLB' && parsed.comp === 'RSQ') {
      if (parts.length !== 2) return null;
      var cm = parts[0].match(/^J([1-9]\d?)$/), lm = parts[1].match(/^([A-Z])(\d{1,2})$/);
      if (!cm || !lm) return null;
      parsed.corner = Number(cm[1]); parsed.layer = lm[1]; parsed.nozzle = Number(lm[2]);
      return parsed;
    }
    if (parsed.sys === 'DPGRQ') {
      if (parts.length !== 3) return null;
      var p1 = parts[0].match(POS_RE), p2 = parts[1].match(POS_RE), tb = parts[2].match(TUBE_RE);
      if (!p1 || !p2 || !tb) return null;
      parsed.pos = parts[0]; parsed.posNum = Number(p1[2]);
      parsed.pos2 = parts[1]; parsed.pos2Num = Number(p2[2]);
      parsed.dir = tb[1]; parsed.tube = Number(tb[2]);
      return parsed;
    }
    if (['GGRQ', 'GZRQ', 'HPGRQ', 'SMQ'].indexOf(parsed.sys) >= 0) {
      if (parts.length !== 2) return null;
      var q1 = parts[0].match(POS_RE), q2 = parts[1].match(TUBE_RE);
      if (!q1 || !q2) return null;
      parsed.pos = parts[0]; parsed.posNum = Number(q1[2]);
      parsed.dir = q2[1]; parsed.tube = Number(q2[2]);
      return parsed;
    }
    if (parsed.sys === 'DGRQ' || parsed.sys === 'DZRQ') {
      var rest = parts.slice();
      var sm = rest.length && /^([1-9]\d?)KJ$/.test(rest[0]) ? rest.shift().match(/^([1-9]\d?)KJ$/) : null;
      if (sm) parsed.space = Number(sm[1]);
      if (rest.length < 1 || rest.length > 2) return null;
      var r1 = rest[0].match(POS_RE);
      if (!r1) return null;
      parsed.pos = rest[0]; parsed.posNum = Number(r1[2]);
      if (rest.length === 2) {
        var rt = rest[1].match(TUBE_RE);
        if (!rt) return null;
        parsed.dir = rt[1]; parsed.tube = Number(rt[2]);
      } else if (parsed.sys !== 'DZRQ') return null;
      return parsed;
    }
    return null;
  }

  function inNumRange(num, pair) { return num >= pair[0] && num <= pair[1]; }

  function matrixRowMatch(row, parsed) {
    if (String(row.sys || '').toUpperCase() !== parsed.sys) return false;
    if (String(row.comp || '').toUpperCase() !== parsed.comp) return false;
    if (row.special === 'rsq') {
      return parsed.corner !== null && inNumRange(parsed.corner, row.corners) &&
        (row.layers || []).indexOf(parsed.layer) >= 0 && parsed.nozzle !== null && inNumRange(parsed.nozzle, row.nozzles);
    }
    if (row.pos) {
      if (parsed.pos !== row.pos) return false;
    } else {
      if (!parsed.pos || (row.posLetters || []).indexOf(parsed.pos[0]) < 0 || !inNumRange(parsed.posNum, [1, row.pMax])) return false;
      if (row.pos2Letters && (!parsed.pos2 || (row.pos2Letters || []).indexOf(parsed.pos2[0]) < 0 || !inNumRange(parsed.pos2Num, [1, row.p2Max]))) return false;
    }
    if (row.spaces) {
      if (parsed.space !== null && !inNumRange(parsed.space, row.spaces)) return false;
    } else if (parsed.space !== null) return false;
    if (parsed.dir && parsed.tube !== null) {
      if ((row.dirs || []).indexOf(parsed.dir) < 0 || !inNumRange(parsed.tube, [1, row.tMax])) return false;
    } else if (!row.tubeOptional) return false;
    return true;
  }

  /* ---------------- 方向感知归一 ----------------
   * 现场可从任意一端计数（炉左/炉右、炉前/炉后、上/下），方向字母与序号互为镜像：
   * L-n ≡ R-(总数+1-n)。台账矩阵展开只认规范方向（dirs/posLetters 首位），
   * 这里把「反方向但矩阵合法」的编码无损换算成同一物理位置的规范编码，
   * 避免同一根管以两个身份入库（历史分裂、报废不彻底）。
   * 返回 { code: 规范编码, changed: true }；不适用（结构非法/矩阵外/已是规范方向/
   * 燃烧器区域无方向段）返回 null，调用方按原编码继续走既有校验。 */
  var DIR_COMPLEMENT = { L: 'R', R: 'L', F: 'B', B: 'F', U: 'D', D: 'U' };

  function canonicalTubeCode(code, matrixRows) {
    var normalized = normalizeCode(code);
    if (!normalized) return null;
    var parsed = parseTubeCodeParts(normalized);
    if (!parsed) return null;
    var rows = Array.isArray(matrixRows) ? matrixRows : [];
    var row = null;
    for (var i = 0; i < rows.length; i += 1) {
      if (matrixRowMatch(rows[i], parsed)) { row = rows[i]; break; }
    }
    if (!row || row.special === 'rsq') return null;
    var dirCanonical = row.dirs && row.dirs.length ? String(row.dirs[0]).toUpperCase() : '';
    var posCanonical = row.posLetters && row.posLetters.length ? String(row.posLetters[0]).toUpperCase() : '';
    var pos2Canonical = row.pos2Letters && row.pos2Letters.length ? String(row.pos2Letters[0]).toUpperCase() : '';
    var pad3 = function (n) { return String(n).padStart(3, '0'); };
    var changed = false;

    /* 逐段换算：管号方向（墙面用 FBLR、过/再热器用 UD）与排/小屏号方位互为镜像 */
    var posSeg = parsed.pos;
    if (posCanonical && parsed.pos && parsed.pos.charAt(0) !== posCanonical &&
        DIR_COMPLEMENT[posCanonical] === parsed.pos.charAt(0)) {
      posSeg = posCanonical + pad3(row.pMax + 1 - parsed.posNum);
      changed = true;
    }
    var pos2Seg = parsed.pos2;
    if (pos2Canonical && parsed.pos2 && parsed.pos2.charAt(0) !== pos2Canonical &&
        DIR_COMPLEMENT[pos2Canonical] === parsed.pos2.charAt(0)) {
      pos2Seg = pos2Canonical + pad3(row.p2Max + 1 - parsed.pos2Num);
      changed = true;
    }
    var dirSeg = parsed.dir ? parsed.dir + pad3(parsed.tube) : '';
    if (parsed.dir && dirCanonical && parsed.dir !== dirCanonical &&
        DIR_COMPLEMENT[dirCanonical] === parsed.dir) {
      dirSeg = dirCanonical + pad3(row.tMax + 1 - parsed.tube);
      changed = true;
    }
    if (!changed) return null;

    /* 按该系统段的语形重建编码（Q 流水号沿用原始写法，宽度不动） */
    var body = [];
    if (row.pos) {
      body.push(posSeg, dirSeg);
    } else {
      if (parsed.space !== null) body.push(parsed.space + 'KJ');
      body.push(posSeg);
      if (pos2Seg) body.push(pos2Seg);
      if (dirSeg) body.push(dirSeg);
    }
    var segs = normalized.split('-');
    var canonical = [segs[0], segs[1], segs[2]].concat(body, [segs[segs.length - 1]]).join('-');
    /* 自检：换算结果必须仍落在同一矩阵行（同一物理位置），否则放弃归一 */
    var reparsed = parseTubeCodeParts(canonical);
    if (!reparsed) return null;
    var stillMatched = false;
    for (var j = 0; j < rows.length; j += 1) {
      if (matrixRowMatch(rows[j], reparsed)) { stillMatched = true; break; }
    }
    return stillMatched ? { code: canonical, changed: true } : null;
  }

  function validateTubeCode(code, matrixRows) {
    var normalized = normalizeCode(code);
    if (!normalized) return { valid: false, reason: '管段编码为空', code: '' };
    if (!TUBE_CODE_PATTERN.test(normalized)) {
      return { valid: false, reason: '管段编码格式不符合规则（示例：2G-SLB-WB-F000-R025-Q16）', code: normalized };
    }
    var parsed = parseTubeCodeParts(normalized);
    if (!parsed) {
      return { valid: false, reason: '管段编码结构不符合所属系统的编码规则', code: normalized };
    }
    var result = { valid: true, code: normalized, parts: parsed, matched: null };
    var rows = Array.isArray(matrixRows) ? matrixRows : [];
    if (rows.length) {
      var hit = null;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!row || typeof row !== 'object') continue;
        if (matrixRowMatch(row, parsed)) { hit = row; break; }
      }
      result.matched = hit;
      if (!hit) result.reason = '编码格式有效，但未落入台账矩阵的排/屏或管号范围';
    }
    return result;
  }

  /* ============================================================
   * 智能编码匹配（台账 / 矩阵相似码建议）
   * ============================================================ */

  var MATRIX_EXPAND_LIMIT = 30000;  /* 矩阵展开的编码数量上限，防止异常矩阵拖垮清洗 */
  var CODE_SUGGEST_MIN_SCORE = 0.82; /* 低于该相似度不给出建议，避免把合法新码误报成疑似错码 */

  /* 台账矩阵 → 基础编码集合（流水号固定 Q001，按行内首选方位/方向展开）：2G-SLB-WB-F000-R025-Q001。
     用于判断「这个编码在台账里是否存在」，以及给疑似错码找最近的真实编码。 */
  function expandMatrixCodes(matrixRows, units) {
    var out = [];
    var seen = {};
    var rows = Array.isArray(matrixRows) ? matrixRows : [];
    var unitList = normalizeUnits(units);
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || out.length >= MATRIX_EXPAND_LIMIT) return;
      var sys = String(row.sys || '').toUpperCase();
      var comp = String(row.comp || '').toUpperCase();
      if (!sys || !comp) return;
      unitList.forEach(function (unit) {
        var prefix = unit + 'G-' + sys + '-' + comp;
        if (row.special === 'rsq') {
          for (var c = row.corners[0]; c <= row.corners[1] && out.length < MATRIX_EXPAND_LIMIT; c += 1) {
            (row.layers || []).forEach(function (layer) {
              for (var n = row.nozzles[0]; n <= row.nozzles[1] && out.length < MATRIX_EXPAND_LIMIT; n += 1) {
                var rsqCode = prefix + '-J' + c + '-' + layer + pad2(n) + '-Q001';
                if (!seen[rsqCode]) { seen[rsqCode] = true; out.push(rsqCode); }
              }
            });
          }
          return;
        }
        var posList = row.pos ? [row.pos]
          : Array.from({ length: row.pMax }, function (_, i) { return String(row.posLetters[0]) + String(i + 1).padStart(3, '0'); });
        var pos2List = row.pos2Letters
          ? Array.from({ length: row.p2Max }, function (_, i) { return String(row.pos2Letters[0]) + String(i + 1).padStart(3, '0'); })
          : [null];
        var spaceList = row.spaces
          ? Array.from({ length: row.spaces[1] - row.spaces[0] + 1 }, function (_, i) { return String(row.spaces[0] + i) + 'KJ'; })
          : [null];
        var dir = row.dirs ? row.dirs[0] : 'U';
        for (var si = 0; si < spaceList.length && out.length < MATRIX_EXPAND_LIMIT; si += 1) {
          for (var pi = 0; pi < posList.length && out.length < MATRIX_EXPAND_LIMIT; pi += 1) {
            for (var pj = 0; pj < pos2List.length && out.length < MATRIX_EXPAND_LIMIT; pj += 1) {
              for (var t = 1; t <= row.tMax && out.length < MATRIX_EXPAND_LIMIT; t += 1) {
                var head = [spaceList[si], posList[pi], pos2List[pj]].filter(Boolean).join('-');
                var code = prefix + '-' + [head, dir + String(t).padStart(3, '0')].filter(Boolean).join('-') + '-Q001';
                if (!seen[code]) { seen[code] = true; out.push(code); }
              }
            }
          }
        }
      });
    });
    return out;
  }

  /* 疑似错码 → 最近的候选编码。只在「机组号 + 系统代码」相同的候选里找
     （跨系统的编码差异太大，相似度没有参考意义），返回 { code, similarity } 或 null。 */
  function suggestSimilarCode(code, candidateList, minScore) {
    var target = normalizeCode(code).toUpperCase();
    if (!target) return null;
    var targetKey = target.replace(/-/g, '');
    var targetParts = target.split('-');
    var threshold = typeof minScore === 'number' ? minScore : CODE_SUGGEST_MIN_SCORE;
    var best = null;
    var list = Array.isArray(candidateList) ? candidateList : [];
    for (var i = 0; i < list.length; i += 1) {
      var candidate = normalizeCode(list[i]).toUpperCase();
      if (!candidate || candidate === target) continue;
      var candidateParts = candidate.split('-');
      /* 前缀过滤：机组号或系统代码不同的候选直接跳过，也把计算量压下来 */
      if (targetParts.length >= 2 && candidateParts.length >= 2 &&
          (targetParts[0] !== candidateParts[0] || targetParts[1] !== candidateParts[1])) continue;
      var score = stringSimilarity(targetKey, candidate.replace(/-/g, ''));
      if (!best || score > best.similarity) {
        best = { code: candidate, similarity: score };
        if (score >= 0.999) break;
      }
    }
    if (!best || best.similarity < threshold) return null;
    return best;
  }

  function buildTubeCodeLedger(knownCodes, matrixRows, units) {
    var list = [];
    var seen = {};
    var pushCandidate = function (value) {
      var code = normalizeCode(value).toUpperCase();
      if (code && !seen[code]) { seen[code] = true; list.push(code); }
    };
    if (Array.isArray(knownCodes)) knownCodes.forEach(pushCandidate);
    expandMatrixCodes(matrixRows, units).forEach(pushCandidate);
    return { list: list, set: seen };
  }

  /* ============================================================
   * 内部小工具
   * ============================================================ */

  function toObjectArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (item) { return item && typeof item === 'object'; });
  }

  function toDate(value) {
    try {
      if (Object.prototype.toString.call(value) === '[object Date]') {
        return isFinite(value.getTime()) ? new Date(value.getTime()) : null;
      }
      if (typeof value === 'number' && isFinite(value)) {
        var fromNumber = new Date(value);
        return isFinite(fromNumber.getTime()) ? fromNumber : null;
      }
      if (typeof value === 'string' && value.trim()) {
        var normalized = normalizeDateText(value);
        if (normalized) {
          var pieces = normalized.split('-');
          return new Date(Date.UTC(Number(pieces[0]), Number(pieces[1]) - 1, Number(pieces[2])));
        }
        var parsed = new Date(value);
        return isFinite(parsed.getTime()) ? parsed : null;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  function addMonths(date, delta) {
    var year = date.getUTCFullYear();
    var month = date.getUTCMonth();
    var day = date.getUTCDate();
    var target = new Date(Date.UTC(year, month + delta, 1));
    var lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
  }

  function uniquePush(list, value) {
    if (list.indexOf(value) < 0) list.push(value);
  }

  function cloneSpec(spec) {
    return {
      name: spec.name,
      label: spec.label,
      minRole: spec.minRole,
      requiresConfirm: spec.requiresConfirm,
      runnableWithoutFile: spec.runnableWithoutFile,
      intent: spec.intent
    };
  }

  /* ============================================================
   * 数据集 API（§2.1）
   * ============================================================ */

  function normalizeDatasetType(value) {
    var text = normalizeText(value);
    if (text === 'events' || text === 'event') return 'events';
    if (text === 'material_library' || text === 'materiallibrary' || text === 'material') return 'material_library';
    return 'unknown';
  }

  function getDataset(type) {
    var normalized = normalizeDatasetType(type);
    return normalized === 'unknown' ? null : DATASET_REGISTRY[normalized];
  }

  function datasetCatalog() {
    return DATASET_LIST.map(function (item) {
      return {
        type: item.type,
        label: item.label,
        keywords: item.keywords.slice(),
        headers: item.headers.slice(),
        requiredHeaders: item.requiredHeaders.slice(),
        rowRequired: item.rowRequired.slice(),
        businessKey: item.businessKey.slice(),
        dateColumns: item.dateColumns.slice(),
        typeColumn: item.typeColumn
      };
    });
  }

  function datasetLabel(type) {
    var normalized = normalizeDatasetType(type);
    if (normalized === 'unknown') return '数据';
    var spec = DATASET_REGISTRY[normalized];
    return spec ? spec.label : '数据';
  }

  function canonicalHeader(datasetType, rawHeader) {
    var raw = String(rawHeader === null || rawHeader === undefined ? '' : rawHeader).replace(/^\uFEFF/, '').trim();
    if (!raw) return '';
    var resolved = canonicalHeaderWithLevel(datasetType, raw);
    return resolved.canonical || raw;
  }

  function buildHeaderIndex(datasetType, headers) {
    var list = Array.isArray(headers) ? headers : [];
    var index = {};
    list.forEach(function (header, position) {
      var canonical = canonicalHeader(datasetType, header);
      if (canonical && index[canonical] === undefined) index[canonical] = position;
    });
    return index;
  }

  /* 数据集检测专用：只认精确别名，避免模糊匹配把无关表格误判成台账 */
  function buildExactHeaderIndex(datasetType, headers) {
    var list = Array.isArray(headers) ? headers : [];
    var index = {};
    var lookup = ALIAS_LOOKUP[normalizeDatasetType(datasetType)];
    if (!lookup) return index;
    list.forEach(function (header, position) {
      var raw = String(header === null || header === undefined ? '' : header).replace(/^\uFEFF/, '').trim();
      if (!raw) return;
      var canonical = lookup[normalizeText(raw)];
      if (canonical && index[canonical] === undefined) index[canonical] = position;
    });
    return index;
  }

  function resolveDatasetType(headers, fileName) {
    try {
      var headerList = Array.isArray(headers) ? headers : [];
      if (headerList.length) {
        var eventsIndex = buildExactHeaderIndex('events', headerList);
        var materialIndex = buildExactHeaderIndex('material_library', headerList);
        var materialMatched = materialIndex['部件名称'] !== undefined &&
          materialIndex['规格型号'] !== undefined &&
          materialIndex['材质'] !== undefined;
        if (materialMatched) return 'material_library';
        var eventsMatched = eventsIndex['日期'] !== undefined && eventsIndex['管段编码'] !== undefined;
        if (eventsMatched) return 'events';
      }
      var fileText = normalizeText(fileName);
      if (fileText) {
        /* 文件名兜底与注册表 keywords 保持单一真相，避免文档声称支持「测厚/炉管/受热面」
           而正则漏掉（曾导致「测厚记录.csv」识别失败）。材料库优先，与表头检测一致。 */
        var keywordHit = function (datasetType) {
          var keywords = (DATASET_REGISTRY[datasetType] && DATASET_REGISTRY[datasetType].keywords) || [];
          for (var k = 0; k < keywords.length; k += 1) {
            var word = normalizeText(keywords[k]);
            if (word && fileText.indexOf(word) >= 0) return true;
          }
          return false;
        };
        if (keywordHit('material_library')) return 'material_library';
        if (keywordHit('events')) return 'events';
      }
      return 'unknown';
    } catch (err) {
      return 'unknown';
    }
  }

  function detectDatasetType(headers, fileName) {
    return resolveDatasetType(headers, fileName);
  }

  function normalizeUnits(units) {
    if (!Array.isArray(units) || !units.length) return DEFAULT_UNITS.slice();
    var result = [];
    units.forEach(function (unit) {
      var text = normalizeText(unit);
      if ((text === '1' || text === '2') && result.indexOf(text) < 0) result.push(text);
    });
    return result.length ? result : DEFAULT_UNITS.slice();
  }

  function makeCodeSet(values) {
    var set = {};
    if (!Array.isArray(values)) return set;
    values.forEach(function (value) {
      var code = normalizeCode(value);
      if (code) set[code] = true;
    });
    return set;
  }

  function normalizeMatrixRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (row) { return row && typeof row === 'object'; });
  }

  /* ============================================================
   * 工具目录 API（§2.2）
   * ============================================================ */

  function toolCatalog() {
    return TOOL_SPECS.map(cloneSpec);
  }

  function toolSpec(name) {
    return TOOL_MAP[name] || null;
  }

  function toolRank(role) {
    var text = normalizeText(role);
    return ROLE_RANK[text] || 0;
  }

  function roleLabel(role) {
    var text = normalizeText(role);
    return ROLE_LABELS[text] || ROLE_LABELS.viewer;
  }

  function normalizeRole(role) {
    var text = normalizeText(role);
    if (text === 'admin' || text === 'editor' || text === 'viewer') return text;
    if (!text) return 'editor';
    return 'viewer';
  }

  function toolsForRole(role) {
    var rank = toolRank(normalizeRole(role));
    return TOOL_SPECS.filter(function (spec) { return (ROLE_RANK[spec.minRole] || 0) <= rank; }).map(cloneSpec);
  }

  /* 契约 §2.2：requiredRole(tool, datasetType?)；当前两个数据集共用同一权限档，
   * 保留 datasetType 形参，便于后续按数据集细分（例如材料库将来只开放给 admin）。 */
  function requiredRole(tool, datasetType) {
    var spec = TOOL_MAP[tool];
    if (!spec) return 'admin';
    if (datasetType !== undefined && datasetType !== null) {
      normalizeDatasetType(datasetType);
    }
    return spec.minRole;
  }

  /* ============================================================
   * 清洗（§2.4）
   * ============================================================ */

  function cellText(value) {
    if (value === null || value === undefined) return '';
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return normalizeDateText(value) || '';
    }
    return String(value);
  }

  function rowToCells(row) {
    if (Array.isArray(row)) return row.map(cellText);
    if (row === null || row === undefined) return [];
    return [cellText(row)];
  }

  function normalizeCellText(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\uFEFF/, '').trim();
  }

  function boilerFromText(value) {
    var text = normalizeText(value);
    var match = text.match(/[12]/);
    return match ? match[0] : '';
  }

  function boilerFromCode(code) {
    var match = normalizeCode(code).match(/^([12])G-/);
    return match ? match[1] : '';
  }

  function categoryKey(raw) {
    var text = normalizeText(raw);
    if (!text) return '';
    if (CATEGORY_EVENT_KEYS.indexOf(text) >= 0) return '事件';
    if (CATEGORY_REPLACEMENT_KEYS.indexOf(text) >= 0) return '更换';
    return '';
  }

  function pushCheck(checks, id, severity, title, detail, rows, suggestion, sample) {
    var check = {
      id: id,
      severity: severity,
      title: title,
      detail: detail,
      rows: Array.isArray(rows) ? rows.slice() : []
    };
    if (suggestion) check.suggestion = suggestion;
    if (Array.isArray(sample) && sample.length) check.sample = sample.slice(0, 5);
    checks.push(check);
    return check;
  }

  function buildFallbackReport(fileName, sheetName, err) {
    return {
      datasetType: 'unknown',
      datasetLabel: '数据',
      fileName: fileName || '',
      sheetName: sheetName || '',
      summary: { totalRows: 0, cleanRows: 0, issueCount: 0, duplicateRows: 0, errorCount: 0, warningCount: 0, importable: false },
      checks: [{
        id: 'unknown_type',
        severity: 'warning',
        title: '清洗失败',
        detail: '清洗过程中出现异常，已降级为不导入：' + (err && err.message ? err.message : String(err)),
        rows: []
      }],
      normalizations: [],
      rowIndexes: [],
      headers: []
    };
  }

  function cleanRows(input) {
    var source = input && typeof input === 'object' ? input : {};
    var fileName = source.fileName === null || source.fileName === undefined ? '' : String(source.fileName);
    var sheetName = source.sheetName === null || source.sheetName === undefined ? '' : String(source.sheetName);
    try {
      return cleanRowsInternal(source, fileName, sheetName);
    } catch (err) {
      return buildFallbackReport(fileName, sheetName, err);
    }
  }

  function cleanRowsInternal(source, fileName, sheetName) {
    var rowsInput = Array.isArray(source.rows) ? source.rows : [];
    var units = normalizeUnits(source.units);
    var retiredCodes = makeCodeSet(source.retiredCodes);
    var matrixRows = normalizeMatrixRows(source.matrixRows);
    /* 台账候选集：系统里已有的管段编码 + 台账矩阵展开出的基础编码，供智能编码匹配使用 */
    var ledger = buildTubeCodeLedger(source.knownCodes, matrixRows, units);
    var rows = rowsInput.map(rowToCells);
    var rawFirstHeader = rows.length && rows[0].length ? String(rowsInput[0] && rowsInput[0][0] !== undefined ? rowsInput[0][0] : '') : '';
    var hasBom = /^\uFEFF/.test(rawFirstHeader);

    var headerRow = rows.length ? rows[0].map(normalizeCellText) : [];
    var declaredType = normalizeDatasetType(source.datasetType);
    var datasetType = declaredType;
    if (datasetType === 'unknown') datasetType = resolveDatasetType(headerRow, fileName);
    var known = datasetType !== 'unknown';
    /* 模型映射结果（headerMap）：原始列名 -> 标准列名；只接受该数据集真实存在的列名 */
    var headerOverride = {};
    if (known && source.headerMap && typeof source.headerMap === 'object') {
      Object.keys(source.headerMap).forEach(function (raw) {
        var target = normalizeText(source.headerMap[raw]);
        var canonical = DATASET_REGISTRY[datasetType].headers.filter(function (name) {
          return normalizeText(name) === target;
        })[0];
        if (canonical) headerOverride[normalizeText(raw)] = canonical;
      });
    }
    var canonicalHeaders = [];
    var headerMapping = headerRow.map(function (header, position) {
      var resolved = known
        ? canonicalHeaderWithLevel(datasetType, header, headerOverride)
        : { canonical: header, level: 'exact' };
      canonicalHeaders.push(resolved.canonical);
      return { position: position, raw: header, canonical: resolved.canonical, level: resolved.level };
    });
    /* 列索引按映射后的标准列名构建（同一标准列取首次出现的位置） */
    var colIndex = {};
    headerMapping.forEach(function (item) {
      if (!item.canonical) return;
      if (colIndex[item.canonical] === undefined) colIndex[item.canonical] = item.position;
    });

    var normalizations = [];
    var checks = [];
    if (hasBom) normalizations.push('已去除表头 BOM 标记');

    var missingHeaderNames = [];
    if (known) {
      DATASET_REGISTRY[datasetType].requiredHeaders.forEach(function (name) {
        if (colIndex[name] === undefined) missingHeaderNames.push(name);
      });
      if (missingHeaderNames.length) {
        normalizations.push('表头缺少必需列：' + missingHeaderNames.join('、'));
      }
    }

    var dataRows = rows.slice(1).map(function (cells) { return cells; });
    var totalRows = dataRows.length;

    var cleanRowsList = [];
    var rowIndexes = [];
    var seenKeys = {};
    var duplicateGroups = {};
    var duplicateOrder = [];
    var missingRequiredRows = [];
    var invalidDateRows = [];
    var invalidDateSamples = [];
    var invalidNumberRows = [];
    var invalidNumberSamples = [];
    var unknownTypeRows = [];
    var unknownTypeSamples = [];
    var boilerMismatchRows = [];
    var boilerMismatchSamples = [];
    var unmatchedRows = [];
    var unmatchedSamples = [];
    var retiredRows = [];
    var retiredSamples = [];
    var outOfRangeRows = [];
    var outOfRangeSamples = [];
    var unknownLedgerRows = [];
    var unknownLedgerSamples = [];
    var directionNormalizedRows = [];
    var directionNormalizedSamples = [];
    var duplicateDroppedRows = [];

    var lastNonEmptyHeader = -1;
    headerRow.forEach(function (header, position) {
      if (String(header).trim() !== '') lastNonEmptyHeader = position;
    });
    var extraHeaderColumns = headerRow.length - 1 - lastNonEmptyHeader;
    var extraColumnRows = [];

    function markDuplicate(groupMap, order, key, firstRowNumber, rowNumber) {
      if (!groupMap[key]) {
        groupMap[key] = [firstRowNumber, rowNumber];
        order.push(key);
      } else if (groupMap[key].indexOf(rowNumber) < 0) {
        groupMap[key].push(rowNumber);
      }
    }

    dataRows.forEach(function (cells, offset) {
      var rowNumber = offset + 1;
      var rawWidth = cells.length;
      var trimmed = cells.map(function (cell) { return String(cell === null || cell === undefined ? '' : cell).trim(); });
      var isBlank = trimmed.every(function (cell) { return cell === ''; });
      if (isBlank) {
        normalizations.push('第 ' + rowNumber + ' 行为空行，已丢弃');
        return;
      }

      if (!known) {
        var genericKey = 'g:' + trimmed.join('\u0001');
        if (seenKeys[genericKey]) {
          markDuplicate(duplicateGroups, duplicateOrder, genericKey, seenKeys[genericKey], rowNumber);
          uniquePush(duplicateDroppedRows, rowNumber);
          return;
        }
        seenKeys[genericKey] = rowNumber;
        var genericRow = trimmed.slice();
        while (genericRow.length < headerRow.length) genericRow.push('');
        cleanRowsList.push(genericRow);
        rowIndexes.push(rowNumber);
        return;
      }

      var pick = function (name) {
        var index = colIndex[name];
        if (index === undefined || index < 0 || index >= cells.length) return '';
        return String(cells[index] === null || cells[index] === undefined ? '' : cells[index]).trim();
      };

      if (datasetType === 'events') {
        if (rawWidth < 5) {
          missingRequiredRows.push(rowNumber);
          return;
        }
        var categoryRaw = pick('数据分类');
        var category = categoryKey(categoryRaw);
        if (!category) {
          unknownTypeRows.push(rowNumber);
          if (unknownTypeSamples.length < 5) unknownTypeSamples.push(categoryRaw || '（空）');
          return;
        }
        var dateRaw = pick('日期');
        var codeRaw = pick('管段编码');
        var relatedRaw = pick('关联新管码');
        var missing = [];
        if (colIndex['日期'] !== undefined && !dateRaw) missing.push('日期');
        if (colIndex['管段编码'] !== undefined && !codeRaw) missing.push('管段编码');
        if (colIndex['关联新管码'] !== undefined && category === '更换' && !relatedRaw) missing.push('关联新管码');
        if (missing.length) {
          missingRequiredRows.push(rowNumber);
          return;
        }

        var boilerRaw = pick('炉号');
        var boiler = boilerFromText(boilerRaw);
        var code = normalizeCode(codeRaw);
        var relatedCode = normalizeCode(relatedRaw);
        var codeBoiler = boilerFromCode(code);
        var relatedBoiler = boilerFromCode(relatedCode);
        var rowBoiler = boiler || codeBoiler || relatedBoiler;
        var boilerInvalid = Boolean(boilerRaw) && (!boiler || units.indexOf(boiler) < 0);
        var mismatch = boilerInvalid ||
          Boolean(boiler && codeBoiler && boiler !== codeBoiler) ||
          Boolean(boiler && relatedBoiler && boiler !== relatedBoiler) ||
          Boolean(rowBoiler && relatedBoiler && rowBoiler !== relatedBoiler) ||
          Boolean(rowBoiler && units.indexOf(rowBoiler) < 0) ||
          !rowBoiler;
        if (mismatch) {
          boilerMismatchRows.push(rowNumber);
          if (boilerMismatchSamples.length < 5) boilerMismatchSamples.push(boilerRaw ? boilerRaw + ' / ' + (code || relatedCode) : (code || relatedCode));
          return;
        }

        /* 方向感知归一：反方向编码按同一物理位置换算成规范方向（台账只存规范身份），
           换算结果进 direction_normalized 警告行，人工确认后入库；管段编码与关联新管码同口径。 */
        if (matrixRows.length) {
          var canonicalCode = canonicalTubeCode(code, matrixRows);
          if (canonicalCode) {
            normalizations.push('第 ' + rowNumber + ' 行编码「' + code + '」计数方向与台账规范相反，已按同一物理位置归一为 ' + canonicalCode.code);
            directionNormalizedRows.push(rowNumber);
            if (directionNormalizedSamples.length < 5) directionNormalizedSamples.push(code + ' ≙ ' + canonicalCode.code);
            code = canonicalCode.code;
          }
          var canonicalRelated = canonicalTubeCode(relatedCode, matrixRows);
          if (canonicalRelated) {
            normalizations.push('第 ' + rowNumber + ' 行关联新管码「' + relatedCode + '」已按同一物理位置归一为 ' + canonicalRelated.code);
            directionNormalizedRows.push(rowNumber);
            if (directionNormalizedSamples.length < 5) directionNormalizedSamples.push(relatedCode + ' ≙ ' + canonicalRelated.code);
            relatedCode = canonicalRelated.code;
          }
        }

        var normalizedDate = normalizeDateText(dateRaw);
        var dateValue = normalizedDate || dateRaw;
        if (!normalizedDate) {
          invalidDateRows.push(rowNumber);
          if (invalidDateSamples.length < 5) invalidDateSamples.push(dateRaw);
        } else if (normalizedDate !== dateRaw) {
          normalizations.push('第 ' + rowNumber + ' 行日期「' + dateRaw + '」已归一为 ' + normalizedDate);
        }

        var thicknessRaw = pick('厚度(mm)');
        var hardnessRaw = pick('硬度(HB)');
        var thicknessBad = thicknessRaw !== '' && !isNumericText(thicknessRaw);
        var hardnessBad = hardnessRaw !== '' && !isNumericText(hardnessRaw);
        if (thicknessBad || hardnessBad) {
          invalidNumberRows.push(rowNumber);
          if (invalidNumberSamples.length < 5) {
            if (thicknessBad) invalidNumberSamples.push('厚度 ' + thicknessRaw);
            if (hardnessBad && invalidNumberSamples.length < 5) invalidNumberSamples.push('硬度 ' + hardnessRaw);
          }
        }

        if (code && !TUBE_CODE_PATTERN.test(code)) {
          unmatchedRows.push(rowNumber);
          if (unmatchedSamples.length < 5) unmatchedSamples.push(code);
        }
        if (code && retiredCodes[code]) {
          retiredRows.push(rowNumber);
          if (retiredSamples.length < 5) retiredSamples.push(code);
        }
        /* 智能编码匹配：编码不在台账（已有记录 + 矩阵展开）时，找最相似的真实编码给建议。
           新规则下更换产生的新管码是同位置新流水号（…-Q002），台账里已有同位置编码就不算笔误。 */
        var codeSuggestion = null;
        if (code && !retiredCodes[code] && ledger.list.length) {
          var baseCode = code.replace(/-R\d+$/i, '');
          var baseNoSeq = baseCode.replace(/-Q\d{1,3}$/i, '');
          var knownSamePosition = baseNoSeq && ledger.list.some(function (known) {
            return String(known).indexOf(baseNoSeq + '-Q') === 0;
          });
          if (!ledger.set[baseCode] && !knownSamePosition) codeSuggestion = suggestSimilarCode(baseCode, ledger.list);
        }
        if (code && matrixRows.length) {
          var rangeChecked = validateTubeCode(code, matrixRows);
          if (rangeChecked.valid && !rangeChecked.matched) {
            outOfRangeRows.push(rowNumber);
            if (outOfRangeSamples.length < 5) {
              outOfRangeSamples.push(codeSuggestion
                ? code + '（近似：' + codeSuggestion.code + '，相似度 ' + Math.round(codeSuggestion.similarity * 100) + '%）'
                : code);
            }
          }
        } else if (code && codeSuggestion) {
          unknownLedgerRows.push(rowNumber);
          if (unknownLedgerSamples.length < 5) {
            unknownLedgerSamples.push(code + ' ≈ ' + codeSuggestion.code + '（相似度 ' + Math.round(codeSuggestion.similarity * 100) + '%）');
          }
        }

        var typeText = pick('事件类型/更换原因');
        var descText = pick('详细描述/结论');
        var businessKey = category === '事件'
          ? ['事件', code, dateValue, typeText, descText, thicknessRaw, hardnessRaw].join('\u0001')
          : ['更换', rowBoiler, code, relatedCode, dateValue, typeText].join('\u0001');
        if (seenKeys[businessKey]) {
          markDuplicate(duplicateGroups, duplicateOrder, businessKey, seenKeys[businessKey], rowNumber);
          uniquePush(duplicateDroppedRows, rowNumber);
          return;
        }
        seenKeys[businessKey] = rowNumber;

        var cleanRow = cells.map(function (cell, position) {
          var value = String(cell === null || cell === undefined ? '' : cell).trim();
          if (position === colIndex['日期'] && normalizedDate) value = normalizedDate;
          if (position === colIndex['管段编码'] && code) value = code;
          if (position === colIndex['关联新管码'] && relatedCode) value = relatedCode;
          return value;
        });
        while (cleanRow.length < headerRow.length) cleanRow.push('');
        cleanRowsList.push(cleanRow);
        rowIndexes.push(rowNumber);
        return;
      }

      /* material_library */
      var component = pick('部件名称');
      var spec = pick('规格型号');
      var material = pick('材质');
      var positionText = pick('分段/位置');
      var materialMissing = [];
      if (colIndex['部件名称'] !== undefined && !component) materialMissing.push('部件名称');
      if (colIndex['规格型号'] !== undefined && !spec) materialMissing.push('规格型号');
      if (colIndex['材质'] !== undefined && !material) materialMissing.push('材质');
      if (materialMissing.length) {
        missingRequiredRows.push(rowNumber);
        return;
      }

      var numericColumns = [['管径', pick('管径')], ['壁厚', pick('壁厚')], ['库存根数', pick('库存根数')]];
      var materialNumberBad = false;
      numericColumns.forEach(function (pair) {
        if (pair[1] !== '' && !isNumericText(pair[1])) {
          materialNumberBad = true;
          if (invalidNumberSamples.length < 5) invalidNumberSamples.push(pair[0] + ' ' + pair[1]);
        }
      });
      if (materialNumberBad) invalidNumberRows.push(rowNumber);

      var materialKey = [component, positionText, spec, material].join('\u0001');
      if (seenKeys[materialKey]) {
        markDuplicate(duplicateGroups, duplicateOrder, materialKey, seenKeys[materialKey], rowNumber);
        uniquePush(duplicateDroppedRows, rowNumber);
        return;
      }
      seenKeys[materialKey] = rowNumber;

      var materialRow = trimmed.slice();
      while (materialRow.length < headerRow.length) materialRow.push('');
      cleanRowsList.push(materialRow);
      rowIndexes.push(rowNumber);
    });

    /* ---------------- 输出列重排 ----------------
     * 页面导入（importLifecycleRows / importMaterialRows）按列位置取数
     * （第 0 列=数据分类、第 1 列=炉号……），因此清洗输出必须重排成模板顺序：
     * 已映射的标准列在前（按模板序），未识别列按原始顺序附在末尾。 */
    var fuzzyMappedHeaders = [];
    var unmappedHeaders = [];
    if (known) {
      headerMapping.forEach(function (item) {
        if (item.level === 'fuzzy' || item.level === 'model') fuzzyMappedHeaders.push(item);
        else if (item.level === 'none' && item.raw) unmappedHeaders.push(item);
      });
    }
    if (known && cleanRowsList.length) {
      var templateHeaders = DATASET_REGISTRY[datasetType].headers;
      /* 标准列名 → 首次出现的原始列位置 */
      var positionByCanonical = {};
      headerMapping.forEach(function (item) {
        if (item.canonical && positionByCanonical[item.canonical] === undefined) {
          positionByCanonical[item.canonical] = item.position;
        }
      });
      /* 模板列全量输出（缺列补空列占位，保证页面按位置导入不错位），未识别列附在末尾 */
      var columnOrder = templateHeaders.map(function (name) {
        return positionByCanonical[name] !== undefined ? positionByCanonical[name] : -1;
      });
      var extraPositions = [];
      headerMapping.forEach(function (item) {
        if (columnOrder.indexOf(item.position) < 0) extraPositions.push(item.position);
      });
      columnOrder = columnOrder.concat(extraPositions);

      var pickColumn = function (cells, position) {
        if (position < 0) return '';
        var value = cells && position < cells.length ? cells[position] : '';
        return String(value === null || value === undefined ? '' : value);
      };
      var reorderedHeader = templateHeaders.slice();
      extraPositions.forEach(function (position) {
        reorderedHeader.push(headerMapping[position].canonical);
      });
      cleanRowsList = cleanRowsList.map(function (cells) {
        return columnOrder.map(function (position) { return pickColumn(cells, position); });
      });
      headerRow = reorderedHeader;
      canonicalHeaders = reorderedHeader.slice();
    }

    /* 组装检查项 */
    if (known && missingHeaderNames.length) {
      var headerBlockedRows = [];
      dataRows.forEach(function (cells, offset) {
        var isBlankRow = cells.every(function (cell) { return String(cell === null || cell === undefined ? '' : cell).trim() === ''; });
        if (!isBlankRow) headerBlockedRows.push(offset + 1);
      });
      pushCheck(checks, 'missing_required', 'error', '表头缺少必需列',
        '缺少列：' + missingHeaderNames.join('、') + '。请使用页面提供的 CSV 模板重新导出。',
        headerBlockedRows, '在「数据录入」页下载对应模板，按模板表头填写后再导入。');
    }
    /* 表头级缺失已单独报错时，不再重复输出行级 missing_required（这些行本就不能导入） */
    if (missingRequiredRows.length && !missingHeaderNames.length) {
      pushCheck(checks, 'missing_required', 'error', '缺少必需字段',
        '共 ' + missingRequiredRows.length + ' 行缺少必需字段（日期、管段编码；更换行还需要关联新管码），已跳过。',
        missingRequiredRows, '补齐必填字段后重新导入，或直接从页面模板重新填写。');
    }
    if (unknownTypeRows.length) {
      pushCheck(checks, 'unknown_type', 'warning', '未识别的数据分类',
        '共 ' + unknownTypeRows.length + ' 行「数据分类」既不是事件也不是更换，已跳过（与页面导入口径一致，不阻断其余行）。',
        unknownTypeRows, '数据分类只能填「事件」或「更换」。', unknownTypeSamples);
    }
    if (boilerMismatchRows.length) {
      pushCheck(checks, 'boiler_mismatch', 'error', '炉号与管段编码不一致',
        '共 ' + boilerMismatchRows.length + ' 行无法确定机组，或炉号与编码首位不一致，这些行不会导入。',
        boilerMismatchRows, '检查「炉号」列是否为 1 或 2，并确认管段编码以对应机组号（1G- / 2G-）开头。', boilerMismatchSamples);
    }
    if (invalidDateRows.length) {
      pushCheck(checks, 'invalid_date', 'warning', '日期无法识别',
        '共 ' + invalidDateRows.length + ' 行日期无法归一为 YYYY-MM-DD，已保留原文。',
        invalidDateRows, '建议统一为 2024-01-05 这种格式。', invalidDateSamples);
    }
    if (invalidNumberRows.length) {
      pushCheck(checks, 'invalid_number', 'warning', '厚度/硬度不是数字',
        '共 ' + invalidNumberRows.length + ' 行的数值列无法解析为数字。',
        invalidNumberRows, '数值列请只填写数字，例如 7.10、185。', invalidNumberSamples);
    }
    if (duplicateDroppedRows.length) {
      var droppedSorted = duplicateDroppedRows.slice().sort(function (a, b) { return a - b; });
      var keptRowsSorted = [];
      var involvedRowsAll = [];
      duplicateOrder.forEach(function (key) {
        var group = duplicateGroups[key];
        if (!group || group.length < 2) return;
        uniquePush(keptRowsSorted, group[0]);
        group.forEach(function (rowNumber) { uniquePush(involvedRowsAll, rowNumber); });
      });
      var duplicateCheck = pushCheck(checks, 'duplicate_rows', 'warning', '文件内重复记录',
        '共 ' + droppedSorted.length + ' 行与前面的记录重复，重复行只保留首行（行号包含每组被保留的首行）。',
        involvedRowsAll.sort(function (a, b) { return a - b; }), '确认是否有重复录入；如需保留，请先修改业务键字段。');
      duplicateCheck.duplicateRows = droppedSorted.length;
      duplicateCheck.droppedRows = droppedSorted;
      duplicateCheck.keptRows = keptRowsSorted.sort(function (a, b) { return a - b; });
    }
    if (unmatchedRows.length) {
      pushCheck(checks, 'unmatched_code', 'warning', '管段编码格式不符合规则',
        '共 ' + unmatchedRows.length + ' 行管段编码不符合新编码规则（示例：2G-SLB-WB-F000-R025-Q16），仍会导入。',
        unmatchedRows, '建议按编码生成器重新生成管段编码。', unmatchedSamples);
    }
    if (retiredRows.length) {
      pushCheck(checks, 'retired_code', 'warning', '使用了已报废管码',
        '共 ' + retiredRows.length + ' 行管段编码已报废，请确认是否为历史补录。',
        retiredRows, '补录历史数据可以保留，新增检测请使用在役管码。', retiredSamples);
    }
    if (outOfRangeRows.length) {
      pushCheck(checks, 'out_of_range', 'warning', '编码超出台账矩阵范围',
        '共 ' + outOfRangeRows.length + ' 行编码的屏/管圈超出台账矩阵范围。',
        outOfRangeRows, '对照「炉管台账」中的屏号/管圈号核对。', outOfRangeSamples);
    }
    if (unknownLedgerRows.length) {
      pushCheck(checks, 'unknown_code', 'warning', '编码未在台账中找到',
        '共 ' + unknownLedgerRows.length + ' 行管段编码在台账（已有记录 + 矩阵范围）中不存在，但找到了高度相似的编码，疑似录入笔误；行仍会导入，请逐条核对。',
        unknownLedgerRows, '对照「炉管台账」核对屏号/管圈号/管序号；确属新管请先用编码生成器登记。', unknownLedgerSamples);
    }
    if (directionNormalizedRows.length) {
      pushCheck(checks, 'direction_normalized', 'warning', '编码计数方向已归一',
        '共 ' + directionNormalizedRows.length + ' 行编码的计数方向与台账规范方向相反（现场从另一端计数），已按同一物理位置自动换算为规范编码并留痕；行仍导入，请抽查换算结果。',
        directionNormalizedRows, '现场可从任意一端计数，系统按台账规范方向（台账矩阵展开口径）统一换算，无需人工换算。', directionNormalizedSamples);
    }
    if (extraHeaderColumns > 0) {
      pushCheck(checks, 'extra_columns', 'info', '表头末尾存在空列',
        '表头末尾有 ' + extraHeaderColumns + ' 个空列，已忽略。', [], '删除多余列可以让文件更易读。');
      normalizations.push('已忽略表头末尾 ' + extraHeaderColumns + ' 个空列');
    }
    if (fuzzyMappedHeaders.length || unmappedHeaders.length) {
      var mappingDetails = fuzzyMappedHeaders.map(function (item) {
        return '「' + item.raw + '」→「' + item.canonical + '」' + (item.level === 'model' ? '（模型匹配）' : '（智能匹配）');
      });
      var mappingDetail = mappingDetails.length
        ? '已把 ' + mappingDetails.length + ' 列映射到标准字段：' + mappingDetails.join('、') + '。'
        : '';
      if (unmappedHeaders.length) {
        mappingDetail += (mappingDetail ? ' ' : '') + unmappedHeaders.length + ' 个列名未识别（'
          + unmappedHeaders.slice(0, 5).map(function (item) { return '「' + item.raw + '」'; }).join('、')
          + (unmappedHeaders.length > 5 ? '等' : '') + '），已原样保留在结果末尾，不会写入台账字段。';
      }
      pushCheck(checks, 'header_mapping', 'info', '字段智能匹配', mappingDetail, [],
        unmappedHeaders.length
          ? '把列名改成模板列名（或配置模型后重新上传）可完整入库；未识别列仅随清洗结果导出。'
          : '映射按列名相似度判断，导入前请在预览中抽查数值列是否对位。');
    }
    if (!known) {
      pushCheck(checks, 'unknown_type', 'warning', '未识别数据集',
        '无法从表头识别数据集类型，仅执行去空行、去重和 trim 的通用清洗，不会导入。',
        [], '请确认表头包含「日期 + 管段编码」（寿命事件）或「部件名称 + 规格型号 + 材质」（材料库）。');
      /* 通用去重的结果统一在主检查块里输出（duplicateDroppedRows 已包含），此处不重复输出。 */
    }

    /* 统计：errorCount/warningCount 为涉及行数 */
    var errorRowSet = {};
    var warningRowSet = {};
    checks.forEach(function (check) {
      if (check.severity !== 'error' && check.severity !== 'warning') return;
      var target = check.severity === 'error' ? errorRowSet : warningRowSet;
      (check.rows || []).forEach(function (rowNumber) { target[rowNumber] = true; });
    });
    var errorCount = Object.keys(errorRowSet).length;
    var warningCount = Object.keys(warningRowSet).length;
    var duplicateCount = 0;
    checks.forEach(function (check) {
      if (check.id === 'duplicate_rows' && check.duplicateRows) duplicateCount += check.duplicateRows;
    });
    var cleanCount = cleanRowsList.length;
    var importable = known && !missingHeaderNames.length && errorCount === 0 && cleanCount > 0;

    var report = {
      datasetType: datasetType,
      datasetLabel: datasetLabel(datasetType),
      fileName: fileName,
      sheetName: sheetName,
      summary: {
        totalRows: totalRows,
        cleanRows: cleanCount,
        issueCount: errorCount + warningCount,
        duplicateRows: duplicateCount,
        errorCount: errorCount,
        warningCount: warningCount,
        importable: importable
      },
      checks: checks,
      normalizations: normalizations,
      headerMapping: headerMapping,
      rowIndexes: rowIndexes,
      headers: canonicalHeaders
    };

    var preview = cleanRowsList.slice(0, 5);
    return {
      report: report,
      cleanRows: cleanRowsList.length ? [headerRow.slice()].concat(cleanRowsList) : [headerRow.slice()],
      preview: preview
    };
  }

  /* ============================================================
   * 查询解析（§2.5）
   * ============================================================ */

  function getSystemRule(sys) {
    var key = normalizeCode(sys);
    for (var i = 0; i < CODE_SYSTEMS.length; i += 1) {
      if (CODE_SYSTEMS[i].sys === key) return CODE_SYSTEMS[i];
    }
    return null;
  }

  function sysLabel(sys) {
    var list = Array.isArray(sys) ? sys : [sys];
    var labels = [];
    list.forEach(function (item) {
      var rule = getSystemRule(item);
      if (rule) labels.push(rule.label + '（' + rule.sys + '）');
      else if (item) labels.push(String(item));
    });
    return labels.join('、');
  }

  function zoneLabel(zone) {
    return ZONE_LABELS[normalizeCode(zone)] || String(zone || '');
  }

  var SYS_KEYWORDS = [
    { sys: 'SLB', re: /水冷壁|水冷/ },
    { sys: 'RSH', re: /顶棚过热器|顶棚/ },
    { sys: 'WSH', re: /包墙过热器|包墙/ },
    { sys: 'DGRQ', re: /低温过热器|低过/ },
    { sys: 'DPGRQ', re: /全大屏过热器|全大屏/ },
    { sys: 'HPGRQ', re: /后屏过热器|屏过|屏式/ },
    { sys: 'GGRQ', re: /高温过热器|高过/ },
    { sys: 'DZRQ', re: /低温再热器|低再/ },
    { sys: 'GZRQ', re: /高温再热器|高再/ },
    { sys: 'SMQ', re: /省煤器/ },
    { generic: '过热器', re: /过热器/ },
    { generic: '再热器', re: /再热器/ }
  ];

  function extractSystems(text) {
    var result = [];
    var genericHeat = false;
    var genericReheat = false;
    SYS_KEYWORDS.forEach(function (item) {
      if (item.generic) {
        if (item.re.test(text)) {
          if (item.generic === '过热器') genericHeat = true;
          if (item.generic === '再热器') genericReheat = true;
        }
        return;
      }
      if (item.re.test(text) && result.indexOf(item.sys) < 0) result.push(item.sys);
    });
    if (result.length) return result;
    var codeMatch = text.match(/(?:^|[^A-Z])(SLB|GZRQ|GGRQ|HPGRQ|DPGRQ|DGRQ|DZRQ|SMQ|RSH|WSH)(?:[^A-Z]|$)/);
    if (codeMatch) return [codeMatch[1]];
    if (genericHeat) return ['RSH', 'WSH', 'DGRQ', 'DPGRQ', 'HPGRQ', 'GGRQ'];
    if (genericReheat) return ['DZRQ', 'GZRQ'];
    return [];
  }

  var TYPE_KEYWORDS = [
    { type: '测厚', re: /测厚|壁厚测量/ },
    { type: '金相分析', re: /金相/ },
    { type: '无损检测', re: /无损|探伤/ },
    { type: '割管取样', re: /割管|取样/ },
    { type: '检修维护', re: /检修|维护|维修/ },
    { type: '报废更换', re: /报废|更换/ },
    { type: '安装投运', re: /安装|投运/ }
  ];

  function extractType(text) {
    for (var i = 0; i < TYPE_KEYWORDS.length; i += 1) {
      if (TYPE_KEYWORDS[i].re.test(text)) return TYPE_KEYWORDS[i].type;
    }
    return '';
  }

  function extractUnit(text) {
    var explicit = text.match(/([12])(?:号炉|号机组|#机组|#炉|号锅炉|号机|#)/);
    if (explicit) return explicit[1];
    var chinese = text.match(/(一|二)号(?:炉|机组|锅炉)?/);
    if (chinese) return chinese[1] === '一' ? '1' : '2';
    return '';
  }

  function extractZone(text) {
    if (/前墙|前坡/.test(text)) return 'F000';
    if (/后墙|后坡/.test(text)) return 'B000';
    if (/左墙|左坡/.test(text)) return 'L000';
    if (/右墙|右坡/.test(text)) return 'R000';
    if (/冷灰斗/.test(text)) return 'LHD';
    return '';
  }

  function extractDateFilters(text, now) {
    var filters = {};
    var match;
    var base = toDate(now) || new Date();
    if ((match = text.match(/(?:最近|近|过去)(\d+)个?月/))) {
      var months = Number(match[1]);
      if (months > 0) {
        var fromMonth = addMonths(base, -months);
        filters.dateFrom = formatDateParts(fromMonth.getUTCFullYear(), fromMonth.getUTCMonth() + 1, fromMonth.getUTCDate());
        filters.dateTo = formatDateParts(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
      }
    } else if ((match = text.match(/(?:最近|近|过去)(一|二|两|三|1|2|3)年/))) {
      var label = match[1];
      var years = label === '一' || label === '1' ? 1 : (label === '二' || label === '两' || label === '2' ? 2 : 3);
      var fromYear = addMonths(base, -12 * years);
      filters.dateFrom = formatDateParts(fromYear.getUTCFullYear(), fromYear.getUTCMonth() + 1, fromYear.getUTCDate());
      filters.dateTo = formatDateParts(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
    } else if ((match = text.match(/(\d{4})[-~至到](\d{4})年?/))) {
      filters.dateFrom = match[1] + '-01-01';
      filters.dateTo = match[2] + '-12-31';
    } else if ((match = text.match(/(\d{4})年/))) {
      filters.dateFrom = match[1] + '-01-01';
      filters.dateTo = match[1] + '-12-31';
    }
    return filters;
  }

  function extractThicknessFilters(text) {
    var filters = {};
    var match;
    if ((match = text.match(/(?:壁厚|厚度)(?:小于|低于|不足|少于|<|＜)(\d+(?:\.\d+)?)/))) {
      filters.maxThickness = Number(match[1]);
    } else if ((match = text.match(/(?:壁厚|厚度)(?:大于|高于|超过|>|＞)(\d+(?:\.\d+)?)/))) {
      filters.minThickness = Number(match[1]);
    }
    return filters;
  }

  function extractRiskLevel(text) {
    if (/高风险|严重风险|重大风险/.test(text)) return 'HIGH';
    if (/中风险|预警风险|一般风险/.test(text)) return 'MEDIUM';
    if (/低风险|轻微风险/.test(text)) return 'LOW';
    return '';
  }

  function extractOverdue(text) {
    var filters = {};
    if (/从未检查|从没检查|没检查过|未检查过|从未检验/.test(text)) {
      filters.neverInspected = true;
      return filters;
    }
    var match = text.match(/(\d+)年(?:以上)?(?:没|未)(?:有)?检查/);
    if (match) filters.overdueYears = Number(match[1]);
    return filters;
  }

  function hasMaterialWord(text) {
    return /材料库|备件|库存|材料/.test(text);
  }

  /* ============================================================
   * 查询解析（§2.5）
   * ============================================================ */

  var DATASET_QUERY_LABELS = {
    events: '寿命事件',
    replacements: '更换记录',
    material_library: '受热面材料',
    tube_ledger: '管段台账',
    warnings: '预警记录',
    maintenance: '超期未检记录'
  };

  function parseQuery(message, context) {
    var ctx = context && typeof context === 'object' ? context : {};
    try {
      return parseQueryInternal(message, ctx);
    } catch (err) {
      return { dataset: 'unknown', filters: {}, description: '' };
    }
  }

  function parseQueryInternal(message, ctx) {
    var rawText = message === null || message === undefined ? '' : String(message).trim();
    if (!rawText) return { dataset: 'unknown', filters: {}, description: '' };
    var text = normalizeText(rawText);
    var now = toDate(ctx.now) || new Date();
    var filters = {};

    var unit = extractUnit(text);
    if (unit) filters.unit = unit;
    var systems = extractSystems(text);
    if (systems.length === 1) filters.sys = systems[0];
    else if (systems.length > 1) filters.sys = systems;
    var zone = extractZone(text);
    if (zone) filters.zone = zone;
    var type = extractType(text);
    if (type) filters.type = type;

    var upperText = rawText.toUpperCase();
    var codeMatch = upperText.match(new RegExp(TUBE_CODE_SOURCE));
    if (codeMatch) {
      filters.code = normalizeCode(codeMatch[0]);
    } else {
      var fragment = text.match(/(?:包含|含有|带)([a-z0-9][a-z0-9-]{1,30})/);
      if (fragment) filters.code = normalizeCode(fragment[1]);
    }

    var dateFilters = extractDateFilters(text, now);
    Object.keys(dateFilters).forEach(function (key) { filters[key] = dateFilters[key]; });
    var thicknessFilters = extractThicknessFilters(text);
    Object.keys(thicknessFilters).forEach(function (key) { filters[key] = thicknessFilters[key]; });
    var riskLevel = extractRiskLevel(text);
    if (riskLevel) filters.riskLevel = riskLevel;
    var overdue = extractOverdue(text);
    Object.keys(overdue).forEach(function (key) { filters[key] = overdue[key]; });

    var quoted = rawText.match(/[「"“']([^」"”']{1,24})[」"”']/);
    if (quoted) {
      var quotedText = quoted[1].trim();
      var quotedUpper = normalizeCode(quotedText);
      if (getSystemRule(quotedUpper)) {
        if (!filters.sys) filters.sys = quotedUpper;
      } else if (quotedText) {
        filters.keyword = quotedText;
      }
    }
    var keywordMatch = text.match(/(?:材质|材料|钢种)(?:是|为|:)?([a-z0-9-]{2,16})/);
    if (!filters.keyword && keywordMatch) filters.keyword = keywordMatch[1];
    if (!filters.keyword && /低于理论厚度/.test(text)) filters.keyword = '低于理论厚度';

    var hasEventWords = /事件|检测|测厚|金相|无损|割管|检修|寿命|记录|数据/.test(text);
    var hasFilter = Boolean(filters.unit || filters.sys || filters.type || filters.code || filters.keyword ||
      filters.dateFrom || filters.dateTo || filters.maxThickness !== undefined || filters.minThickness !== undefined ||
      filters.riskLevel || filters.overdueYears || filters.neverInspected);

    var dataset = 'unknown';
    if (/超期|未检|没检查|未检查|从未检查|多久没|几年没|检修计划|维护计划/.test(text)) dataset = 'maintenance';
    else if (/材料库|备件|库存/.test(text) || (hasMaterialWord(text) && !hasEventWords)) dataset = 'material_library';
    else if (/台账|管段清单|编码清单|所有管段|生成管段/.test(text)) dataset = 'tube_ledger';
    else if (/更换记录|换管|报废记录|替换记录|更换情况/.test(text)) dataset = 'replacements';
    else if (/预警|告警|异常|风险|问题清单|隐患/.test(text) && !hasEventWords) dataset = 'warnings';
    else if (hasEventWords || hasFilter) dataset = 'events';
    else if (/预警|告警|风险/.test(text)) dataset = 'warnings';

    if (dataset !== 'events' && dataset !== 'replacements' && dataset !== 'tube_ledger') {
      delete filters.keyword;
      delete filters.type;
      delete filters.zone;
    }
    if (dataset === 'unknown') return { dataset: 'unknown', filters: filters, description: '' };
    return { dataset: dataset, filters: filters, description: buildQueryDescription(dataset, filters) };
  }

  function buildQueryDescription(dataset, filters) {
    var parts = [];
    if (filters.unit) parts.push(filters.unit + ' 号机组');
    if (filters.sys) {
      var sysText = Array.isArray(filters.sys)
        ? filters.sys.map(function (sys) { return sysLabel(sys); }).join('、')
        : sysLabel(filters.sys);
      parts.push('受热面「' + sysText + '」');
    }
    if (filters.zone) parts.push('部位「' + zoneLabel(filters.zone) + '」');
    if (filters.type) parts.push('类型「' + filters.type + '」');
    if (filters.code) parts.push('管段「' + filters.code + '」');
    if (filters.keyword) parts.push('关键词「' + filters.keyword + '」');
    if (filters.dateFrom || filters.dateTo) {
      parts.push('日期 ' + (filters.dateFrom || '不限') + ' ~ ' + (filters.dateTo || '不限'));
    }
    if (filters.maxThickness !== undefined) parts.push('壁厚 < ' + filters.maxThickness + 'mm');
    if (filters.minThickness !== undefined) parts.push('壁厚 > ' + filters.minThickness + 'mm');
    if (filters.riskLevel) parts.push('风险等级 ' + filters.riskLevel);
    if (filters.overdueYears) parts.push(filters.overdueYears + ' 年以上未检查');
    if (filters.neverInspected) parts.push('从未检查');
    var label = DATASET_QUERY_LABELS[dataset] || '记录';
    return parts.length ? '查 ' + parts.join('、') + '的' + label : '查全部' + label;
  }

  /* ============================================================
   * 编辑解析（§2.6）
   * ============================================================ */

  var EDIT_FIELD_RULES = [
    { field: 'thickness', label: '厚度', re: /厚度|壁厚/ },
    { field: 'hardness', label: '硬度', re: /硬度/ },
    { field: 'date', label: '日期', re: /日期|时间/ },
    { field: 'code', label: '管段编码', re: /管码|管段编码|编码|编号/ },
    { field: 'type', label: '事件类型', re: /类型|事件类型|检测类型/ },
    { field: 'desc', label: '描述', re: /描述|结论|备注|说明/ },
    { field: 'spec', label: '规格', re: /规格/ },
    { field: 'material', label: '材质', re: /材质|材料/ }
  ];
  var EDIT_FIELD_LABELS = {
    date: '日期', code: '管段编码', type: '事件类型', desc: '描述',
    thickness: '厚度', hardness: '硬度', spec: '规格', material: '材质'
  };

  function extractTubeCodes(text) {
    var result = [];
    var source = String(text === null || text === undefined ? '' : text);
    var pattern = new RegExp(TUBE_CODE_SOURCE, 'gi');
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var code = normalizeCode(match[0]);
      if (code && result.indexOf(code) < 0) result.push(code);
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    return result;
  }

  function parseEdit(message, context) {
    var ctx = context && typeof context === 'object' ? context : {};
    try {
      return parseEditInternal(message, ctx);
    } catch (err) {
      return null;
    }
  }

  function parseEditInternal(message, ctx) {
    var rawText = message === null || message === undefined ? '' : String(message).trim();
    if (!rawText) return null;
    var text = normalizeText(rawText);
    var codes = extractTubeCodes(rawText);
    var verbMatch = EDIT_VERB_RE.exec(rawText);
    if (!verbMatch) return null;
    var verbEnd = verbMatch.index + verbMatch[0].length;
    var beforeVerb = normalizeText(rawText.slice(0, verbMatch.index));

    var fieldRule = null;
    for (var i = 0; i < EDIT_FIELD_RULES.length && !fieldRule; i += 1) {
      if (EDIT_FIELD_RULES[i].re.test(beforeVerb)) fieldRule = EDIT_FIELD_RULES[i];
    }
    if (!fieldRule) {
      for (var j = 0; j < EDIT_FIELD_RULES.length && !fieldRule; j += 1) {
        if (EDIT_FIELD_RULES[j].re.test(text)) fieldRule = EDIT_FIELD_RULES[j];
      }
    }
    if (!fieldRule) return null;

    var targetCode = '';
    var rest = '';
    if (fieldRule.field === 'code') {
      if (codes.length < 2) return null;
      targetCode = codes[0];
      var secondIndex = rawText.toUpperCase().indexOf(codes[1]);
      rest = rawText.slice(Math.max(verbEnd, secondIndex));
    } else {
      if (!codes.length) return null;
      targetCode = codes[0];
      rest = rawText.slice(verbEnd);
    }
    rest = rest.replace(/^[：:，,。\s]+/, '').replace(/[。，,；;]+$/g, '').trim();
    if (!rest) return null;

    var value = '';
    if (fieldRule.field === 'date') {
      var dateMatch = rest.match(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/);
      var normalized = normalizeDateText(dateMatch ? dateMatch[0] : rest);
      if (!normalized) return null;
      value = normalized;
    } else if (fieldRule.field === 'thickness' || fieldRule.field === 'hardness') {
      var numberMatch = rest.match(/[-+]?\d+(?:\.\d+)?/);
      if (!numberMatch) return null;
      var num = Number(numberMatch[0]);
      if (!isFinite(num) || num <= 0) return null;
      if (fieldRule.field === 'thickness' && (num < 0.1 || num > 100)) return null;
      if (fieldRule.field === 'hardness' && (num < 1 || num > 600)) return null;
      value = String(num);
    } else if (fieldRule.field === 'code') {
      var newCodes = extractTubeCodes(rest);
      if (!newCodes.length) return null;
      var validated = validateTubeCode(newCodes[0]);
      if (!validated.valid) return null;
      value = validated.code;
    } else if (fieldRule.field === 'type') {
      var normalizedType = normalizeEventType(rest);
      if (!normalizedType.known) return null;
      value = normalizedType.type;
    } else {
      value = rest.replace(/^[「"“']+/, '').replace(/[」"”']+$/g, '').trim();
      if (!value) return null;
    }

    var recordHint = 'latest';
    var targetDate = '';
    var recordDateMatch = rawText.match(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/);
    if (recordDateMatch) {
      var recordDate = normalizeDateText(recordDateMatch[0]);
      if (recordDate) {
        recordHint = 'date';
        targetDate = recordDate;
      }
    }
    if (recordHint === 'latest' && /最早|第一次|首次|最开始/.test(text)) recordHint = 'oldest';

    var hintText = recordHint === 'date' ? (targetDate + ' 当天的记录') : (recordHint === 'oldest' ? '最早记录' : '最新记录');
    var reply = '准备把 ' + targetCode + '（' + hintText + '）的' + EDIT_FIELD_LABELS[fieldRule.field] + '改为「' + value + '」，确认后写入。';

    var result = {
      targetCode: targetCode,
      recordHint: recordHint,
      field: fieldRule.field,
      value: value,
      reply: reply
    };
    if (recordHint === 'date') result.targetDate = targetDate;
    return result;
  }

  /* ============================================================
   * 意图解析（§2.3）
   * ============================================================ */

  function datasetTypeFromKeywords(text) {
    var scores = { events: 0, material_library: 0 };
    DATASET_LIST.forEach(function (dataset) {
      dataset.keywords.forEach(function (keyword) {
        var key = normalizeText(keyword);
        if (key && text.indexOf(key) >= 0) scores[dataset.type] += 1;
      });
    });
    if (scores.events > scores.material_library) return 'events';
    if (scores.material_library > scores.events) return 'material_library';
    return 'unknown';
  }

  function detectIntentDataset(text, ctx) {
    var headerType = 'unknown';
    if (Array.isArray(ctx.headers)) headerType = resolveDatasetType(ctx.headers, ctx.fileName);
    var activeType = normalizeDatasetType(ctx.activeDatasetType);
    var textType = datasetTypeFromKeywords(text);
    if (textType !== 'unknown') return textType;
    if (headerType !== 'unknown') return headerType;
    if (activeType !== 'unknown') return activeType;
    return 'unknown';
  }

  var UNKNOWN_INTENT_REPLY = '没太听懂这句话。你可以试试：\n1. 「检查这批寿命数据能不能导入」\n2. 「查一下 2 号炉高再的测厚记录」\n3. 「现在数据质量怎么样」\n4. 「近两年壁厚趋势」看图表分析';

  function createUnknownIntent(reply, datasetType, ctx) {
    var params = {};
    if (datasetType && datasetType !== 'unknown') params.datasetType = datasetType;
    return {
      intent: 'unknown',
      datasetType: datasetType || 'unknown',
      tool: INTENT_TOOL.unknown,
      params: params,
      confidence: 0.15,
      reply: reply,
      source: 'rules',
      needsFile: false,
      needsConfirm: false
    };
  }

  function parseIntent(message, context) {
    var ctx = context && typeof context === 'object' ? context : {};
    try {
      return parseIntentInternal(message, ctx);
    } catch (err) {
      return createUnknownIntent(UNKNOWN_INTENT_REPLY, 'unknown', ctx);
    }
  }

  function parseIntentInternal(message, ctx) {
    var rawText = message === null || message === undefined ? '' : String(message).trim();
    var text = normalizeText(rawText);
    if (!text) return createUnknownIntent(UNKNOWN_INTENT_REPLY, 'unknown', ctx);

    var templateRequest = TEMPLATE_RE.test(text);
    var cannotImport = CANNOT_IMPORT_RE.test(text);
    var cannotExport = /导出|下载|另存为|保存为|保存成|存成/.test(text);
    var exportScan = templateRequest ? text.replace(/下载/g, '').replace(/模板/g, '') : text;
    var importScan = cannotImport ? text.replace(/能不能导入|能否导入|能导入吗|可以导入吗|可不可以导入|能入库吗|能不能入库|可不可以入库/g, '') : text;
    /* 明确的导出/下载说法优先走导出：不让「导出壁厚趋势」被当成分析 */
    var analyzeScan = cannotExport ? '' : text;

    var scores = { undo: 0, clean: 0, export: 0, import: 0, edit: 0, query: 0, analyze: 0, stats: 0, help: 0 };
    INTENT_PATTERNS.forEach(function (rule) {
      var scan = rule.intent === 'export' ? exportScan
        : (rule.intent === 'import' ? importScan
          : (rule.intent === 'analyze' ? analyzeScan : text));
      if (rule.re.test(scan)) scores[rule.intent] += rule.weight;
    });
    if (templateRequest) scores.help += 6;
    if (cannotImport) scores.clean += 6;
    if (EDIT_VERB_RE.test(text)) {
      if (EDIT_FIELD_RE.test(text)) scores.edit += 5;
      else if (/报废|测厚|金相|无损|割管|检修|安装|投运/.test(text)) scores.edit += 3;
      else scores.edit += 1;
    }
    if (COUNTING_RE.test(text) && !LISTING_RE.test(text)) scores.stats += 3;
    if (analyzeScan && STRONG_ANALYSIS_RE.test(analyzeScan)) scores.analyze += 6;

    var bestIntent = 'unknown';
    var bestScore = 0;
    INTENT_PRIORITY.forEach(function (intent) {
      if (intent === 'unknown') return;
      if (scores[intent] > bestScore) { bestIntent = intent; bestScore = scores[intent]; }
    });
    if (bestScore < 2) { bestIntent = 'unknown'; bestScore = 0; }

    var datasetType = detectIntentDataset(text, ctx);
    if (bestIntent === 'unknown') return createUnknownIntent(UNKNOWN_INTENT_REPLY, datasetType, ctx);

    var tool = INTENT_TOOL[bestIntent];
    var spec = TOOL_MAP[tool];
    var role = normalizeRole(ctx.role);
    var neededRole = spec ? spec.minRole : 'editor';
    var hasPending = Boolean(ctx.hasPendingFile || ctx.hasPendingRows);
    var needsFile = spec ? (!spec.runnableWithoutFile && !hasPending) : false;
    var needsConfirm = spec ? Boolean(spec.requiresConfirm) : false;

    var params = {};
    if (datasetType !== 'unknown') params.datasetType = datasetType;
    var exportScope = '';
    var exportFormat = '';
    if (bestIntent === 'export') {
      exportScope = /全部|全厂|所有|整个/.test(text) ? 'all' : 'current_filter';
      exportFormat = /xlsx|excel|xls|表格文件/.test(text) ? 'xlsx' : 'csv';
      params.exportScope = exportScope;
      params.format = exportFormat;
    }
    var queryResult = null;
    if (bestIntent === 'query') {
      queryResult = parseQuery(rawText, ctx);
      if (queryResult.dataset && queryResult.dataset !== 'unknown') params.queryDataset = queryResult.dataset;
    }
    var editResult = null;
    if (bestIntent === 'edit') editResult = parseEdit(rawText, ctx);
    if ((bestIntent === 'import' || bestIntent === 'clean') && datasetType !== 'unknown' && /表头|列名|字段/.test(text)) {
      params.expectHeader = DATASET_REGISTRY[datasetType].headers.join(',');
    }
    if (templateRequest) params.note = 'template';

    var reply = buildIntentReply({
      intent: bestIntent,
      datasetType: datasetType,
      needsFile: needsFile,
      queryResult: queryResult,
      editResult: editResult,
      exportScope: exportScope,
      exportFormat: exportFormat,
      template: templateRequest
    });
    if (toolRank(role) < toolRank(neededRole)) {
      reply = '该操作需要' + roleLabel(neededRole) + '权限，请联系管理员。' + reply;
    }

    var confidence = Math.round(Math.min(0.98, 0.32 + bestScore * 0.07) * 100) / 100;

    return {
      intent: bestIntent,
      datasetType: datasetType,
      tool: tool,
      params: params,
      confidence: confidence,
      reply: reply,
      source: 'rules',
      needsFile: needsFile,
      needsConfirm: needsConfirm
    };
  }

  function buildIntentReply(info) {
    var label = datasetLabel(info.datasetType);
    if (info.template) {
      return '模板下载不走助手导出：请到「数据录入」页点「下载 CSV 模板」（寿命数据）或「设备资料 → 材料库」页点「下载维护模板」。下载好填写完再发给我，我先清洗再导入。';
    }
    switch (info.intent) {
      case 'clean':
        return info.needsFile
          ? '好的，把要导入的 CSV / Excel 发给我，我先跑一遍清洗规则，再让你确认导入。'
          : '我先把待处理的数据跑一遍清洗规则，再给出问题明细。';
      case 'import':
        return info.needsFile
          ? '收到，把文件发给我，导入前会先清洗并二次确认。'
          : '准备导入' + label + '，导入前会二次确认，并记录本次导入以便撤销。';
      case 'export':
        return '好的，导出' + (info.exportScope === 'all' ? '全部' : '当前筛选') + '的' + label +
          '（' + (info.exportFormat === 'xlsx' ? 'Excel' : 'CSV') + '）。';
      case 'query':
        return '我来查询：' + (info.queryResult && info.queryResult.description ? info.queryResult.description : label + '记录') + '。';
      case 'stats':
        return '好，我汇总一下当前数据的整体情况和问题。';
      case 'analyze':
        return '好，我按你说的口径做一次分析，结果会用图表和结论一起给你（可导出明细）。';
      case 'edit':
        return info.editResult
          ? info.editResult.reply
          : '我可以修改单条记录的单个字段。请给出管段编码、字段和新值，例如：「把 2G-SLB-WB-F000-R025-Q16 的最新测厚记录厚度改成 6.8」。';
      case 'undo':
        return '准备撤销最近一次导入，执行前会二次确认。';
      default:
        return '我可以帮你清洗、导入、导出、查询、统计和修改单条记录。说「帮助」看全部示例。';
    }
  }

  /* ============================================================
   * 统计（§2.7）
   * ============================================================ */

  function codeInMatrix(code, matrixRows) {
    var parsed = validateTubeCode(code);
    if (!parsed.valid) return false;
    var parts = parsed.parts;
    for (var i = 0; i < matrixRows.length; i += 1) {
      var row = matrixRows[i];
      if (!row || typeof row !== 'object') continue;
      if (matrixRowMatch(row, parts)) return true;
    }
    return false;
  }

  function materialTheoryKnown(item) {
    if (!item || typeof item !== 'object') return false;
    return ['straight', 'bend', 'nominalWall'].some(function (field) {
      var value = toNumber(item[field]);
      return value !== null && value > 0;
    });
  }

  function eventBusinessKey(event) {
    return [
      normalizeCode(event.code),
      normalizeText(event.type),
      normalizeText(event.date),
      normalizeText(event.desc),
      normalizeText(event.spec),
      normalizeText(event.material),
      normalizeText(event.thickness),
      normalizeText(event.hardness)
    ].join('|');
  }

  function buildStats(snapshot) {
    try {
      var snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
      var events = toObjectArray(snap.events);
      var replacements = toObjectArray(snap.replacements);
      var materialLibrary = toObjectArray(snap.materialLibrary);
      var matrixRows = normalizeMatrixRows(snap.matrix);
      var retired = makeCodeSet(snap.retiredCodes);
      var now = toDate(snap.now) || new Date();
      var cutoff = new Date(now.getTime() - 30 * 86400000);

      var codeSet = {};
      events.forEach(function (event) {
        var code = normalizeCode(event.code);
        if (code) codeSet[code] = true;
      });
      var recentCount = events.filter(function (event) {
        var ts = toNumber(event.ts);
        if (ts !== null && ts >= cutoff.getTime()) return true;
        var normalized = normalizeDateText(event.date);
        if (!normalized) return false;
        var date = toDate(normalized);
        return Boolean(date && date.getTime() >= cutoff.getTime());
      }).length;

      var metrics = [
        { label: '寿命事件', value: formatNumber(events.length), hint: '数据录入页事件总数' },
        { label: '涉及管段', value: formatNumber(Object.keys(codeSet).length), hint: '去重后的管段编码数' },
        { label: '更换记录', value: formatNumber(replacements.length), hint: '更换登记总数' },
        { label: '材料库记录', value: formatNumber(materialLibrary.length), hint: '受热面材料库记录数' },
        { label: '近 30 天新增', value: formatNumber(recentCount), hint: '按事件日期或写入时间统计' }
      ];

      var issues = [];

      var detectionRows = [];
      events.forEach(function (event, index) {
        var type = normalizeEventType(event.type);
        if (type.type !== '测厚' && type.type !== '金相分析' && type.type !== '无损检测') return;
        var thickness = String(event.thickness === null || event.thickness === undefined ? '' : event.thickness).trim();
        var hardness = String(event.hardness === null || event.hardness === undefined ? '' : event.hardness).trim();
        if (!thickness || !hardness) detectionRows.push(index + 1);
      });
      if (detectionRows.length) {
        issues.push({
          severity: 'warning',
          title: '检测事件缺少厚度/硬度',
          detail: '共 ' + detectionRows.length + ' 条检测事件未记录厚度或硬度，会影响寿命评估。',
          rows: detectionRows
        });
      }

      var seenKeys = {};
      var duplicateRows = [];
      events.forEach(function (event, index) {
        var key = eventBusinessKey(event);
        if (seenKeys[key]) duplicateRows.push(index + 1);
        else seenKeys[key] = true;
      });
      if (duplicateRows.length) {
        issues.push({
          severity: 'warning',
          title: '业务键重复事件',
          detail: '共 ' + duplicateRows.length + ' 条事件与前面的记录业务键重复（管码+类型+日期+描述+规格+材质+厚度+硬度）。',
          rows: duplicateRows
        });
      }

      if (matrixRows.length) {
        var outsideRows = [];
        events.forEach(function (event, index) {
          var code = normalizeCode(event.code);
          if (!code) return;
          if (!codeInMatrix(code, matrixRows)) outsideRows.push(index + 1);
        });
        if (outsideRows.length) {
          issues.push({
            severity: 'warning',
            title: '编码不在台账矩阵',
            detail: '共 ' + outsideRows.length + ' 条事件的管段编码未落入任何台账矩阵范围。',
            rows: outsideRows
          });
        }
      }

      var retiredRows = [];
      events.forEach(function (event, index) {
        var code = normalizeCode(event.code);
        if (!code || !retired[code]) return;
        var type = normalizeEventType(event.type);
        if (type.type === '报废更换' || type.type === '安装投运') return;
        retiredRows.push(index + 1);
      });
      if (retiredRows.length) {
        issues.push({
          severity: 'warning',
          title: '已报废管码仍有新事件',
          detail: '共 ' + retiredRows.length + ' 条事件使用了已报废管码，新增检测请改用新管码。',
          rows: retiredRows
        });
      }

      var noStockRows = [];
      materialLibrary.forEach(function (item, index) {
        var hasStock = ['stockQty', 'totalLengthM', 'reserveLocation'].some(function (field) {
          var value = item[field];
          return value !== null && value !== undefined && String(value).trim() !== '';
        });
        if (!hasStock) noStockRows.push(index + 1);
      });
      if (noStockRows.length) {
        issues.push({
          severity: 'info',
          title: '材料库缺少库存信息',
          detail: '共 ' + noStockRows.length + ' 条材料记录未填写库存根数、库存长度或预留位置。',
          rows: noStockRows
        });
      }

      var theoryRows = [];
      materialLibrary.forEach(function (item, index) {
        if (!materialTheoryKnown(item)) theoryRows.push(index + 1);
      });
      if (theoryRows.length) {
        issues.push({
          severity: 'warning',
          title: '材料库理论厚度未匹配',
          detail: '共 ' + theoryRows.length + ' 条材料记录没有可用的理论厚度（直管/弯管），寿命判定会缺少阈值依据。',
          rows: theoryRows
        });
      }

      var intro = '当前共 ' + events.length + ' 条寿命事件（涉及 ' + Object.keys(codeSet).length + ' 个管段编码）、' +
        replacements.length + ' 条更换记录、' + materialLibrary.length + ' 条材料库记录；' +
        (issues.length ? '发现 ' + issues.length + ' 类数据问题，建议逐项核对。' : '暂未发现明显数据问题。');

      return { intro: intro, metrics: metrics, issues: issues };
    } catch (err) {
      return { intro: '统计数据时出现异常，已返回空结果。', metrics: [], issues: [] };
    }
  }

  /* ============================================================
   * 导出
   * ============================================================ */

  var api = {
    version: 'v1',
    DEFAULT_UNITS: DEFAULT_UNITS.slice(),
    TUBE_CODE_SOURCE: TUBE_CODE_SOURCE,
    EVENT_TYPES: EVENT_TYPE_ALIASES.map(function (item) { return item.type; }),
    datasetCatalog: datasetCatalog,
    getDataset: getDataset,
    datasetLabel: datasetLabel,
    canonicalHeader: canonicalHeader,
    canonicalHeaderWithLevel: canonicalHeaderWithLevel,
    fuzzyMatchHeader: fuzzyMatchHeader,
    buildHeaderIndex: buildHeaderIndex,
    resolveDatasetType: resolveDatasetType,
    detectDatasetType: detectDatasetType,
    normalizeDatasetType: normalizeDatasetType,
    expandMatrixCodes: expandMatrixCodes,
    suggestSimilarCode: suggestSimilarCode,
    canonicalTubeCode: canonicalTubeCode,
    buildTubeCodeLedger: buildTubeCodeLedger,
    stringSimilarity: stringSimilarity,
    toolCatalog: toolCatalog,
    toolSpec: toolSpec,
    toolsForRole: toolsForRole,
    requiredRole: requiredRole,
    toolRank: toolRank,
    roleLabel: roleLabel,
    normalizeRole: normalizeRole,
    parseIntent: parseIntent,
    parseQuery: parseQuery,
    parseEdit: parseEdit,
    cleanRows: cleanRows,
    buildStats: buildStats,
    normalizeText: normalizeText,
    normalizeDateText: normalizeDateText,
    normalizeEventType: normalizeEventType,
    normalizeCode: normalizeCode,
    validateTubeCode: validateTubeCode,
    formatNumber: formatNumber,
    escapeHtml: escapeHtml,
    sysLabel: sysLabel,
    zoneLabel: zoneLabel,
    getSystemRule: getSystemRule,
    extractTubeCodes: extractTubeCodes,
    extractSystems: extractSystems,
    extractType: extractType,
    extractUnit: extractUnit,
    extractZone: extractZone,
    extractDateFilters: extractDateFilters
  };

  global.BTAssistantCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
