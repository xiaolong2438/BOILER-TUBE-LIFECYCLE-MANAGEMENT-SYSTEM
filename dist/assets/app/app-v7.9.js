
// ========== LOCAL DB (CSV 数据录入模块) ==========
let userDB = JSON.parse(localStorage.getItem('boiler_user_db') || '{"events":[], "replacements":[]}');
const LLM_CONFIG_KEY = 'boiler_llm_config';
const LLM_PROVIDER_PRESETS = {
  custom: { baseUrl: '', model: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' }
};
function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function showToast(message, type = 'info', duration = 3600) {
  const host = document.getElementById('toast-host');
  if(!host) { alert(message); return; }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-text">${escapeHTML(message)}</span><button type="button" class="toast-close" aria-label="关闭">×</button>`;
  host.appendChild(el);
  const dismiss = () => { if(!el.parentNode) return; el.classList.add('leaving'); setTimeout(() => el.remove(), 240); };
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  if(duration > 0) setTimeout(dismiss, duration);
}
function downloadBlob(filename, content, type = 'text/plain;charset=utf-8;') { const blob = new Blob([content], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href); }
const CLOUD_STORAGE_ENDPOINT = '/api/storage';
/* 多设备覆盖保护：记录本机最后一次写入时间；云端覆盖本机前先备份 */
const LOCAL_DB_AT_KEY = 'boiler_user_db_local_at';
const DB_BACKUP_KEY = 'boiler_user_db_backup';
const MATERIAL_BACKUP_KEY = 'boiler_material_library_backup';
function parseCloudTime(value) {
  if(!value) return 0;
  const text = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') + 'Z' : text;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}
function safeParseJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch(err) { return fallback; }
}
const cloudSaveTimers = new Map();
let currentAuthSession = null;
function cloudStorageEnabled() { return location.protocol.startsWith('http') && location.host && location.origin !== 'null'; }
async function cloudStorageRequest(key, method = 'GET', value) {
  if(!cloudStorageEnabled()) return null;
  try {
    const response = await fetch(`${CLOUD_STORAGE_ENDPOINT}/${encodeURIComponent(key)}`, {
      method,
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ value })
    });
    if(response.status === 404) return { found: false };
    if(!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
function queueCloudStorageSave(key, value) {
  if(!cloudStorageEnabled()) return;
  const prev = cloudSaveTimers.get(key);
  if(prev) clearTimeout(prev);
  cloudSaveTimers.set(key, setTimeout(() => { cloudStorageRequest(key, 'PUT', value); }, 250));
}
async function bootstrapCloudStorage() {
  if(!cloudStorageEnabled()) return;
  const [remoteUserDB, remoteMaterialLibrary] = await Promise.all([
    cloudStorageRequest('boiler_user_db'),
    cloudStorageRequest('boiler_material_library')
  ]);
  let changed = false;
  let conflictNotice = '';
  const localRaw = localStorage.getItem('boiler_user_db') || '';
  const localAt = Date.parse(localStorage.getItem(LOCAL_DB_AT_KEY) || '') || 0;

  if(remoteUserDB?.found && remoteUserDB.value && typeof remoteUserDB.value === 'object') {
    const remoteRaw = JSON.stringify(remoteUserDB.value);
    const remoteAt = parseCloudTime(remoteUserDB.updatedAt);
    const localDB = safeParseJson(localRaw, null);
    const localCount = localDB ? ((localDB.events || []).length + (localDB.replacements || []).length) : 0;
    const remoteCount = ((remoteUserDB.value.events || []).length + (remoteUserDB.value.replacements || []).length);
    const differs = Boolean(localRaw) && localRaw !== remoteRaw;
    if(differs && localAt > remoteAt + 2000) {
      /* 本机比云端新：保留本机并排队上传，避免被旧版本冲掉 */
      queueCloudStorageSave('boiler_user_db', userDB);
      conflictNotice = '本机数据比云端新（本机 ' + localCount + ' 条 / 云端 ' + remoteCount + ' 条），已保留本机版本并排队上传。';
    } else {
      if(differs && localCount > 0) {
        localStorage.setItem(DB_BACKUP_KEY, JSON.stringify({
          at: new Date().toISOString(),
          reason: 'cloud-newer',
          remoteUpdatedAt: remoteUserDB.updatedAt || '',
          data: localDB
        }));
        conflictNotice = '云端数据比本机新（本机 ' + localCount + ' 条 / 云端 ' + remoteCount +
          ' 条），已载入云端版本；本机原数据已备份到本地，可在「维护记录」查看这条记录。';
      }
      userDB = remoteUserDB.value;
      localStorage.setItem('boiler_user_db', remoteRaw);
      localStorage.setItem(LOCAL_DB_AT_KEY, new Date(remoteAt || Date.now()).toISOString());
      changed = true;
    }
  }
  if(remoteMaterialLibrary?.found && Array.isArray(remoteMaterialLibrary.value)) {
    const localMatRaw = localStorage.getItem('boiler_material_library') || '';
    const remoteMatRaw = JSON.stringify(remoteMaterialLibrary.value);
    if(localMatRaw && localMatRaw !== remoteMatRaw) {
      localStorage.setItem(MATERIAL_BACKUP_KEY, JSON.stringify({
        at: new Date().toISOString(),
        reason: 'cloud-newer',
        data: localMatRaw
      }));
    }
    localStorage.setItem('boiler_material_library', remoteMatRaw);
    changed = true;
  }
  if(remoteUserDB?.found === false && ((userDB.events || []).length || (userDB.replacements || []).length)) {
    queueCloudStorageSave('boiler_user_db', userDB);
  }
  if(remoteMaterialLibrary?.found === false) {
    const localMaterials = JSON.parse(localStorage.getItem('boiler_material_library') || '[]');
    if(Array.isArray(localMaterials) && localMaterials.length) queueCloudStorageSave('boiler_material_library', localMaterials);
  }
  if(changed) {
    renderDataManagerTables();
    updateLifecycleDropdown();
    populateAIThicknessTargets();
    renderDashboardWarnings();
    syncDashboardSnapshot();
    renderMaintenancePlan();
    renderComponent('ww');
    const activeComp = document.querySelector('.comp-tab.active')?.dataset.comp || 'ww';
    renderMaterialLibrary(activeComp);
  }
  if(conflictNotice) {
    showToast(conflictNotice, 'warn', 9000);
    try {
      if(window.BTMaintenanceLog && typeof window.BTMaintenanceLog.hook === 'function') {
        window.BTMaintenanceLog.hook('system', { summary: conflictNotice });
      }
    } catch(err) { /* 留痕失败不影响主流程 */ }
  }
}
async function loadAuthSession() {
  if(!cloudStorageEnabled()) return;
  try {
    const response = await fetch('/api/auth/session');
    if(response.status === 401) {
      location.href = '/login';
      return;
    }
    if(!response.ok) return;
    const session = await response.json();
    currentAuthSession = session;
    const userEl = document.getElementById('auth-user');
    if(userEl && session.username) userEl.textContent = `账号：${session.username}${session.role === 'admin' ? '（管理员）' : ''}`;
    const resetTab = document.getElementById('password-tab-reset');
    if(resetTab) resetTab.hidden = session.role !== 'admin';
  } catch {
    currentAuthSession = null;
    const userEl = document.getElementById('auth-user');
    if(userEl) { userEl.textContent = '本地模式 · 数据保存在本浏览器'; userEl.title = '未连接云端服务，数据仅存储于 localStorage'; }
    const resetTab = document.getElementById('password-tab-reset');
    if(resetTab) resetTab.hidden = true;
  }
}
async function logoutUser() {
  if(!cloudStorageEnabled()) {
    location.reload();
    return;
  }
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
  location.href = '/login';
}
function openPasswordManager() {
  const modal = document.getElementById('password-modal');
  if(!modal) return;
  setPasswordMessage('', '');
  switchPasswordTab('change');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  const resetTab = document.getElementById('password-tab-reset');
  if(resetTab) resetTab.hidden = currentAuthSession?.role !== 'admin';
  setTimeout(() => document.getElementById('current-password')?.focus(), 0);
}
function closePasswordManager() {
  const modal = document.getElementById('password-modal');
  if(!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}
function switchPasswordTab(tab) {
  const isReset = tab === 'reset' && currentAuthSession?.role === 'admin';
  const activeTab = isReset ? 'reset' : 'change';
  document.getElementById('password-tab-change')?.classList.toggle('active', activeTab === 'change');
  document.getElementById('password-tab-reset')?.classList.toggle('active', activeTab === 'reset');
  const changeForm = document.getElementById('change-password-form');
  const resetForm = document.getElementById('reset-password-form');
  if(changeForm) changeForm.hidden = activeTab !== 'change';
  if(resetForm) resetForm.hidden = activeTab !== 'reset';
  setPasswordMessage('', '');
}
function setPasswordMessage(message, type = '') {
  const messageEl = document.getElementById('password-message');
  if(!messageEl) return;
  messageEl.textContent = message;
  messageEl.className = `password-message${type ? ` ${type}` : ''}`;
}
async function submitPasswordChange(event) {
  event.preventDefault();
  if(!cloudStorageEnabled()) {
    setPasswordMessage('本地文件预览模式不能修改云端密码。', 'error');
    return;
  }
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const body = Object.fromEntries(new FormData(form).entries());
  submitButton.disabled = true;
  setPasswordMessage('正在更新密码...', '');
  try {
    const response = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(result.error || '密码更新失败');
    form.reset();
    setPasswordMessage(result.message || '密码已更新，请重新登录。', 'ok');
    setTimeout(() => logoutUser(), 900);
  } catch (error) {
    setPasswordMessage(error.message || '密码更新失败', 'error');
  } finally {
    submitButton.disabled = false;
  }
}
async function submitAdminPasswordReset(event) {
  event.preventDefault();
  if(!cloudStorageEnabled()) {
    setPasswordMessage('本地文件预览模式不能修改云端密码。', 'error');
    return;
  }
  const form = event.currentTarget;
  const formData = new FormData(form);
  const targetUsername = String(formData.get('targetUsername') || '').trim();
  const submitButton = form.querySelector('button[type="submit"]');
  if(!targetUsername) {
    setPasswordMessage('请输入目标账号。', 'error');
    return;
  }
  submitButton.disabled = true;
  setPasswordMessage('正在重置密码...', '');
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(targetUsername)}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newPassword: formData.get('newPassword'),
        confirmPassword: formData.get('confirmPassword')
      })
    });
    const result = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(result.error || '密码重置失败');
    form.reset();
    setPasswordMessage(result.message || `已重置 ${targetUsername} 的密码。`, 'ok');
    if(currentAuthSession?.username === targetUsername) setTimeout(() => logoutUser(), 900);
  } catch (error) {
    setPasswordMessage(error.message || '密码重置失败', 'error');
  } finally {
    submitButton.disabled = false;
  }
}
document.getElementById('change-password-form')?.addEventListener('submit', submitPasswordChange);
document.getElementById('reset-password-form')?.addEventListener('submit', submitAdminPasswordReset);
document.getElementById('password-modal')?.addEventListener('click', event => {
  if(event.target?.id === 'password-modal') closePasswordManager();
});
document.addEventListener('keydown', event => {
  if(event.key === 'Escape') closePasswordManager();
});
document.getElementById('dataEditModal')?.addEventListener('click', event => {
  if(event.target?.id === 'dataEditModal') closeDataEditModal();
});
document.addEventListener('keydown', event => {
  if(event.key === 'Escape') closeDataEditModal();
});
function parseCSVLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      result.push(current); current = '';
    } else { current += char; }
  }
  result.push(current); return result;
}
function csvEscape(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function saveDB() { localStorage.setItem('boiler_user_db', JSON.stringify(userDB)); localStorage.setItem(LOCAL_DB_AT_KEY, new Date().toISOString()); queueCloudStorageSave('boiler_user_db', userDB); renderDMTable(); renderReplacementTable(); updateLifecycleDropdown(); populateAIThicknessTargets(); renderDashboardWarnings(); syncDashboardSnapshot(); if(typeof runLLMVisualAnalysis === 'function') runLLMVisualAnalysis(); if(typeof nudgeDemoToggleOnce === 'function') nudgeDemoToggleOnce(); if(typeof applyDemoDataToggle === 'function') applyDemoDataToggle(); }
/* 维护记录（操作日志）统一入口：日志失败绝不影响主流程 */
function mlog(kind, payload) {
  try {
    if(window.BTMaintenanceLog && typeof window.BTMaintenanceLog.hook === 'function') return window.BTMaintenanceLog.hook(kind, payload);
  } catch(err) { console.warn('[维护记录] 写入失败：', err); }
  return null;
}
function getBoilerFromCode(code) {
  const match = String(code || '').trim().toUpperCase().match(/^([12])G-/);
  return match ? match[1] : '';
}
function normalizeBoiler(value) {
  const match = String(value || '').trim().match(/[12]/);
  return match ? match[0] : '';
}
function getBatchBoilerFilter() {
  return document.getElementById('dm-batch-boiler')?.value || 'all';
}
/* 方向感知归一（与 AI 助手清洗同一口径）：现场可归近一端计数，落库统一为台账规范方向。
   依赖 assistant-core 的 canonicalTubeCode；组件未加载时原样返回，不阻断保存。 */
function normalizeCodeDirection(code) {
  const core = window.BTAssistantCore;
  if (!core || typeof core.canonicalTubeCode !== 'function' || !Array.isArray(matrix) || !matrix.length) return null;
  return core.canonicalTubeCode(code, matrix);
}
function normalizedTubeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return normalizeCodeDirection(code)?.code || code;
}
function tubePositionKey(value) {
  const code = normalizedTubeCode(value);
  const parsed = parseTubeCode(code);
  if(!parsed || parsed.pos?.endsWith('000') && parsed.sys !== 'SLB') return code;
  return code.replace(/-[QW]\d{1,3}$/, '');
}
function tubeVersionKey(value) {
  const code = normalizedTubeCode(value);
  const parsed = parseTubeCode(code);
  return parsed ? `${tubePositionKey(code)}#${parsed.seq}` : code;
}
function sameTubeMeasurement(a, b) {
  const pa = parseTubeCode(a), pb = parseTubeCode(b);
  return normalizedTubeCode(a) === normalizedTubeCode(b) || Boolean(pa && pb && pa.partKind === pb.partKind && tubeVersionKey(a) === tubeVersionKey(b));
}
function isExactInspectionDate(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(new Date(text).getTime());
}
function tubeEvidenceEvents(code) {
  const position = tubePositionKey(code);
  const local = userDB.events.filter(e => tubePositionKey(e.code) === position);
  const replacements = userDB.replacements.filter(r => tubePositionKey(r.oldCode) === position || tubePositionKey(r.newCode) === position);
  // 未建立更换边界时按位置汇总；有更换记录时只取明确属于该版本的证据。
  return replacements.length ? local.filter(e => tubeVersionKey(e.code) === tubeVersionKey(code)) : local;
}
function eventBoiler(record) {
  return normalizeBoiler(record?.boiler) || getBoilerFromCode(record?.code);
}
function replacementBoiler(record) {
  return normalizeBoiler(record?.boiler) || getBoilerFromCode(record?.oldCode) || getBoilerFromCode(record?.newCode);
}
function syncDataEntryBoilerFromCode() {
  const boiler = getBoilerFromCode(document.getElementById('dm-code')?.value);
  const select = document.getElementById('dm-boiler');
  if(boiler && select) select.value = boiler;
}
function syncReplacementBoilerFromCode() {
  const boiler = getBoilerFromCode(document.getElementById('dm-oldcode')?.value) || getBoilerFromCode(document.getElementById('dm-newcode')?.value);
  const select = document.getElementById('dm-rep-boiler');
  if(boiler && select) select.value = boiler;
}
function addUserEvent() {
  const boiler = document.getElementById('dm-boiler').value;
  let code = document.getElementById('dm-code').value.trim().toUpperCase();
  const spec = document.getElementById('dm-spec').value.trim();
  const material = document.getElementById('dm-material').value.trim();
  const thickness = document.getElementById('dm-thickness').value.trim();
  const hardness = document.getElementById('dm-hardness').value.trim();
  const type = document.getElementById('dm-type').value;
  const date = document.getElementById('dm-date').value;
  const desc = document.getElementById('dm-desc').value.trim();
  if(!boiler || !code || !date || !desc) { showToast('请填写机组、管段编码、日期和详细数据/结论', 'warn'); return; }
  if(getBoilerFromCode(code) && getBoilerFromCode(code) !== boiler) { showToast('所选机组与管段编码开头不一致，请核对。', 'warn'); return; }
  const normalized = normalizeCodeDirection(code);
  if(normalized) code = normalized.code;
  const newEvent = {boiler, code, spec, material, thickness, hardness, type, date, desc, ts: Date.now()};
  userDB.events.push(newEvent);
  saveDB();
  mlog('create', { record: newEvent, source: 'manual' });
  showToast(normalized ? `保存成功（编码已按规范方向归一为 ${code}）` : '保存成功，请前往【管段综合分析】验证', 'ok');
  ['dm-code','dm-spec','dm-material','dm-thickness','dm-hardness','dm-desc'].forEach(id => document.getElementById(id).value = '');
}
function addReplacement() {
  const boiler = document.getElementById('dm-rep-boiler').value;
  let oldCode = document.getElementById('dm-oldcode').value.trim().toUpperCase();
  let newCode = document.getElementById('dm-newcode').value.trim().toUpperCase();
  const reason = document.getElementById('dm-reason').value.trim();
  const date = document.getElementById('dm-rep-date').value;
  if(!boiler || !oldCode || !newCode || !date) { showToast('请填写机组、旧管段编码、新管段编码和更换日期', 'warn'); return; }
  if((getBoilerFromCode(oldCode) && getBoilerFromCode(oldCode) !== boiler) || (getBoilerFromCode(newCode) && getBoilerFromCode(newCode) !== boiler)) { showToast('所选机组与旧/新管段编码开头不一致，请核对。', 'warn'); return; }
  const normalizedOld = normalizeCodeDirection(oldCode);
  if(normalizedOld) oldCode = normalizedOld.code;
  const normalizedNew = normalizeCodeDirection(newCode);
  if(normalizedNew) newCode = normalizedNew.code;
  const newReplacement = {boiler, oldCode, newCode, reason, date, ts: Date.now()};
  userDB.replacements.push(newReplacement);
  userDB.events.push({boiler, code: oldCode, type: '报废更换', date, desc: `更换为 ${newCode}，原因：${reason}`, ts: Date.now()});
  userDB.events.push({boiler, code: newCode, type: '安装投运', date, desc: `替换 ${oldCode}，继承历史`, ts: Date.now()});
  saveDB();
  mlog('replace', { record: newReplacement, source: 'manual' });
  showToast(normalizedOld || normalizedNew ? '更换登记成功（编码已按规范方向归一）' : '更换登记成功', 'ok');
}
function canManageTubeData() {
  try { return getAssistantRole() !== 'viewer'; } catch (err) { return true; }
}
function renderDataManagerTables() { renderDMTable(); renderReplacementTable(); }
function renderDMTable() {
  const tbody = document.getElementById('dm-table-body'); if(!tbody) return;
  const filter = getBatchBoilerFilter();
  const all = [...userDB.events].filter(r => filter === 'all' || eventBoiler(r) === filter).sort((a,b) => b.ts - a.ts);
  const manage = canManageTubeData();
  tbody.innerHTML = all.map(r => {
    const action = manage
      ? `<button class="btn btn-outline" style="padding:2px 8px; font-size:11px;" onclick="openEditEvent(${Number(r.ts)})">编辑</button>
         <button class="btn btn-outline" style="padding:2px 8px; font-size:11px; border-color:var(--danger); color:var(--danger);" onclick="deleteEvent(${Number(r.ts)})">删除</button>`
      : '<span style="font-size:11px; color:var(--text-dim);">只读</span>';
    return `<tr><td>${escapeHTML(r.date)}</td><td>${escapeHTML(eventBoiler(r) || '-')}号</td><td style="color:var(--accent)">${escapeHTML(r.code)}</td><td>${escapeHTML(r.spec || '-')}</td><td style="font-family:inherit">${escapeHTML(r.material || '-')}</td><td>${escapeHTML(r.thickness || '-')}</td><td>${escapeHTML(r.hardness || '-')}</td><td><span class="badge badge-sh">${escapeHTML(r.type)}</span></td><td style="font-family:inherit; max-width:300px; white-space:normal;">${escapeHTML(r.desc)}</td><td style="white-space:nowrap;">${action}</td></tr>`;
  }).join('') || '<tr><td colspan="10" style="text-align:center; padding:20px;">暂无数据</td></tr>';
}
function deleteEvent(ts) { if(confirm('确定删除？')) { const removed = userDB.events.find(e => Number(e.ts) === Number(ts)) || null; userDB.events = userDB.events.filter(e => Number(e.ts) !== Number(ts)); saveDB(); mlog('delete', { record: removed, source: 'manual' }); } }

/* ---------------- 单条记录编辑维护（事件 / 更换登记） ----------------
 * 与 AI 助手共用同一权限口径：viewer 只读；所有修改写入维护记录留痕。 */
const DATA_EDIT_TYPES = ['测厚', '金相分析', '无损检测', '割管取样', '检修维护', '报废更换', '安装投运'];
const DATA_EDIT_FIELD_LABELS = { boiler: '机组', code: '管段编码', spec: '规格', material: '材质', thickness: '厚度', hardness: '硬度', type: '事件类型', date: '日期', desc: '详细数据/结论', oldCode: '旧管段编码', newCode: '新管段编码', reason: '更换原因' };

function openDataEditModal(html) {
  const host = document.getElementById('dataEditModal');
  if(!host) { alert('编辑弹窗容器缺失，请刷新页面。'); return; }
  host.innerHTML = html;
  host.classList.add('open');
  host.setAttribute('aria-hidden', 'false');
}
function closeDataEditModal() {
  const host = document.getElementById('dataEditModal');
  if(!host) return;
  host.classList.remove('open');
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = '';
}
function dataEditBoilerSelect(selectId, current) {
  return `<select id="${selectId}"><option value="1" ${String(current) === '1' ? 'selected' : ''}>1号机组</option><option value="2" ${String(current) === '2' ? 'selected' : ''}>2号机组</option></select>`;
}
function openEditEvent(ts) {
  const record = userDB.events.find(e => Number(e.ts) === Number(ts));
  if(!record) { showToast('没有找到这条记录，可能已被删除。', 'warn'); return; }
  const typeOptions = [...new Set([...DATA_EDIT_TYPES, record.type].filter(Boolean))]
    .map(t => `<option value="${escapeHTML(t)}"></option>`).join('');
  openDataEditModal(`
    <div class="data-edit-panel" role="dialog" aria-modal="true" aria-labelledby="dataEditTitle">
      <div class="data-edit-head">
        <h3 id="dataEditTitle">编辑事件记录</h3>
        <button type="button" class="data-edit-close" onclick="closeDataEditModal()" aria-label="关闭">×</button>
      </div>
      <p class="data-edit-sub">${escapeHTML(record.code)} · 记录编号 ${Number(record.ts)}</p>
      <div class="form-group"><label>机组/炉号</label>${dataEditBoilerSelect('de-boiler', eventBoiler(record))}</div>
      <div class="form-group"><label>管段编码</label><input type="text" id="de-code" value="${escapeHTML(record.code)}" oninput="syncEditEventBoiler()" /></div>
      <div class="form-group"><label>规格</label><input type="text" id="de-spec" value="${escapeHTML(record.spec || '')}" /></div>
      <div class="form-group"><label>材质</label><input type="text" id="de-material" value="${escapeHTML(record.material || '')}" /></div>
      <div class="form-group"><label>厚度(mm)</label><input type="number" id="de-thickness" min="0" step="0.01" value="${escapeHTML(record.thickness || '')}" /></div>
      <div class="form-group"><label>硬度(HB)</label><input type="number" id="de-hardness" min="0" step="1" value="${escapeHTML(record.hardness || '')}" /></div>
      <div class="form-group"><label>事件类型</label><input type="text" id="de-type" list="de-type-options" value="${escapeHTML(record.type || '')}" /><datalist id="de-type-options">${typeOptions}</datalist></div>
      <div class="form-group"><label>日期${/^\d{4}$/.test(record.date || '') ? '（原记录仅有年份，请补全实际日期）' : ''}</label><input type="date" id="de-date" value="${isExactInspectionDate(record.date) ? escapeHTML(record.date) : ''}" /></div>
      <div class="form-group"><label>详细数据/结论</label><textarea id="de-desc" rows="3">${escapeHTML(record.desc || '')}</textarea></div>
      <div style="display:flex; gap:10px; margin-top:6px;">
        <button class="btn" style="flex:1;" onclick="saveEventEdit(${Number(record.ts)})">💾 保存修改</button>
        <button class="btn btn-outline" onclick="closeDataEditModal()">取消</button>
      </div>
    </div>`);
}
function syncEditEventBoiler() {
  const boiler = getBoilerFromCode(document.getElementById('de-code')?.value);
  const select = document.getElementById('de-boiler');
  if(boiler && select) select.value = boiler;
}
function saveEventEdit(ts) {
  const target = userDB.events.find(e => Number(e.ts) === Number(ts));
  if(!target) { showToast('没有找到这条记录，可能已被删除。', 'warn'); closeDataEditModal(); return; }
  const boiler = document.getElementById('de-boiler').value;
  const code = document.getElementById('de-code').value.trim().toUpperCase();
  const spec = document.getElementById('de-spec').value.trim();
  const material = document.getElementById('de-material').value.trim();
  const thickness = document.getElementById('de-thickness').value.trim();
  const hardness = document.getElementById('de-hardness').value.trim();
  const type = document.getElementById('de-type').value.trim();
  const date = document.getElementById('de-date').value;
  const desc = document.getElementById('de-desc').value.trim();
  if(!boiler || !code || !date || !desc) { showToast('机组、管段编码、日期和详细数据/结论不能为空', 'warn'); return; }
  if(getBoilerFromCode(code) && getBoilerFromCode(code) !== boiler) { showToast('所选机组与管段编码开头不一致，请核对。', 'warn'); return; }
  if(thickness !== '') {
    const num = Number(thickness);
    if(!Number.isFinite(num) || num < 0.1 || num > 100) { showToast('厚度必须是 0.1 ~ 100 之间的数字（mm），或留空', 'warn'); return; }
  }
  if(hardness !== '') {
    const num = Number(hardness);
    if(!Number.isFinite(num) || num < 1 || num > 600) { showToast('硬度必须是 1 ~ 600 之间的数字（HB），或留空', 'warn'); return; }
  }
  const changes = [['boiler', boiler], ['code', code], ['spec', spec], ['material', material], ['thickness', thickness], ['hardness', hardness], ['type', type], ['date', date], ['desc', desc]]
    .filter(([key, next]) => String(target[key] ?? '') !== next);
  if(!changes.length) { closeDataEditModal(); showToast('内容未变化，无需保存', 'info'); return; }
  changes.forEach(([key, next]) => {
    const before = String(target[key] ?? '');
    target[key] = next;
    mlog('update', { record: target, field: key, before, after: next, source: 'manual' });
  });
  saveDB();
  closeDataEditModal();
  showToast(`已保存修改（${changes.map(([key]) => DATA_EDIT_FIELD_LABELS[key] || key).join('、')}），维护记录已留痕`, 'ok');
}
function renderReplacementTable() {
  const tbody = document.getElementById('dm-rep-table-body'); if(!tbody) return;
  const filter = getBatchBoilerFilter();
  const all = [...userDB.replacements].filter(r => filter === 'all' || replacementBoiler(r) === filter).sort((a,b) => b.ts - a.ts);
  const manage = canManageTubeData();
  tbody.innerHTML = all.map(r => {
    const action = manage
      ? `<button class="btn btn-outline" style="padding:2px 8px; font-size:11px;" onclick="openEditReplacement(${Number(r.ts)})">编辑</button>
         <button class="btn btn-outline" style="padding:2px 8px; font-size:11px; border-color:var(--danger); color:var(--danger);" onclick="deleteReplacement(${Number(r.ts)})">删除</button>`
      : '<span style="font-size:11px; color:var(--text-dim);">只读</span>';
    return `<tr><td>${escapeHTML(r.date)}</td><td>${escapeHTML(replacementBoiler(r) || '-')}号</td><td style="color:var(--accent)">${escapeHTML(r.oldCode)}</td><td style="color:var(--ok)">${escapeHTML(r.newCode)}</td><td style="font-family:inherit; max-width:260px; white-space:normal;">${escapeHTML(r.reason || '-')}</td><td style="white-space:nowrap;">${action}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center; padding:20px;">暂无更换记录。可在上方“管段更换登记”表单或批量导入中登记。</td></tr>';
}
function isReplacementAutoEvent(event, replacement) {
  if(!event || !replacement) return false;
  if(String(event.date || '') !== String(replacement.date || '')) return false;
  if(event.type === '报废更换' && event.code === replacement.oldCode) return true;
  if(event.type === '安装投运' && event.code === replacement.newCode) return true;
  return false;
}
function deleteReplacement(ts) {
  const record = userDB.replacements.find(r => Number(r.ts) === Number(ts));
  if(!record) return;
  const linked = userDB.events.filter(e => isReplacementAutoEvent(e, record));
  const tip = linked.length ? `本次登记自动生成的 ${linked.length} 条关联事件（报废更换/安装投运）将一并删除。` : '确定删除这条更换登记？';
  if(!confirm(`确定删除更换登记 ${record.oldCode} → ${record.newCode}？${tip}`)) return;
  userDB.replacements = userDB.replacements.filter(r => Number(r.ts) !== Number(ts));
  if(linked.length) {
    const linkedTs = new Set(linked.map(e => Number(e.ts)));
    userDB.events = userDB.events.filter(e => !linkedTs.has(Number(e.ts)));
    linked.forEach(e => mlog('delete', { record: e, source: 'manual' }));
  }
  saveDB();
  mlog('delete', { record, source: 'manual' });
  showToast(linked.length ? `已删除更换登记及 ${linked.length} 条关联事件` : '已删除更换登记', 'ok');
}
function openEditReplacement(ts) {
  const record = userDB.replacements.find(r => Number(r.ts) === Number(ts));
  if(!record) { showToast('没有找到这条更换记录，可能已被删除。', 'warn'); return; }
  openDataEditModal(`
    <div class="data-edit-panel" role="dialog" aria-modal="true" aria-labelledby="dataEditTitle">
      <div class="data-edit-head">
        <h3 id="dataEditTitle">编辑更换登记</h3>
        <button type="button" class="data-edit-close" onclick="closeDataEditModal()" aria-label="关闭">×</button>
      </div>
      <p class="data-edit-sub">${escapeHTML(record.oldCode)} → ${escapeHTML(record.newCode)}</p>
      <div class="form-group"><label>机组/炉号</label>${dataEditBoilerSelect('dr-boiler', replacementBoiler(record))}</div>
      <div class="form-group"><label>旧管段编码</label><input type="text" id="dr-oldcode" value="${escapeHTML(record.oldCode)}" oninput="syncEditReplacementBoiler()" /></div>
      <div class="form-group"><label>新管段编码</label><input type="text" id="dr-newcode" value="${escapeHTML(record.newCode)}" oninput="syncEditReplacementBoiler()" /></div>
      <div class="form-group"><label>更换原因</label><input type="text" id="dr-reason" value="${escapeHTML(record.reason || '')}" /></div>
      <div class="form-group"><label>更换日期</label><input type="date" id="dr-rep-date" value="${escapeHTML(record.date || '')}" /></div>
      <div class="alert alert-info" style="margin:6px 0 12px;"><div>ℹ</div><div>仅修改本条登记；如需调整其自动生成的“报废更换/安装投运”事件，请到事件表中单独编辑。</div></div>
      <div style="display:flex; gap:10px;">
        <button class="btn" style="flex:1;" onclick="saveReplacementEdit(${Number(record.ts)})">💾 保存修改</button>
        <button class="btn btn-outline" onclick="closeDataEditModal()">取消</button>
      </div>
    </div>`);
}
function syncEditReplacementBoiler() {
  const boiler = getBoilerFromCode(document.getElementById('dr-oldcode')?.value) || getBoilerFromCode(document.getElementById('dr-newcode')?.value);
  const select = document.getElementById('dr-boiler');
  if(boiler && select) select.value = boiler;
}
function saveReplacementEdit(ts) {
  const target = userDB.replacements.find(r => Number(r.ts) === Number(ts));
  if(!target) { showToast('没有找到这条更换记录，可能已被删除。', 'warn'); closeDataEditModal(); return; }
  const boiler = document.getElementById('dr-boiler').value;
  const oldCode = document.getElementById('dr-oldcode').value.trim().toUpperCase();
  const newCode = document.getElementById('dr-newcode').value.trim().toUpperCase();
  const reason = document.getElementById('dr-reason').value.trim();
  const date = document.getElementById('dr-rep-date').value;
  if(!boiler || !oldCode || !newCode || !date) { showToast('机组、旧管段编码、新管段编码和更换日期不能为空', 'warn'); return; }
  if((getBoilerFromCode(oldCode) && getBoilerFromCode(oldCode) !== boiler) || (getBoilerFromCode(newCode) && getBoilerFromCode(newCode) !== boiler)) { showToast('所选机组与旧/新管段编码开头不一致，请核对。', 'warn'); return; }
  const changes = [['boiler', boiler], ['oldCode', oldCode], ['newCode', newCode], ['reason', reason], ['date', date]]
    .filter(([key, next]) => String(target[key] ?? '') !== next);
  if(!changes.length) { closeDataEditModal(); showToast('内容未变化，无需保存', 'info'); return; }
  changes.forEach(([key, next]) => {
    const before = String(target[key] ?? '');
    target[key] = next;
    mlog('update', { record: target, field: key, before, after: next, source: 'manual' });
  });
  saveDB();
  closeDataEditModal();
  showToast(`已保存修改（${changes.map(([key]) => DATA_EDIT_FIELD_LABELS[key] || key).join('、')}）`, 'ok');
}
const EVENT_CSV_COLUMNS = ['数据分类','炉号','日期','管段编码','规格','材质','厚度(mm)','硬度(HB)','事件类型/更换原因','关联新管码','详细描述/结论'];
function downloadCSVTemplate() {
  const rows = [
    EVENT_CSV_COLUMNS.join(','),
    ['事件','1','2022-04-15','1G-SLB-WB-F000-R015-Q001','Φ63.5×7.5','SA-210C','7.10','185','测厚','','标高18m处壁厚7.10mm'].map(csvEscape).join(','),
    ['事件','2','2024-05-20','2G-GGRQ-GQ-L012-U005-Q002','Φ51×8','SA-213T91','6.90','210','测厚','','高过炉左往右第12排上往下第5根测厚6.90mm'].map(csvEscape).join(','),
    ['更换','1','2026-05-22','1G-DZRQ-GQ-4KJ-L065-Q001','','','','','爆管更换','1G-DZRQ-GQ-4KJ-L065-Q002','运行中发生泄漏，紧急割管更换'].map(csvEscape).join(',')
  ].join('\n');
  downloadBlob('锅炉寿命数据_录入模板.csv', '\uFEFF' + rows, 'text/csv;charset=utf-8;');
}
function exportCSV() {
  const filter = getBatchBoilerFilter();
  let csvContent = '\uFEFF' + EVENT_CSV_COLUMNS.join(',') + '\n';
  userDB.events.filter(e => filter === 'all' || eventBoiler(e) === filter).forEach(e => {
    csvContent += ['事件', eventBoiler(e), e.date, e.code, e.spec, e.material, e.thickness, e.hardness, e.type, '', e.desc].map(csvEscape).join(',') + '\n';
  });
  userDB.replacements.filter(r => filter === 'all' || replacementBoiler(r) === filter).forEach(r => {
    csvContent += ['更换', replacementBoiler(r), r.date, r.oldCode, '', '', '', '', r.reason, r.newCode, r.reason].map(csvEscape).join(',') + '\n';
  });
  const scope = filter === 'all' ? '全厂' : `${filter}号机组`;
  downloadBlob(`锅炉寿命数据_${scope}_${new Date().toISOString().slice(0,10)}.csv`, csvContent, 'text/csv;charset=utf-8;');
}

// ========== 核心修复：防重复导入逻辑 ==========
function importLifecycleRows(rawRows, options = {}) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const stats = { importedEvents: 0, importedReplacements: 0, skippedDuplicates: 0, skippedMismatch: 0, normalizedCount: 0, normalizationSamples: [], addedEventTs: [], addedReplacementTs: [], errors: [] };
  if(rows.length < 2) { stats.errors.push('CSV 文件为空'); return stats; }
  const headers = (rows[0] || []).map(item => String(item ?? '').replace(/^\uFEFF/, '').trim());
  const hasNewColumns = headers.includes('炉号') && headers.includes('厚度(mm)');
  const batchFilter = options.batchFilter || 'all';
  const nextTimestamp = [...userDB.events, ...userDB.replacements].reduce((latest, record) => Math.max(latest, Number(record.ts) || 0), Date.now()) + 1;
  const sourceValue = (cols, name) => headers.includes(name) ? (cols[headers.indexOf(name)] || '').trim() : '';
  let importEvents = 0, importReplacements = 0, skipDuplicates = 0, skipBoilerMismatch = 0;

  // 查重辅助函数
  const isEventExist = (event) => {
      return userDB.events.some(e =>
        e.code === event.code &&
        e.type === event.type &&
        e.date === event.date &&
        e.desc === event.desc &&
        String(e.spec || '') === String(event.spec || '') &&
        String(e.material || '') === String(event.material || '') &&
        String(e.thickness || '') === String(event.thickness || '') &&
        String(e.hardness || '') === String(event.hardness || '')
      );
  };
  const isReplacementExist = (boiler, oldCode, newCode, date, reason) => {
      return userDB.replacements.some(r => (r.boiler || getBoilerFromCode(r.oldCode)) === boiler && r.oldCode === oldCode && r.newCode === newCode && r.date === date && r.reason === reason);
  };

  for(let i = 1; i < rows.length; i++) {
    const cols = (Array.isArray(rows[i]) ? rows[i] : []).map(item => String(item ?? ''));
    if(cols.every(cell => cell.trim() === '')) continue;
    if(cols.length < 5) continue;

    const category = cols[0].trim();
    const boiler = normalizeBoiler(hasNewColumns ? cols[1] : getBoilerFromCode(cols[2] || ''));
    const date = (hasNewColumns ? cols[2] : cols[1] || '').trim();
    let code = (hasNewColumns ? cols[3] : cols[2] || '').trim().toUpperCase();
    const spec = hasNewColumns ? (cols[4] || '').trim() : '';
    const material = hasNewColumns ? (cols[5] || '').trim() : '';
    const thickness = hasNewColumns ? (cols[6] || '').trim() : '';
    const hardness = hasNewColumns ? (cols[7] || '').trim() : '';
    const typeOrReason = (hasNewColumns ? cols[8] : cols[3] || '').trim();
    let relatedCode = (hasNewColumns ? cols[9] : cols[4] || '').trim().toUpperCase();
    /* 方向感知归一：页面导入与 AI 助手同一口径，反方向编码按同一物理位置换算为规范方向 */
    const canonicalCode = normalizeCodeDirection(code);
    if(canonicalCode) {
      stats.normalizationSamples.push(code + ' ≙ ' + canonicalCode.code);
      code = canonicalCode.code;
    }
    const canonicalRelated = normalizeCodeDirection(relatedCode);
    if(canonicalRelated) {
      stats.normalizationSamples.push(relatedCode + ' ≙ ' + canonicalRelated.code);
      relatedCode = canonicalRelated.code;
    }
    const desc = hasNewColumns ? ((cols[10] || '').trim()) : (cols[5] ? cols[5].trim() : '');
    const ts = nextTimestamp + i;
    const rowBoiler = boiler || getBoilerFromCode(code) || getBoilerFromCode(relatedCode);
    const codeMismatch = (getBoilerFromCode(code) && rowBoiler && getBoilerFromCode(code) !== rowBoiler) || (relatedCode && getBoilerFromCode(relatedCode) && rowBoiler && getBoilerFromCode(relatedCode) !== rowBoiler);
    const filterMismatch = batchFilter !== 'all' && rowBoiler !== batchFilter;
    if(!rowBoiler || codeMismatch || filterMismatch) {
      skipBoilerMismatch++;
      continue;
    }

    if (category === '事件' || category === 'event') {
      const eventRecord = { boiler: rowBoiler, code, spec, material, thickness, hardness, type: typeOrReason, date, desc, ts };
      const sourceId = sourceValue(cols, '来源ID');
      if(sourceId) Object.assign(eventRecord, { sourceId, batch: sourceValue(cols, '检修批次'), datePrecision: sourceValue(cols, '日期精度'), inspectionResult: sourceValue(cols, '检测结果') });
      if (!isEventExist(eventRecord)) {
          userDB.events.push(eventRecord);
          stats.addedEventTs.push(eventRecord.ts);
          importEvents++;
      } else {
          skipDuplicates++;
      }
    } else if (category === '更换' || category === 'replacement') {
      const replacementBoiler = rowBoiler;
      if (!isReplacementExist(replacementBoiler, code, relatedCode, date, typeOrReason)) {
          userDB.replacements.push({ boiler: replacementBoiler, oldCode: code, newCode: relatedCode, reason: typeOrReason, date, ts });
          stats.addedReplacementTs.push(ts);

          const 报废desc = `更换为新管 ${relatedCode}，原因：${typeOrReason}`;
          const 报废event = { boiler: replacementBoiler, code: code, type: '报废更换', date, desc: 报废desc, ts: ts + 0.1 };
          if(!isEventExist(报废event)) {
              userDB.events.push(报废event);
              stats.addedEventTs.push(报废event.ts);
          }
          const 投运desc = `替换旧管 ${code}，继承历史数据`;
          const 投运event = { boiler: replacementBoiler, code: relatedCode, type: '安装投运', date, desc: 投运desc, ts: ts + 0.2 };
          if(!isEventExist(投运event)) {
              userDB.events.push(投运event);
              stats.addedEventTs.push(投运event.ts);
          }
          importReplacements++;
      } else {
          skipDuplicates++;
      }
    }
  }
  saveDB();
  stats.importedEvents = importEvents;
  stats.importedReplacements = importReplacements;
  stats.skippedDuplicates = skipDuplicates;
  stats.skippedMismatch = skipBoilerMismatch;
  stats.normalizedCount = stats.normalizationSamples.length;
  mlog('import', { dataset: 'events', stats: stats, fileName: options.fileName || '' });
  return stats;
}

function importCSV(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
      if (lines.length < 2) { showToast('CSV 文件为空', 'warn'); return; }
      const rawRows = lines.map(parseCSVLine);
      const result = importLifecycleRows(rawRows, { batchFilter: getBatchBoilerFilter(), fileName: file.name });
      showToast(`导入完成：新增事件 ${result.importedEvents} 条、更换 ${result.importedReplacements} 条，跳过重复 ${result.skippedDuplicates} 条${result.skippedMismatch ? `、机组不匹配 ${result.skippedMismatch} 条` : ''}${result.normalizedCount ? `、方向归一 ${result.normalizedCount} 条` : ''}`, 'ok', 6000);
    } catch (err) {
      console.error(err);
      showToast('CSV 解析失败，请检查文件格式是否正确。', 'error');
    }
  };
  reader.readAsText(file, 'UTF-8'); event.target.value = '';
}

// Excel 批量导入：转换为与 CSV 相同的网格结构后走同一条 importLifecycleRows 管线。
function normalizeImportDate(value) {
  if(value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value ?? '').trim();
}
function importXLSX(event) {
  const file = event.target.files[0]; if (!file) return;
  if (typeof XLSX === 'undefined') { showToast('Excel 组件未加载，请检查网络后刷新页面。', 'error', 6000); event.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if(!sheet) { showToast('Excel 文件中没有工作表。', 'warn'); return; }
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
        .map(row => row.map(cell => normalizeImportDate(cell)));
      if(grid.length < 2) { showToast('Excel 文件为空或只有表头。', 'warn'); return; }
      const headers = (grid[0] || []).map(item => String(item ?? '').trim());
      const missing = ['数据分类', '管段编码', '日期'].filter(name => !headers.includes(name));
      if(missing.length) {
        showToast('未识别到表头：缺少“' + missing.join('”“') + '”列，请使用系统提供的 Excel 模板。', 'error', 6000);
        return;
      }
      const result = importLifecycleRows(grid, { batchFilter: getBatchBoilerFilter(), fileName: file.name });
      showToast(`Excel 导入完成：新增事件 ${result.importedEvents} 条、更换 ${result.importedReplacements} 条，跳过重复 ${result.skippedDuplicates} 条${result.skippedMismatch ? `、机组不匹配 ${result.skippedMismatch} 条` : ''}${result.normalizedCount ? `、方向归一 ${result.normalizedCount} 条` : ''}`, 'ok', 6000);
    } catch (err) {
      console.error(err);
      showToast('Excel 解析失败，请确认使用的是系统提供的模板文件。', 'error');
    }
  };
  reader.readAsArrayBuffer(file); event.target.value = '';
}
function downloadXLSXTemplate() {
  if (typeof XLSX === 'undefined') { showToast('Excel 组件未加载，请检查网络后刷新页面。', 'error', 6000); return; }
  const headers = EVENT_CSV_COLUMNS;
  const rows = [
    { '数据分类': '事件', '炉号': '1', '日期': '2022-04-15', '管段编码': '1G-SLB-WB-F000-R015-Q001', '规格': 'Φ63.5×7.5', '材质': 'SA-210C', '厚度(mm)': '7.10', '硬度(HB)': '185', '事件类型/更换原因': '测厚', '关联新管码': '', '详细描述/结论': '标高18m处壁厚7.10mm' },
    { '数据分类': '事件', '炉号': '2', '日期': '2024-05-20', '管段编码': '2G-GGRQ-GQ-L012-U005-Q002', '规格': 'Φ51×8', '材质': 'SA-213T91', '厚度(mm)': '6.90', '硬度(HB)': '210', '事件类型/更换原因': '测厚', '关联新管码': '', '详细描述/结论': '高过炉左往右第12排上往下第5根测厚6.90mm' },
    { '数据分类': '更换', '炉号': '1', '日期': '2026-05-22', '管段编码': '1G-DZRQ-GQ-4KJ-L065-Q001', '规格': '', '材质': '', '厚度(mm)': '', '硬度(HB)': '', '事件类型/更换原因': '爆管更换', '关联新管码': '1G-DZRQ-GQ-4KJ-L065-Q002', '详细描述/结论': '运行中发生泄漏，紧急割管更换' }
  ];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  sheet['!cols'] = headers.map(name => ({ wch: name.length > 8 ? 22 : 14 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '录入模板');
  XLSX.writeFile(workbook, `锅炉寿命数据_录入模板_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
function backupLocalData() { const backup = JSON.stringify({ version: 'v6.7-local-backup', exportedAt: new Date().toISOString(), data: userDB }, null, 2); downloadBlob(`锅炉本地数据备份_${new Date().toISOString().slice(0,10)}.json`, backup, 'application/json;charset=utf-8;'); }
function clearLocalData() { const total = userDB.events.length + userDB.replacements.length; if(total === 0) { showToast('当前没有可清空的本地数据', 'info'); return; } if(confirm(`即将清空 ${total} 条本地数据。清空前将自动导出备份，是否继续？`) && confirm('请再次确认：备份下载后将清空浏览器本地数据。')) { backupLocalData(); userDB = {events:[], replacements:[]}; saveDB(); mlog('clear', { total }); showToast(`已备份并清空 ${total} 条本地数据`, 'ok'); } }

// ========== DATA (基础数据库) ==========
const COMPONENTS = { ww: { name: '炉膛水冷壁', sys: 'SLB', badge: 'badge-ww', spec: 'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat: '按材料库分项', count: 722, detail: {'前墙':'192根','后墙':'192根','侧墙':'169*2根','循环回路':'24个'} }, rsh: { name: '顶棚过热器', sys: 'RSH', badge: 'badge-sh', spec: 'Φ159×18 20G、Φ48.5×6 15CrMoG', mat: '按材料库分项', count: 128, detail: {'区域':'顶棚 CE','屏/排':'1排','管数':'128根'} }, wsh: { name: '包墙过热器', sys: 'WSH', badge: 'badge-sh', spec: 'Φ51×6 12Cr1MoVG、Φ51×7 12Cr1MoVG、Φ63.5×12 12Cr1MoVG', mat: '按材料库分项', count: 260, detail: {'区域':'前/后/侧包墙','屏/排':'1排','管数':'260根'} }, lsh: { name: '低温过热器', sys: 'DGRQ', badge: 'badge-sh', spec: 'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', mat: '按材料库分项', count: 112, detail: {'排数':'112排','管圈':'5根','布置':'顺列逆流'} }, psh: { name: '全大屏过热器', sys: 'DPGRQ', badge: 'badge-sh', spec: 'Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91', mat: '按材料库分项', count: '6片', detail: {'小屏':'4小屏/片','管数':'14根/小屏'} }, 'hsh-p': { name: '屏式过热器', sys: 'HPGRQ', badge: 'badge-sh', spec: 'Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG', mat: '按材料库分项', count: 21, detail: {'屏数':'21屏','管数':'13根/屏'} }, hsh: { name: '高温过热器', sys: 'GGRQ', badge: 'badge-sh', spec: 'Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG', mat: '按材料库分项', count: 32, detail: {'片数':'32片','管圈':'12管圈'} }, lrh: { name: '低温再热器', sys: 'DZRQ', badge: 'badge-rh', spec: 'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', mat: '按材料库分项', count: 112, detail: {'水平':'112片','垂直':'56片'} }, hrh: { name: '高温再热器', sys: 'GZRQ', badge: 'badge-rh', spec: 'Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG', mat: '按材料库分项', count: 64, detail: {'片数':'64片','管圈':'7管圈'} }, eco: { name: '省煤器', sys: 'SMQ', badge: 'badge-eco', spec: 'Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G', mat: '按材料库分项', count: 124, detail: {'管数':'124根'} } };
const MATERIAL_LIBRARY_KEY = 'boiler_material_library';
const MATERIAL_COMPONENT_BY_TAB = { ww:'炉膛水冷壁', rsh:'顶棚过热器', wsh:'包墙过热器', lsh:'低温过热器', psh:'全大屏过热器', 'hsh-p':'屏式过热器', hsh:'高温过热器', lrh:'低温再热器', hrh:'高温再热器', eco:'省煤器' };
const MATERIAL_COLUMNS = ['部件名称','系统代码','分段/位置','结构形式','规格型号','管径','壁厚','材质','库存根数','库存总长度(m)','预留位置','备注'];
const MATERIAL_LIBRARY = [
  { component:'省煤器', sys:'SMQ', position:'1 省煤器蛇形管', shape:'蛇形管', spec:'Φ51×6', diameter:'51', wallThickness:'6', material:'SA-210C', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号1；直管附加壁厚0.6mm，弯管附加壁厚1.7475mm' },
  { component:'省煤器', sys:'SMQ', position:'2 省煤器吊挂管', shape:'吊挂管', spec:'Φ60×9', diameter:'60', wallThickness:'9', material:'SA-210C', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号2；直管附加壁厚0.9mm，弯管附加壁厚1.872mm' },
  { component:'省煤器', sys:'SMQ', position:'3 省煤器至锅筒连接管', shape:'连接管', spec:'Φ159×18', diameter:'159', wallThickness:'18', material:'20G', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号3；直管附加壁厚1.4mm，弯管附加壁厚3.11mm' },
  { component:'炉膛水冷壁', sys:'SLB', position:'4 水冷壁管', shape:'直管', spec:'Φ63.5×7.5', diameter:'63.5', wallThickness:'7.5', material:'SA-210C', inUseQty:'722根', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号4；直管附加壁厚0.75mm，弯管附加壁厚1.29mm' },
  { component:'顶棚过热器', sys:'RSH', position:'5 汽包至顶棚连接管', shape:'连接管', spec:'Φ159×18', diameter:'159', wallThickness:'18', material:'20G', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号5；直管附加壁厚1.4mm，弯管附加壁厚3.11mm' },
  { component:'炉膛水冷壁', sys:'SLB', position:'6 下水连接管', shape:'连接管', spec:'Φ159×18', diameter:'159', wallThickness:'18', material:'20G', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号6；直管附加壁厚1.4mm，弯管附加壁厚3.11mm' },
  { component:'顶棚过热器', sys:'RSH', position:'7 顶棚管', shape:'直管', spec:'Φ48.5×6', diameter:'48.5', wallThickness:'6', material:'15CrMoG', inUseQty:'128根', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号7；直管附加壁厚1.1mm，弯管附加壁厚1.91mm' },
  { component:'包墙过热器', sys:'WSH', position:'8 包墙管（一；顶部）', shape:'直管', spec:'Φ51×6', diameter:'51', wallThickness:'6', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号8；直管附加壁厚1.1mm，弯管附加壁厚1.64mm' },
  { component:'包墙过热器', sys:'WSH', position:'9 包墙管（二）', shape:'直管', spec:'Φ51×7', diameter:'51', wallThickness:'7', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号9；直管附加壁厚1.2mm，弯管附加壁厚2.145mm' },
  { component:'包墙过热器', sys:'WSH', position:'10 包墙管（三）', shape:'直管', spec:'Φ63.5×12', diameter:'63.5', wallThickness:'12', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号10；直管附加壁厚1.7mm，弯管附加壁厚3.32mm' },
  { component:'低温过热器', sys:'DGRQ', position:'11 低过管子（一）', shape:'蛇形管', spec:'Φ57×6', diameter:'57', wallThickness:'6', material:'15CrMoG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号11；直管附加壁厚1.1mm，弯管附加壁厚1.748mm' },
  { component:'低温过热器', sys:'DGRQ', position:'12 低过管子（二）', shape:'蛇形管', spec:'Φ60×8.5', diameter:'60', wallThickness:'8.5', material:'15CrMoG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号12；直管附加壁厚1.35mm，弯管附加壁厚/' },
  { component:'低温过热器', sys:'DGRQ', position:'13 低过管子（三）', shape:'蛇形管', spec:'Φ57×6', diameter:'57', wallThickness:'6', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号13；直管附加壁厚1.1mm，弯管附加壁厚1.748mm' },
  { component:'低温过热器', sys:'DGRQ', position:'14 低过管子（四）', shape:'蛇形管', spec:'Φ57×8', diameter:'57', wallThickness:'8', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号14；直管附加壁厚1.3mm，弯管附加壁厚2.164mm' },
  { component:'全大屏过热器', sys:'DPGRQ', position:'15 全大屏管子（一）', shape:'管子', spec:'Φ51×7', diameter:'51', wallThickness:'7', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号15；直管附加壁厚1.2mm，弯管附加壁厚1.956mm' },
  { component:'全大屏过热器', sys:'DPGRQ', position:'16 全大屏管子（二）', shape:'管子', spec:'Φ51×7', diameter:'51', wallThickness:'7', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号16；直管附加壁厚0.7mm，弯管附加壁厚1.456mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'17 屏式过热器管（一）', shape:'管子', spec:'Φ54×9', diameter:'54', wallThickness:'9', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号17；直管附加壁厚0.9mm，弯管附加壁厚2.7853mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'18 屏式过热器管（二）', shape:'管子', spec:'Φ54×8.5', diameter:'54', wallThickness:'8.5', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号18；直管附加壁厚0.85mm，弯管附加壁厚1.9975mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'19 屏式过热器管（三）', shape:'管子', spec:'Φ54×8.5', diameter:'54', wallThickness:'8.5', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号19；直管附加壁厚1.35mm，弯管附加壁厚2.88mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'20 屏式过热器管（四）', shape:'管子', spec:'Φ54×8.5', diameter:'54', wallThickness:'8.5', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号20；直管附加壁厚0.85mm，弯管附加壁厚1.9975mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'21 屏式过热器管（五）', shape:'管子', spec:'Φ60×8', diameter:'60', wallThickness:'8', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号21；直管附加壁厚0.8mm，弯管附加壁厚1.88mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'22 屏式过热器管（六）', shape:'管子', spec:'Φ60×9', diameter:'60', wallThickness:'9', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号22；直管附加壁厚0.9mm，弯管附加壁厚2.115mm' },
  { component:'屏式过热器', sys:'HPGRQ', position:'23 屏式过热器管（七）', shape:'管子', spec:'Φ60×8', diameter:'60', wallThickness:'8', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号23；直管附加壁厚1.3mm，弯管附加壁厚2.74mm' },
  { component:'高温过热器', sys:'GGRQ', position:'24 高过管子（一）', shape:'管子', spec:'Φ51×9', diameter:'51', wallThickness:'9', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号24；直管附加壁厚1.4mm，弯管附加壁厚2.615mm' },
  { component:'高温过热器', sys:'GGRQ', position:'25 高过管子（二）', shape:'管子', spec:'Φ51×8', diameter:'51', wallThickness:'8', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号25；直管附加壁厚0.8mm，弯管附加壁厚1.88mm' },
  { component:'高温过热器', sys:'GGRQ', position:'26 高过管子（三）', shape:'管子', spec:'Φ51×8', diameter:'51', wallThickness:'8', material:'SA-213TP304H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号26；直管附加壁厚0.8mm，弯管附加壁厚1.88mm' },
  { component:'高温过热器', sys:'GGRQ', position:'27 高过管子（四）', shape:'管子', spec:'Φ51×11', diameter:'51', wallThickness:'11', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号27；直管附加壁厚1.1mm，弯管附加壁厚2.585mm' },
  { component:'高温过热器', sys:'GGRQ', position:'28 高过管子（五）', shape:'管子', spec:'Φ54×7.5', diameter:'54', wallThickness:'7.5', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号28；直管附加壁厚0.75mm，弯管附加壁厚1.7625mm' },
  { component:'高温过热器', sys:'GGRQ', position:'29 高过管子（六）', shape:'管子', spec:'Φ54×9', diameter:'54', wallThickness:'9', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号29；直管附加壁厚0.9mm，弯管附加壁厚/' },
  { component:'高温过热器', sys:'GGRQ', position:'30 高过管子（七）', shape:'管子', spec:'Φ54×11', diameter:'54', wallThickness:'11', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号30；直管附加壁厚1.1mm，弯管附加壁厚2.585mm' },
  { component:'高温过热器', sys:'GGRQ', position:'31 高过管子（八）', shape:'管子', spec:'Φ54×9', diameter:'54', wallThickness:'9', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号31；直管附加壁厚1.4mm，弯管附加壁厚2.615mm' },
  { component:'高温再热器', sys:'GZRQ', position:'32 高温再热器管（一）', shape:'管子', spec:'Φ60×4', diameter:'60', wallThickness:'4', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号32；直管附加壁厚0.9mm，弯管附加壁厚1.332mm' },
  { component:'高温再热器', sys:'GZRQ', position:'33 高温再热器管（二）', shape:'管子', spec:'Φ51×4', diameter:'51', wallThickness:'4', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号33；直管附加壁厚0.9mm，弯管附加壁厚1.26mm' },
  { component:'高温再热器', sys:'GZRQ', position:'34 高温再热器管（三）', shape:'管子', spec:'Φ60×4', diameter:'60', wallThickness:'4', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号34；直管附加壁厚0.4mm，弯管附加壁厚0.832mm' },
  { component:'高温再热器', sys:'GZRQ', position:'35 高温再热器管（四）', shape:'管子', spec:'Φ60×4', diameter:'60', wallThickness:'4', material:'SA-213TP304H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号35；直管附加壁厚0.9mm，弯管附加壁厚1.332mm' },
  { component:'高温再热器', sys:'GZRQ', position:'36 高温再热器管（五）', shape:'管子', spec:'Φ60×6', diameter:'60', wallThickness:'6', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号36；直管附加壁厚0.6mm，弯管附加壁厚1.248mm' },
  { component:'高温再热器', sys:'GZRQ', position:'37 高温再热器管（六）', shape:'管子', spec:'Φ60×5', diameter:'60', wallThickness:'5', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号37；直管附加壁厚0.5mm，弯管附加壁厚1.04mm' },
  { component:'高温再热器', sys:'GZRQ', position:'38 高温再热器管（七）', shape:'管子', spec:'Φ51×5', diameter:'51', wallThickness:'5', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号38；直管附加壁厚0.5mm，弯管附加壁厚1.175mm' },
  { component:'高温再热器', sys:'GZRQ', position:'39 高温再热器管（八）', shape:'管子', spec:'Φ60×5', diameter:'60', wallThickness:'5', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号39；直管附加壁厚1mm，弯管附加壁厚1.54mm' },
  { component:'低温再热器', sys:'DZRQ', position:'40 低再管（一）', shape:'水平段管圈', spec:'Φ63.5×4', diameter:'63.5', wallThickness:'4', material:'SA-210C', inUseQty:'98片×6管圈', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号40；直管附加壁厚0.4mm，弯管附加壁厚0.832mm；低再水平段下三组材料为SA-210C' },
  { component:'低温再热器', sys:'DZRQ', position:'41 低再管（二）', shape:'水平段管圈', spec:'Φ63.5×4', diameter:'63.5', wallThickness:'4', material:'15CrMoG', inUseQty:'98片×6管圈', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号41；直管附加壁厚0.9mm，弯管附加壁厚1.332mm；第五级水平管组材料为15CrMoG' },
  { component:'低温再热器', sys:'DZRQ', position:'42 低再管（三）', shape:'出口垂直段管屏', spec:'Φ63.5×4', diameter:'63.5', wallThickness:'4', material:'12Cr1MoVG', inUseQty:'49屏×12管圈', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号42；直管附加壁厚0.9mm，弯管附加壁厚1.332mm；出口垂直段材料为12Cr1MoVG' },
  { component:'低温再热器', sys:'DZRQ', position:'43 低再管（四）', shape:'支撑耳板外圈管', spec:'Φ63.5×6', diameter:'63.5', wallThickness:'6', material:'SA-210C', inUseQty:'按支撑耳板位置', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号43；直管附加壁厚1.1mm，弯管附加壁厚1.8144mm；支撑耳板外圈管' },
  { component:'低温再热器', sys:'DZRQ', position:'44 低再管（五）', shape:'支撑耳板外圈管', spec:'Φ63.5×6', diameter:'63.5', wallThickness:'6', material:'15CrMoG', inUseQty:'按支撑耳板位置', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号44；直管附加壁厚1.1mm，弯管附加壁厚1.748mm；支撑耳板外圈管' }
];
const SH_HEADERS = [{n:1,name:'顶棚进口集箱',spec:'φ273×45',mat:'20G'},{n:2,name:'高过出口集箱',spec:'φ609.6×110',mat:'12Cr1MoVG'}];
const RH_HEADERS = [{n:1,name:'低再进口集箱',spec:'φ559×30',mat:'20G'},{n:2,name:'高再出口集箱',spec:'φ711×40',mat:'12Cr1MoVG'}];
/* 演示数据三态开关（默认自动）：无真实数据显示演示，检测到真实录入即自动隐藏；
   可强制开（对照演示）/ 强制关。关闭或自动隐藏后，示范管段从预警/档案/搜索/AI 分析中完全消失。 */
const DEMO_DATA_KEY = 'blcms-demo-data';
function demoDataPref() {
  try { const pref = localStorage.getItem(DEMO_DATA_KEY); return pref === 'on' || pref === 'off' ? pref : 'auto'; } catch (err) { return 'auto'; }
}
function hasRealTubeData() { return (typeof userDB !== 'undefined' && Array.isArray(userDB.events) && userDB.events.length > 0); }
function demoDataEnabled() {
  const pref = demoDataPref();
  if(pref === 'on') return true;
  if(pref === 'off') return false;
  return !hasRealTubeData(); /* 自动：真实数据到位即隐藏演示 */
}
function systemLifecycleData() { return demoDataEnabled() ? LIFECYCLE_DATA : {}; }
function applyDemoDataToggle() {
  const btn = document.getElementById('demo-data-toggle');
  if(!btn) return;
  const pref = demoDataPref();
  btn.textContent = pref === 'auto' ? '演示·自动' : (pref === 'on' ? '演示·开' : '演示·关');
  btn.classList.toggle('is-hidden', !demoDataEnabled());
  btn.title = pref === 'auto'
    ? '演示数据：自动（' + (demoDataEnabled() ? '当前显示，录入真实数据后自动隐藏' : '已因真实数据自动隐藏') + '），点击强制打开'
    : pref === 'on' ? '演示数据：强制显示（与真实数据并存），点击强制隐藏' : '演示数据：已强制隐藏，点击恢复自动';
}
function refreshAfterDemoToggle() {
  renderDashboardWarnings();
  syncDashboardSnapshot();
  renderMaintenancePlan();
  updateLifecycleDropdown();
  renderComponent(document.querySelector('.comp-tab.active')?.dataset.comp || 'ww');
}
function toggleDemoData() {
  const order = ['auto', 'on', 'off'];
  const next = order[(order.indexOf(demoDataPref()) + 1) % order.length];
  try { localStorage.setItem(DEMO_DATA_KEY, next); } catch (err) { /* 忽略 */ }
  applyDemoDataToggle();
  refreshAfterDemoToggle();
  const message = next === 'auto'
    ? '演示数据回到自动：' + (demoDataEnabled() ? '暂无真实数据，显示演示。' : '检测到真实数据，演示已隐藏。')
    : next === 'on'
      ? '已强制显示演示数据（与真实数据并存，适合对照讲解）。'
      : '已强制隐藏演示数据：预警、档案、分析与待处置任务只使用真实录入。';
  showToast(message, 'info', 6000);
}
/* 自动模式下首次出现真实数据时提示一次（演示已被自动隐藏） */
function nudgeDemoToggleOnce() {
  if(demoDataPref() !== 'auto' || !hasRealTubeData()) return;
  try {
    if(sessionStorage.getItem('blcms-demo-auto')) return;
    sessionStorage.setItem('blcms-demo-auto', '1');
  } catch (err) { return; }
  showToast('检测到真实数据，演示管段已自动隐藏；如需对照可在左下角强制打开。', 'info', 8000);
}

const LIFECYCLE_DATA = {
  '2G-SLB-WB-F000-R025-Q001': { name: '2号炉水冷壁前墙炉右往左第25根', spec: 'Φ63.5×7.5 · SA-210C', install: '2016-03-10', hours: 72540, status: 'ok', risk: '状态良好', timeline: [{date:'2016-03-10',t:'安装',d:'壁厚7.5'},{date:'2025-11-11',t:'测厚',d:'壁厚6.8'}] },
  '1G-GGRQ-GQ-L012-U005-Q001': { name: '1号炉高温过热器炉左往右第12排上往下第5根', spec: 'Φ51×8 · SA-213T91', install: '2018-06-15', hours: 58720, status: 'warn', risk: '蠕变损伤68%', timeline: [{date:'2018-06-15',t:'安装',d:'合格'},{date:'2025-12-15',t:'评估',d:'剩余寿命8.2万h'}] },
  '2G-GZRQ-GQ-L032-U004-Q001': { name: '2号炉高温再热器炉左往右第32排上往下第4根', spec: 'Φ60×4 · SA-213TP304H', install: '2017-11-05', hours: 65830, status: 'danger', risk: '壁厚减薄至3.3mm', timeline: [{date:'2017-11-05',t:'安装',d:'壁厚4.0'},{date:'2025-09-15',t:'测厚',d:'壁厚3.3'}] },
  '1G-DPGRQ-GQ-L001-L002-U007-Q001': { name: '1号炉全大屏过热器第1片第2小屏上往下第7根', spec: 'Φ51×7 · 12Cr1MoVG', install: '2017-05-20', hours: 68900, status: 'warn', risk: '屏底结渣区需关注', timeline: [{date:'2017-05-20',t:'安装',d:'合格'},{date:'2026-01-10',t:'测厚',d:'壁厚6.2'}] },
  '2G-HPGRQ-GQ-L015-U009-Q001': { name: '2号炉后屏过热器炉左往右第15屏上往下第9根', spec: 'Φ54×9 · SA-213TP347H', install: '2018-03-18', hours: 60110, status: 'warn', risk: '高温腐蚀区金相复查', timeline: [{date:'2018-03-18',t:'安装',d:'合格'},{date:'2025-10-20',t:'金相',d:'组织轻度球化'}] },
  '1G-DGRQ-GQ-2KJ-L045-U003-Q001': { name: '1号炉低温过热器第2检修空间第45排上往下第3根', spec: 'Φ57×6 · 15CrMoG', install: '2016-08-02', hours: 71230, status: 'ok', risk: '状态良好', timeline: [{date:'2016-08-02',t:'安装',d:'壁厚6.0'},{date:'2025-06-18',t:'测厚',d:'壁厚5.4'}] },
  '1G-DZRQ-GQ-4KJ-L065-Q001': { name: '1号炉低温再热器第4检修空间炉左往右第65排', spec: 'Φ63.5×4 · SA-210C', install: '2015-12-11', hours: 76850, status: 'ok', risk: '状态良好', timeline: [{date:'2015-12-11',t:'安装',d:'壁厚4.0'},{date:'2025-04-05',t:'测厚',d:'壁厚3.7'}] },
  '2G-SMQ-EXIN-L012-U001-Q001': { name: '2号炉省煤器进口集箱炉左往右第12排', spec: 'Φ159×18 · 20G', install: '2016-03-10', hours: 72540, status: 'ok', risk: '状态良好', timeline: [{date:'2016-03-10',t:'安装',d:'合格'},{date:'2025-11-11',t:'测厚',d:'壁厚17.2'}] },
  '2G-SLB-LHD-F000-L016-Q001': { name: '2号炉冷灰斗前坡炉左往右第16根', spec: 'Φ63.5×7.5 · SA-210C', install: '2016-03-10', hours: 72540, status: 'warn', risk: '灰斗冲刷区磨损', timeline: [{date:'2016-03-10',t:'安装',d:'壁厚7.5'},{date:'2025-08-22',t:'测厚',d:'壁厚5.9'}] },
  '2G-SLB-RSQ-J1-A03-Q001': { name: '2号炉燃烧器区域1号角A层第3喷口', spec: 'Φ63.5×7.5 · SA-210C', install: '2016-03-10', hours: 72540, status: 'ok', risk: '状态良好', timeline: [{date:'2016-03-10',t:'安装',d:'合格'},{date:'2025-05-30',t:'测厚',d:'壁厚7.0'}] }
};
const matrix = [
  { name:'水冷壁-前墙', sys:'SLB', comp:'WB', pos:'F000', dirs:['R','L'], tMax:192, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww' },
  { name:'水冷壁-后墙', sys:'SLB', comp:'WB', pos:'B000', dirs:['R','L'], tMax:192, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww' },
  { name:'水冷壁-左墙（B侧）', sys:'SLB', comp:'WB', pos:'L000', dirs:['F','B'], tMax:169, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww' },
  { name:'水冷壁-右墙（A侧）', sys:'SLB', comp:'WB', pos:'R000', dirs:['F','B'], tMax:169, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww' },
  { name:'冷灰斗-前坡', sys:'SLB', comp:'LHD', pos:'F000', dirs:['L','R'], tMax:96, spec:'Φ63.5×7.5 SA-210C', mat:'按材料库分项', badge:'badge-ww' },
  { name:'冷灰斗-后坡', sys:'SLB', comp:'LHD', pos:'B000', dirs:['L','R'], tMax:96, spec:'Φ63.5×7.5 SA-210C', mat:'按材料库分项', badge:'badge-ww' },
  { name:'燃烧器区域', sys:'SLB', comp:'RSQ', special:'rsq', corners:[1,4], layers:['A','B','C','D','E','F'], nozzles:[1,8], spec:'Φ63.5×7.5 SA-210C', mat:'按材料库分项', badge:'badge-ww' },
  { name:'全大屏过热器', sys:'DPGRQ', comp:'GQ', posLetters:['L','R'], pMax:6, pos2Letters:['L','R'], p2Max:4, dirs:['U','D'], tMax:14, spec:'Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91', mat:'按材料库分项', badge:'badge-sh' },
  { name:'后屏过热器', sys:'HPGRQ', comp:'GQ', posLetters:['L','R'], pMax:21, dirs:['U','D'], tMax:13, spec:'Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh' },
  { name:'高温过热器', sys:'GGRQ', comp:'GQ', posLetters:['L','R'], pMax:32, dirs:['U','D'], tMax:12, fieldDirs:['F','B'], fieldDefault:'F', spec:'Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh' },
  { name:'高温再热器', sys:'GZRQ', comp:'GQ', posLetters:['L','R'], pMax:64, dirs:['U','D'], tMax:7, fieldDirs:['F','B'], spec:'Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG', mat:'按材料库分项', badge:'badge-rh' },
  { name:'低温过热器', sys:'DGRQ', comp:'GQ', spaces:[1,4], posLetters:['L','R'], pMax:112, dirs:['U','D'], tMax:5, spec:'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh' },
  { name:'低温再热器', sys:'DZRQ', comp:'GQ', spaces:[1,5], posLetters:['L','R'], pMax:112, dirs:['U','D'], tMax:6, tubeOptional:true, spec:'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', mat:'按材料库分项', badge:'badge-rh' },
  { name:'省煤器蛇形管', sys:'SMQ', comp:'SG', posLetters:['L','R'], pMax:124, dirs:['U','D'], tMax:1, spec:'Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-eco' },
  { name:'省煤器进口集箱', sys:'SMQ', comp:'EXIN', posLetters:['L','R'], pMax:124, dirs:['U','D'], tMax:1, spec:'Φ159×18 20G', mat:'按材料库分项', badge:'badge-eco' },
  { name:'省煤器出口集箱', sys:'SMQ', comp:'EXOUT', posLetters:['L','R'], pMax:124, dirs:['U','D'], tMax:1, spec:'Φ159×18 20G', mat:'按材料库分项', badge:'badge-eco' }
];
const CODE_SYSTEMS = [
  { sys:'SLB', label:'水冷壁', comps:['WB','LHD','RSQ'] },
  { sys:'GZRQ', label:'高温再热器', comps:['GQ'] },
  { sys:'GGRQ', label:'高温过热器', comps:['GQ'] },
  { sys:'HPGRQ', label:'后屏过热器', comps:['GQ'] },
  { sys:'DPGRQ', label:'全大屏过热器', comps:['GQ'] },
  { sys:'DGRQ', label:'低温过热器', comps:['GQ'] },
  { sys:'DZRQ', label:'低温再热器', comps:['GQ'] },
  { sys:'SMQ', label:'省煤器', comps:['SG','EXIN','EXOUT'] }
];
/* 顶棚过热器/包墙过热器仅存在于材料库，不参与新编码规则 */
const ALL_CODE_SYSTEMS = [...CODE_SYSTEMS, { sys:'RSH', label:'顶棚过热器' }, { sys:'WSH', label:'包墙过热器' }];
const COMPONENT_LABELS = { GQ:'管屏', WB:'水冷壁管', SG:'省煤器蛇形管', EXIN:'省煤器进口集箱', EXOUT:'省煤器出口集箱', LHD:'冷灰斗', RSQ:'燃烧器区域' };
/* 方位/方向字母含义（规则第4条） */
const CODE_DIR_LABELS = { A:'A侧', B:'炉后往前/B侧', F:'炉前往后', L:'炉左往右', R:'炉右往左/A侧', U:'上往下', D:'下往上' };
const WALL_THICKNESS_WARNING_RULES = [
  { no:1, sys:'SMQ', name:'省煤器蛇形管', diameter:'51', wall:'6', material:'SA-210C', pressure:20.2, temperature:348, allowableStress:135.2, straight:3.80, bendRadius:60, bend:3.23 },
  { no:2, sys:'SMQ', name:'省煤器吊挂管', diameter:'60', wall:'9', material:'SA-210C', pressure:20.2, temperature:358, allowableStress:131.1, straight:4.59, bendRadius:200, bend:4.29 },
  { no:3, sys:'SMQ', name:'省煤器至锅筒连接管', diameter:'159', wall:'18', material:'20G', pressure:20.2, temperature:328, allowableStress:106, straight:13.83, bendRadius:650, bend:13.08 },
  { no:4, sys:'SLB', name:'水冷壁管', diameter:'63.5', wall:'7.5', material:'SA-210C', pressure:20.1, temperature:411, allowableStress:93.4, straight:6.49, bendRadius:150, bend:5.92 },
  { no:5, sys:'RSH', name:'汽包至顶棚连接管', diameter:'159', wall:'18', material:'20G', pressure:19.78, temperature:361, allowableStress:97, straight:14.71, bendRadius:650, bend:13.91 },
  { no:6, sys:'SLB', name:'下水连接管', diameter:'159', wall:'18', material:'20G', pressure:20.1, temperature:361, allowableStress:97, straight:14.93, bendRadius:650, bend:14.11 },
  { no:7, sys:'RSH', name:'顶棚管', diameter:'48.5', wall:'6', material:'15CrMoG', pressure:19.78, temperature:475, allowableStress:119, straight:3.72, bendRadius:90, bend:3.33 },
  { no:8, sys:'WSH', name:'包墙管（一；顶部）', diameter:'51', wall:'6', material:'12Cr1MoVG', pressure:19.68, temperature:415, allowableStress:132.9, straight:3.52, bendRadius:120, bend:3.21 },
  { no:9, sys:'WSH', name:'包墙管（二）', diameter:'51', wall:'7', material:'12Cr1MoVG', pressure:19.68, temperature:415, allowableStress:132.9, straight:3.52, bendRadius:120, bend:3.21 },
  { no:10, sys:'WSH', name:'包墙管（三）', diameter:'63.5', wall:'12', material:'12Cr1MoVG', pressure:19.68, temperature:415, allowableStress:132.9, straight:4.38, bendRadius:120, bend:3.92 },
  { no:11, sys:'DGRQ', zone:'E', name:'低过管子（一）', diameter:'57', wall:'6', material:'15CrMoG', pressure:19.36, temperature:460, allowableStress:121.6, straight:4.49, bendRadius:150, bend:4.13 },
  { no:12, sys:'DGRQ', name:'低过管子（二）', diameter:'60', wall:'8.5', material:'15CrMoG', pressure:19.36, temperature:384, allowableStress:130, straight:4.16, bendRadius:'/', bend:'/' },
  { no:13, sys:'DGRQ', zone:'O', name:'低过管子（三）', diameter:'57', wall:'6', material:'12Cr1MoVG', pressure:19.36, temperature:507, allowableStress:110, straight:4.61, bendRadius:150, bend:4.24 },
  { no:14, sys:'DGRQ', name:'低过管子（四）', diameter:'57', wall:'8', material:'12Cr1MoVG', pressure:19.36, temperature:540, allowableStress:79, straight:6.22, bendRadius:150, bend:5.73 },
  { no:15, sys:'DPGRQ', name:'全大屏管子（一）', diameter:'51', wall:'7', material:'12Cr1MoVG', pressure:19.12, temperature:486, allowableStress:122, straight:3.71, bendRadius:160, bend:3.45 },
  { no:16, sys:'DPGRQ', name:'全大屏管子（二）', diameter:'51', wall:'7', material:'SA-213T91', pressure:19.12, temperature:514, allowableStress:120, straight:4.02, bendRadius:160, bend:3.74 },
  { no:17, sys:'HPGRQ', name:'屏式过热器管（一）', diameter:'54', wall:'9', material:'SA-213TP347H', pressure:18.86, temperature:596, allowableStress:95, straight:5.15, bendRadius:58, bend:4.33 },
  { no:18, sys:'HPGRQ', name:'屏式过热器管（二）', diameter:'54', wall:'8.5', material:'SA-213T91', pressure:18.86, temperature:545, allowableStress:109, straight:4.57, bendRadius:120, bend:4.15 },
  { no:19, sys:'HPGRQ', name:'屏式过热器管（三）', diameter:'54', wall:'8.5', material:'12Cr1MoVG', pressure:18.86, temperature:527, allowableStress:90, straight:5.12, bendRadius:96, bend:4.56 },
  { no:20, sys:'HPGRQ', name:'屏式过热器管（四）', diameter:'54', wall:'8.5', material:'SA-213TP347H', pressure:18.86, temperature:565, allowableStress:110, straight:4.53, bendRadius:120, bend:4.12 },
  { no:21, sys:'HPGRQ', name:'屏式过热器管（五）', diameter:'60', wall:'8', material:'SA-213T91', pressure:18.86, temperature:529, allowableStress:115, straight:4.85, bendRadius:120, bend:4.36 },
  { no:22, sys:'HPGRQ', name:'屏式过热器管（六）', diameter:'60', wall:'9', material:'SA-213TP347H', pressure:18.86, temperature:597, allowableStress:94, straight:5.77, bendRadius:120, bend:5.19 },
  { no:23, sys:'HPGRQ', name:'屏式过热器管（七）', diameter:'60', wall:'8', material:'12Cr1MoVG', pressure:18.86, temperature:442, allowableStress:129, straight:4.09, bendRadius:120, bend:3.68 },
  { no:24, sys:'GGRQ', name:'高过管子（一）', diameter:'51', wall:'9', material:'12Cr1MoVG', pressure:18.49, temperature:553, allowableStress:69, straight:6.03, bendRadius:120, bend:5.50 },
  { no:25, sys:'GGRQ', name:'高过管子（二）', diameter:'51', wall:'8', material:'SA-213T91', pressure:18.49, temperature:578, allowableStress:78, straight:5.66, bendRadius:120, bend:5.16 },
  { no:26, sys:'GGRQ', name:'高过管子（三）', diameter:'51', wall:'8', material:'SA-213TP304H', pressure:18.49, temperature:579, allowableStress:77, straight:5.72, bendRadius:120, bend:5.22 },
  { no:27, sys:'GGRQ', name:'高过管子（四）', diameter:'51', wall:'11', material:'SA-213T22', pressure:18.49, temperature:547, allowableStress:49, straight:8.35, bendRadius:120, bend:7.62 },
  { no:28, sys:'GGRQ', name:'高过管子（五）', diameter:'54', wall:'7.5', material:'SA-213TP347H', pressure:18.49, temperature:574, allowableStress:109, straight:4.49, bendRadius:120, bend:4.08 },
  { no:29, sys:'GGRQ', name:'高过管子（六）', diameter:'54', wall:'9', material:'SA-213T91', pressure:18.49, temperature:547, allowableStress:108, straight:4.53, bendRadius:'/', bend:'/' },
  { no:30, sys:'GGRQ', name:'高过管子（七）', diameter:'54', wall:'11', material:'SA-213T22', pressure:18.49, temperature:542, allowableStress:52, straight:8.42, bendRadius:120, bend:7.65 },
  { no:31, sys:'GGRQ', name:'高过管子（八）', diameter:'54', wall:'9', material:'12Cr1MoVG', pressure:18.49, temperature:496, allowableStress:119, straight:3.89, bendRadius:120, bend:3.54 },
  { no:32, sys:'GZRQ', name:'高温再热器管（一）', diameter:'60', wall:'4', material:'12Cr1MoVG', pressure:4.81, temperature:558, allowableStress:66, straight:2.11, bendRadius:200, bend:1.97 },
  { no:33, sys:'GZRQ', name:'高温再热器管（二）', diameter:'51', wall:'4', material:'12Cr1MoVG', pressure:4.81, temperature:454, allowableStress:127, straight:0.95, bendRadius:200, bend:0.89 },
  { no:34, sys:'GZRQ', name:'高温再热器管（三）', diameter:'60', wall:'4', material:'SA-213T91', pressure:4.81, temperature:598, allowableStress:66, straight:2.41, bendRadius:200, bend:2.25 },
  { no:35, sys:'GZRQ', name:'高温再热器管（四）', diameter:'60', wall:'4', material:'SA-213TP304H', pressure:4.81, temperature:601, allowableStress:64, straight:2.47, bendRadius:200, bend:2.31 },
  { no:36, sys:'GZRQ', name:'高温再热器管（五）', diameter:'60', wall:'6', material:'SA-213T91', pressure:4.81, temperature:601, allowableStress:102, straight:1.68, bendRadius:200, bend:1.57 },
  { no:37, sys:'GZRQ', name:'高温再热器管（六）', diameter:'60', wall:'5', material:'SA-213T22', pressure:4.81, temperature:551, allowableStress:47, straight:3.22, bendRadius:200, bend:3.01 },
  { no:38, sys:'GZRQ', name:'高温再热器管（七）', diameter:'51', wall:'5', material:'SA-213T22', pressure:4.81, temperature:539, allowableStress:54, straight:2.43, bendRadius:120, bend:2.22 },
  { no:39, sys:'GZRQ', name:'高温再热器管（八）', diameter:'60', wall:'5', material:'12Cr1MoVG', pressure:4.81, temperature:454, allowableStress:127, straight:1.12, bendRadius:200, bend:1.04 },
  { no:40, sys:'DZRQ', name:'低再管（一）', diameter:'63.5', wall:'4', material:'SA-210C', pressure:4.81, temperature:428, allowableStress:81, straight:2.15, bendRadius:160, bend:1.97 },
  { no:41, sys:'DZRQ', name:'低再管（二）', diameter:'63.5', wall:'4', material:'15CrMoG', pressure:4.81, temperature:452, allowableStress:122, straight:1.23, bendRadius:160, bend:1.13 },
  { no:42, sys:'DZRQ', name:'低再管（三）', diameter:'63.5', wall:'4', material:'12Cr1MoVG', pressure:4.81, temperature:552, allowableStress:69, straight:2.14, bendRadius:160, bend:1.96 },
  { no:43, sys:'DZRQ', name:'低再管（四）', diameter:'63.5', wall:'6', material:'SA-210C', pressure:4.81, temperature:444, allowableStress:71, straight:2.40, bendRadius:120, bend:2.15 },
  { no:44, sys:'DZRQ', name:'低再管（五）', diameter:'63.5', wall:'6', material:'15CrMoG', pressure:4.81, temperature:474, allowableStress:119, straight:1.26, bendRadius:150, bend:1.15 }
];

function getSysLabel(sys) { const rule = CODE_SYSTEMS.find(item => item.sys === sys); if(rule) return `${sys} · ${rule.label}`; const m = matrix.find(item => item.sys === sys); return m ? `${sys} · ${m.name.replace(/[-－].*$/, '')}` : sys; }
function getZoneLabel(zone) { return CODE_DIR_LABELS[zone] || zone; }
function normalizeMaterial(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/SA[-\s]?213TP/g, 'TP')
    .replace(/SA[-\s]?213T/g, 'T')
    .replace(/SA[-\s]?210C/g, 'SA210C')
    .replace(/[-\s]/g, '');
}
function materialAliases(value) {
  return String(value || '')
    .split(/[、,，/;；\s]+/)
    .map(normalizeMaterial)
    .filter(Boolean);
}
function numericTokens(value) {
  return String(value || '').match(/\d+(?:\.\d+)?/g) || [];
}
function specPairs(value) {
  const pairs = [];
  String(value || '').replace(/[Φφ]/g, '').replace(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/g, (_, d, w) => {
    pairs.push({ diameter: d, wall: w });
    return _;
  });
  return pairs;
}
function wallWarningValue(rule) {
  return Math.max(Number(rule.straight) || 0, Number(rule.bend) || 0);
}
function collectWallWarningMatches(meta) {
  const sys = String(meta.sys || '').toUpperCase();
  const zone = String(meta.zone || '').toUpperCase();
  const pairs = [...specPairs(meta.spec), ...specPairs(meta.name), ...specPairs(meta.position)];
  const diameters = new Set([...numericTokens(meta.diameter), ...pairs.map(pair => pair.diameter)].filter(Boolean));
  const walls = new Set([...numericTokens(meta.wallThickness), ...pairs.map(pair => pair.wall)].filter(Boolean));
  const materials = new Set(materialAliases(meta.material || meta.mat || meta.spec));
  return WALL_THICKNESS_WARNING_RULES
    .map(rule => {
      if(sys && rule.sys !== sys) return null;
      if(rule.zone && zone && rule.zone !== zone) return null;
      let score = sys ? 5 : 0;
      if(rule.zone && zone === rule.zone) score += 2;
      const diameterHit = diameters.size === 0 || diameters.has(rule.diameter);
      const wallHit = walls.size === 0 || walls.has(rule.wall);
      const ruleMaterials = materialAliases(rule.material);
      const materialHit = materials.size === 0 || ruleMaterials.some(value => materials.has(value));
      if(!diameterHit || !wallHit) return null;
      if(diameters.size) score += 2;
      if(walls.size) score += 2;
      if(materialHit && materials.size) score += 2;
      return { ...rule, warning: wallWarningValue(rule), score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.warning - a.warning);
}
function resolveWallThicknessWarning(target) {
  const code = typeof target === 'string' ? target : '';
  const inventory = code ? validateCodeAgainstMatrix(code) : null;
  const component = code ? matchComponentFromCode(code) : null;
  const lifecycle = code ? systemLifecycleData()[code] : null;
  const meta = typeof target === 'string'
    ? { sys: getCodeSystem(code), zone: '', spec: [lifecycle?.spec, inventory?.row?.spec, component?.spec].filter(Boolean).join(' '), material: [lifecycle?.spec, inventory?.row?.mat, component?.mat].filter(Boolean).join(' ') }
    : target;
  const matches = collectWallWarningMatches(meta || {});
  if(matches.length === 0) return null;
  const topScore = matches[0].score;
  const candidates = matches.filter(item => item.score === topScore);
  const selected = candidates.reduce((best, item) => item.warning > best.warning ? item : best, candidates[0]);
  return {
    value: selected.warning,
    straight: selected.straight,
    bend: selected.bend,
    rule: selected,
    matches,
    thresholdSource: `理论计算厚度预警值：${selected.name}（直管 ${selected.straight}mm${Number(selected.bend) ? `，弯管外侧 ${selected.bend}mm` : ''}）`
  };
}
function formatWallThicknessWarning(meta) {
  const matches = collectWallWarningMatches(meta);
  if(matches.length === 0) return '-';
  const values = [...new Set(matches.map(item => wallWarningValue(item).toFixed(2)))].sort((a, b) => Number(a) - Number(b));
  return values.length === 1 ? values[0] : `${values[0]}~${values[values.length - 1]}`;
}
function materialRuleForRow(item) {
  return Object.hasOwn(item, 'theoryMatched') ? item : materialTheoryForItem(item);
}
function extractAdditionalThickness(remark, kind) {
  const match = String(remark || '').match(new RegExp(`${kind}附加壁厚\\s*(/|\\d+(?:\\.\\d+)?)\\s*mm?`, 'i'));
  return match ? match[1] : '';
}
function materialCell(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}
const GENERATOR_WALL_OPTIONS = {
  WB: [['F000','F000 · 前墙'],['B000','B000 · 后墙'],['L000','L000 · 左墙（B侧）'],['R000','R000 · 右墙（A侧）']],
  LHD: [['F000','F000 · 前坡'],['B000','B000 · 后坡'],['L000','L000 · 左坡'],['R000','R000 · 右坡']]
};
function generatorMatrixRow(sys, comp) { return matrix.find(m => m.sys === sys && m.comp === comp) || null; }
function renderGeneratorFields() {
  const box = document.getElementById('generatorFields');
  if(!box) return;
  const sys = document.getElementById('f-system').value;
  const rule = CODE_SYSTEMS.find(item => item.sys === sys) || CODE_SYSTEMS[0];
  const compSelect = document.getElementById('f-comp');
  const comp = rule.comps.includes(compSelect?.value) ? compSelect.value : rule.comps[0];
  const row = generatorMatrixRow(rule.sys, comp);
  const dirOptions = letters => letters.map(l => `<option value="${l}">${l} · ${escapeHTML(CODE_DIR_LABELS[l] || l)}</option>`).join('');
  let html = '';
  if(row && row.special === 'rsq') {
    const corners = []; for(let c = row.corners[0]; c <= row.corners[1]; c += 1) corners.push(`<option value="${c}">J${c} · ${c}号角</option>`);
    html = `<div class="form-group"><label>角号</label><select id="f-corner">${corners.join('')}</select></div>
      <div class="form-group"><label>喷口层</label><select id="f-layer">${row.layers.map(l => `<option value="${l}">${l} 层</option>`).join('')}</select></div>
      <div class="form-group"><label>喷口序号</label><input type="number" id="f-nozzle" min="${row.nozzles[0]}" max="${row.nozzles[1]}" value="1" /></div>`;
  } else if(row && row.pos) {
    html = `<div class="form-group"><label>方位（墙/坡）</label><select id="f-pos">${(GENERATOR_WALL_OPTIONS[comp] || []).map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}</select></div>
      <div class="form-group"><label>管号方向</label><select id="f-dir">${dirOptions(row.fieldDirs ? [...row.fieldDirs, ...row.dirs] : row.dirs)}</select></div>
      <div class="form-group"><label>管号 (3位, ${row.fieldDirs ? '现场F/B总数待核；U/D参考1~' : '1~'}${row.tMax})</label><input type="number" id="f-tube" min="1" max="${row.fieldDirs ? 999 : row.tMax}" value="1" /></div>`;
  } else if(row) {
    const posNums = max => Array.from({length: max}, (_, i) => `<option value="${i + 1}">${m0pad(i + 1, 3)}</option>`).join('');
    html = `${row.spaces ? `<div class="form-group"><label>检修空间（低过/低再）</label><select id="f-space"><option value="">省略 · 默认第1空间</option>${Array.from({length: row.spaces[1] - row.spaces[0] + 1}, (_, i) => { const n = row.spaces[0] + i; return n === 1 ? '' : `<option value="${n}KJ">${n}KJ · 第${n}检修空间</option>`; }).join('')}</select></div>` : ''}
      <div class="form-group"><label>${row.pos2Letters ? '片号方位' : '排/屏号方位'}</label><select id="f-pos-letter">${dirOptions(row.posLetters)}</select></div>
      <div class="form-group"><label>${row.pos2Letters ? '片号 (3位, 1~' + row.pMax + ')' : '排/屏号 (3位, 1~' + row.pMax + ')'}</label><select id="f-pos-num">${posNums(row.pMax)}</select></div>
      ${row.pos2Letters ? `<div class="form-group"><label>小屏号方位</label><select id="f-pos2-letter">${dirOptions(row.pos2Letters)}</select></div>
      <div class="form-group"><label>小屏号 (3位, 1~${row.p2Max})</label><select id="f-pos2-num">${posNums(row.p2Max)}</select></div>` : ''}
      <div class="form-group"><label>管号方向</label><select id="f-dir">${dirOptions(row.fieldDirs ? [...row.fieldDirs, ...row.dirs] : row.dirs)}</select></div>
      <div class="form-group"><label>管号 (3位, ${row.fieldDirs ? '现场F/B总数待核；U/D参考1~' : '1~'}${row.tMax})</label><input type="number" id="f-tube" min="1" max="${row.fieldDirs ? 999 : row.tMax}" value="1" /></div>`;
  }
  html += `<div class="form-group"><label for="f-part-kind">检测部位</label><select id="f-part-kind"><option value="Q">Q · 管子</option><option value="W">W · 弯头</option></select></div><div class="form-group"><label>流水号 (同批次唯一)</label><input type="number" id="f-seq" min="1" max="999" value="1" /></div>`;
  box.innerHTML = html;
  box.querySelectorAll('select, input').forEach(el => el.addEventListener('input', genCode));
  if(compSelect) compSelect.value = comp;
  genCode();
}
function m0pad(n, len) { return String(n).padStart(len, '0'); }
function populateCodeGeneratorOptions() {
  const sysSelect = document.getElementById('f-system');
  const compSelect = document.getElementById('f-comp');
  if(!sysSelect) return;
  sysSelect.innerHTML = CODE_SYSTEMS.map(item => `<option value="${escapeHTML(item.sys)}">${escapeHTML(item.sys)} · ${escapeHTML(item.label)}</option>`).join('');
  function updateCompOptions() {
    const rule = CODE_SYSTEMS.find(item => item.sys === sysSelect.value) || CODE_SYSTEMS[0];
    if(compSelect) {
      compSelect.innerHTML = rule.comps.map(comp => `<option value="${escapeHTML(comp)}">${escapeHTML(comp)} · ${escapeHTML(COMPONENT_LABELS[comp] || comp)}</option>`).join('');
      compSelect.style.display = rule.comps.length > 1 ? '' : 'none';
    }
    renderGeneratorFields();
  }
  sysSelect.addEventListener('change', updateCompOptions);
  if(compSelect) compSelect.addEventListener('change', renderGeneratorFields);
  updateCompOptions();
}
function genCode() {
  const out = document.getElementById('codeOut');
  if(!out) return;
  const b = document.getElementById('f-boiler').value;
  const sys = document.getElementById('f-system').value;
  const compSelect = document.getElementById('f-comp');
  const comp = compSelect ? compSelect.value : 'GQ';
  const val = id => document.getElementById(id)?.value || '';
  const num = id => Math.max(1, Number(val(id) || 1));
  const seq = m0pad(num('f-seq'), 3);
  let body = '';
  if(sys === 'SLB' && comp === 'RSQ') {
    body = `J${val('f-corner')}-${val('f-layer')}${m0pad(num('f-nozzle'), 2)}`;
  } else if(sys === 'SLB') {
    body = `${val('f-pos')}-${val('f-dir')}${m0pad(num('f-tube'), 3)}`;
  } else if(sys === 'DPGRQ') {
    body = `${val('f-pos-letter')}${m0pad(num('f-pos-num'), 3)}-${val('f-pos2-letter')}${m0pad(num('f-pos2-num'), 3)}-${val('f-dir')}${m0pad(num('f-tube'), 3)}`;
  } else if(sys === 'DGRQ' || sys === 'DZRQ') {
    const space = val('f-space');
    body = `${space ? space + '-' : ''}${val('f-pos-letter')}${m0pad(num('f-pos-num'), 3)}-${val('f-dir')}${m0pad(num('f-tube'), 3)}`;
  } else {
    body = `${val('f-pos-letter')}${m0pad(num('f-pos-num'), 3)}-${val('f-dir')}${m0pad(num('f-tube'), 3)}`;
  }
  const partKind = val('f-part-kind') === 'W' ? 'W' : 'Q';
  const code = `${b}-${sys}-${comp}-${body}-${partKind}${seq}`;
  out.innerHTML = code.split('-').map(seg => `<span class="code-segment">${escapeHTML(seg)}</span>`).join('-');
  const matched = validateCodeAgainstMatrix(code);
  const desc = document.getElementById('codeDesc');
  const fieldPosition = window.BTAssistantCore?.validateTubeCode(code, matrix)?.fieldPosition;
  if(desc) desc.textContent = matched ? `${matched.row.name} · ${matched.row.spec}` : fieldPosition ? '现场管位编码有效；每屏总管数及与U/D管圈映射待核，保持原方向。' : '当前编号超出台账矩阵范围，请核对排/屏与管号编号。';
  window._curCode = code;
}
/* ========== 新编码规则 ==========
 * 模板：{机组}G-SYS-COMP-{方位}{三位排/片号}-{方位}{三位排/屏号}-{方向}{三位管号}-Q{序号}
 * 机组：1G/2G；系统：SLB/GZRQ/GGRQ/HPGRQ/DPGRQ/DGRQ/DZRQ/SMQ；部件：GQ/WB/SG/EXIN/EXOUT/LHD/RSQ
 * 方位/方向：A侧→R、B侧→L、炉左往右→L、炉右往左→R、炉前往后→F、炉后往前→B、下往上→D、上往下→U
 * 无明确排/屏号用 000 占位；无明确方向默认 U；低过/低再默认第 1 检修空间可省略 */
function parseTubeCode(code) {
  const raw = String(code || '').trim().toUpperCase();
  const head = raw.match(/^([12])G-(SLB|GZRQ|GGRQ|HPGRQ|DPGRQ|DGRQ|DZRQ|SMQ)-(GQ|WB|SG|EXIN|EXOUT|LHD|RSQ)(?:-(.*))?$/);
  if(!head) return null;
  const parsed = { raw, unit: head[1] + 'G', boiler: head[1], sys: head[2], comp: head[3], pos: null, posNum: null, pos2: null, pos2Num: null, space: null, corner: null, layer: '', nozzle: null, dir: null, tube: null, seq: null };
  const parts = head[4] ? head[4].split('-') : [];
  /* 尾段 Q=直管部位、W=弯头部位；同编号 Q/W 是同一根管的两个部位 */
  const tail = parts.length && /^[QW]\d{1,3}$/.test(parts[parts.length - 1]) ? parts.pop() : null;
  if(!tail) return null;
  parsed.seq = Number(tail.slice(1));
  parsed.partKind = tail[0];
  const POS_RE = /^([FBLR])(\d{3})$/;
  const TUBE_RE = /^(?:GGRQ|GZRQ)$/.test(parsed.sys) ? /^([FBUD])(\d{3})$/ : /^([UD])(\d{3})$/;
  const WALL_RE = /^([FBLR])000$/;
  if(parsed.sys === 'SLB' && (parsed.comp === 'WB' || parsed.comp === 'LHD')) {
    if(parts.length !== 2) return null;
    const pm = parts[0].match(WALL_RE), tm = parts[1].match(/^([FBLR])(\d{3})$/);
    if(!pm || !tm) return null;
    parsed.pos = parts[0]; parsed.posNum = 0;
    parsed.dir = tm[1]; parsed.tube = Number(tm[2]);
    return parsed;
  }
  if(parsed.sys === 'SLB' && parsed.comp === 'RSQ') {
    if(parts.length !== 2) return null;
    const cm = parts[0].match(/^J([1-9]\d?)$/), lm = parts[1].match(/^([A-Z])(\d{1,2})$/);
    if(!cm || !lm) return null;
    parsed.corner = Number(cm[1]); parsed.layer = lm[1]; parsed.nozzle = Number(lm[2]);
    return parsed;
  }
  if(parsed.sys === 'DPGRQ') {
    if(parts.length !== 3) return null;
    const p1 = parts[0].match(POS_RE), p2 = parts[1].match(POS_RE), tb = parts[2].match(TUBE_RE);
    if(!p1 || !p2 || !tb) return null;
    parsed.pos = parts[0]; parsed.posNum = Number(p1[2]);
    parsed.pos2 = parts[1]; parsed.pos2Num = Number(p2[2]);
    parsed.dir = tb[1]; parsed.tube = Number(tb[2]);
    return parsed;
  }
  if(['GGRQ','GZRQ','HPGRQ','SMQ'].includes(parsed.sys)) {
    if(parts.length !== 2) return null;
    const p1 = parts[0].match(POS_RE), tb = parts[1].match(TUBE_RE);
    if(!p1 || !tb) return null;
    parsed.pos = parts[0]; parsed.posNum = Number(p1[2]);
    parsed.dir = tb[1]; parsed.tube = Number(tb[2]);
    return parsed;
  }
  if(['DGRQ','DZRQ'].includes(parsed.sys)) {
    const rest = parts.slice();
    const sm = rest.length && /^([1-9]\d?)KJ$/.test(rest[0]) ? rest.shift().match(/^([1-9]\d?)KJ$/) : null;
    if(sm) parsed.space = Number(sm[1]);
    if(rest.length < 1 || rest.length > 2) return null;
    const p1 = rest[0].match(POS_RE);
    if(!p1) return null;
    parsed.pos = rest[0]; parsed.posNum = Number(p1[2]);
    if(rest.length === 2) {
      const tb = rest[1].match(TUBE_RE);
      if(!tb) return null;
      parsed.dir = tb[1]; parsed.tube = Number(tb[2]);
    } else if(parsed.sys !== 'DZRQ') return null;
    return parsed;
  }
  return null;
}
function isValidTubeCodeStructure(code) { return parseTubeCode(code) !== null; }
const inRange = (num, pair) => num >= pair[0] && num <= pair[1];
function matrixRowMatches(row, parsed) {
  if(row.sys !== parsed.sys || row.comp !== parsed.comp) return false;
  if(row.special === 'rsq') {
    return parsed.corner !== null && inRange(parsed.corner, row.corners) &&
      row.layers.includes(parsed.layer) && parsed.nozzle !== null && inRange(parsed.nozzle, row.nozzles);
  }
  if(row.pos) {
    if(parsed.pos !== row.pos) return false;
  } else {
    if(!parsed.pos || !row.posLetters.includes(parsed.pos[0]) || !inRange(parsed.posNum, [1, row.pMax])) return false;
    if(row.pos2Letters && (!parsed.pos2 || !row.pos2Letters.includes(parsed.pos2[0]) || !inRange(parsed.pos2Num, [1, row.p2Max]))) return false;
  }
  if(row.spaces) {
    if(parsed.space !== null && !inRange(parsed.space, row.spaces)) return false;
  } else if(parsed.space !== null) return false;
  if(parsed.dir !== null && parsed.tube !== null) {
    if(!row.dirs.includes(parsed.dir) || !inRange(parsed.tube, [1, row.tMax])) return false;
  } else if(!row.tubeOptional) return false;
  return true;
}
function matchComponentFromCode(code) {
  const parsed = parseTubeCode(code);
  if(!parsed) return null;
  return matrix.find(m => matrixRowMatches(m, parsed)) || matrix.find(m => m.sys === parsed.sys && m.comp === parsed.comp) || matrix.find(m => m.sys === parsed.sys) || null;
}
function validateCodeAgainstMatrix(code) {
  const parsed = parseTubeCode(code);
  if(!parsed) return null;
  const row = matrix.find(m => matrixRowMatches(m, parsed));
  return row ? { ...parsed, row } : null;
}
function validateCodeAgainstRules(code) {
  const parsed = parseTubeCode(code);
  if(!parsed) return null;
  const rule = CODE_SYSTEMS.find(item => item.sys === parsed.sys);
  if(!rule || !rule.comps.includes(parsed.comp)) return null;
  return { ...parsed, rule };
}
function classifyWarningLevel(text, status = '') {
  const value = `${text || ''} ${status || ''}`.toLowerCase();
  if(status === 'danger' || /爆管|泄漏|报废|更换|danger|high|蠕变损伤[6-9]\d|壁厚减薄至\s*[0-3]\.?[0-9]?/.test(value)) return 'HIGH';
  if(status === 'warn' || /warn|medium|预警|关注|减薄|腐蚀|蠕变|金相|裂纹|超标|发现异物|氧化皮|不合格/.test(value)) return 'MEDIUM';
  return 'INFO';
}
function warningClass(level) {
  return level === 'HIGH' ? 'alert-danger' : level === 'MEDIUM' ? 'alert-warn' : 'alert-info';
}
function collectRetiredTubeCodes() {
  const retiredCodes = new Set();
  userDB.replacements.forEach(r => { if(r.oldCode) retiredCodes.add(r.oldCode); });
  userDB.events.forEach(event => {
    if(/报废更换|更换为/.test(`${event.type || ''} ${event.desc || ''}`)) retiredCodes.add(event.code);
  });
  return retiredCodes;
}
function isRetiredTubeCode(code, retiredCodes = collectRetiredTubeCodes()) {
  return retiredCodes.has(code) || [...retiredCodes].some(retired => sameTubeMeasurement(retired, code) || parseTubeCode(retired)?.partKind === 'Q' && tubeVersionKey(retired) === tubeVersionKey(code));
}
const DASHBOARD_SURFACE_HEALTH = [
  { sys: 'SLB', name: '水冷壁', score: 88, unit1: 1, unit2: -1, meta: '磨损/腐蚀' },
  { sys: 'DGRQ', name: '低温过热器', score: 76, unit1: 2, unit2: -2, meta: '积灰/低温腐蚀' },
  { sys: 'DPGRQ', name: '全大屏过热器', score: 68, unit1: 1, unit2: -3, meta: '结渣/夹持管' },
  { sys: 'HPGRQ', name: '屏式过热器', score: 71, unit1: 2, unit2: -2, meta: '高温腐蚀' },
  { sys: 'GGRQ', name: '高温过热器', score: 58, unit1: 2, unit2: -5, meta: '蠕变/氧化皮' },
  { sys: 'GZRQ', name: '高温再热器', score: 52, unit1: 3, unit2: -6, meta: '减薄/烟温偏差' },
  { sys: 'SMQ', name: '省煤器', score: 82, unit1: 1, unit2: -2, meta: '冲刷/低温腐蚀' }
];
let dashboardUnit = localStorage.getItem('boiler_dashboard_unit') || 'all';
function codeMatchesDashboardUnit(code, unit = dashboardUnit) {
  if(unit === 'all') return true;
  return String(code || '').split('-')[0] === unit;
}
function getDashboardUnitLabel(unit = dashboardUnit) {
  return unit === 'all' ? '全厂' : `${unit}#机组`;
}
function getDashboardScopedWarnings(limit = 6) {
  return collectDashboardWarnings({ limit: 100 }).filter(item => codeMatchesDashboardUnit(item.code)).slice(0, limit);
}
function setDashboardUnit(unit) {
  dashboardUnit = ['1', '2'].includes(String(unit)) ? String(unit) : 'all';
  localStorage.setItem('boiler_dashboard_unit', dashboardUnit);
  document.querySelectorAll('#dashboard-unit-switch button').forEach(btn => btn.classList.toggle('active', btn.dataset.unit === dashboardUnit));
  syncDashboardSnapshot();
  renderDashboardWarnings();
}
function collectDashboardWarnings(options = {}) {
  const limit = Number(options.limit) || 6;
  const retiredCodes = collectRetiredTubeCodes();
  const systemWarnings = Object.entries(systemLifecycleData())
    .filter(([code]) => !isRetiredTubeCode(code, retiredCodes))
    .map(([code, item]) => {
      const level = classifyWarningLevel(item.risk, item.status);
      return { code, level, source: '系统寿命数据', text: `${item.name} · ${item.risk}`, sort: level === 'HIGH' ? 0 : level === 'MEDIUM' ? 1 : 2 };
    });
  const localWarnings = userDB.events
    .filter(event => !isRetiredTubeCode(event.code, retiredCodes))
    .map(event => {
      const level = classifyWarningLevel(`${event.type} ${event.desc}`, '');
      return { code: event.code, level, source: '本地录入', text: `${event.date} ${event.type} · ${event.desc}`, sort: level === 'HIGH' ? 0 : level === 'MEDIUM' ? 1 : 2, ts: event.ts || 0 };
    })
    .filter(item => item.level !== 'INFO' || /测厚|检验|评估|金相|蠕变|腐蚀|减薄/.test(item.text));
  const measuredWarnings = [...new Set(userDB.events.map(event => event.code))]
    .filter(code => !isRetiredTubeCode(code, retiredCodes))
    .map(code => {
      const history = extractThicknessData(code, { includeSystem: false });
      const current = history[history.length - 1];
      if(!current) return null;
      const info = resolveMaterialTheoryThickness(code, selectedTubePipeType(code));
      const warning = assessReplacementWarning(current.val, info);
      if(warning.level === 'normal') return null;
      const level = warning.level === 'replace' ? 'HIGH' : 'MEDIUM';
      return { code, level, source: '材料库理论厚度判定', sort: warning.level === 'replace' ? -2 : -1,
        text: `${warning.label} · 实测 ${current.val}mm · ${info.threshold === null ? info.reason : `采用${info.pipeType === 'bend' ? '弯管外侧' : '直管'} ${info.threshold}mm；裕量 ${warning.margin.toFixed(2)}mm`}` };
    }).filter(Boolean);
  const measuredCodes = new Set(measuredWarnings.map(item => item.code));
  return [...measuredWarnings, ...systemWarnings.filter(item => !measuredCodes.has(item.code)), ...localWarnings.filter(item => !measuredCodes.has(item.code))]
    .sort((a, b) => a.sort - b.sort || (b.ts || 0) - (a.ts || 0)).slice(0, limit);
}
function getDashboardSurfaceHealth(unit = dashboardUnit) {
  return DASHBOARD_SURFACE_HEALTH.map(item => {
    const delta = unit === '1' ? item.unit1 : unit === '2' ? item.unit2 : 0;
    return { ...item, score: Math.max(35, Math.min(96, item.score + delta)) };
  });
}
function getDashboardTrendStats(warnings = getDashboardScopedWarnings(100), unit = dashboardUnit) {
  const surfaces = getDashboardSurfaceHealth(unit);
  const avg = surfaces.reduce((sum, item) => sum + item.score, 0) / surfaces.length;
  const highCount = warnings.filter(item => item.level === 'HIGH').length;
  const mediumCount = warnings.filter(item => item.level === 'MEDIUM').length;
  const penalty = highCount * 1.8 + mediumCount * 0.8;
  const base = unit === '1' ? [74, 76, 79, 82] : unit === '2' ? [62, 64, 66, 69] : [68, 72, 76, 80];
  const series = base.map((value, index) => {
    const weighted = value * 0.7 + avg * 0.3 - penalty * (index === base.length - 1 ? 1 : 0.45);
    return Math.round(Math.max(45, Math.min(96, weighted)));
  });
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  return { current, previous, delta: current - previous, highCount, mediumCount, series, labels: unit === 'all' ? ['2020A修', '2022C修', '2024A修', '当前'] : unit === '1' ? ['2019A修', '2021C修', '2023A修', '当前'] : ['2020A修', '2022C修', '2024A修', '当前'] };
}
function buildDashboardTrendChart(stats = getDashboardTrendStats()) {
  const svg = document.getElementById('dashboardTrendChart');
  if(!svg) return;
  const values = stats.series;
  const labels = stats.labels || ['2018', '2020', '2022', '当前'];
  const width = 520, height = 284;
  const pad = { left: 38, right: 18, top: 22, bottom: 32 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const minVal = 45, maxVal = 95;
  const x = index => pad.left + (index / Math.max(1, values.length - 1)) * plotW;
  const y = value => pad.top + plotH - ((value - minVal) / (maxVal - minVal)) * plotH;
  const points = values.map((value, index) => [x(index), y(value), value]);
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${points[points.length - 1][0].toFixed(1)} ${pad.top + plotH} L ${points[0][0].toFixed(1)} ${pad.top + plotH} Z`;
  const grid = [50, 60, 70, 80, 90].map(value => {
    const yy = y(value);
    return `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" stroke="var(--chart-grid)" stroke-opacity="0.12" /><text x="${pad.left - 9}" y="${yy + 4}" text-anchor="end" fill="var(--chart-label)" font-size="10">${value}</text>`;
  }).join('');
  const labelEls = labels.map((label, index) => `<text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="var(--chart-label)" font-size="10">${label}</text>`).join('');
  const dots = points.map((point, index) => {
    const isLast = index === points.length - 1;
    return `<circle cx="${point[0]}" cy="${point[1]}" r="${isLast ? 5 : 3.6}" fill="${isLast ? 'var(--chart-dot-fill)' : 'var(--chart-accent)'}" stroke="var(--chart-accent-2)" stroke-width="${isLast ? 2.5 : 1.6}"${isLast ? ' filter="url(#dashboardTrendGlow)"' : ''}><title>${labels[index]} ${point[2]}%</title></circle>`;
  }).join('');
  svg.innerHTML = `<defs>
    <linearGradient id="dashboardTrendFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:var(--chart-accent)" stop-opacity="0.34" />
      <stop offset="70%" style="stop-color:var(--chart-accent)" stop-opacity="0.06" />
      <stop offset="100%" style="stop-color:var(--chart-accent)" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="dashboardTrendLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" style="stop-color:var(--chart-accent-2)" /><stop offset="100%" style="stop-color:var(--chart-accent-2)" />
    </linearGradient>
    <filter id="dashboardTrendGlow"><feGaussianBlur stdDeviation="2.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
  ${grid}
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="var(--chart-grid)" stroke-opacity="0.24" />
  <path d="${area}" fill="url(#dashboardTrendFill)" />
  <path d="${line}" fill="none" stroke="url(#dashboardTrendLine)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" filter="url(#dashboardTrendGlow)" />
  ${dots}
  ${labelEls}
  <text x="${pad.left}" y="16" fill="var(--chart-title)" font-size="12" font-weight="700">综合健康度趋势</text>
  <text x="${width - pad.right}" y="16" text-anchor="end" fill="${stats.delta >= 0 ? 'var(--chart-green)' : 'var(--chart-red)'}" font-size="12" font-weight="700">${stats.delta >= 0 ? '+' : ''}${stats.delta}%</text>
  <g id="dashboardTrendHover" opacity="0" pointer-events="none">
    <line y1="${pad.top}" y2="${pad.top + plotH}" stroke="var(--chart-hover-line)" stroke-width="1" stroke-dasharray="3 3" />
    <circle r="5" fill="var(--chart-dot-fill)" stroke="var(--chart-accent-2)" stroke-width="2" filter="url(#dashboardTrendGlow)" />
    <g id="dashboardTrendTip">
      <rect rx="5" ry="5" fill="var(--chart-tip-bg)" stroke="var(--chart-tip-stroke)" stroke-width="1" width="86" height="40" />
      <text id="dashboardTrendTipVal" x="43" y="18" text-anchor="middle" fill="var(--chart-tip-val)" font-size="15" font-weight="700"></text>
      <text id="dashboardTrendTipLbl" x="43" y="32" text-anchor="middle" fill="var(--chart-label)" font-size="10"></text>
    </g>
  </g>
  <rect id="dashboardTrendHit" x="0" y="0" width="${width}" height="${height}" fill="transparent" style="cursor:crosshair" />`;
  const hover = svg.querySelector('#dashboardTrendHover');
  const hit = svg.querySelector('#dashboardTrendHit');
  if(hover && hit) {
    const cross = hover.querySelector('line');
    const marker = hover.querySelector('circle');
    const tip = svg.querySelector('#dashboardTrendTip');
    const tipRect = tip.querySelector('rect');
    const tipVal = svg.querySelector('#dashboardTrendTipVal');
    const tipLbl = svg.querySelector('#dashboardTrendTipLbl');
    const tipW = 86, tipH = 40;
    const moveTo = (index) => {
      const px = points[index][0], py = points[index][1];
      cross.setAttribute('x1', px); cross.setAttribute('x2', px);
      marker.setAttribute('cx', px); marker.setAttribute('cy', py);
      tipVal.textContent = `${points[index][2]}%`;
      tipLbl.textContent = labels[index];
      let tx = px - tipW / 2;
      tx = Math.max(pad.left, Math.min(width - pad.right - tipW, tx));
      const ty = Math.max(2, py - tipH - 12);
      tipRect.setAttribute('x', tx); tipRect.setAttribute('y', ty);
      tipVal.setAttribute('x', tx + tipW / 2); tipVal.setAttribute('y', ty + 18);
      tipLbl.setAttribute('x', tx + tipW / 2); tipLbl.setAttribute('y', ty + 32);
      hover.setAttribute('opacity', '1');
    };
    const nearestIndex = (evt) => {
      const rect = svg.getBoundingClientRect();
      const vx = ((evt.clientX - rect.left) / rect.width) * width;
      let best = 0, bestD = Infinity;
      points.forEach((p, i) => { const d = Math.abs(p[0] - vx); if(d < bestD) { bestD = d; best = i; } });
      return best;
    };
    hit.addEventListener('mousemove', (evt) => moveTo(nearestIndex(evt)));
    hit.addEventListener('mouseleave', () => hover.setAttribute('opacity', '0'));
    hit.addEventListener('touchstart', (evt) => {
      if(evt.touches.length) moveTo(nearestIndex(evt.touches[0]));
    }, { passive: true });
    hit.addEventListener('touchmove', (evt) => {
      if(evt.touches.length) moveTo(nearestIndex(evt.touches[0]));
      evt.preventDefault();
    }, { passive: false });
    hit.addEventListener('touchend', () => setTimeout(() => hover.setAttribute('opacity', '0'), 1600));
  }
}
function renderDashboardSurfaceList() {
  const box = document.getElementById('dashboardSurfaceList');
  if(!box) return;
  const surfaces = getDashboardSurfaceHealth().sort((a, b) => a.score - b.score).slice(0, 5);
  box.innerHTML = surfaces.map(item => {
    const tone = item.score < 60 ? 'danger' : item.score < 75 ? 'warn' : 'ok';
    return `<button type="button" class="surface-item ${tone}" onclick="openComponentLifecycle('${escapeHTML(item.sys)}','${escapeHTML(item.name)}')">
      <span class="surface-name">${escapeHTML(item.name)} · ${escapeHTML(item.sys)}</span>
      <span class="surface-bar"><span style="width:${item.score}%"></span></span>
      <span class="surface-score">${item.score}%</span>
      <span class="surface-meta">${escapeHTML(item.meta)}</span>
    </button>`;
  }).join('');
}
function renderDashboardHealthCore(stats) {
  const ring = document.getElementById('dashboardHealthRing');
  const value = document.getElementById('dashboard-overall-health');
  const right = document.getElementById('dashboardCoreRightMetrics');
  if(!ring || !value || !right) return;
  const health = Math.max(0, Math.min(100, Number(stats.current) || 0));
  const tone = health < 60 ? 'var(--danger)' : health < 75 ? 'var(--warn)' : 'var(--ok)';
  ring.style.setProperty('--health-value', health);
  ring.style.setProperty('--health-color', tone);
  ring.setAttribute('aria-label', `综合健康度 ${health}%`);
  if(window.__healthRaf) cancelAnimationFrame(window.__healthRaf);
  const startVal = Number(value.dataset.raw) || 0;
  value.textContent = `${health}%`;
  value.dataset.raw = health;
  if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches && startVal !== health) {
    const startTime = performance.now();
    const duration = 900;
    const step = now => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      value.textContent = `${Math.round(startVal + (health - startVal) * eased)}%`;
      if(t >= 1) { value.textContent = `${health}%`; return; }
      window.__healthRaf = requestAnimationFrame(step);
    };
    window.__healthRaf = requestAnimationFrame(step);
  }
  right.style.display = 'contents';
  right.innerHTML = `<div class="health-side-metric hl" style="--metric-color:${stats.delta >= 0 ? 'var(--ok)' : 'var(--danger)'};grid-column:1;grid-row:1;align-self:center"><span>较上次检修</span><strong>${stats.delta >= 0 ? '+' : '-'}${stats.delta}%</strong></div><div class="health-side-metric" style="--metric-color:var(--ok);grid-column:3;grid-row:1;align-self:center"><span>生命周期闭环率</span><strong>83%</strong></div>`;
}
function syncDashboardSnapshot() {
  const updateTime = document.getElementById('dashboard-update-time');
  if(updateTime) updateTime.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  const unitLabel = getDashboardUnitLabel();
  const currentUnit = document.getElementById('dashboard-current-unit');
  if(currentUnit) currentUnit.textContent = unitLabel;
  const sourceSum = document.getElementById('dashboard-source-sum');
  if(sourceSum) sourceSum.textContent = dashboardUnit === 'all' ? '台账+检测+检修' : `${unitLabel} · 台账+检测+检修`;
  document.querySelectorAll('#dashboard-unit-switch button').forEach(btn => btn.classList.toggle('active', btn.dataset.unit === dashboardUnit));
  const scopedEvents = userDB.events.filter(event => codeMatchesDashboardUnit(event.code));
  const scopedReplacements = userDB.replacements.filter(item => codeMatchesDashboardUnit(item.oldCode) || codeMatchesDashboardUnit(item.newCode));
  const eventCount = document.getElementById('dq-event-count');
  if(eventCount) eventCount.textContent = `${scopedEvents.length} 条`;
  const replacementCount = document.getElementById('dq-replacement-count');
  if(replacementCount) replacementCount.textContent = `${scopedReplacements.length} 条`;
  const warnings = getDashboardScopedWarnings(100);
  const highCount = warnings.filter(item => item.level === 'HIGH').length;
  const mediumCount = warnings.filter(item => item.level === 'MEDIUM').length;
  const trendStats = getDashboardTrendStats(warnings);
  renderDashboardHealthCore(trendStats);
  const ledgerStats = tubeLedgerMatrixStats();
  const ledgerCount = dashboardUnit === 'all' ? ledgerStats.total * 2 : ledgerStats.total;
  const leftUnit = document.getElementById('dashboard-left-unit');
  if(leftUnit) leftUnit.textContent = unitLabel;
  const highEl = document.getElementById('dashboard-high-risk-count');
  if(highEl) highEl.textContent = highCount.toLocaleString();
  const warnEl = document.getElementById('dashboard-warn-risk-count');
  if(warnEl) warnEl.textContent = mediumCount.toLocaleString();
  const highKpi = document.getElementById('dashboard-high-risk-count-kpi');
  if(highKpi) highKpi.textContent = highCount.toLocaleString();
  const warnKpi = document.getElementById('dashboard-warn-risk-count-kpi');
  if(warnKpi) warnKpi.textContent = mediumCount.toLocaleString();
  const healthNote = document.getElementById('dashboard-overall-health-note');
  if(healthNote) healthNote.textContent = dashboardUnit === 'all' ? '全厂主要受热面综合口径' : `${unitLabel}主要受热面综合口径`;
  const deltaEl = document.getElementById('dashboard-overall-delta');
  if(deltaEl) {
    deltaEl.textContent = `${trendStats.delta >= 0 ? '+' : ''}${trendStats.delta}%`;
    deltaEl.style.color = trendStats.delta >= 0 ? 'var(--ok)' : 'var(--danger)';
  }
  const ledgerEl = document.getElementById('dashboard-ledger-count');
  if(ledgerEl) ledgerEl.textContent = ledgerCount.toLocaleString();
  const overhaulEl = document.getElementById('dashboard-next-overhaul');
  if(overhaulEl) {
    // 两台炉 A 级检修交替进行：2#机组 2027，1#机组 2028；全厂取最近节点
    const nextOverhaul = { '2': '2027 A修', '1': '2028 A修', 'all': '2027 A修 · 2#' };
    overhaulEl.textContent = nextOverhaul[dashboardUnit] || '2027 A修';
  }
  const ledgerNote = document.getElementById('dashboard-ledger-note');
  if(ledgerNote) ledgerNote.textContent = dashboardUnit === 'all' ? '全厂两台炉，按新编码规则（机组G-SYS-COMP-位置-Q流水号）覆盖全受热面' : `${unitLabel}，按新编码规则覆盖全受热面`;
  document.querySelectorAll('[data-dashboard-boiler]').forEach(item => {
    item.style.display = dashboardUnit === 'all' || item.dataset.dashboardBoiler === dashboardUnit ? '' : 'none';
  });
  buildDashboardTrendChart(trendStats);
  renderDashboardSurfaceList();
}
function renderDashboardWarnings() {
  const box = document.getElementById('dashboard-warning-list');
  if(!box) return;
  const warnings = getDashboardScopedWarnings(8);
  if(warnings.length === 0) {
    box.innerHTML = `<div class="command-warning alert-info"><strong>当前无预警</strong><span>${escapeHTML(getDashboardUnitLabel())}暂无需要优先关注的管段</span></div>`;
  } else {
    box.innerHTML = warnings.map(item => `<button type="button" class="command-warning ${warningClass(item.level)}" onclick="openTubeProfile('${escapeHTML(item.code)}')"><strong>${escapeHTML(item.code)}</strong><span>${escapeHTML(item.text)}</span></button>`).join('');
  }
  renderHeroTasks();
}
/* 待处置任务：优先由真实预警自动生成 Top3；无预警且演示数据开启时保留内置示例卡 */
function renderHeroTasks() {
  const host = document.querySelector('.hero-task-list');
  if(!host) return;
  const warnings = getDashboardScopedWarnings(99);
  if(warnings.length === 0) {
    if(!demoDataEnabled()) {
      host.innerHTML = `<div class="hero-task-item" style="cursor:default;"><div class="prio">✓</div><div><div class="title">暂无待处置任务</div><div class="meta">导入检测数据后将按预警自动生成</div></div></div>`;
    }
    return; /* 演示开启时保留 HTML 内置的三张示例卡 */
  }
  host.innerHTML = warnings.slice(0, 3).map((item, index) => {
    const prio = item.level === 'HIGH' ? 'P' + Math.min(1 + index, 3) : item.level === 'MEDIUM' ? 'P' + Math.min(2 + index, 3) : 'P3';
    const tone = item.level === 'HIGH' ? ' danger' : item.level === 'MEDIUM' ? ' warn' : '';
    const boiler = String(item.code || '')[0] === '2' ? '2' : '1';
    return `<button type="button" class="hero-task-item${tone}" data-dashboard-boiler="${boiler}" onclick="openTubeProfile('${escapeHTML(item.code)}')" title="打开管段档案 ${escapeHTML(item.code)}"><div class="prio">${prio}</div><div><div class="title">${escapeHTML(item.text)}</div><div class="meta">${escapeHTML(item.code)} · ${escapeHTML(item.source)}</div></div></button>`;
  }).join('');
  host.querySelectorAll('[data-dashboard-boiler]').forEach(item => {
    item.style.display = dashboardUnit === 'all' || item.dataset.dashboardBoiler === dashboardUnit ? '' : 'none';
  });
}
function formatDashboardWarningsForPrompt() {
  const warnings = getDashboardScopedWarnings();
  return warnings.length
    ? `${getDashboardUnitLabel()}视角：\n` + warnings.map(item => `[${item.level}] ${item.code} ${item.text} (${item.source})`).join('\n')
    : `${getDashboardUnitLabel()}当前未发现需要展示的预警。`;
}
function extractThicknessData(code, options = {}) {
  const includeSystem = options.includeSystem !== false;
  const timelineEvents = includeSystem ? (systemLifecycleData()[code]?.timeline || []).map(item => ({ code, type: item.t || '', date: item.date, desc: item.d || '', source: '系统寿命样例' })) : [];
  const localEvents = userDB.events.filter(e => sameTubeMeasurement(e.code, code)).map(e => ({ ...e, source: '本地录入' }));
  const data = [];
  [...timelineEvents, ...localEvents]
    .filter(e => sameTubeMeasurement(e.code, code) && isExactInspectionDate(e.date) && (positiveThickness(e.thickness) !== null || String(e.type).includes('测厚') || String(e.desc).includes('壁厚') || String(e.desc).includes('减薄')))
    .forEach(e => {
      const typedThickness = parseFloat(e.thickness);
      const match = String(e.desc).match(/(?:壁厚|减薄至|厚度)\s*[:：]?\s*(\d+\.?\d*)/i);
      const value = Number.isFinite(typedThickness) ? typedThickness : (match ? parseFloat(match[1]) : NaN);
      if (Number.isFinite(value) && value > 0 && Number.isFinite(new Date(e.date).getTime())) {
        const d = new Date(e.date);
        const year = d.getFullYear() + (d.getMonth() / 12);
        data.push({ year: parseFloat(year.toFixed(2)), val: value, dateStr: e.date, source: e.source });
      }
    });
  const byTime = new Map();
  data.forEach(point => { if(!byTime.has(point.year) || byTime.get(point.year).val > point.val) byTime.set(point.year, point); });
  return [...byTime.values()].sort((a,b) => a.year - b.year);
}

function switchView(viewId, { updateHash = true } = {}) {
  const target = document.getElementById('view-' + viewId);
  if(!target) return;
  const btn = document.querySelector(`.nav-btn[data-view="${viewId}"]`);
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v === target));
  const titleEl = document.getElementById('topbar-title');
  const VIEW_TITLES = { dashboard: '炉管风险驾驶舱', 'tube-analysis': '管段综合分析', 'maintenance-plan': '检修计划指挥', datamgr: '数据录入与管理', generator: '编码生成器', inventory: '全量管段台账', maintainlog: '维护记录', components: '受热面材料库', headers: '集箱库', diagram: '炉管分布图' };
  if(titleEl) titleEl.textContent = VIEW_TITLES[viewId] || (btn ? btn.querySelector('span')?.textContent : '') || titleEl.textContent;
  if(window.scrollY > 8) window.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.classList.remove('rail-open');
  if(btn) btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  if(viewId === 'maintainlog' && window.BTMaintenanceLog && typeof window.BTMaintenanceLog.render === 'function') window.BTMaintenanceLog.render();
  if(updateHash && location.hash !== '#view-' + viewId) history.replaceState(null, '', '#view-' + viewId);
}
function initNav() {
  const btns = [...document.querySelectorAll('.nav-btn')];
  btns.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
    btn.addEventListener('keydown', (e) => {
      if(e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = btns.indexOf(btn);
      const next = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      next.focus();
      switchView(next.dataset.view);
    });
  });
  const fromHash = (location.hash || '').replace('#view-', '');
  if(fromHash && document.getElementById('view-' + fromHash)) switchView(fromHash, { updateHash: false });
}
function toggleRail() {
  if (window.matchMedia('(min-width: 961px)').matches && document.body.classList.contains('rail-collapsed') && typeof window.toggleRailCollapse === 'function') {
    window.toggleRailCollapse();
    return;
  }
  document.body.classList.toggle('rail-open');
}

// 数字键 1-9 快速切换模块（焦点不在输入控件时生效）
document.addEventListener('keydown', (e) => {
  if(!/^[1-9]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
  const btns = [...document.querySelectorAll('.nav-btn')];
  const idx = Number(e.key) - 1;
  if(idx < btns.length && !btns[idx].classList.contains('active')) switchView(btns[idx].dataset.view);
});
function updateClock() { document.getElementById('clock').textContent = new Date().toLocaleTimeString('zh-CN', {hour12: false}); }
let clockTimer = setInterval(updateClock, 1000);
document.addEventListener('visibilitychange', () => {
  if(document.hidden) { clearInterval(clockTimer); clockTimer = null; }
  else if(!clockTimer) { updateClock(); clockTimer = setInterval(updateClock, 1000); }
});
updateClock();
function animateCounters() { document.querySelectorAll('[data-count]').forEach(el => { const target = parseInt(el.dataset.count); let cur = 0; const step = Math.max(1, Math.floor(target / 40)); const int = setInterval(() => { cur += step; if (cur >= target) { cur = target; clearInterval(int); } el.textContent = cur.toLocaleString(); }, 30); }); }
function buildBarChart() { const box = document.getElementById('barChart'); if(!box) return; const data = [{l:'水冷壁',sys:'SLB',v:722,c:'var(--ok)'},{l:'低过',sys:'DGRQ',v:1120,c:'var(--accent)'},{l:'大屏',sys:'DPGRQ',v:336,c:'var(--accent)'},{l:'屏过',sys:'HPGRQ',v:273,c:'var(--chart-orange)'},{l:'高过',sys:'GGRQ',v:384,c:'var(--danger)'},{l:'低再',sys:'DZRQ',v:1344,c:'var(--chart-violet)'},{l:'高再',sys:'GZRQ',v:448,c:'var(--chart-pink)'},{l:'省煤器',sys:'SMQ',v:124,c:'var(--ok)'}]; const max = Math.max(...data.map(d => d.v)); box.innerHTML = data.map(d => `<button type="button" class="bar-item" data-sys="${escapeHTML(d.sys)}" onclick="openComponentLifecycle('${escapeHTML(d.sys)}','${escapeHTML(d.l)}')" title="查看${escapeHTML(d.l)}检修记录"><div class="bar" data-val="${d.v}" style="height:${(d.v/max)*85}%; background:linear-gradient(180deg, ${d.c}, var(--chart-bar-base));"></div><div class="bar-label">${escapeHTML(d.l)}</div></button>`).join(''); }
function copyCode() { if(window._curCode) { navigator.clipboard?.writeText(window._curCode); showToast(`已复制编码：${window._curCode}`, 'ok'); } }

function getTubeProfileData(rawCode) {
  const code = normalizedTubeCode(rawCode);
  if(!code) return null;
  const localEvents = tubeEvidenceEvents(code)
    .sort((a,b) => String(a.date).localeCompare(String(b.date)));
  let d = systemLifecycleData()[code];
  let source = d ? 'system' : '';
  let badge = d ? 'badge-sh' : 'badge-ww';
  if(!d && localEvents.length > 0) {
    const compInfo = matchComponentFromCode(code);
    const latestEvent = localEvents[localEvents.length - 1];
    d = {
      name: compInfo ? compInfo.name : '动态录入管段',
      spec: compInfo ? compInfo.spec + ' · ' + compInfo.mat : '规格材质待完善',
      install: localEvents[0].date,
      hours: '--',
      status: 'ok',
      risk: `共 ${localEvents.length} 条记录，最新: ${latestEvent.date} ${latestEvent.type}`,
      timeline: []
    };
    source = 'local';
    badge = 'badge-ww';
  }
  if(!d) {
    const inventoryMatch = validateCodeAgainstMatrix(code);
    if(inventoryMatch) {
      const m = inventoryMatch.row;
      d = {
        name: m.name,
        spec: `${m.spec} · ${m.mat}`,
        install: '暂无记录',
        hours: '--',
        status: 'ok',
        risk: '管段存在，但暂无检测或寿命事件记录',
        timeline: []
      };
      source = 'inventory';
      badge = m.badge;
    }
  }
  if(!d) {
    const ruleMatch = validateCodeAgainstRules(code);
    if(ruleMatch) {
      d = {
        name: getSysLabel(ruleMatch.rule.sys),
        spec: `${ruleMatch.rule.sys} · ${COMPONENT_LABELS[ruleMatch.comp] || ruleMatch.comp}`,
        install: '暂无记录',
        hours: '--',
        status: 'ok',
        risk: '编码规则有效，但暂无台账矩阵映射或检测记录',
        timeline: []
      };
      source = 'rule';
      badge = 'badge-sh';
    }
  }
  if(!d) return null;
  const adverse = localEvents.some(e => /发现异物|氧化皮|裂纹|不合格|泄漏/.test(`${e.type || ''} ${e.desc || ''}`));
  if(adverse) d = { ...d, status: d.status === 'danger' ? 'danger' : 'warn', risk: '同管检测记录存在异常观察，请核实处置及复检闭环' };
  const localEvts = localEvents.map(e => ({date: e.date, t: e.type, d: `${escapeHTML(e.code)} · ${escapeHTML(e.desc)} <span style="color:var(--accent);font-size:10px;border:1px solid var(--accent);padding:1px 4px;border-radius:3px;">手工录入</span>`}));
  const timeline = [...(d.timeline || []), ...localEvts].sort((a,b) => new Date(a.date) - new Date(b.date));
  const thicknessData = extractThicknessData(code, { includeSystem: false });
  return { code, data: d, source, badge, timeline, thicknessData, localEvents };
}
function buildTubeProfileHTML(rawCode, options = {}) {
  const profile = getTubeProfileData(rawCode);
  if(!profile) return `<div class="alert alert-warn">未找到 ${escapeHTML(rawCode)} 的任何数据。</div>`;
  const { code, data: d, source, badge, timeline, thicknessData } = profile;
  const pipeType = options.pipeType ?? selectedTubePipeType(code);
  const thresholdInfo = resolveTubeTheoryThreshold(code, pipeType);
  const latestThickness = thicknessData[thicknessData.length - 1]?.val ?? null;
  const replacementWarning = assessReplacementWarning(latestThickness, thresholdInfo);
  const statusColor = replacementWarning.level === 'replace' ? 'var(--danger)' : replacementWarning.level === 'replace-soon' ? 'var(--warn)' : d.status==='ok'?'var(--ok)':d.status==='warn'?'var(--warn)':'var(--danger)';
  const sourceLabel = source === 'local' ? '本地录入' : source === 'inventory' ? '台账规则' : source === 'rule' ? '编码规则' : '系统演示';
  let miniChartSVG = '';
  let aiTrendEntry = `<div class="alert alert-info" style="margin-top:15px;"><div><strong>AI趋势分析待补充测厚数据</strong><br><span style="font-size:12px;color:var(--text-dim);">本地测厚记录不足 2 条，当前仅展示基础档案与寿命事件。</span></div></div>`;
  if (thicknessData.length >= 2) {
      const w = 400, h = 100, p = 20;
      const minY = Math.min(...thicknessData.map(d=>d.val)) * 0.95; const maxY = Math.max(...thicknessData.map(d=>d.val)) * 1.05;
      const minX = thicknessData[0].year; const maxX = thicknessData[thicknessData.length-1].year;
      const xS = x => p + ((x-minX)/(maxX-minX || 1)) * (w-2*p); const yS = y => h - p - ((y-minY)/(maxY-minY || 1)) * (h-2*p);
      let path = thicknessData.map((d,i) => `${i===0?'M':'L'} ${xS(d.year)} ${yS(d.val)}`).join(' ');
      miniChartSVG = `<svg class="mini-chart" viewBox="0 0 ${w} ${h}"><path d="${path}" fill="none" stroke="var(--chart-accent)" stroke-width="2"/><path d="${path} L ${xS(maxX)} ${h-p} L ${xS(minX)} ${h-p} Z" fill="var(--chart-accent-soft)"/>${thicknessData.map(d=>`<circle cx="${xS(d.year)}" cy="${yS(d.val)}" r="3" fill="var(--chart-accent)"/>`).join('')}</svg>`;
      const latestThickness = thicknessData[thicknessData.length - 1];
      aiTrendEntry = `<div class="alert alert-info" style="margin-top:15px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;"><div><strong>已具备AI趋势分析条件</strong><br><span style="font-size:12px;color:var(--text-dim);">本地测厚记录 ${thicknessData.length} 条，最新 ${escapeHTML(latestThickness.dateStr)} / ${latestThickness.val.toFixed(2)}mm</span></div><button class="btn btn-ai" onclick="analyzeTubeDetails('${escapeHTML(code)}')">查看预测曲线与模型判定</button></div>`;
  }
  const theoryHTML = `<div class="info-grid" style="margin-top:12px"><div class="info-item"><div class="k">名义壁厚</div><div class="v">${thresholdInfo.nominalWall ?? '--'} mm</div></div><div class="info-item"><div class="k">直管理论厚度</div><div class="v">${thresholdInfo.straight ?? '--'} mm</div></div><div class="info-item"><div class="k">弯管外侧理论厚度</div><div class="v">${thresholdInfo.bend ?? '--'} mm</div></div><div class="info-item"><div class="k">最终采用阈值</div><div class="v" style="color:${replacementWarning.level === 'normal' ? 'var(--ok)' : 'var(--danger)'}">${thresholdInfo.matched ? (thresholdInfo.pipeType === 'bend' ? '弯管外侧' : '直管') + ' ' + thresholdInfo.threshold + ' mm' : '未匹配材料库'}</div></div></div><div class="alert ${replacementWarning.level === 'normal' ? 'alert-info' : 'alert-warn'}" style="margin-top:12px"><strong>${replacementWarning.label}</strong>${replacementWarning.margin !== null ? `：当前 ${latestThickness}mm，距理论阈值 ${replacementWarning.margin.toFixed(2)}mm` : '：禁止输出寿命数字或误导性曲线'}</div>`;
  const profileAction = options.context === 'search' ? '' : `<button class="btn btn-outline" onclick="openTubeProfile('${escapeHTML(code)}')">打开一体化档案</button>`;
  const lifecycleAction = options.context === 'lifecycle' ? '' : `<button class="btn btn-outline" onclick="jumpLifecycle('${escapeHTML(code)}')">在寿命跟踪页打开</button>`;
  const actions = profileAction || lifecycleAction ? `<div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:15px;">${profileAction}${lifecycleAction}</div>` : '';
  const timelineHTML = timeline.length
    ? timeline.map(t => `<div class="tl-item"><div class="tl-date">${escapeHTML(t.date)}</div><div class="tl-title">${escapeHTML(t.t)}</div><div class="tl-desc">${t.d}</div></div>`).join('')
    : '<div class="alert alert-info">暂无寿命事件记录。可在“数据录入”补充测厚、检修或更换信息后形成完整趋势。</div>';
  return `<div class="tube-detail"><h3>${escapeHTML(code)} <span class="badge ${badge}" style="margin-left:10px;">${sourceLabel}</span></h3><div class="info-grid"><div class="info-item"><div class="k">名称/部件</div><div class="v">${escapeHTML(d.name)}</div></div><div class="info-item"><div class="k">规格材质</div><div class="v">${escapeHTML(d.spec)}</div></div><div class="info-item"><div class="k">首次记录/投运</div><div class="v">${escapeHTML(d.install)}</div></div><div class="info-item"><div class="k">状态/风险</div><div class="v" style="color:${statusColor}; font-size:12px;">${escapeHTML(d.risk)}</div></div></div>${theoryHTML}${miniChartSVG}${aiTrendEntry}${actions}</div><div class="card"><div class="card-title">全寿命事件时间线 (共 ${timeline.length} 条)</div><div class="timeline">${timelineHTML}</div></div>`;
}
function openTubeProfile(code) {
  document.querySelector('[data-view="tube-analysis"]').click();
  document.getElementById('lcCustomCode').value = code;
  document.getElementById('searchResult').innerHTML = buildTubeProfileHTML(code, { context: 'search' });
  analyzeTubeDetails(code);
}
function doSearch() {
  const q = document.getElementById('lcCustomCode').value.trim().toUpperCase();
  const res = document.getElementById('searchResult');
  if(!q) { res.innerHTML = '<div class="alert alert-info">请输入管码关键词进行查询</div>'; return; }
  let matches = []; let matchedCodes = new Set();
  Object.keys(systemLifecycleData()).forEach(k => { if(k.includes(q)) { matches.push({code:k, data:systemLifecycleData()[k], source: 'system'}); matchedCodes.add(k); } });
  userDB.events.forEach(e => {
    if(e.code.includes(q) && !matchedCodes.has(e.code)) {
        const profile = getTubeProfileData(e.code);
        matches.push({ code: e.code, data: profile.data, source: profile.source });
        matchedCodes.add(e.code);
    }
  });
  if(matches.length === 1 && matches[0].code === q) {
      res.innerHTML = buildTubeProfileHTML(q, { context: 'search' });
      analyzeTubeDetails(q);
      return;
  }
  if(matches.length === 0) {
      const profile = getTubeProfileData(q);
      if(profile) {
        res.innerHTML = buildTubeProfileHTML(q, { context: 'search' });
        analyzeTubeDetails(q);
        return;
      }
      let compInfo = matchComponentFromCode(q);
      if(compInfo) { res.innerHTML = `<div class="alert alert-info">找到部件 <strong>${escapeHTML(compInfo.name)} (${escapeHTML(compInfo.sys)})</strong>，但该管码暂无检测/录入记录。</div>`; return; }
      res.innerHTML = `<div class="alert alert-warn">未找到与 "${escapeHTML(q)}" 匹配的管码或部件记录</div>`; return; 
  }
  res.innerHTML = matches.map(m => {
    const d = m.data; const statusColor = d.status==='ok'?'var(--ok)':d.status==='warn'?'var(--warn)':'var(--danger)';
    const sourceBadge = m.source === 'local' ? '<span class="badge badge-ww" style="margin-left:10px;">本地录入</span>' : '<span class="badge badge-sh" style="margin-left:10px;">系统演示</span>';
    return `<div class="tube-detail"><h3>${escapeHTML(m.code)} ${sourceBadge}</h3><div class="info-grid"><div class="info-item"><div class="k">名称/部件</div><div class="v">${escapeHTML(d.name)}</div></div><div class="info-item"><div class="k">规格/材质</div><div class="v">${escapeHTML(d.spec)}</div></div><div class="info-item"><div class="k">首次记录/投运</div><div class="v">${escapeHTML(d.install)}</div></div><div class="info-item"><div class="k">状态/风险</div><div class="v" style="color:${statusColor}; font-size:12px;">${escapeHTML(d.risk)}</div></div></div><div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:15px;"><button class="btn" onclick="openTubeProfile('${escapeHTML(m.code)}')">打开一体化档案</button><button class="btn btn-outline" onclick="jumpLifecycle('${escapeHTML(m.code)}')">查看寿命页</button></div></div>`;
  }).join('');
}
function jumpLifecycle(code) { document.querySelector('[data-view="tube-analysis"]').click(); document.getElementById('lcCustomCode').value = code; loadLifecycle(code); }
function openAITrendFromLifecycle(code) {
  document.querySelector('[data-view="tube-analysis"]').click();
  populateAIThicknessTargets();
  const input = document.getElementById('ai-custom-target');
  if(input) input.value = code;
  runAIAnalysis(code);
}
function getCodeSystem(code) {
  const parts = String(code || '').toUpperCase().split('-');
  return parts.length >= 2 ? parts[1] : '';
}
function getCodeBoiler(code) {
  const match = String(code || '').trim().toUpperCase().match(/^([12])G-/);
  return match ? match[1] : '';
}
function openComponentLifecycle(sys, label) {
  document.querySelector('[data-view="tube-analysis"]').click();
  document.getElementById('searchResult').innerHTML = `<div class="alert alert-info"><div>ℹ</div><div>当前显示 ${escapeHTML(label || getSysLabel(sys))} 汇总；本模块的寿命档案输入框和下方全受热面管段查询仍支持全部受热面，不限于当前部件。</div></div>`;
  document.getElementById('lcCustomCode').value = '';
  loadComponentLifecycle(sys, label, 'all');
}
function loadComponentLifecycle(sys, label, boilerFilter = 'all', surfaceFilter = null) {
  const normalizedSys = String(sys || '').toUpperCase();
  const selectedSys = surfaceFilter === 'all' ? 'all' : String(surfaceFilter || normalizedSys).toUpperCase();
  const title = selectedSys === 'all' ? '全部受热面' : (CODE_SYSTEMS.find(item => item.sys === selectedSys)?.label || label || getSysLabel(selectedSys));
  const systemExamples = Object.entries(systemLifecycleData())
    .filter(([code]) => selectedSys === 'all' || getCodeSystem(code) === selectedSys)
    .map(([code, item]) => ({ code, boiler: getCodeBoiler(code), date: item.install, type: '系统样例', desc: item.risk, source: item.name }));
  const localEvents = userDB.events
    .filter(e => selectedSys === 'all' || getCodeSystem(e.code) === selectedSys)
    .map(e => ({ code: e.code, boiler: getCodeBoiler(e.code), date: e.date, type: e.type, desc: e.desc, source: '本地录入' }));
  const replacementEvents = userDB.replacements
    .filter(r => selectedSys === 'all' || getCodeSystem(r.oldCode) === selectedSys || getCodeSystem(r.newCode) === selectedSys)
    .map(r => ({ code: r.oldCode, boiler: getCodeBoiler(r.oldCode) || getCodeBoiler(r.newCode), date: r.date, type: '管段更换', desc: `${r.oldCode} → ${r.newCode}；${r.reason}`, source: '更换登记' }));
  const records = [...systemExamples, ...localEvents, ...replacementEvents].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const filteredRecords = records.filter(r => boilerFilter === 'all' || r.boiler === boilerFilter);
  const materialRows = getMaterialLibrary().filter(item => selectedSys === 'all' || item.sys === selectedSys);
  const filterOptions = [{value:'all', label:'全部'}, {value:'1', label:'1号炉'}, {value:'2', label:'2号炉'}];
  const boilerFilterTabs = filterOptions.map(option => `<button class="llm-view-tab ${boilerFilter === option.value ? 'active' : ''}" onclick="loadComponentLifecycle('${escapeHTML(normalizedSys)}','${escapeHTML(label || getSysLabel(normalizedSys))}','${escapeHTML(option.value)}','${escapeHTML(selectedSys)}')">${escapeHTML(option.label)}</button>`).join('');
  const surfaceOptions = [{ value: 'all', label: '全部受热面' }, ...CODE_SYSTEMS.map(item => ({ value: item.sys, label: item.label }))];
  const surfaceFilterTabs = surfaceOptions.map(option => `<button class="llm-view-tab ${selectedSys === option.value ? 'active' : ''}" onclick="loadComponentLifecycle('${escapeHTML(normalizedSys)}','${escapeHTML(label || getSysLabel(normalizedSys))}','${escapeHTML(boilerFilter)}','${escapeHTML(option.value)}')">${escapeHTML(option.label)}</button>`).join('');
  const recordRows = filteredRecords.map(r => `
    <tr>
      <td>${escapeHTML(r.date || '-')}</td>
      <td>${escapeHTML(r.boiler ? r.boiler + '号炉' : '-')}</td>
      <td style="color:var(--accent); font-family:'Consolas',monospace;">${escapeHTML(r.code || '-')}</td>
      <td><span class="badge badge-sh">${escapeHTML(r.type || '-')}</span></td>
      <td style="font-family:inherit; white-space:normal; min-width:260px;">${escapeHTML(r.desc || '')}</td>
      <td>${escapeHTML(r.source || '')}</td>
      <td>${r.code ? `<button class="btn btn-outline" style="padding:2px 8px; font-size:11px;" onclick="jumpLifecycle('${escapeHTML(r.code)}')">时间线</button>` : ''}</td>
    </tr>`).join('');
  const materialSummary = materialRows.map(item => {
    const rule = materialRuleForRow(item);
    return `
    <tr>
      <td style="font-family:inherit">${escapeHTML(materialCell(item.component || getSysLabel(item.sys)))}</td>
      <td>${escapeHTML(materialCell(item.categoryNo))}</td>
      <td style="font-family:inherit">${escapeHTML(item.sampleName || item.position)}</td>
      <td>${escapeHTML(materialCell(item.diameter))}</td>
      <td>${escapeHTML(materialCell(item.wallThickness))}</td>
      <td style="font-family:inherit">${escapeHTML(materialCell(item.material))}</td>
      <td>${escapeHTML(materialCell(rule.straight))}</td>
      <td>${escapeHTML(materialCell(rule.bend))}</td>
      <td>${escapeHTML(materialCell(item.spec))}</td>
      <td>${escapeHTML(materialCell(item.totalLengthM))}</td>
      <td style="font-family:inherit; min-width:220px; white-space:normal;">${escapeHTML(materialCell(item.remark))}</td>
    </tr>`;
  }).join('');
  document.getElementById('lcContent').innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHTML(title)} 检修/检测记录汇总</div>
      <div class="info-grid">
        <div class="info-item"><div class="k">系统代码</div><div class="v">${escapeHTML(selectedSys === 'all' ? 'ALL' : selectedSys)}</div></div>
        <div class="info-item"><div class="k">关联记录</div><div class="v">${filteredRecords.length}/${records.length} 条</div></div>
        <div class="info-item"><div class="k">材料条目</div><div class="v">${materialRows.length} 条</div></div>
        <div class="info-item"><div class="k">数据来源</div><div class="v">样例 + 本地录入</div></div>
      </div>
      <div class="alert alert-info" style="margin-top:15px;"><div>ℹ</div><div>当前卡片是 ${escapeHTML(title)} 汇总视角，不会限制查询范围；可在这里继续查询全部受热面任意管段。</div></div>
      <div class="search-box" style="margin-top:15px;">
        <input type="text" id="componentGlobalSearchInput" placeholder="全受热面管段查询：输入任意系统管码，例如 2G-SLB-WB-F000-R025-Q16" onkeypress="if(event.key==='Enter')openTubeProfile(this.value.trim().toUpperCase())" />
        <button class="btn" onclick="openTubeProfile(document.getElementById('componentGlobalSearchInput').value.trim().toUpperCase())">全受热面查询</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">检修/检测记录</div>
      <div style="font-size:11px;color:var(--text-dim);letter-spacing:1px;margin-bottom:6px;">炉号筛选</div>
      <div class="llm-view-tabs" id="componentBoilerFilter">${boilerFilterTabs}</div>
      <div style="font-size:11px;color:var(--text-dim);letter-spacing:1px;margin:12px 0 6px;">受热面筛选</div>
      <div class="llm-view-tabs" id="componentSurfaceFilter">${surfaceFilterTabs}</div>
      <div class="table-wrap"><table><thead><tr><th>日期</th><th>炉号</th><th>管段编码</th><th>类型</th><th>记录/结论</th><th>来源</th><th>操作</th></tr></thead><tbody>${recordRows || '<tr><td colspan="7" style="text-align:center; padding:20px;">当前炉号下暂无检修/检测记录。可在“数据录入”中按管段编码补录。</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-title">对应受热面管材</div>
      <div class="table-wrap"><table><thead><tr><th>受热面</th><th>序号</th><th>名称</th><th>外径(mm)</th><th>取用壁厚(mm)</th><th>材料</th><th>直管理论计算厚度(mm)</th><th>弯管外侧理论计算厚度(mm)</th><th>规格型号</th><th>库存总长度(m)</th><th>备注</th></tr></thead><tbody>${materialSummary || '<tr><td colspan="11" style="text-align:center; padding:20px;">暂无材料库记录。</td></tr>'}</tbody></table></div>
    </div>`;
}

document.querySelectorAll('.comp-tab').forEach(tab => { tab.addEventListener('click', () => { document.querySelectorAll('.comp-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); renderComponent(tab.dataset.comp); }); });
function materialKey(item) { return [item.component, item.position, item.spec, item.material].map(v => String(v || '').trim()).join('|'); }
const MATERIAL_CLASSIFICATION_RULES = [
  { sys:'SMQ', start:1, end:3 },
  { sys:'SLB', nums:[4, 6] },
  { sys:'RSH', nums:[5, 7] },
  { sys:'WSH', start:8, end:10 },
  { sys:'DGRQ', start:11, end:14 },
  { sys:'DPGRQ', start:15, end:16 },
  { sys:'HPGRQ', start:17, end:23 },
  { sys:'GGRQ', start:24, end:31 },
  { sys:'GZRQ', start:32, end:39 },
  { sys:'DZRQ', start:40, end:44 }
];
function materialSampleNo(item) {
  const remarkNo = String(item.remark || '').match(/序号\s*(\d+)/);
  if(remarkNo) return Number(remarkNo[1]);
  const positionNo = String(item.position || '').match(/^\s*(\d+)/);
  return positionNo ? Number(positionNo[1]) : null;
}
function materialLocalNo(item) {
  const no = materialSampleNo(item);
  if(!no) return null;
  const sys = String(item.sys || '').toUpperCase();
  const rule = MATERIAL_CLASSIFICATION_RULES.find(rule => rule.sys === sys && (
    rule.nums ? rule.nums.includes(no) : no >= rule.start && no <= rule.end
  ));
  if(!rule) {
    const localRule = MATERIAL_CLASSIFICATION_RULES.find(rule => rule.sys === sys);
    const maxLocalNo = localRule?.nums ? localRule.nums.length : (localRule?.end - localRule?.start + 1);
    return maxLocalNo && no >= 1 && no <= maxLocalNo ? no : null;
  }
  return rule.nums ? rule.nums.indexOf(no) + 1 : no - rule.start + 1;
}
function stripMaterialPositionNumber(position) {
  return String(position || '').replace(/^\s*\d+\s*/, '').trim();
}
function classifyMaterialRow(item) {
  const categoryNo = materialLocalNo(item);
  const sampleNo = materialSampleNo(item);
  const sampleName = stripMaterialPositionNumber(item.position);
  return {
    ...item,
    sampleNo,
    categoryNo,
    sampleName,
    position: categoryNo ? `${categoryNo} ${sampleName}` : sampleName
  };
}
function parseSpecSize(spec) {
  const text = String(spec || '').trim();
  const match = text.match(/[Φφ]?\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
  if(match) return { diameter: match[1], wallThickness: match[2] };
  const diameterOnly = text.match(/[Φφ]\s*(\d+(?:\.\d+)?)/);
  return diameterOnly ? { diameter: diameterOnly[1], wallThickness: '' } : {};
}
function splitSpecPart(part) {
  const text = String(part || '').trim();
  if(!text) return [];
  const wallVariant = text.match(/^([Φφ]?\s*\d+(?:\.\d+)?\s*[×xX*]\s*)(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)+)$/);
  if(wallVariant) {
    return wallVariant[2].split(/\s*\/\s*/).map(wall => `${wallVariant[1].trim()}${wall}`.trim());
  }
  if(text.includes('/')) {
    const parts = text.split(/\s*\/\s*/).map(value => value.trim()).filter(Boolean);
    if(parts.length > 1 && parts.every(value => /[Φφ]?\s*\d/.test(value))) return parts;
  }
  return [text];
}
function splitMaterialSpecRows(items) {
  const splitRows = [];
  items.forEach(item => {
    const parts = String(item.spec || '').split(/[、，,；;\n]+/).flatMap(splitSpecPart).filter(Boolean);
    const specs = parts.length ? [...new Set(parts)] : [item.spec || ''];
    specs.forEach(spec => {
      const size = parseSpecSize(spec);
      splitRows.push(classifyMaterialRow({
        ...item,
        spec,
        diameter: size.diameter || item.diameter || '',
        wallThickness: size.wallThickness || item.wallThickness || ''
      }));
    });
  });
  const uniqueRows = new Map();
  splitRows.forEach(item => uniqueRows.set(materialKey(item), item));
  return [...uniqueRows.values()];
}
function isLegacyMaterialRow(item) {
  const key = [item.component, item.position, item.shape].map(v => String(v || '').trim()).join('|');
  return [
    '包墙过热器|包墙过热器|直管',
    '低温过热器|水平段|蛇形管',
    '低温过热器|垂直段|蛇形管',
    '全大屏过热器|备件库存|U形管',
    '屏式过热器|屏式管屏|U形管',
    '高温过热器|高过管屏|U形管/包扎管',
    '低温再热器|水平段|蛇形管',
    '低温再热器|垂直段|蛇形管',
    '高温再热器|高再管屏|U形管',
    '省煤器|省煤器管束|蛇形管'
  ].includes(key);
}
function positiveThickness(value) {
  if(value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function materialTheoryForItem(item) {
  const size = parseSpecSize(item.spec);
  const diameter = positiveThickness(item.diameter || size.diameter);
  const nominalWall = positiveThickness(item.wallThickness || size.wallThickness);
  const materials = materialAliases(item.material);
  const matches = WALL_THICKNESS_WARNING_RULES.filter(rule =>
    rule.sys === item.sys && Number(rule.diameter) === diameter && Number(rule.wall) === nominalWall &&
    materials.length === 1 && materialAliases(rule.material).includes(materials[0]));
  const rule = matches.length === 1 ? matches[0] : null;
  return { ...item, nominalWall, straight: positiveThickness(rule?.straight), bend: positiveThickness(rule?.bend),
    theoryMatched: Boolean(rule), theoryRule: rule, theoryZone: rule?.zone || '',
    pressure: rule?.pressure ?? null, temperature: rule?.temperature ?? null, bendRadius: rule?.bendRadius ?? null };
}
function getMaterialLibrary() {
  const saved = JSON.parse(localStorage.getItem(MATERIAL_LIBRARY_KEY) || '[]');
  const merged = new Map();
  MATERIAL_LIBRARY.forEach(item => merged.set(materialKey(item), item));
  const standardBySampleNo = new Map(MATERIAL_LIBRARY.map(item => [`${item.sys}|${materialSampleNo(item)}`, item]));
  saved.filter(item => !isLegacyMaterialRow(item)).forEach(item => {
    const standard = standardBySampleNo.get(`${String(item.sys || '').toUpperCase()}|${materialSampleNo(item)}`);
    if(standard) {
      /* 页面编辑过的行（_edited）按用户修改全量覆盖标准行；CSV 导入的旧行只回读库存三字段 */
      merged.set(materialKey(standard), item._edited
        ? { ...standard, ...item }
        : {
            ...standard,
            stockQty: item.stockQty || standard.stockQty || '',
            totalLengthM: item.totalLengthM || standard.totalLengthM || '',
            reserveLocation: item.reserveLocation || standard.reserveLocation || ''
          });
      return;
    }
    merged.set(materialKey(item), { stockQty:'', totalLengthM:'', reserveLocation:'', remark:'', ...item });
  });
  return splitMaterialSpecRows([...merged.values()]).map(materialTheoryForItem);
}
function saveMaterialLibrary(items, options = {}) {
  const beforeRows = getMaterialLibrary();
  localStorage.setItem(MATERIAL_LIBRARY_KEY, JSON.stringify(items));
  queueCloudStorageSave(MATERIAL_LIBRARY_KEY, items);
  const active = document.querySelector('.comp-tab.active')?.dataset.comp || 'ww';
  renderMaterialLibrary(active);
  try {
    const beforeMap = new Map(beforeRows.map(item => [materialKey(item), item]));
    const afterMap = new Map((Array.isArray(items) ? items : []).map(item => [materialKey(item), item]));
    let added = 0, updated = 0, removed = 0, sample = '';
    afterMap.forEach((item, key) => {
      if(!beforeMap.has(key)) { added++; if(!sample) sample = item.component || ''; }
      else if(JSON.stringify(beforeMap.get(key)) !== JSON.stringify(item)) updated++;
    });
    beforeMap.forEach((item, key) => { if(!afterMap.has(key)) removed++; });
    if(added || updated || removed) {
      mlog(options.reason === 'import' ? 'import' : 'material', {
        dataset: 'material_library',
        stats: { added, updated, removed },
        added, updated, removed, sample,
        fileName: options.fileName || '',
        reason: options.reason || ''
      });
    }
  } catch(err) { console.warn('[维护记录] 材料库差异计算失败：', err); }
}
function materialRowToCSV(item) {
  return [
    item.component, item.sys, item.position, item.shape, item.spec, item.diameter, item.wallThickness,
    item.material, item.stockQty, item.totalLengthM, item.reserveLocation, item.remark
  ].map(csvEscape).join(',');
}
function materialCSVToItem(cols) {
  const oldFormat = cols.length >= 13;
  const remarkIndex = oldFormat ? 12 : 11;
  return {
    component: (cols[0] || '').trim(),
    sys: (cols[1] || '').trim().toUpperCase(),
    position: (cols[2] || '').trim(),
    shape: (cols[3] || '').trim(),
    spec: (cols[4] || '').trim(),
    diameter: (cols[5] || '').trim(),
    wallThickness: (cols[6] || '').trim(),
    material: (cols[7] || '').trim(),
    inUseQty: oldFormat ? (cols[8] || '').trim() : '',
    stockQty: (cols[oldFormat ? 9 : 8] || '').trim(),
    totalLengthM: (cols[oldFormat ? 10 : 9] || '').trim(),
    reserveLocation: (cols[oldFormat ? 11 : 10] || '').trim(),
    remark: (cols[remarkIndex] || '').trim()
  };
}
function downloadMaterialCSVTemplate() {
  const header = '\uFEFF' + MATERIAL_COLUMNS.join(',');
  const examples = getMaterialLibrary().slice(0, 6).map(materialRowToCSV).join('\n');
  downloadBlob('受热面材料库_维护模板.csv', `${header}\n${examples}`, 'text/csv;charset=utf-8;');
}
function exportMaterialCSV() {
  const header = '\uFEFF' + MATERIAL_COLUMNS.join(',');
  const rows = getMaterialLibrary().map(materialRowToCSV).join('\n');
  downloadBlob(`受热面材料库_${new Date().toISOString().slice(0,10)}.csv`, `${header}\n${rows}`, 'text/csv;charset=utf-8;');
}
function importMaterialRows(rawRows, options = {}) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const stats = { imported: 0, errors: [] };
  if(rows.length < 2) { stats.errors.push('材料库 CSV 文件为空'); return stats; }
  const merged = new Map(getMaterialLibrary().map(item => [materialKey(item), item]));
  for(let i = 1; i < rows.length; i++) {
    const cols = (Array.isArray(rows[i]) ? rows[i] : []).map(item => String(item ?? ''));
    if(cols.every(cell => cell.trim() === '')) continue;
    const item = materialCSVToItem(cols);
    if(!item.component || !item.spec || !item.material) continue;
    merged.set(materialKey(item), item);
    stats.imported++;
  }
  saveMaterialLibrary([...merged.values()], { reason: 'import', fileName: options.fileName || '' });
  return stats;
}

function importMaterialCSV(event) {
  const file = event.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const lines = e.target.result.split(/\r?\n/).filter(line => line.trim() !== '');
      if(lines.length < 2) { showToast('材料库 CSV 文件为空', 'warn'); return; }
      const result = importMaterialRows(lines.map(parseCSVLine), { fileName: file.name });
      showToast(`材料库导入完成，更新/新增 ${result.imported} 条记录`, 'ok');
    } catch (err) {
      console.error(err);
      showToast('材料库 CSV 解析失败，请检查文件格式。', 'error');
    }
  };
  reader.readAsText(file, 'UTF-8'); event.target.value = '';
}
function openEditMaterialStock(encodedKey) {
  if(getAssistantRole() === 'viewer') { showToast('当前为只读账号，不能修改材料记录。', 'warn'); return; }
  const key = decodeURIComponent(encodedKey);
  const library = getMaterialLibrary();
  const index = library.findIndex(item => materialKey(item) === key);
  if(index < 0) { showToast('没有找到这条材料记录，可能已被重新导入覆盖。', 'warn'); return; }
  const item = library[index];
  openDataEditModal(`
    <div class="data-edit-panel" role="dialog" aria-modal="true" aria-labelledby="materialStockTitle">
      <div class="data-edit-head">
        <h3 id="materialStockTitle">编辑材料记录</h3>
        <button type="button" class="data-edit-close" onclick="closeDataEditModal()" aria-label="关闭">×</button>
      </div>
      <p class="data-edit-sub">${escapeHTML(item.component || '')} · ${escapeHTML(item.position || '')} · ${escapeHTML(item.spec || '')}</p>
      <div class="form-group"><label>部件名称</label><input type="text" id="ms-component" value="${escapeHTML(String(item.component ?? ''))}" /></div>
      <div class="form-group"><label>系统代码</label><input type="text" id="ms-sys" list="ms-sys-options" value="${escapeHTML(String(item.sys ?? ''))}" /><datalist id="ms-sys-options">${ALL_CODE_SYSTEMS.map(s => `<option value="${escapeHTML(s.sys)}">${escapeHTML(s.sys)} · ${escapeHTML(s.label)}</option>`).join('')}</datalist></div>
      <div class="form-group"><label>分段/位置（保留开头序号）</label><input type="text" id="ms-position" value="${escapeHTML(String(item.position ?? ''))}" /></div>
      <div class="form-group"><label>结构形式</label><input type="text" id="ms-shape" value="${escapeHTML(String(item.shape ?? ''))}" placeholder="例: 直管 / 蛇形管 / U形管" /></div>
      <div class="form-group"><label>规格型号</label><input type="text" id="ms-spec" value="${escapeHTML(String(item.spec ?? ''))}" placeholder="例: Φ63.5×7.5（多种用、分隔）" oninput="syncMaterialEditSpec()" /></div>
      <div class="form-group"><label>管径 / 壁厚(mm)（由规格自动识别）</label><input type="text" id="ms-size-preview" readonly style="opacity:.75;" value="${escapeHTML(materialEditSpecPreview(item.spec))}" /></div>
      <div class="form-group"><label>材质</label><input type="text" id="ms-material" value="${escapeHTML(String(item.material ?? ''))}" placeholder="例: SA-210C" /></div>
      <div class="form-group"><label>库存根数</label><input type="text" id="ms-stock" value="${escapeHTML(String(item.stockQty ?? ''))}" placeholder="例: 120（可留空）" /></div>
      <div class="form-group"><label>库存总长度(m)</label><input type="text" id="ms-length" value="${escapeHTML(String(item.totalLengthM ?? ''))}" placeholder="例: 360（可留空）" /></div>
      <div class="form-group"><label>预留位置</label><input type="text" id="ms-reserve" value="${escapeHTML(String(item.reserveLocation ?? ''))}" placeholder="例: 1号库房B区" /></div>
      <div class="form-group"><label>备注</label><textarea id="ms-remark" rows="3">${escapeHTML(String(item.remark ?? ''))}</textarea></div>
      <div style="display:flex; gap:10px; margin-top:6px;">
        <button class="btn" style="flex:1;" onclick="saveMaterialStockEdit('${escapeHTML(encodedKey)}')">💾 保存修改</button>
        <button class="btn btn-outline" onclick="closeDataEditModal()">取消</button>
      </div>
    </div>`);
}
function materialEditSpecPreview(spec) {
  const size = parseSpecSize(spec);
  return size.diameter ? `Φ${size.diameter} × ${size.wallThickness || '?'}` : '（按规格自动识别）';
}
function syncMaterialEditSpec() {
  const preview = document.getElementById('ms-size-preview');
  if(preview) preview.value = materialEditSpecPreview(document.getElementById('ms-spec')?.value || '');
}
function saveMaterialStockEdit(encodedKey) {
  if(getAssistantRole() === 'viewer') { showToast('当前为只读账号，不能修改材料记录。', 'warn'); return; }
  const key = decodeURIComponent(encodedKey);
  const fields = {
    component: (document.getElementById('ms-component')?.value || '').trim(),
    sys: (document.getElementById('ms-sys')?.value || '').trim().toUpperCase(),
    position: (document.getElementById('ms-position')?.value || '').trim(),
    shape: (document.getElementById('ms-shape')?.value || '').trim(),
    spec: (document.getElementById('ms-spec')?.value || '').trim(),
    material: (document.getElementById('ms-material')?.value || '').trim(),
    stockQty: (document.getElementById('ms-stock')?.value || '').trim(),
    totalLengthM: (document.getElementById('ms-length')?.value || '').trim(),
    reserveLocation: (document.getElementById('ms-reserve')?.value || '').trim(),
    remark: (document.getElementById('ms-remark')?.value || '').trim()
  };
  const pureNumber = (text) => /^\d+(\.\d+)?$/.test(text);
  if(!fields.component || !fields.position || !fields.spec) { showToast('部件名称、分段/位置、规格型号不能为空。', 'warn'); return; }
  if(!ALL_CODE_SYSTEMS.some(s => s.sys === fields.sys)) { showToast('系统代码请从列表选择（如 SLB、GGRQ、SMQ）。', 'warn'); return; }
  if(fields.stockQty && !pureNumber(fields.stockQty)) { showToast('库存根数请填数字（如 120），或留空。', 'warn'); return; }
  if(fields.totalLengthM && !pureNumber(fields.totalLengthM)) { showToast('库存总长度请填数字（米，如 360），或留空。', 'warn'); return; }
  const library = getMaterialLibrary();
  const index = library.findIndex(item => materialKey(item) === key);
  if(index < 0) { showToast('没有找到这条材料记录，可能已被重新导入覆盖。', 'warn'); return; }
  const size = parseSpecSize(fields.spec);
  const next = library.map((item, i) => i === index
    ? { ...item, ...fields, diameter: size.diameter || '', wallThickness: size.wallThickness || '', _edited: true }
    : item);
  saveMaterialLibrary(next, { reason: 'manual' });
  closeDataEditModal();
  showToast('材料记录已更新并同步（若已登录云端）。', 'ok');
}
function renderMaterialLibrary(key) {
  const c = COMPONENTS[key];
  const componentName = MATERIAL_COMPONENT_BY_TAB[key] || c?.name || '';
  const allRows = getMaterialLibrary();
  const rows = allRows.filter(item => item.component === componentName || item.sys === c?.sys);
  const stockRows = rows.filter(item => item.stockQty || item.totalLengthM || item.reserveLocation).length;
  const tableRows = rows.map(item => {
    const rule = materialRuleForRow(item);
    return `
    <tr>
      <td>${escapeHTML(materialCell(item.categoryNo))}</td>
      <td style="font-family:inherit">${escapeHTML(item.sampleName || item.position)}</td>
      <td>${escapeHTML(materialCell(item.diameter))}</td>
      <td>${escapeHTML(materialCell(item.wallThickness))}</td>
      <td style="font-family:inherit">${escapeHTML(materialCell(item.material))}</td>
      <td>${escapeHTML(materialCell(rule.pressure))}</td>
      <td>${escapeHTML(materialCell(rule.temperature))}</td>
      <td>${escapeHTML(materialCell(rule.straight))}</td>
      <td>${escapeHTML(materialCell(rule.bendRadius))}</td>
      <td>${escapeHTML(materialCell(rule.bend))}</td>
      <td>${escapeHTML(materialCell(item.spec))}</td>
      <td>${escapeHTML(materialCell(item.stockQty))}</td>
      <td>${escapeHTML(materialCell(item.totalLengthM))}</td>
      <td style="font-family:inherit; min-width:220px; white-space:normal;">${escapeHTML(materialCell(item.remark))}</td>
      <td>${getAssistantRole() === 'viewer' ? '' : `<button class="btn btn-outline" style="padding:2px 8px; font-size:11px;" onclick="openEditMaterialStock('${encodeURIComponent(materialKey(item))}')">编辑</button>`}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="15" style="text-align:center; padding:20px;">暂无材料记录，可通过材料库 CSV 导入维护。</td></tr>';
  document.getElementById('compContent').innerHTML = `
    <div class="card">
      <div class="card-title"><span class="badge ${c?.badge || 'badge-sh'}">${escapeHTML(c?.sys || '')}</span> ${escapeHTML(componentName)} 材料清单</div>
      <div class="info-grid">
        <div class="info-item"><div class="k">材料记录</div><div class="v">${rows.length} 条</div></div>
        <div class="info-item"><div class="k">库存维护项</div><div class="v">${stockRows} 条</div></div>
        <div class="info-item"><div class="k">维护方式</div><div class="v">页面编辑 / CSV 导入导出</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">样表分类清单</div>
      <div class="table-wrap"><table><thead><tr><th>序号</th><th>名称</th><th>外径(mm)</th><th>取用壁厚(mm)</th><th>材料</th><th>设计压力(MPa)</th><th>设计温度(℃)</th><th>直管理论计算厚度(mm)</th><th>弯管半径(mm)</th><th>弯管外侧理论计算厚度(mm)</th><th>规格型号</th><th>库存根数</th><th>库存总长度(m)</th><th>备注</th><th>操作</th></tr></thead><tbody>${tableRows}</tbody></table></div>
    </div>`;
}
function renderComponent(key) { renderMaterialLibrary(key); }
function renderHeaders() { document.getElementById('shHeaders').innerHTML = SH_HEADERS.map(h => `<tr><td>${h.n}</td><td>${h.name}</td><td>${h.spec}</td><td>${h.mat}</td></tr>`).join(''); document.getElementById('rhHeaders').innerHTML = RH_HEADERS.map(h => `<tr><td>${h.n}</td><td>${h.name}</td><td>${h.spec}</td><td>${h.mat}</td></tr>`).join(''); }

function updateLifecycleDropdown() { const sel = document.getElementById('lcSelect'); const codes = [...new Set(userDB.events.map(e => e.code))]; sel.innerHTML = '<option value="">-- 请选择管码 --</option>' + codes.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join(''); }
function loadLifecycle(customCode) {
  const code = customCode || document.getElementById('lcSelect').value || document.getElementById('lcCustomCode').value.trim().toUpperCase();
  if(!code) return;
  const profile = getTubeProfileData(code);
  if(!profile) { document.getElementById('lcContent').innerHTML = `<div class="alert alert-warn">未找到 ${escapeHTML(code)} 的任何数据。</div>`; return; }
  document.getElementById('lcContent').innerHTML = buildTubeProfileHTML(code, { context: 'lifecycle' });
  analyzeTubeDetails(code);
}

function renderMatrix() { const tbody = document.getElementById('matrixBody'); let total = 0; tbody.innerHTML = matrix.map(m => { const count = matrixRowCount(m); total += count; return `<tr><td style="font-family:inherit">${m.name}</td><td><span class="badge ${m.badge}">${m.sys}</span></td><td>${m.comp} · ${COMPONENT_LABELS[m.comp] || ''}</td><td>${matrixRowRangeText(m)}</td><td style="color:var(--accent)">${count}</td><td>${m.spec}</td><td style="font-family:inherit;font-size:11px">${m.mat}</td></tr>`; }).join(''); document.getElementById('invTotal').textContent = total.toLocaleString(); }
function pad(n, len) { return String(n).padStart(len, '0'); }
const MAINTENANCE_CYCLE_YEARS = 6;
const MAINTENANCE_OUTAGE_INTERVAL_YEARS = 2;
const MAINTENANCE_OUTAGE_COUNT = 3;
const MAINTENANCE_OUTAGE_PATTERN = [
  { type: 'A修', durationDays: 50, workloadShare: 50 },
  { type: 'C修', durationDays: 30, workloadShare: 25 },
  { type: 'C修', durationDays: 30, workloadShare: 25 }
];
const MAINTENANCE_INSPECTION_ITEMS = ['割管取样', '射线', '测厚', '硬度', '防磨防爆检查'];
const MAINTENANCE_SYSTEM_PRIORITY = ['GZRQ', 'GGRQ', 'HPGRQ', 'DPGRQ', 'DZRQ', 'DGRQ', 'SLB', 'RSH', 'WSH', 'SMQ'];
function maintenanceFocusForSurface(sys) {
  if(['GGRQ', 'GZRQ', 'HPGRQ', 'DPGRQ'].includes(sys)) return '高温蠕变、氧化皮堆积、异种钢焊口和弯头外弧减薄';
  if(['DGRQ', 'DZRQ', 'SMQ'].includes(sys)) return '烟气冲刷、磨损减薄、支吊卡涩和积灰腐蚀';
  if(sys === 'SLB') return '水冷壁高热负荷区、防磨瓦、鳍片焊缝和局部鼓包';
  return '吊挂、密封、包覆区域和历史缺陷复查';
}
function maintenanceSystemPriority(sys) {
  const index = MAINTENANCE_SYSTEM_PRIORITY.indexOf(sys);
  return index >= 0 ? index : MAINTENANCE_SYSTEM_PRIORITY.length;
}
function maintenanceHistoryScore(text, status = '') {
  const value = `${text || ''} ${status || ''}`;
  let score = 0;
  [
    { pattern: /danger|严重|爆管|泄漏|裂纹|超标|更换|失效|异常|减薄至|蠕变损伤/i, score: 8 },
    { pattern: /warn|预警|减薄|蠕变|氧化皮|鼓包|硬度异常|脱碳|过热|磨损/i, score: 5 },
    { pattern: /射线|测厚|硬度|金相|割管|防磨防爆|检修|复查/i, score: 2 }
  ].forEach(rule => { if(rule.pattern.test(value)) score += rule.score; });
  return score;
}
function collectMaintenanceHistorySignals(boiler = 'all') {
  const signals = Object.fromEntries(CODE_SYSTEMS.map(item => [item.sys, { historyScore: 0, count: 0, reasons: [], latestDate: '' }]));
  const addSignal = (sys, score, reason, date = '') => {
    if(!signals[sys]) return;
    signals[sys].historyScore += score;
    signals[sys].count += 1;
    if(date && (!signals[sys].latestDate || new Date(date) > new Date(signals[sys].latestDate))) signals[sys].latestDate = date;
    if(reason && signals[sys].reasons.length < 4) signals[sys].reasons.push(reason);
  };
  Object.entries(systemLifecycleData()).forEach(([code, item]) => {
    if(boiler !== 'all' && getCodeBoiler(code) !== boiler) return;
    const sys = getCodeSystem(code);
    const timelineText = (item.timeline || []).map(t => `${t.t || ''}${t.d || ''}`).join(' ');
    const score = maintenanceHistoryScore(`${item.name || ''} ${item.risk || ''} ${timelineText}`, item.status);
    if(score) addSignal(sys, score, `系统样例：${item.risk || item.name || code}`, item.install);
  });
  userDB.events.forEach(event => {
    if(boiler !== 'all' && eventBoiler(event) !== boiler) return;
    const sys = getCodeSystem(event.code);
    const score = maintenanceHistoryScore(`${event.type || ''} ${event.desc || ''} ${event.thickness || ''} ${event.hardness || ''}`);
    if(score) addSignal(sys, score, `本地记录：${event.type || '检测'} ${event.desc || event.code}`, event.date);
  });
  userDB.replacements.forEach(record => {
    const recordBoiler = getCodeBoiler(record.oldCode) || getCodeBoiler(record.newCode);
    if(boiler !== 'all' && recordBoiler !== boiler) return;
    [record.oldCode, record.newCode].forEach(code => {
      const sys = getCodeSystem(code);
      addSignal(sys, 8, `换管记录：${record.reason || record.oldCode}`, record.date);
    });
  });
  return signals;
}
function getMaintenanceLedgerSurfaces() {
  const aggregates = new Map();
  matrix.forEach(row => {
    const ledgerCount = matrixRowCount(row);
    const current = aggregates.get(row.sys) || {
      sys: row.sys,
      label: CODE_SYSTEMS.find(item => item.sys === row.sys)?.label || row.name,
      ledgerCount: 0,
      specs: new Set(),
      materials: new Set(),
      zones: new Set(),
      badge: row.badge
    };
    current.ledgerCount += ledgerCount;
    current.specs.add(row.spec);
    current.materials.add(row.mat);
    current.zones.add(`${row.comp} · ${COMPONENT_LABELS[row.comp] || ''}`);
    aggregates.set(row.sys, current);
  });
  return [...aggregates.values()].map(item => ({
    ...item,
    spec: [...item.specs].join(' / '),
    material: [...item.materials].join(' / '),
    zones: [...item.zones].join(' / ')
  }));
}
function getLatestMaintenanceContext(boiler = 'all') {
  const records = [];
  const pushRecord = (sys, date, type, desc, source) => {
    if(!sys) return;
    records.push({ sys, date: date || '', type: type || '检修记录', desc: desc || '', source });
  };
  Object.entries(systemLifecycleData()).forEach(([code, item]) => {
    if(boiler !== 'all' && getCodeBoiler(code) !== boiler) return;
    const sys = getCodeSystem(code);
    (item.timeline || []).forEach(t => pushRecord(sys, t.date, t.t, t.d, '系统寿命样例'));
    pushRecord(sys, item.install, '投运/样例', item.risk || item.name, '系统寿命样例');
  });
  userDB.events.forEach(event => {
    if(boiler !== 'all' && eventBoiler(event) !== boiler) return;
    if(!/检修|检查|防磨防爆|测厚|射线|硬度|金相|割管|取样|更换|裂纹|磨损|减薄|蠕变/i.test(`${event.type || ''} ${event.desc || ''}`)) return;
    pushRecord(getCodeSystem(event.code), event.date, event.type, event.desc, '本地检测记录');
  });
  userDB.replacements.forEach(record => {
    const recordBoiler = getCodeBoiler(record.oldCode) || getCodeBoiler(record.newCode);
    if(boiler !== 'all' && recordBoiler !== boiler) return;
    pushRecord(getCodeSystem(record.oldCode), record.date, '管段更换', record.reason || record.oldCode, '更换登记');
    pushRecord(getCodeSystem(record.newCode), record.date, '管段更换', record.reason || record.newCode, '更换登记');
  });
  records.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const bySys = {};
  records.forEach(record => {
    if(!bySys[record.sys]) bySys[record.sys] = [];
    bySys[record.sys].push(record);
  });
  return { latest: records[0] || null, bySys, records };
}
function buildAntiWearExpansionRecommendation(surface, latestContext) {
  const latest = latestContext.bySys[surface.sys]?.[0] || null;
  const latestText = latest ? `最近一次检修：${latest.date || '-'} ${latest.type || ''}（${latest.source || ''}）${latest.desc ? `，${latest.desc}` : ''}` : '最近一次检修：暂无明确记录';
  const signalText = `${surface.historyReasons?.join('；') || ''} ${latest?.type || ''} ${latest?.desc || ''}`;
  const abnormal = maintenanceHistoryScore(signalText, surface.historyScore >= 8 ? 'warn' : '') >= 5;
  const supplemental = !latest
    ? '重点补充：本周期首次建立防磨防爆基准，A修优先完成全视距排查和影像留档'
    : /防磨防爆|磨损|冲刷|护瓦|防磨瓦/i.test(`${latest.type || ''} ${latest.desc || ''}`)
      ? '重点补充：复核上次防磨防爆问题点、已处理部位和同排同屏相邻部位'
      : '重点补充：最近一次检修未明确防磨防爆结论，补做烟气冲刷、管卡磨损、防磨瓦和焊缝外观检查';
  const ranges = {
    SLB: '扩大检查范围：高热负荷区、燃烧器周边、卫燃带边界、相邻±3排及鳍片焊缝',
    GGRQ: '扩大检查范围：同屏相邻±2屏、外圈弯头、夹持管、异种钢焊口和吹灰器覆盖区',
    GZRQ: '扩大检查范围：同屏相邻±2屏、外圈弯头、定位管夹、入口喷水影响区和烟气走廊',
    HPGRQ: '扩大检查范围：屏底外圈、包扎管、相邻±2屏、管排晃动磨损和高温腐蚀区',
    DPGRQ: '扩大检查范围：屏底夹持管、外圈迎烟面、结渣冲刷区和相邻小屏',
    DGRQ: '扩大检查范围：水平段迎烟面、吹灰器附近、积灰桥接区、同排上下游管组',
    DZRQ: '扩大检查范围：水平段下部、支撑块/管卡接触点、低速积灰区和垂直段过渡区',
    SMQ: '扩大检查范围：蛇形管迎烟面、弯头外弧、灰斗上方、低温腐蚀和飞灰磨损区',
    RSH: '扩大检查范围：吊挂管、穿墙密封、顶棚边界和包覆过渡焊缝',
    WSH: '扩大检查范围：包墙密封区、角部膨胀缝、支吊结构接触点和相邻包覆管'
  };
  const expansion = ranges[surface.sys] || '扩大检查范围：同规格、同材质、同烟气冲刷路径及相邻管排';
  return `${latestText}；${supplemental}；${abnormal ? expansion : `常规范围：${expansion.replace('扩大检查范围：', '')}`}`;
}
function splitSurfacesByWorkload(surfaces) {
  const workloadTotal = surfaces.reduce((sum, surface) => sum + (surface.ledgerCount || 1), 0);
  const groups = MAINTENANCE_OUTAGE_PATTERN.map(pattern => ({ targetWorkload: workloadTotal * pattern.workloadShare / 100, workload: 0, surfaces: [] }));
  let groupIndex = 0;
  surfaces.forEach(surface => {
    const current = groups[groupIndex];
    if(groupIndex < groups.length - 1 && current.surfaces.length && current.workload >= current.targetWorkload) groupIndex += 1;
    groups[groupIndex].surfaces.push(surface);
    groups[groupIndex].workload += surface.ledgerCount || 1;
  });
  return groups.map(group => group.surfaces);
}
function buildMaintenanceOutagePlan(cycleStartYear = new Date().getFullYear(), boiler = 'all') {
  const startYear = Number.isFinite(Number(cycleStartYear)) ? Number(cycleStartYear) : new Date().getFullYear();
  const historySignals = collectMaintenanceHistorySignals(boiler);
  const latestContext = getLatestMaintenanceContext(boiler);
  const rankedSurfaces = getMaintenanceLedgerSurfaces().map(surface => ({
    ...surface,
    historyScore: historySignals[surface.sys]?.historyScore || 0,
    historyCount: historySignals[surface.sys]?.count || 0,
    historyReasons: historySignals[surface.sys]?.reasons || [],
    latestHistoryDate: historySignals[surface.sys]?.latestDate || '',
    focus: maintenanceFocusForSurface(surface.sys)
  })).sort((a, b) => b.historyScore - a.historyScore || a.sys.localeCompare(b.sys));
  const workloadGroups = splitSurfacesByWorkload(rankedSurfaces);
  return MAINTENANCE_OUTAGE_PATTERN.map((pattern, index) => {
    const outageNo = index + 1;
    const surfaces = (workloadGroups[index] || []).map(surface => ({
      ...surface,
      outageNo,
      antiWearExpansion: buildAntiWearExpansionRecommendation(surface, latestContext)
    }));
    return {
      outageNo,
      type: pattern.type,
      durationDays: pattern.durationDays,
      workloadShare: pattern.workloadShare,
      boiler,
      year: startYear + (outageNo * MAINTENANCE_OUTAGE_INTERVAL_YEARS),
      cycleYear: outageNo * MAINTENANCE_OUTAGE_INTERVAL_YEARS,
      surfaces,
      items: MAINTENANCE_INSPECTION_ITEMS,
      latestMaintenance: latestContext.latest,
      focus: surfaces.map(surface => {
        const basis = surface.historyScore ? `历史风险${surface.historyScore}分，${surface.historyReasons.join('；')}` : '无高风险历史记录，按周期覆盖';
        return `${surface.label}：${surface.focus}；优化依据：${basis}；${surface.antiWearExpansion}`;
      }).join('；')
    };
  });
}
const MAINTENANCE_PHYSICAL_CHECK_RE = /测厚|射线|硬度|金相|割管|取样|检查|检修|防磨防爆|无损|超声|UT|RT|PT|MT|复查|复检/i;
function isMaintenanceInspectionRecord(record) {
  return MAINTENANCE_PHYSICAL_CHECK_RE.test(`${record?.type || ''} ${record?.desc || ''} ${record?.t || ''} ${record?.d || ''}`);
}
function getInspectionAsOfDate(asOfYear) {
  const year = Number(asOfYear) || new Date().getFullYear();
  return new Date(year, 11, 31, 23, 59, 59);
}
function yearsSinceDate(dateText, asOfYear) {
  if(/^\d{4}$/.test(String(dateText || ''))) return Math.max(0, Number(asOfYear) - Number(dateText));
  const date = new Date(dateText || 0);
  if(Number.isNaN(date.getTime())) return null;
  return Math.max(0, (getInspectionAsOfDate(asOfYear) - date) / (365.25 * 24 * 60 * 60 * 1000));
}
/* 矩阵行 → 该行(单机组)的规范编码清单；方向/方位取行内首选字母，其余字母仅用于校验 */
function matrixExpandCodes(m, unit) {
  const out = [];
  const prefix = `${unit}G-${m.sys}-${m.comp}`;
  if(m.special === 'rsq') {
    for(let c = m.corners[0]; c <= m.corners[1]; c += 1) {
      for(const layer of m.layers) {
        for(let n = m.nozzles[0]; n <= m.nozzles[1]; n += 1) {
          out.push({ code: `${prefix}-J${c}-${layer}${pad(n, 2)}-Q001`, loc: `${c}号角 · ${layer}层第${n}喷口` });
        }
      }
    }
    return out;
  }
  const posList = m.pos ? [m.pos] : Array.from({length: m.pMax}, (_, i) => `${m.posLetters[0]}${pad(i + 1, 3)}`);
  const pos2List = m.pos2Letters ? Array.from({length: m.p2Max}, (_, i) => `${m.pos2Letters[0]}${pad(i + 1, 3)}`) : [null];
  const spaceList = m.spaces ? Array.from({length: m.spaces[1] - m.spaces[0] + 1}, (_, i) => `${m.spaces[0] + i}KJ`) : [null];
  const dir = m.dirs[0];
  for(const sp of spaceList) {
    for(const p of posList) {
      for(const p2 of pos2List) {
        const head = [sp, p, p2].filter(Boolean).join('-');
        for(let t = 1; t <= m.tMax; t += 1) {
          const locParts = [
            sp ? `第${parseInt(sp, 10)}检修空间` : '',
            m.pos ? `${m.pos}墙/坡` : `第${parseInt(p.slice(1), 10)}排/屏`,
            p2 ? `第${parseInt(p2.slice(1), 10)}小屏` : '',
            `${dir}${pad(t, 3)}`
          ].filter(Boolean);
          out.push({ code: `${prefix}-${[head, `${dir}${pad(t, 3)}`].filter(Boolean).join('-')}-Q001`, loc: locParts.join(' · ') });
        }
      }
    }
  }
  return out;
}
function matrixRowCount(m) {
  if(m.special === 'rsq') return (m.corners[1] - m.corners[0] + 1) * m.layers.length * (m.nozzles[1] - m.nozzles[0] + 1);
  let count = (m.pos ? 1 : m.pMax * (m.pos2Letters ? m.p2Max : 1)) * m.tMax;
  if(m.spaces) count *= (m.spaces[1] - m.spaces[0] + 1);
  return count;
}
/* 台账矩阵统计：管理单元总数与分系统口径，随 matrix 定义自动更新（勿写死数字） */
function tubeLedgerMatrixStats() {
  const stats = { total: 0, slb: 0, sh: 0, rhEco: 0 };
  matrix.forEach(item => {
    const count = matrixRowCount(item);
    stats.total += count;
    if(item.sys === 'SLB') stats.slb += count;
    else if(['DGRQ', 'DPGRQ', 'HPGRQ', 'GGRQ'].includes(item.sys)) stats.sh += count;
    else stats.rhEco += count;
  });
  return stats;
}
function matrixRowRangeText(m) {
  if(m.special === 'rsq') return `J${m.corners[0]}~J${m.corners[1]} · ${m.layers[0]}~${m.layers[m.layers.length - 1]}层 · 喷口${m.nozzles[0]}~${m.nozzles[1]}`;
  if(m.pos) return `${m.pos} · 管1~${m.tMax}`;
  const posText = `${m.posLetters.join('/')}${pad(1, 3)}~${m.pMax}`;
  const pos2Text = m.pos2Letters ? ` × ${m.pos2Letters.join('/')}${pad(1, 3)}~${m.p2Max}` : '';
  const spaceText = m.spaces ? ` · 空间${m.spaces[0]}~${m.spaces[1]}KJ` : '';
  return `${posText}${pos2Text}${spaceText} · ${m.dirs.join('/')}1~${m.tMax}${m.fieldDirs ? '；现场F/B管位总数待核，不与U/D换算' : ''}`;
}
function getGeneratedTubeLedgerRows(boiler = 'all') {
  const boilers = boiler === 'all' ? ['1', '2'] : [String(boiler)];
  const rows = [];
  boilers.forEach(boilerId => {
    matrix.forEach(item => {
      matrixExpandCodes(item, boilerId).forEach(entry => {
        rows.push({
          code: entry.code,
          boiler: boilerId,
          sys: item.sys,
          label: CODE_SYSTEMS.find(sys => sys.sys === item.sys)?.label || item.name,
          surface: item.name,
          location: entry.loc,
          spec: item.spec,
          material: item.mat,
          badge: item.badge
        });
      });
    });
  });
  const byCode = new Map(rows.map(row => [tubePositionKey(row.code), row]));
  userDB.events.forEach(event => {
    const code = normalizedTubeCode(event.code);
    const position = tubePositionKey(code);
    if(!code || byCode.has(position)) return;
    if(boiler !== 'all' && eventBoiler(event) !== String(boiler)) return;
    const comp = matchComponentFromCode(code);
    byCode.set(position, {
      code,
      boiler: eventBoiler(event) || getCodeBoiler(code),
      sys: getCodeSystem(code),
      label: CODE_SYSTEMS.find(sys => sys.sys === getCodeSystem(code))?.label || comp?.name || '本地录入管段',
      surface: comp?.name || '本地录入管段',
      location: tubeLocationText(code),
      spec: event.spec || comp?.spec || '',
      material: event.material || comp?.mat || '',
      badge: comp?.badge || 'badge-rh'
    });
  });
  return [...byCode.values()];
}
function tubeLocationText(code) {
  const parsed = parseTubeCode(code);
  if(!parsed) return '-';
  if(parsed.corner !== null) return `${parsed.corner}号角 · ${parsed.layer}层第${parsed.nozzle}喷口`;
  const posText = parsed.pos && /000$/.test(parsed.pos)
    ? ({ F000: '前墙/坡', B000: '后墙/坡', L000: '左墙/坡', R000: '右墙/坡' })[parsed.pos] || parsed.pos
    : parsed.pos ? `第${parsed.posNum}排/屏` : '';
  const parts = [
    parsed.space ? `第${parsed.space}检修空间` : '',
    posText,
    parsed.pos2 ? `第${parsed.pos2Num}小屏` : '',
    parsed.tube !== null ? `${parsed.dir}${pad(parsed.tube, 3)}` : '整排取样'
  ].filter(Boolean);
  return parts.join(' · ');
}
function collectTubeInspectionRecords(boiler = 'all') {
  const records = new Map();
  const add = (code, date, type, desc, source) => {
    const normalized = String(code || '').toUpperCase();
    if(!normalized || !date) return;
    const recordBoiler = getCodeBoiler(normalized);
    if(boiler !== 'all' && recordBoiler !== String(boiler)) return;
    const candidate = { code: normalized, date, type: type || '检查', desc: desc || '', source };
    const position = tubePositionKey(normalized);
    const old = records.get(position);
    if(!old || String(candidate.date).localeCompare(String(old.date)) > 0) records.set(position, candidate);
  };
  Object.entries(systemLifecycleData()).forEach(([code, item]) => {
    (item.timeline || []).forEach(event => {
      if(isMaintenanceInspectionRecord(event)) add(code, event.date, event.t, event.d, '系统寿命样例');
    });
  });
  userDB.events.forEach(event => {
    if(isMaintenanceInspectionRecord(event)) add(event.code, event.date, event.type, event.desc, '本地检测记录');
  });
  userDB.replacements.forEach(record => {
    add(record.oldCode, record.date, '管段更换', record.reason || '更换登记', '更换登记');
    add(record.newCode, record.date, '安装投运', `替换 ${record.oldCode || ''}`, '更换登记');
  });
  return records;
}
function classifyInspectionAging(years, hasRecord) {
  if(!hasRecord) return { priority: 'P1', bucket: '未见检查记录', threshold: 12, className: 'p1' };
  if(years >= 12) return { priority: 'P1', bucket: '12年以上', threshold: 12, className: 'p1' };
  if(years >= 10) return { priority: 'P2', bucket: '10年以上', threshold: 10, className: 'p2' };
  if(years >= 8) return { priority: 'P3', bucket: '8年以上', threshold: 8, className: 'p3' };
  if(years >= 6) return { priority: 'P4', bucket: '6年以上', threshold: 6, className: 'p4' };
  return { priority: '已查', bucket: '6年内', threshold: 0, className: 'p4' };
}
function maintenanceOverdueAction(row) {
  const focus = maintenanceFocusForSurface(row.sys);
  if(!row.hasRecord) return `无明确检查记录，先补测厚/硬度/外观，建立基准；${focus}`;
  if(row.yearsSince >= 12) return `立即列入最近停炉窗口，做测厚、硬度、金相/无损复核；${focus}`;
  if(row.yearsSince >= 10) return `优先安排A修或最近C修复查，高温区同步扩大到相邻屏/排；${focus}`;
  if(row.yearsSince >= 8) return `下次C修纳入抽查，结合吹灰器、管卡和迎烟面扩大检查；${focus}`;
  return `纳入6年滚动覆盖，补齐最近一次检查结论和影像记录；${focus}`;
}
function buildMaintenanceOverdueRows(asOfYear, boiler = 'all') {
  const inspectionMap = collectTubeInspectionRecords(boiler);
  return getGeneratedTubeLedgerRows(boiler).map(row => {
    const latest = inspectionMap.get(tubePositionKey(row.code));
    const years = latest ? yearsSinceDate(latest.date, asOfYear) : null;
    const aging = classifyInspectionAging(years ?? 999, Boolean(latest));
    return {
      ...row,
      hasRecord: Boolean(latest),
      lastDate: latest?.date || '',
      lastType: latest?.type || '',
      lastSource: latest?.source || '',
      yearsSince: years,
      yearsSort: latest ? years : 999,
      priority: aging.priority,
      bucket: aging.bucket,
      threshold: aging.threshold,
      className: aging.className
    };
  }).map(row => ({ ...row, action: maintenanceOverdueAction(row) }))
    .sort((a, b) => b.yearsSort - a.yearsSort || maintenanceSystemPriority(a.sys) - maintenanceSystemPriority(b.sys) || a.code.localeCompare(b.code));
}
function getOverdueStats(rows) {
  return {
    noRecord: rows.filter(row => !row.hasRecord).length,
    over12: rows.filter(row => !row.hasRecord || (row.yearsSince ?? 0) >= 12).length,
    over10: rows.filter(row => !row.hasRecord || (row.yearsSince ?? 0) >= 10).length,
    over8: rows.filter(row => !row.hasRecord || (row.yearsSince ?? 0) >= 8).length,
    over6: rows.filter(row => !row.hasRecord || (row.yearsSince ?? 0) >= 6).length,
    total: rows.length
  };
}
function filterMaintenanceOverdueRows(rows, threshold, surface = 'all') {
  const surfaceRows = surface === 'all' ? rows : rows.filter(row => row.sys === surface);
  if(threshold === 'never') return surfaceRows.filter(row => !row.hasRecord);
  const limit = Number(threshold) || 6;
  return surfaceRows.filter(row => !row.hasRecord || (row.yearsSince ?? 0) >= limit);
}
function interleaveMaintenanceRowsBySurface(rows, limit = 120) {
  const groups = new Map();
  MAINTENANCE_SYSTEM_PRIORITY.forEach(sys => groups.set(sys, []));
  rows.forEach(row => {
    if(!groups.has(row.sys)) groups.set(row.sys, []);
    groups.get(row.sys).push(row);
  });
  const result = [];
  while(result.length < limit) {
    let added = false;
    for(const sys of groups.keys()) {
      const group = groups.get(sys);
      if(group && group.length) {
        result.push(group.shift());
        added = true;
        if(result.length >= limit) break;
      }
    }
    if(!added) break;
  }
  return result;
}
function renderMaintenanceAgingBuckets(stats) {
  const target = document.getElementById('maintenanceOverdueBuckets');
  if(!target) return;
  const buckets = [
    { label: '未见检查记录', value: stats.noRecord, desc: '台账中没有测厚、射线、硬度、金相、检修或防磨防爆记录', cls: 'critical' },
    { label: '12年以上', value: stats.over12, desc: '最高优先级，建议最近停炉窗口先查', cls: 'critical' },
    { label: '10年以上', value: stats.over10, desc: '高温受热面、焊口和弯头优先复核', cls: 'critical' },
    { label: '8年以上', value: stats.over8, desc: '下次C修应覆盖，补齐检查结论', cls: 'warn' },
    { label: '6年以上', value: stats.over6, desc: '进入6年滚动覆盖清单，避免继续漏检', cls: 'warn' }
  ];
  target.innerHTML = buckets.map(item => `<div class="aging-bucket ${item.cls}"><div class="k">${escapeHTML(item.label)}</div><div class="v">${item.value.toLocaleString()}</div><div class="d">${escapeHTML(item.desc)}</div></div>`).join('');
}
function renderMaintenancePlan() {
  const body = document.getElementById('maintenanceOutagePlanBody');
  const coverageBody = document.getElementById('maintenanceCoverageBody');
  const overdueBody = document.getElementById('maintenanceOverdueBody');
  if(!body || !coverageBody || !overdueBody) return;
  const startInput = document.getElementById('maintenanceCycleStart');
  const boilerSelect = document.getElementById('maintenanceBoiler');
  const thresholdSelect = document.getElementById('maintenanceOverdueThreshold');
  const surfaceSelect = document.getElementById('maintenanceSurfaceFilter');
  const startYear = Number(startInput?.value) || new Date().getFullYear();
  const boiler = boilerSelect?.value || 'all';
  const threshold = thresholdSelect?.value || '6';
  const surfaceFilter = surfaceSelect?.value || 'all';
  const boilerText = boiler === 'all' ? '1号炉 / 2号炉' : `${boiler}号炉`;
  const surfaceText = surfaceFilter === 'all' ? '全部受热面' : `${surfaceFilter} · ${CODE_SYSTEMS.find(item => item.sys === surfaceFilter)?.label || ''}`;
  const overdueRows = buildMaintenanceOverdueRows(startYear, boiler);
  const overdueStats = getOverdueStats(overdueRows);
  const filteredOverdueRows = filterMaintenanceOverdueRows(overdueRows, threshold, surfaceFilter);
  const visibleOverdueRows = surfaceFilter === 'all' ? interleaveMaintenanceRowsBySurface(filteredOverdueRows, 120) : filteredOverdueRows.slice(0, 120);
  const statMap = {
    'maintenance-overdue-12': overdueStats.over12,
    'maintenance-overdue-10': overdueStats.over10,
    'maintenance-overdue-8': overdueStats.over8,
    'maintenance-overdue-6': overdueStats.over6
  };
  Object.entries(statMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if(el) el.textContent = value.toLocaleString();
  });
  renderMaintenanceAgingBuckets(overdueStats);
  overdueBody.innerHTML = visibleOverdueRows.map(row => `
    <tr>
      <td class="priority-cell ${escapeHTML(row.className)}">${escapeHTML(row.priority)}</td>
      <td style="color:var(--accent)">${escapeHTML(row.code)}</td>
      <td><span class="badge ${escapeHTML(row.badge || 'badge-rh')}">${escapeHTML(row.sys)}</span> ${escapeHTML(row.label)}</td>
      <td style="font-family:inherit;">${escapeHTML(row.location || tubeLocationText(row.code))}</td>
      <td>${row.hasRecord ? `${escapeHTML(row.lastDate)}<br><span style="color:var(--text-dim);font-size:11px;">${escapeHTML(row.lastType)} · ${escapeHTML(row.lastSource)}</span>` : '<span class="badge badge-eco">未见记录</span>'}</td>
      <td>${row.hasRecord ? `${row.yearsSince.toFixed(1)}年` : '未见记录'}</td>
      <td><span class="badge ${row.threshold >= 10 || !row.hasRecord ? 'badge-eco' : row.threshold >= 8 ? 'badge-sh' : 'badge-rh'}">${escapeHTML(row.bucket)}</span></td>
      <td style="font-family:inherit; white-space:normal; min-width:280px;">${escapeHTML(row.action)}</td>
    </tr>`).join('') || '<tr><td colspan="8" style="text-align:center; padding:20px;">当前筛选条件下暂无超期未检查炉管。</td></tr>';
  const plan = buildMaintenanceOutagePlan(startYear, boiler);
  body.innerHTML = plan.map(outage => `
    <tr>
      <td>第${outage.outageNo}次停炉（第${outage.cycleYear}年）</td>
      <td>${escapeHTML(outage.type)} · ${outage.durationDays}天</td>
      <td>${outage.workloadShare}%</td>
      <td>${outage.year}</td>
      <td style="font-family:inherit; white-space:normal;">${outage.surfaces.map(surface => `<span class="badge badge-sh" style="margin:2px;">${escapeHTML(surface.sys)} · ${escapeHTML(surface.label)} · ${surface.ledgerCount}管</span>`).join('')}</td>
      <td style="font-family:inherit; white-space:normal;">${outage.items.map(item => `<span class="badge badge-ww" style="margin:2px;">${escapeHTML(item)}</span>`).join('')}</td>
      <td style="font-family:inherit; white-space:normal; min-width:320px;">${escapeHTML(outage.focus)}</td>
    </tr>`).join('');
  const assignedSurfaces = plan.flatMap(outage => outage.surfaces.map(surface => ({ ...surface, plannedYear: outage.year })));
  const overdueBySys = overdueRows.reduce((map, row) => {
    if(!map[row.sys]) map[row.sys] = { noRecord: 0, over12: 0, over10: 0, over8: 0, over6: 0 };
    if(!row.hasRecord) map[row.sys].noRecord += 1;
    if(!row.hasRecord || (row.yearsSince ?? 0) >= 12) map[row.sys].over12 += 1;
    if(!row.hasRecord || (row.yearsSince ?? 0) >= 10) map[row.sys].over10 += 1;
    if(!row.hasRecord || (row.yearsSince ?? 0) >= 8) map[row.sys].over8 += 1;
    if(!row.hasRecord || (row.yearsSince ?? 0) >= 6) map[row.sys].over6 += 1;
    return map;
  }, {});
  coverageBody.innerHTML = assignedSurfaces.map(surface => {
    const outageNo = surface.outageNo;
    const aging = overdueBySys[surface.sys] || { noRecord: 0, over12: 0, over10: 0, over8: 0, over6: 0 };
    return `
      <tr>
        <td style="font-family:inherit;"><span class="badge badge-rh">${escapeHTML(surface.sys)}</span> ${escapeHTML(surface.label)} · ${surface.ledgerCount || 0}管</td>
        ${MAINTENANCE_INSPECTION_ITEMS.map(() => '<td><span class="badge badge-ww">已覆盖</span></td>').join('')}
        <td>第${outageNo}次停炉 · ${surface.plannedYear || '-'} · 台账${surface.ledgerCount || 0}管 · 未见记录${aging.noRecord} · 12年以上${aging.over12} · 8年以上${aging.over8}</td>
      </tr>`;
  }).join('');
  const summary = document.getElementById('maintenancePlanSummary');
  const latest = plan.find(item => item.latestMaintenance)?.latestMaintenance;
  const latestText = latest ? `${latest.date || '-'} ${latest.type || ''} ${latest.desc || ''}` : '暂无最近一次检修记录';
  const workloadTotal = getMaintenanceLedgerSurfaces().reduce((sum, surface) => sum + surface.ledgerCount, 0);
  const thresholdText = threshold === 'never' ? '未见检查记录' : `${threshold}年以上`;
  if(summary) summary.innerHTML = `<div>ℹ</div><div>${escapeHTML(boilerText)}截至 ${startYear} 年，全量台账 ${overdueStats.total.toLocaleString()} 根中，未见检查记录 ${overdueStats.noRecord.toLocaleString()} 根，12年以上/未见记录 ${overdueStats.over12.toLocaleString()} 根，10年以上/未见记录 ${overdueStats.over10.toLocaleString()} 根，8年以上/未见记录 ${overdueStats.over8.toLocaleString()} 根，6年以上/未见记录 ${overdueStats.over6.toLocaleString()} 根。当前筛选：${escapeHTML(surfaceText)} · ${escapeHTML(thresholdText)}，命中 ${filteredOverdueRows.length.toLocaleString()} 根；全部受热面视图会按系统均衡展示前 ${visibleOverdueRows.length} 根，避免只显示某一个受热面。下方A/C/C安排仍按 ${MAINTENANCE_CYCLE_YEARS} 年滚动覆盖：A修50天承担50%工作量，两次C修各30天、各承担25%；最近一次检修上下文：${escapeHTML(latestText)}。</div>`;
}
function exportMaintenanceOverdueCSV() {
  const startYear = Number(document.getElementById('maintenanceCycleStart')?.value) || new Date().getFullYear();
  const boiler = document.getElementById('maintenanceBoiler')?.value || 'all';
  const threshold = document.getElementById('maintenanceOverdueThreshold')?.value || '6';
  const surface = document.getElementById('maintenanceSurfaceFilter')?.value || 'all';
  const boilerText = boiler === 'all' ? '1号炉-2号炉' : `${boiler}号炉`;
  const surfaceText = surface === 'all' ? '全部受热面' : surface;
  const thresholdText = threshold === 'never' ? '未见检查记录' : `${threshold}年以上`;
  const rows = filterMaintenanceOverdueRows(buildMaintenanceOverdueRows(startYear, boiler), threshold, surface);
  const header = ['炉号','管段编码','受热面代码','受热面','位置','规格','材质','上次检查日期','上次检查类型','记录来源','距今年限','分层','优先级','建议动作'];
  const dataRows = rows.map(row => [
    row.boiler || getCodeBoiler(row.code),
    row.code,
    row.sys,
    row.label,
    row.location || tubeLocationText(row.code),
    row.spec || '',
    row.material || '',
    row.lastDate || '未见记录',
    row.lastType || '',
    row.lastSource || '',
    row.hasRecord ? row.yearsSince.toFixed(1) : '未见记录',
    row.bucket,
    row.priority,
    row.action
  ]);
  const csv = '\uFEFF' + [header, ...dataRows].map(row => row.map(maintenanceCSVCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `漏检超期炉管清单_${boilerText}_${surfaceText}_${thresholdText}_${startYear}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function maintenanceCSVCell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function exportMaintenancePlanCSV() {
  const startYear = Number(document.getElementById('maintenanceCycleStart')?.value) || new Date().getFullYear();
  const boiler = document.getElementById('maintenanceBoiler')?.value || 'all';
  const boilerText = boiler === 'all' ? '1号炉/2号炉' : `${boiler}号炉`;
  const boilerIds = boiler === 'all' ? ['1', '2'] : [boiler];
  const plan = buildMaintenanceOutagePlan(startYear, boiler);
  const rows = plan.flatMap(outage => outage.surfaces.flatMap(surface => outage.items.flatMap(item => boilerIds.map(boilerId => {
    const planCode = `${boilerId}-${surface.sys}-PL-000-0000-${outage.type === 'A修' ? 'A01' : `C0${outage.outageNo}`}`;
    const desc = `计划项：${item}；受热面：${surface.sys} ${surface.label}；台账工作量：${surface.ledgerCount || 0}管；周期起始年：${startYear}；${outage.type} 第${outage.outageNo}次停炉（第${outage.cycleYear}年），计划年份：${outage.year}，工期：${outage.durationDays}天，工作量：${outage.workloadShare}%；历史风险分：${surface.historyScore || 0}；重点补充/扩大检查范围：${surface.antiWearExpansion || ''}；现场结果：；责任人：；完成日期：；备注：`;
    return [
      '事件',
      boilerId,
      '',
      planCode,
      surface.spec || '',
      surface.material || '',
      '',
      '',
      '检修维护',
      '',
      desc
    ];
  }))));
  const csv = '\uFEFF' + [EVENT_CSV_COLUMNS, ...rows].map(row => row.map(maintenanceCSVCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `检修模块_A-C-C计划清单_${boilerText}_${startYear}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function generateCSV(boilerId) {
  const logBox = document.getElementById('invLogBox');
  const progBar = document.getElementById('invProgBar');
  const progFill = document.getElementById('invProgFill');
  const previewBox = document.getElementById('invPreview');
  logBox.style.display = 'block'; progBar.style.display = 'block'; logBox.innerHTML = ''; progFill.style.width = '0%';
  const boilers = boilerId === 0 ? [1, 2] : [boilerId];
  let csvContent = '\uFEFF' + '炉号,机组,系统代码,部件代码,位置描述,流水号,完整管码,部件名称,规格,材质' + '\n';
  let previewLines = [];
  const tasks = [];
  boilers.forEach(b => matrix.forEach(m => matrixExpandCodes(m, String(b)).forEach(entry => tasks.push({ b, m, entry }))));
  const rowCount = tasks.length;
  invLog(`[INIT] 启动生成引擎... 目标: ${boilers.join(', ')}，预计 ${rowCount.toLocaleString()} 条`);
  let cursor = 0;
  function processChunk() {
    const startTime = performance.now();
    while(performance.now() - startTime < 50 && cursor < rowCount) {
      const { b, m, entry } = tasks[cursor];
      csvContent += `${b},${b}G,${m.sys},${m.comp},${entry.loc},001,${entry.code},${m.name},${m.spec},${m.mat}
`;
      if(cursor < 10) previewLines.push(`<span>${entry.code}</span> | ${m.name}`);
      cursor += 1;
    }
    progFill.style.width = `${(cursor / rowCount) * 100}%`;
    if(cursor < rowCount) { requestAnimationFrame(processChunk); return; }
    progFill.style.width = '100%';
    invLog(`[DONE] 总计 ${rowCount.toLocaleString()} 条。正在打包...`);
    previewBox.innerHTML = previewLines.join('<br>') + '<br><span>... (共 ' + rowCount.toLocaleString() + ' 条)</span>';
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `锅炉管段台账_${boilerId===0?'全厂':boilerId+'号炉'}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  requestAnimationFrame(processChunk);
}
function invLog(msg) { const logBox = document.getElementById('invLogBox'); logBox.innerHTML += `<div>[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${msg}</div>`; logBox.scrollTop = logBox.scrollHeight; }

function normalizeLLMBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}
/* ---------------- 模型配置：localStorage 是唯一真相，DOM 只是编辑缓冲 ----------------
   以前 getLLMConfig 直接读表单 DOM，导致「表单没回填/还没渲染」时把已保存配置判成未配置，
   而且逻辑无法单测。现在读写分离：
   - readLLMConfigFromStorage / getLLMConfig：读已保存配置（任何非面板逻辑都用它）
   - getLLMFormConfig：面板内的操作（识别模型、测试连接）用，允许使用尚未保存的输入
   - saveLLMConfig：表单 → 存储
------------------------------------------------------------------------- */
function readLLMConfigFromStorage() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LLM_CONFIG_KEY) || '{}') || {}; } catch(err) { saved = {}; }
  const preset = LLM_PROVIDER_PRESETS[saved.provider] || LLM_PROVIDER_PRESETS.custom || { baseUrl: '' };
  return {
    provider: saved.provider || 'custom',
    baseUrl: normalizeLLMBaseUrl(saved.baseUrl || preset.baseUrl || ''),
    apiKey: saved.apiKey || '',
    model: String(saved.model || '').trim(),
    temperature: Number(saved.temperature ?? 0.2),
    models: Array.isArray(saved.models) ? saved.models.slice(0, 200) : []
  };
}
function getLLMConfig() {
  const config = readLLMConfigFromStorage();
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature
  };
}
function getLLMFormConfig() {
  const saved = readLLMConfigFromStorage();
  const readField = (id, fallback) => {
    const el = document.getElementById(id);
    const value = el && typeof el.value === 'string' ? el.value.trim() : '';
    return value === '' ? fallback : value;
  };
  return {
    provider: readField('llm-provider', saved.provider),
    baseUrl: normalizeLLMBaseUrl(readField('llm-base-url', saved.baseUrl)),
    apiKey: readField('llm-api-key', saved.apiKey),
    model: readField('llm-model', saved.model),
    temperature: Number(readField('llm-temperature', saved.temperature))
  };
}
function saveLLMConfig() {
  const config = getLLMFormConfig();
  const saved = readLLMConfigFromStorage();
  localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify({ ...config, models: saved.models }));
  setLLMStatus('配置已保存到本浏览器（模型：' + (config.model || '未选择') + '）。', 'ok');
  syncLLMConfigStatus();
}
function loadLLMConfigToForm() {
  const config = readLLMConfigFromStorage();
  const ids = { provider:'llm-provider', baseUrl:'llm-base-url', apiKey:'llm-api-key', temperature:'llm-temperature' };
  Object.entries(ids).forEach(([key, id]) => { const el = document.getElementById(id); if(el) el.value = config[key]; });
  renderLLMModelOptions(config.models.length ? config.models : (config.model ? [config.model] : []), config.model);
  syncLLMConfigStatus();
}
function syncLLMConfigStatus() {
  const config = readLLMConfigFromStorage();
  if(llmServerStatus?.serverKey && !config.apiKey) {
    setLLMStatus('已就绪：未填本地 API Key，模型调用将走服务端代理（密钥不出浏览器）。', 'ok');
    return;
  }
  if(config.baseUrl && config.apiKey && config.model) {
    setLLMStatus('已载入配置：' + config.model + '（' + config.baseUrl + '）', 'ok');
    return;
  }
  const missing = [];
  if(!config.baseUrl) missing.push('Base URL');
  if(!config.apiKey) missing.push('API Key');
  if(!config.model) missing.push('模型');
  setLLMStatus(missing.length ? '未完成配置：还缺 ' + missing.join('、') + '；当前可用规则分析' : '未配置模型', 'info');
}
// 服务端模型接口状态（/api/llm/status）：{ serverKey, baseUrl, model }，绝不包含密钥本身。
let llmServerStatus = null;
function usingServerLLM(config = getLLMFormConfig()) {
  return Boolean(llmServerStatus?.serverKey) && !config.apiKey;
}
async function refreshLLMServerStatus() {
  if(!cloudStorageEnabled()) return;
  try {
    const response = await fetch('/api/llm/status');
    if(!response.ok) return;
    llmServerStatus = await response.json();
  } catch {
    llmServerStatus = null;
    window.__llmServerKey = false;
    return;
  }
  // 助手模块（独立 IIFE）通过该标志感知服务端密钥模式
  window.__llmServerKey = Boolean(llmServerStatus?.serverKey);
  updateLLMServerHint();
  syncLLMConfigStatus();
}
function updateLLMServerHint() {
  if(!llmServerStatus?.serverKey) return;
  const saved = readLLMConfigFromStorage();
  const keyInput = document.getElementById('llm-api-key');
  if(keyInput && !keyInput.value && !saved.apiKey) {
    keyInput.placeholder = '留空即使用服务端密钥（推荐）';
    const note = keyInput.closest('.form-group')?.querySelector('.llm-note');
    if(note) note.textContent = '服务端已配置模型密钥：API Key 留空即走服务端代理，密钥不会出现在浏览器；也可填写自己的 Key 直连服务商。';
  }
}
function applyLLMProviderPreset() {
  const provider = document.getElementById('llm-provider').value;
  const preset = LLM_PROVIDER_PRESETS[provider];
  if(!preset || provider === 'custom') return;
  document.getElementById('llm-base-url').value = preset.baseUrl;
  renderLLMModelOptions([], '');
  setLLMStatus(`已套用 ${provider} 预设，请填写或确认 API Key 后识别可用模型。`, 'info');
}
function buildLLMContext() {
  const localCodes = [...new Set(userDB.events.map(e => e.code))].slice(0, 8);
  const recentEvents = userDB.events.slice(-8).map(e => `${e.date} ${e.code} ${e.type}: ${e.desc}`).join('\n') || '暂无本地录入事件';
  const lifecycle = Object.entries(systemLifecycleData()).slice(0, 4).map(([code, d]) => `${code}: ${d.name}, ${d.spec}, 投运/记录 ${d.install}, 风险 ${d.risk}`).join('\n');
  const ledgerStats = tubeLedgerMatrixStats();
  const parts = [
    '系统：锅炉炉管全生命周期管理系统，覆盖 1#/2# 机组炉管台账、寿命跟踪、预警与检修记录。',
    `总览：单炉管管理单元 ${ledgerStats.total}；水冷壁 ${ledgerStats.slb}；过热器系统 ${ledgerStats.sh}；再热+省煤器 ${ledgerStats.rhEco}。`,
    `当前实际预警：\n${formatDashboardWarningsForPrompt()}`,
    `本地录入：事件 ${userDB.events.length} 条，更换 ${userDB.replacements.length} 条；涉及管码：${localCodes.join(', ') || '暂无'}`,
    `寿命样例：\n${lifecycle}`,
    `最近本地事件：\n${recentEvents}`
  ];
  if(Array.isArray(lastLLMVisualInsights) && lastLLMVisualInsights.length) {
    parts.push(`总览可视化分析结论（本地规则计算，可作为解读依据）：\n${lastLLMVisualInsights.map(i => `- ${i}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
function buildLLMMessages(promptText) {
  return [
    { role: 'system', content: '你是电站锅炉受热面炉管寿命管理专家。请基于给定台账、预警、测厚、蠕变和检修上下文，输出结构化、可执行的深度分析。不要编造未给出的现场数据；不确定处请标注需要复核。优先返回严格JSON，不要包裹Markdown代码块。JSON字段：summary(数组), risks(数组，每项含code,level,reason,action), mechanisms(数组), maintenance(数组), uncertainty(数组)。' },
    { role: 'user', content: `${buildLLMContext()}\n\n分析任务：${promptText}\n\n请按以下JSON结构返回，便于系统渲染：{"summary":["关键结论"],"risks":[{"code":"管码或部件","level":"高/中/低","reason":"主要原因","action":"建议动作"}],"mechanisms":["失效机理判断"],"maintenance":["检修建议"],"uncertainty":["依据与不确定性"]}` }
  ];
}
function extractLLMResponseText(data) {
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.output_text || '';
}
function extractLLMModels(data) {
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return [...new Set(rawModels.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean))].sort();
}
function renderLLMModelOptions(models, selected = '') {
  const select = document.getElementById('llm-model');
  if(!select) return;
  const list = [...new Set(models || [])].filter(Boolean);
  if(list.length === 0) {
    select.innerHTML = '<option value="">请先识别可用模型</option>';
    return;
  }
  select.innerHTML = '<option value="">请选择模型</option>' + list.map(id => `<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`).join('');
  if(selected && list.includes(selected)) select.value = selected;
  else if(list.length === 1) select.value = list[0];
}
function formatLLMError(err, action = '调用') {
  const message = err?.message || String(err);
  if(/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return `${action}失败：浏览器无法连接模型接口。常见原因是服务商接口不允许本地 HTML 页面跨域访问(CORS)、API Base URL 填写错误、网络代理不可达，或安全软件拦截。\n\n处理建议：\n1. 确认 Base URL 形如 https://xxx/v1，页面会自动请求 /models 和 /chat/completions。\n2. 若同一地址和 Key 在服务端工具可用、但浏览器失败，基本就是跨域限制，需要本地代理或后端转发。\n3. 也可以换一个明确支持 OpenAI Compatible 且允许浏览器跨域的网关地址。\n\n原始错误：${message}`;
  }
  return `${action}失败：${message}`;
}
function setLLMStatus(message, type = 'info') {
  const el = document.getElementById('llm-status');
  if(!el) return;
  el.textContent = message;
  el.style.color = type === 'ok' ? 'var(--ok)' : type === 'error' ? 'var(--danger)' : type === 'warn' ? 'var(--warn)' : 'var(--text-dim)';
}
function setLLMViewMode(mode) {
  const report = document.getElementById('llm-report-view');
  const raw = document.getElementById('llm-raw-view');
  const reportTab = document.getElementById('llm-report-tab');
  const rawTab = document.getElementById('llm-raw-tab');
  if(report) report.style.display = mode === 'raw' ? 'none' : 'block';
  if(raw) raw.style.display = mode === 'raw' ? 'block' : 'none';
  if(reportTab) reportTab.classList.toggle('active', mode !== 'raw');
  if(rawTab) rawTab.classList.toggle('active', mode === 'raw');
}
function normalizeReportArray(value) {
  if(Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item));
  if(typeof value === 'string' && value.trim()) return value.split(/\n+/).map(v => v.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean);
  return [];
}
function parseLLMReport(text) {
  const raw = String(text || '').trim();
  const jsonText = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(jsonText);
    return {
      summary: normalizeReportArray(parsed.summary || parsed.keyFindings || parsed.conclusion),
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      mechanisms: normalizeReportArray(parsed.mechanisms),
      maintenance: normalizeReportArray(parsed.maintenance || parsed.actions || parsed.recommendations),
      uncertainty: normalizeReportArray(parsed.uncertainty || parsed.evidence),
      raw
    };
  } catch (err) {
    const lines = raw.split(/\n+/).map(line => line.replace(/^#+\s*/, '').replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean);
    return {
      summary: lines.slice(0, 4),
      risks: [],
      mechanisms: [],
      maintenance: [],
      uncertainty: ['模型未返回结构化JSON，已保留原文供核对。'],
      raw
    };
  }
}
function renderList(items) {
  const list = normalizeReportArray(items);
  if(list.length === 0) return '<div class="v">暂无明确条目</div>';
  return `<ul>${list.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>`;
}
function renderLLMReport(text) {
  const report = parseLLMReport(text);
  const target = document.getElementById('llm-report-view');
  if(!target) return;
  const riskRows = report.risks.length ? report.risks.map(item => `
    <tr>
      <td>${escapeHTML(item.code || item.target || item.name || '未指明')}</td>
      <td>${escapeHTML(item.level || item.risk || '待判定')}</td>
      <td>${escapeHTML(item.reason || item.cause || '')}</td>
      <td>${escapeHTML(item.action || item.recommendation || '')}</td>
    </tr>`).join('') : '<tr><td colspan="4">模型未提供结构化风险排序，请查看关键结论或原文。</td></tr>';
  target.innerHTML = `
    <div class="llm-report-grid">
      <div class="llm-report-card"><div class="k">关键结论</div><div class="v">${renderList(report.summary)}</div></div>
      <div class="llm-report-card"><div class="k">检修建议</div><div class="v">${renderList(report.maintenance)}</div></div>
    </div>
    <div class="llm-report-section">
      <h4>风险排序</h4>
      <div class="table-wrap"><table class="llm-report-table"><thead><tr><th>对象</th><th>风险等级</th><th>主要原因</th><th>建议动作</th></tr></thead><tbody>${riskRows}</tbody></table></div>
    </div>
    <div class="llm-report-section"><h4>失效机理</h4>${renderList(report.mechanisms)}</div>
    <div class="llm-report-section"><h4>依据与不确定性</h4>${renderList(report.uncertainty)}</div>
  `;
}
/* ---------------- 模型输出数值审计（只提示，不改写报告） ---------------- */
function auditLLMText(reportText, evidenceText) {
  try {
    const mod = window.BTAssistantAnalysis;
    if(!mod || typeof mod.auditNumericClaims !== 'function') return null;
    const audit = mod.auditNumericClaims(reportText, evidenceText);
    return audit && typeof audit === 'object' ? audit : null;
  } catch(err) { return null; }
}
function auditLLMNotice(audit) {
  if(!audit) return '';
  if(audit.skipped) return '数值校验：本次问题未附带本地数据，已跳过校验。';
  if(audit.ok) return '数值校验：通过，报告中的数值均可在本地数据中找到。';
  return '数值校验：发现 ' + audit.count + ' 处数值在本地证据中找不到（' + audit.examples.join('、') + '），引用前请核对。';
}
function prependLLMNotice(text, tone) {
  const host = document.getElementById('llm-report-view');
  if(!host || !text) return;
  const box = document.createElement('div');
  box.className = 'llm-audit-note';
  const ok = tone !== 'warn';
  box.style.cssText = 'margin:0 0 10px;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.6;' +
    'border-left:3px solid ' + (ok ? 'var(--ok)' : 'var(--warn)') + ';' +
    'background:color-mix(in srgb, ' + (ok ? 'var(--ok)' : 'var(--warn)') + ' 10%, transparent);' +
    'color:var(--text-mid);';
  box.textContent = text;
  host.insertBefore(box, host.firstChild);
}
function renderLLMResult(text) {
  const value = text || '模型没有返回可显示内容。';
  const el = document.getElementById('llm-result');
  const raw = document.getElementById('llm-raw-view');
  if(el) el.textContent = value;
  if(raw) raw.textContent = value;
  renderLLMReport(value);
  setLLMViewMode('report');
  if(window.BTReportPro && typeof window.BTReportPro.onReportReplaced === 'function') window.BTReportPro.onReportReplaced(false);
}
function exportLLMReportPDF() {
  const report = document.getElementById('llm-report-view');
  const prompt = document.getElementById('llm-prompt')?.value || '';
  const raw = document.getElementById('llm-result')?.textContent || '';
  if(window.BTReportPro && typeof window.BTReportPro.guardExport === 'function') {
    if(!window.BTReportPro.guardExport('PDF')) return;
  } else if(!report || !raw || raw.includes('模型返回的深度分析会整理成报告显示在这里')) {
    showToast('请先生成结构化报告，再导出 PDF。', 'warn');
    return;
  }
  if(!report) {
    showToast('未找到报告容器，请刷新页面重试。', 'error');
    return;
  }
  const printWindow = window.open('', '_blank');
  if(!printWindow) {
    showToast('浏览器阻止了打印窗口，请允许弹窗后重试。', 'error');
    return;
  }
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>AI结构化分析报告</title>
      <style>
        @page { size: A4; margin: 16mm; }
        body { margin: 0; background: #fff; color: #1f2937; font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 12px; line-height: 1.65; }
        .printable-report { max-width: 190mm; margin: 0 auto; }
        .report-header { border-bottom: 2px solid #0f766e; padding-bottom: 12px; margin-bottom: 18px; }
        h1 { margin: 0 0 8px; font-size: 24px; color: #0f766e; letter-spacing: 1px; }
        .meta { color: #64748b; font-size: 11px; display: grid; gap: 3px; }
        .prompt { margin: 14px 0 18px; padding: 10px 12px; border-left: 3px solid #0f766e; background: #f8fafc; color: #334155; }
        .llm-report-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
        .llm-report-card, .llm-report-section { border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; margin-bottom: 12px; background: #fff; break-inside: avoid; }
        .llm-report-card .k { color: #0f766e; font-size: 12px; font-weight: 700; margin-bottom: 6px; }
        .llm-report-card .v, .llm-report-section, li { color: #1f2937; }
        .llm-report-section h4 { margin: 0 0 8px; color: #0f766e; font-size: 14px; }
        ul { margin: 0; padding-left: 18px; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { border: 1px solid #cbd5e1; padding: 7px; text-align: left; vertical-align: top; word-break: break-word; }
        th { background: #ecfdf5; color: #0f766e; font-weight: 700; }
        .table-wrap { overflow: visible; }
        ${window.BTDocx ? window.BTDocx.printVarsCss() : ':root{--accent:#0f766e;--text-dim:#475569;--text-faint:#64748b;--text-ghost:#94a3b8;--text-hi:#0f172a;--line:#94a3b8;--line-subtle:#cbd5e1;--danger:#dc2626;--warn:#d97706;--ok:#16a34a;--surface-sunken:#f1f5f9;}'}
        .llm-report-viz { break-inside: auto; }
        .llm-viz-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 8px 0 10px; }
        .llm-viz-metric { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 10px; }
        .llm-viz-metric .k { color: #64748b; font-size: 10px; }
        .llm-viz-metric .v { color: #0f172a; font-weight: 700; font-size: 13px; }
        figure.llm-viz-chart { margin: 8px 0 12px; break-inside: avoid; }
        figure.llm-viz-chart svg { width: 100%; height: auto; }
        ul.llm-viz-insights { margin: 8px 0 0; padding-left: 18px; color: #334155; }
        @media print { .print-hint { display: none; } }
      </style>
    </head>
    <body>
      <main class="printable-report">
        <section class="report-header">
          <h1>AI结构化分析报告</h1>
          <div class="meta">
            <div>系统：锅炉炉管全生命周期管理系统</div>
            <div>导出时间：${escapeHTML(exportedAt)}</div>
          </div>
        </section>
        <section class="prompt"><strong>分析问题：</strong>${escapeHTML(prompt)}</section>
        ${report.innerHTML}
        <p class="print-hint" style="color:#64748b;margin-top:18px;">请在打印窗口中选择“保存为 PDF”。</p>
      </main>
    </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 250);
}
function clearLLMResult() {
  renderLLMResult('模型返回的深度分析会整理成报告显示在这里。');
  if(window.BTReportPro && typeof window.BTReportPro.onReportReplaced === 'function') window.BTReportPro.onReportReplaced(true);
  setLLMStatus('结果已清空。', 'info');
}

/* 总览深度分析面板：本地可视化分析（复用助手分析引擎，图表作为大模型解读的数据依据） */
let lastLLMVisualInsights = [];
function runLLMVisualAnalysis() {
  const view = document.getElementById('llm-viz-view');
  const module = window.BTAssistantAnalysis;
  if(!view) return;
  if(!module || typeof module.runAnalysis !== 'function') {
    view.innerHTML = '<div class="llm-note">可视化分析组件未加载，请刷新页面。</div>';
    return;
  }
  const query = document.getElementById('llm-viz-type')?.value || '壁厚趋势';
  const spec = module.parseAnalysis(query, {});
  const snapshot = typeof collectAssistantSnapshot === 'function' ? collectAssistantSnapshot() : { events: userDB.events || [], replacements: userDB.replacements || [] };
  const result = spec ? module.runAnalysis(spec, snapshot) : null;
  if(!result || !result.ok) {
    view.innerHTML = '<div class="llm-note">当前数据不足以生成「' + escapeHTML(query) + '」，请先在「数据录入」导入测厚/事件数据。</div>';
    lastLLMVisualInsights = [];
    return;
  }
  lastLLMVisualInsights = result.insights || [];
  let chartSvg = '';
  try { chartSvg = module.chartSvg(result.chart, { emptyText: '暂无可绘制的数据' }); } catch (err) { chartSvg = ''; }
  const metricsHtml = (result.metrics || []).map(m =>
    `<div class="llm-viz-metric"><span class="k">${escapeHTML(m.label)}</span><span class="v">${escapeHTML(String(m.value))}</span></div>`).join('');
  const insightsHtml = (result.insights || []).map(i => `<li>${escapeHTML(i)}</li>`).join('');
  view.innerHTML = `
    <div class="llm-viz-title">${escapeHTML(result.title || query)} · 样本 ${result.sampleSize ?? 0} 条</div>
    ${metricsHtml ? `<div class="llm-viz-metrics">${metricsHtml}</div>` : ''}
    ${chartSvg ? `<figure class="llm-viz-chart">${chartSvg}</figure>` : ''}
    ${insightsHtml ? `<ul class="llm-viz-insights">${insightsHtml}</ul>` : ''}`;
}
async function discoverLLMModels(options = {}) {
  const config = getLLMFormConfig();
  const useServer = usingServerLLM(config);
  if(!useServer) {
    if(!config.baseUrl) throw new Error('请填写 API Base URL。');
    if(!config.apiKey) throw new Error('请填写 API Key，或在服务端配置 LLM_API_KEY 后留空。');
  }
  if(!options.silent) {
    setLLMStatus(useServer ? '正在通过服务端识别可用模型...' : '正在识别可用模型...', 'info');
    renderLLMResult('正在请求 /models 获取模型列表...');
  }
  const response = useServer
    ? await fetch('/api/llm/models')
    : await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (err) { throw new Error(`模型列表接口返回非JSON内容：${raw.slice(0, 240)}`); }
  if(!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || data.error || raw.slice(0, 240) || '模型列表请求失败'}`);
  const models = extractLLMModels(data);
  if(models.length === 0) throw new Error('接口已响应，但未在 /models 返回中找到可用模型 id。');
  const previous = JSON.parse(localStorage.getItem(LLM_CONFIG_KEY) || '{}');
  const serverDefault = llmServerStatus?.model;
  const selected = (previous.model && models.includes(previous.model)) ? previous.model
    : (serverDefault && models.includes(serverDefault)) ? serverDefault
    : models[0];
  renderLLMModelOptions(models, selected);
  localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify({ ...config, model: selected, models }));
  if(!options.silent) {
    renderLLMResult(`已识别 ${models.length} 个可用模型：\n${models.join('\n')}`);
    setLLMStatus(`模型识别完成，当前选择：${selected}`, 'ok');
  }
  return models;
}
async function discoverLLMModelsFromUI() {
  try {
    await discoverLLMModels();
  } catch (err) {
    renderLLMResult(formatLLMError(err, '模型识别'));
    setLLMStatus('模型识别失败，详情见结果框。', 'error');
  }
}
async function ensureLLMModelSelected() {
  let config = getLLMFormConfig();
  if(config.model) return config;
  await discoverLLMModels({ silent: true });
  config = getLLMFormConfig();
  if(!config.model) throw new Error('未选择可用模型，请先识别模型并选择。');
  return config;
}
async function sendLLMMessages(messages, maxTokens = 1800, options = {}) {
  const config = await ensureLLMModelSelected();
  if(!config.model) throw new Error('未识别到可用模型。');
  localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 0);
  const controller = timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const payload = { model: config.model, messages, temperature: config.temperature, max_tokens: maxTokens };
  const useServer = usingServerLLM(config);
  try {
    const response = useServer
      ? await fetch('/api/llm/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined
        })
      : await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined
        });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch (err) { throw new Error(`接口返回非JSON内容：${raw.slice(0, 240)}`); }
    if(!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || data.error || raw.slice(0, 240) || '接口请求失败'}`);
    const text = extractLLMResponseText(data);
    if(!text) throw new Error('接口返回成功，但未找到 choices[0].message.content。');
    return text;
  } catch (err) {
    if(controller && controller.signal.aborted) {
      const timeoutError = new Error(`模型调用超时（${Math.round(timeoutMs / 1000)} 秒）`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw err;
  } finally {
    if(timer) clearTimeout(timer);
  }
}

async function callLLMChatCompletions(promptText, maxTokens = 1800) {
  const payload = { messages: buildLLMMessages(promptText) };
  return sendLLMMessages(payload.messages, maxTokens);
}

async function callAssistantChatCompletions(messages, maxTokens = 600) {
  return sendLLMMessages(messages, maxTokens, { timeoutMs: 8000 });
}

// 视觉/文档识别调用：图片与长文档解析耗时明显更长，给独立的长超时。
async function callVisionLLM(messages, maxTokens = 3000) {
  return sendLLMMessages(messages, maxTokens, { timeoutMs: 90000 });
}
async function testLLMConnection() {
  setLLMStatus('正在测试连接...', 'info');
  renderLLMResult('正在向模型发送最小测试请求...');
  try {
    const text = await callLLMChatCompletions('请只回复：连接成功。', 64);
    renderLLMResult(text);
    setLLMStatus('连接测试完成。', 'ok');
  } catch (err) {
    renderLLMResult(formatLLMError(err, '连接测试'));
    setLLMStatus('连接测试失败，详情见结果框。', 'error');
  }
}
async function runLLMAnalysis() {
  const promptText = document.getElementById('llm-prompt').value.trim();
  if(!promptText) { setLLMStatus('请先输入分析问题。', 'warn'); return; }
  setLLMStatus('正在调用大模型进行深度分析...', 'info');
  renderLLMResult('请求已发送，等待模型返回...');
  try {
    const text = await callLLMChatCompletions(promptText, 2200);
    renderLLMResult(text);
    const audit = auditLLMText(text, promptText);
    if(audit && !audit.ok && !audit.skipped) {
      prependLLMNotice(auditLLMNotice(audit), 'warn');
      setLLMStatus('深度分析完成，但发现 ' + audit.count + ' 处数值无本地依据，请核对。', 'warn');
    } else {
      if(audit && !audit.skipped) prependLLMNotice(auditLLMNotice(audit), 'ok');
      setLLMStatus('深度分析完成。' + (audit && !audit.skipped ? '数值校验通过。' : ''), 'ok');
    }
  } catch (err) {
    renderLLMResult(formatLLMError(err, '调用'));
    setLLMStatus('调用失败，详情见结果框。', 'error');
  }
}
async function runWarningTrendAnalysis() {
  const promptBox = document.getElementById('llm-prompt');
  const warnings = formatDashboardWarningsForPrompt();
  promptBox.value = `预警趋势分析：请基于当前实际预警列表，判断未来运行风险趋势、风险排序、可能失效机理、建议复检项目、检修优先级和需要补充的数据。\n\n当前实际预警：\n${warnings}`;
  await runLLMAnalysis();
}

function collectAIThicknessTargets() {
  const codes = [...new Set(userDB.events.map(e => e.code))].filter(Boolean);
  return codes
    .map(code => {
      const thicknessData = extractThicknessData(code, { includeSystem: false });
      const meta = systemLifecycleData()[code] || {};
      const compInfo = matchComponentFromCode(code);
      const label = meta.name || compInfo?.name || '本地录入管段';
      if(thicknessData.length >= 1) return { code, label, points: thicknessData.length, latest: thicknessData[thicknessData.length - 1] }; /* 单测点也入列：走行业先验速率预估 */
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.code.localeCompare(b.code));
}
function populateAIThicknessTargets() {
  const sel = document.getElementById('ai-target');
  if(!sel) return;
  const targets = collectAIThicknessTargets();
  if(targets.length === 0) {
    sel.innerHTML = '<option value="">本地暂无具备分析条件的炉管</option>';
    sel.disabled = false;
    return;
  }
  sel.disabled = false;
  const previous = sel.value;
  sel.innerHTML = targets.map(item => `<option value="${escapeHTML(item.code)}">${escapeHTML(item.code)} (${escapeHTML(item.label)} · ${item.points}条测厚)</option>`).join('');
  if(previous && targets.some(item => item.code === previous)) sel.value = previous;
}
function median(values) {
  const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if(list.length === 0) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
function robustTheilSenModel(points) {
  const slopes = [];
  for(let i = 0; i < points.length; i++) {
    for(let j = i + 1; j < points.length; j++) {
      const dx = points[j].year - points[i].year;
      if(Math.abs(dx) > 0.01) slopes.push((points[j].val - points[i].val) / dx);
    }
  }
  const slope = median(slopes);
  const intercept = median(points.map(point => point.val - slope * point.year));
  const residuals = points.map(point => point.val - (slope * point.year + intercept));
  const mad = median(residuals.map(value => Math.abs(value - median(residuals))));
  return { slope, intercept, residuals, mad: mad || 0.03 };
}
function extractMaterialHint(value) {
  const text = String(value || '').toUpperCase();
  const patterns = [
    'SA-213TP347H', 'SA-213TP304H', 'SA-213T91', 'SA-213T22',
    'SA-210C', '12CR1MOVG', '15CRMOG', 'TP347H', 'TP304H', 'T91', 'T22', '20G'
  ];
  return patterns.find(pattern => text.replace(/\s/g, '').includes(pattern.replace(/\s/g, ''))) || '';
}
function resolveMaterialTheoryThickness(code, pipeType) {
  code = String(code || '').trim().toUpperCase();
  const inventory = validateCodeAgainstMatrix(code)?.row;
  const component = matchComponentFromCode(code);
  const lifecycle = systemLifecycleData()[code];
  const events = userDB.events.filter(event => sameTubeMeasurement(event.code, code))
    .sort((a,b) => String(b.date).localeCompare(String(a.date)));
  const localSpec = events.find(event => event.spec)?.spec;
  const localMaterial = events.find(event => event.material)?.material;
  const spec = localSpec || lifecycle?.spec || inventory?.spec || component?.spec || '';
  // Explicit tube metadata takes precedence over multi-spec component descriptions.
  const material = localMaterial || extractMaterialHint(localSpec || lifecycle?.spec) || inventory?.mat || component?.mat || '';
  const pairs = specPairs(spec);
  const sizes = [...new Map(pairs.map(pair => [`${Number(pair.diameter)}x${Number(pair.wall)}`, pair])).values()];
  const materials = materialAliases(material);
  const sys = getCodeSystem(code), zone = '';
  const meta = { sys, zone, spec, material };
  const candidates = sizes.length === 1 && materials.length === 1 ? getMaterialLibrary().filter(item =>
    item.sys === sys && (!item.theoryZone || !zone || item.theoryZone === zone) &&
    Number(item.diameter) === Number(sizes[0].diameter) && Number(item.wallThickness) === Number(sizes[0].wall) &&
    materialAliases(item.material).length === 1 && materialAliases(item.material)[0] === materials[0]) : [];
  const selected = candidates.length === 1 ? candidates[0] : null;
  const requestedType = pipeType ?? events.find(event => event.pipeType)?.pipeType ?? lifecycle?.pipeType ?? (selected?.shape === '直管' ? 'straight' : '');
  const normalizedType = ['straight', '直管'].includes(requestedType) ? 'straight' : ['bend', '弯管外侧'].includes(requestedType) ? 'bend' : null;
  const straight = positiveThickness(selected?.straight), bend = positiveThickness(selected?.bend);
  const threshold = normalizedType === 'straight' ? straight : normalizedType === 'bend' ? bend : null;
  const reason = !selected ? '材料库未唯一匹配，请补全材质、外径及名义壁厚' : !normalizedType ? '未指定测点管型' : threshold === null ? '材料库缺少所选管型理论厚度' : '';
  return { matched: Boolean(selected && threshold !== null), pipeType: normalizedType, threshold,
    nominalWall: selected?.nominalWall ?? (sizes.length === 1 ? positiveThickness(sizes[0].wall) : null), straight, bend,
    source: selected ? `材料库：${selected.sampleName || selected.position} · ${selected.spec} · ${selected.material}` : reason,
    reason, material: selected?.material || material, spec: selected?.spec || spec, rule: selected || false, meta };
}
function resolveTubeTheoryThreshold(code, pipeType) { return resolveMaterialTheoryThickness(code, pipeType); }
function selectedTubePipeType(code) { return window.__tubePipeTypes?.[code] ?? (parseTubeCode(code)?.partKind === 'W' ? 'bend' : undefined); }
function formatTheoryDetails(info) {
  const mm = value => value === null || value === undefined ? '未提供' : `${value.toFixed(2)}mm`;
  return `名义壁厚 ${mm(info.nominalWall)} · 直管理论厚度 ${mm(info.straight)} · 弯管外侧理论厚度 ${mm(info.bend)} · 最终采用 ${info.pipeType === 'straight' ? '直管' : info.pipeType === 'bend' ? '弯管外侧' : '管型未指定'} ${mm(info.threshold)}。${info.reason || info.source}`;
}
function yearWhenCrosses(currentYear, currentValue, threshold, rate) {
  if(rate <= 0 || currentValue <= threshold) return currentValue <= threshold ? currentYear : Infinity;
  return currentYear + ((currentValue - threshold) / rate);
}
function robustLinearTrend(points) {
  const sorted = points.filter(p => Number.isFinite(Number(p.value ?? p.val)) && Number.isFinite(Number(p.year))).map(p => ({ ...p, year: Number(p.year), value: Number(p.value ?? p.val) })).sort((a,b) => a.year - b.year);
  if(sorted.length < 2) return { slope: 0, intercept: sorted[0]?.value || 0, residualMad: 0, points: sorted };
  const slopes = [];
  for(let i = 0; i < sorted.length; i += 1) for(let j = i + 1; j < sorted.length; j += 1) {
    const dt = sorted[j].year - sorted[i].year;
    if(dt > 0) slopes.push((sorted[j].value - sorted[i].value) / dt);
  }
  slopes.sort((a,b) => a - b);
  const slope = slopes[Math.floor(slopes.length / 2)] || 0;
  const intercepts = sorted.map(p => p.value - slope * p.year).sort((a,b) => a - b);
  const intercept = intercepts[Math.floor(intercepts.length / 2)] || 0;
  const residuals = sorted.map(p => p.value - (intercept + slope * p.year)).sort((a,b) => a - b);
  const med = residuals[Math.floor(residuals.length / 2)] || 0;
  const deviations = residuals.map(r => Math.abs(r - med)).sort((a,b) => a - b);
  return { slope, intercept, residualMad: deviations[Math.floor(deviations.length / 2)] || 0, points: sorted };
}
function assessPredictionQuality(history, outliers = 0) {
  const span = history.length >= 2 ? history[history.length - 1].year - history[0].year : 0;
  const score = Math.max(0, Math.min(100, Math.round(35 + Math.min(history.length, 8) * 6 + Math.min(span, 6) * 5 - outliers * 8)));
  return { points: history.length, span, score, reliable: history.length >= 3 && span >= 1 && score >= 55 };
}
function collectAICompositeSignals(code, history = []) {
  const events = tubeEvidenceEvents(code)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const hardnessHistory = events
    .filter(event => sameTubeMeasurement(event.code, code) && isExactInspectionDate(event.date))
    .map(event => ({ date: event.date, value: parseFloat(event.hardness), source: event.type || '记录', desc: event.desc || '' }))
    .filter(point => point.value > 0 && Number.isFinite(point.value) && Number.isFinite(new Date(point.date).getTime()));
  const metallographyPattern = /金相|组织|晶粒|碳化物|球化|晶界|蠕变|脱碳|裂纹|氧化|过热|珠光体|贝氏体|马氏体/i;
  const adversePattern = /裂纹|晶界|球化|蠕变|脱碳|过热|氧化皮|腐蚀|异常|劣化|超标|疏松/i;
  const inspectionPattern = /无损|UT|PT|MT|RT|超声|射线|磁粉|渗透|割管|取样|复检|检修|更换/i;
  const metallography = events.filter(event => metallographyPattern.test(`${event.type || ''} ${event.desc || ''}`));
  const inspectionEvents = events.filter(event => inspectionPattern.test(`${event.type || ''} ${event.desc || ''}`));
  const latestHardness = hardnessHistory[hardnessHistory.length - 1] || null;
  const firstHardness = hardnessHistory[0] || null;
  const hardnessDelta = latestHardness && firstHardness ? latestHardness.value - firstHardness.value : 0;
  const hardnessPoints = hardnessHistory.map(point => ({ ...point, year: new Date(point.date).getFullYear() + new Date(point.date).getMonth() / 12 }));
  const hardnessModel = robustLinearTrend(hardnessPoints);
  const hardnessRate = hardnessModel.slope;
  const hardnessQuality = assessPredictionQuality(hardnessPoints);
  const hardnessTrend = hardnessHistory.length < 2
    ? (latestHardness ? `单点硬度 ${latestHardness.value}HB，需后续复测形成趋势${hardnessPriorHint(code)}` : '暂无硬度数据')
    : `硬度 ${firstHardness.value}HB → ${latestHardness.value}HB，变化 ${hardnessDelta >= 0 ? '+' : ''}${hardnessDelta.toFixed(0)}HB，变化率 ${hardnessRate >= 0 ? '+' : ''}${hardnessRate.toFixed(1)} HB/年` + hardnessPriorHint(code);
  const hardnessForecast = latestHardness && hardnessHistory.length >= 3 && hardnessQuality.reliable
    ? (() => {
        const lastPoint = hardnessPoints[hardnessPoints.length - 1];
        const bandHalf = Math.max(3, (hardnessModel.residualMad || 0) * 1.4826);
        const points = [1, 2, 3].map(dt => {
          const val = latestHardness.value + hardnessRate * dt;
          const half = bandHalf + Math.max(1.5, Math.abs(hardnessRate) * 0.3 * dt);
          return { year: Number((lastPoint.year + dt).toFixed(1)), val: Math.round(val), low: Math.round(val - half), high: Math.round(val + half) };
        });
        return { oneYear: points[0].val, threeYear: points[2].val, direction: Math.abs(hardnessRate) < 1 ? '稳定' : hardnessRate < 0 ? '软化' : '硬化',
          confidence: hardnessQuality.reliable ? hardnessQuality.score : Math.min(54, hardnessQuality.score),
          points, bandHalf: Math.round(bandHalf) };
      })()
    : null;
  const metallographyKeywords = [...new Set(metallography.flatMap(event => {
    const text = `${event.type || ''} ${event.desc || ''}`;
    return ['金相','组织','晶粒','碳化物','球化','晶界','蠕变','脱碳','裂纹','氧化','过热','腐蚀']
      .filter(keyword => text.includes(keyword));
  }))];
  const thicknessRisk = history.length >= 2 ? 1 : 0;
  const hardnessRisk = Math.abs(hardnessDelta) >= 15 ? 1 : 0;
  const metallographyRisk = metallography.some(event => adversePattern.test(`${event.type || ''} ${event.desc || ''}`)) ? 2 : (metallography.length ? 1 : 0);
  const inspectionRisk = inspectionEvents.some(event => adversePattern.test(`${event.type || ''} ${event.desc || ''}`)) ? 1 : 0;
  return {
    events,
    hardnessHistory,
    hardnessTrend,
    hardnessRate,
    hardnessForecast,
    hardnessQuality,
    latestHardness,
    metallography,
    metallographyKeywords,
    inspectionEvents,
    riskAdditions: thicknessRisk + hardnessRisk + metallographyRisk + inspectionRisk,
    evidenceSummary: [
      `测厚数据：${history.length} 条`,
      `硬度历史：${hardnessHistory.length ? hardnessTrend : '暂无硬度数据'}`,
      `金相组织：${metallography.length ? metallography.map(e => `${e.date} ${e.type} ${e.desc}`).join('；') : '暂无金相组织记录'}`,
      `无损/检修：${inspectionEvents.length ? inspectionEvents.map(e => `${e.date} ${e.type} ${e.desc}`).join('；') : '暂无无损或检修结论'}`
    ]
  };
}
function buildCompositeAIReport(trendData, composite) {
  const rank = { '正常': 1, '关注': 2, '预警': 3, '高危': 4, '立即更换预警': 4, '接近理论厚度·提前更换预警': 4 };
  const score = Math.min(4, (rank[trendData.status] || 2) + composite.riskAdditions);
  const compositeRisk = score >= 4 ? '高危' : score >= 3 ? '预警' : score >= 2 ? '关注' : '正常';
  const hardnessText = composite.hardnessHistory.length
    ? composite.hardnessHistory.map(p => `${p.date}：${p.value}HB（${p.source}）`).join('\n')
    : '暂无硬度历史';
  const metallographyText = composite.metallography.length
    ? composite.metallography.map(e => `${e.date}：${e.type}，${e.desc}`).join('\n')
    : '暂无金相组织记录';
  const inspectionText = composite.inspectionEvents.length
    ? composite.inspectionEvents.map(e => `${e.date}：${e.type}，${e.desc}`).join('\n')
    : '暂无无损/割管/检修结论';
  const evidenceText = composite.evidenceSummary.map(item => `- ${item}`).join('\n');
  const report = `【AI综合分析判断】\n综合风险：${compositeRisk}\n综合证据：\n${evidenceText}\n\n硬度历史：\n${hardnessText}\n硬度预测：${composite.hardnessForecast ? `${composite.hardnessForecast.direction}，1年 ${composite.hardnessForecast.oneYear}HB，3年 ${composite.hardnessForecast.threeYear}HB，置信度 ${composite.hardnessForecast.confidence}%` : `数据不足，${composite.hardnessTrend}`}\n\n金相组织/材料劣化证据：\n${metallographyText}\n\n无损检测与检修结论：\n${inspectionText}\n\n综合判断逻辑：减薄趋势给出寿命下限，当前厚度与理论阈值决定承压裕量；硬度变化用于识别材料软化、硬化或热影响异常；金相组织、裂纹、蠕变、脱碳、球化等记录用于校正单纯测厚无法覆盖的材料劣化风险。大模型深度分析会基于以上证据给出机理、复检范围和检修优先级，不会编造未录入的现场数据。`;
  return { compositeRisk, score, hardnessText, metallographyText, inspectionText, evidenceText, report };
}
function assessReplacementWarning(current, thresholdInfo) {
  const threshold = Number(thresholdInfo?.threshold);
  const value = Number(current);
  if(current === null || current === undefined || current === '' || !thresholdInfo?.matched || threshold <= 0 || !Number.isFinite(threshold) || !Number.isFinite(value)) return { level: 'unknown', label: '无法判定更换预警', margin: null };
  const margin = value - threshold;
  const nearLimit = 0.2;
  if(margin <= 0) return { level: 'replace', label: '立即更换预警', margin };
  if(margin <= nearLimit + 1e-9) return { level: 'replace-soon', label: '接近理论厚度·提前更换预警', margin };
  return { level: 'normal', label: '高于理论厚度下限', margin };
}
/* 行业经验先验减薄速率（mm/y）：单测点无法拟合趋势时的兜底，随本管实测积累自动退位。
   区间含义：slow=同类机组偏慢、fast=偏快；均为占位经验值，可按电厂实际修订。 */
const PRIOR_THINNING_RATES = {
  SLB: { slow: 0.05, fast: 0.15 }, RSH: { slow: 0.03, fast: 0.08 }, WSH: { slow: 0.03, fast: 0.08 },
  DGRQ: { slow: 0.05, fast: 0.12 }, DPGRQ: { slow: 0.06, fast: 0.15 }, HPGRQ: { slow: 0.08, fast: 0.18 },
  GGRQ: { slow: 0.08, fast: 0.20 }, DZRQ: { slow: 0.05, fast: 0.12 }, GZRQ: { slow: 0.08, fast: 0.20 },
  SMQ: { slow: 0.03, fast: 0.08 }
};
/* 材质级先验速率（优先于受热面默认值）：合金成分决定抗氧化/腐蚀能力，减薄速度差异可达数倍 */
const PRIOR_RATE_MATERIAL_RULES = [
  { match: /tp347|tp304|304h|347h|tp321/i, label: '奥氏体不锈钢', slow: 0.03, fast: 0.08 },
  { match: /t91|t92|p91|p92|x10crmovnb|grade 9/i, label: '马氏体耐热钢(T91级)', slow: 0.04, fast: 0.10 },
  { match: /12cr1mo|15crmo|10crmo|t22|t12|2\.25cr|crmo/i, label: '低合金铬钼钢', slow: 0.05, fast: 0.12 },
  { match: /20g|sa-210|a210|st45|碳钢/i, label: '碳钢', slow: 0.06, fast: 0.18 }
];
/* 材质典型硬度参考区间（HB，母材供货态，依据标准/工程资料 2026-10 核实）：
   奥氏体: ASME SA-213 规定 ≤192 HBW（TP304H 192HB/200HV/90HRB max），下限为典型供货值；
   T91级: ASME SA-213 规定 ≤250 HBW；工程下限 180 HBW（P91 母材 180~250HB，见 CN104634679B 及焊接工艺文献）；
   铬钼钢: GB/T 5310 12Cr1MoVG 退火/高温回火态 ≤179 HBW，正火+回火供货典型 135~180；
   碳钢: 20# ≤156 HBS（GB/T 699 供货），SA-210C 标准上限 ≤179 HB、典型供货 130~160。 */
const HARDNESS_MATERIAL_REFERENCE = [
  { match: /tp347|tp304|304h|347h|tp321/i, label: '奥氏体不锈钢', low: 140, high: 192, direction: '稳定（时效硬化极缓）', rate: '约 ±0.5 HB/年' },
  { match: /t91|t92|p91|p92|x10crmovnb|grade 9/i, label: '马氏体耐热钢(T91级)', low: 180, high: 250, direction: '稳定（回火马氏体，变化缓慢）', rate: '约 ±0.5 HB/年' },
  { match: /12cr1mo|15crmo|10crmo|t22|t12|2\.25cr|crmo/i, label: '低合金铬钼钢', low: 135, high: 180, direction: '缓慢软化（珠光体球化）', rate: '约 -0.3~-1 HB/年' },
  { match: /20g|sa-210|a210|st45|碳钢/i, label: '碳钢', low: 120, high: 160, direction: '软化（球化为主）', rate: '约 -0.5~-2 HB/年' }
];
function getHardnessMaterialRef(material) {
  const text = String(material || '').trim();
  if(!text) return null;
  for(let i = 0; i < HARDNESS_MATERIAL_REFERENCE.length; i += 1) {
    if(HARDNESS_MATERIAL_REFERENCE[i].match.test(text)) return HARDNESS_MATERIAL_REFERENCE[i];
  }
  return null;
}
function hardnessPriorHint(code) {
  const material = getTubeMaterialText(code);
  const ref = getHardnessMaterialRef(material);
  if(!ref) return '';
  return `；按材质「${material}」（${ref.label}）经验：典型趋势${ref.direction}，${ref.rate}（先验参考，需复测确认）`;
}
function getTubeMaterialText(code) {
  try {
    const list = (userDB.events || []).filter(e => e.code === code && e.material);
    if(list.length) return String(list[list.length - 1].material).trim();
  } catch (err) { /* 忽略 */ }
  return '';
}
function getPriorThinningRates(code, materialHint) {
  const material = String(materialHint || getTubeMaterialText(code) || '');
  for(let i = 0; i < PRIOR_RATE_MATERIAL_RULES.length; i += 1) {
    const rule = PRIOR_RATE_MATERIAL_RULES[i];
    if(rule.match.test(material)) return { slow: rule.slow, fast: rule.fast, label: rule.label, basis: 'material' };
  }
  const sys = String(code || '').split('-')[1]?.toUpperCase() || '';
  return { ...(PRIOR_THINNING_RATES[sys] || { slow: 0.05, fast: 0.15 }), label: '', basis: 'surface' };
}
/* 两年后劣化预测：实测模式用基准/加速速率，先验模式用先验区间；统一输出区间+裕量+是否触阈 */
function buildTwoYearForecast(current, threshold, slowRate, fastRate, basis) {
  if(current === null || current === undefined || !Number.isFinite(Number(current))) return null;
  const currentVal = Number(current);
  const twoYearHigh = currentVal - slowRate * 2;  /* 偏慢情景 → 壁厚偏高 */
  const twoYearLow = currentVal - fastRate * 2;   /* 偏快情景 → 壁厚偏低 */
  const mid = (twoYearHigh + twoYearLow) / 2;
  const thresh = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : null;
  return {
    basis, /* 'measured' | 'prior' */
    wallHigh: twoYearHigh, wallLow: twoYearLow, wallMid: mid,
    margin: thresh !== null ? twoYearLow - thresh : null,
    touchesThreshold: thresh !== null ? twoYearLow <= thresh : null,
    certainlyBelow: thresh !== null ? twoYearHigh <= thresh : null
  };
}
function formatTwoYearText(twoYear) {
  if(!twoYear) return '--';
  const line = `两年后壁厚 ${twoYear.wallLow.toFixed(2)}~${twoYear.wallHigh.toFixed(2)}mm` + (twoYear.basis === 'prior' ? '（先验）' : '');
  if(twoYear.margin === null) return line;
  return line + (twoYear.certainlyBelow ? '，将低于预警阈值' : twoYear.touchesThreshold ? `，偏快情景将触阈（裕量 ${twoYear.margin.toFixed(2)}mm）` : `，裕量 ${twoYear.margin.toFixed(2)}mm`);
}

function predictThicknessTrendFromHistory(code, history, pipeType) {
  const sorted = [...history].filter(p => positiveThickness(p.val) !== null && p.year !== null && Number.isFinite(Number(p.year))).map(p => ({...p, val: Number(p.val), year: Number(p.year)})).sort((a,b) => a.year - b.year);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const thresholdInfo = resolveTubeTheoryThreshold(code, pipeType);
  const threshold = thresholdInfo.threshold;
  const currentValue = sorted[sorted.length - 1]?.val ?? null;
  const replacementWarning = assessReplacementWarning(currentValue, thresholdInfo);
  if(sorted.length < 2 || !thresholdInfo.matched) {
    const quality = assessPredictionQuality(sorted);
    const compositeSignals = collectAICompositeSignals(code, sorted);
    const status = ['replace','replace-soon'].includes(replacementWarning.level) ? replacementWarning.label : (sorted.length === 1 && thresholdInfo.matched ? '先验预估' : '数据不足');

    /* 单测点 + 规格已匹配：用行业先验速率给出区间预测（含两年后劣化），明确标注非本管实测 */
    if(sorted.length === 1 && thresholdInfo.matched) {
      const prior = getPriorThinningRates(code);
      const priorMedian = (prior.slow + prior.fast) / 2;
      const horizonEnd = Math.ceil(last.year + 6);
      const prediction = [];
      for(let y = Math.ceil(last.year) + 1; y <= horizonEnd; y += 1) {
        const dt = y - last.year;
        const p50 = last.val - priorMedian * dt;
        const band = Math.max(0.03, (prior.fast - prior.slow) * dt / 2);
        prediction.push({ year: y, val: parseFloat(p50.toFixed(2)), low: parseFloat((p50 - band).toFixed(2)), high: parseFloat((p50 + band).toFixed(2)) });
      }
      const slowYear = yearWhenCrosses(last.year, last.val, threshold, prior.slow);
      const fastYear = yearWhenCrosses(last.year, last.val, threshold, prior.fast);
      const medianYear = yearWhenCrosses(last.year, last.val, threshold, priorMedian);
      const twoYear = buildTwoYearForecast(last.val, threshold, prior.slow, prior.fast, 'prior');
      const trendData = { target: code, current: currentValue, threshold, thresholdInfo, replacementWarning,
        rateValue: priorMedian, rate: `${prior.slow.toFixed(2)}~${prior.fast.toFixed(2)} mm/y（行业先验${prior.basis === 'material' ? '·' + prior.label : ''}）`, rul: null, rulText: '先验区间', conf: 20, status,
        history: sorted, prediction, twoYear,
        thresholdYear: Number.isFinite(slowYear) && Number.isFinite(fastYear) ? `${fastYear.toFixed(0)}~${slowYear.toFixed(0)}（先验）` : '未触及（先验）',
        p50ThresholdYear: Number.isFinite(medianYear) ? medianYear.toFixed(0) + '（先验）' : '未触及',
        acceleratedThresholdYear: Number.isFinite(fastYear) ? fastYear.toFixed(0) + '（先验）' : '未触及',
        baselineThresholdYear: Number.isFinite(slowYear) ? slowYear.toFixed(0) + '（先验）' : '未触及',
        outliers: [], quality, reliable: false, priorBased: true,
        modelName: '行业先验速率区间（单测点兜底）' };
      const composite = buildCompositeAIReport(trendData, compositeSignals);
      return { ...trendData, compositeRisk: composite.compositeRisk, compositeScore: composite.score, compositeSignals, composite,
        report: `仅有 1 个测点，无法拟合本管趋势；${prior.basis === 'material' ? `按材质「${getTubeMaterialText(code) || prior.label}」（${prior.label}）行业先验速率 ${prior.slow.toFixed(2)}~${prior.fast.toFixed(2)} mm/y 预估` : `按受热面行业先验速率 ${prior.slow.toFixed(2)}~${prior.fast.toFixed(2)} mm/y 预估（未识别材质，可录入材质后细化）`}。
${formatTheoryDetails(thresholdInfo)}
${replacementWarning.label}
两年后预估：${formatTwoYearText(twoYear)}。
※ 先验结论仅供参考，积累 2 个及以上测点后自动切换为实测趋势。

${composite.report}` };
    }

    const trendData = { target: code, current: currentValue, threshold, thresholdInfo, replacementWarning,
      rateValue: null, rate: '不可可靠预测', rul: null, rulText: '不可可靠预测', conf: 0, status,
      history: sorted, prediction: [], thresholdYear: '不可可靠预测', p50ThresholdYear: '不可可靠预测',
      acceleratedThresholdYear: '不可可靠预测', baselineThresholdYear: '不可可靠预测', outliers: [], quality, reliable: false,
      modelName: 'Theil-Sen + 近期窗口 + 三情景' };
    const composite = buildCompositeAIReport(trendData, compositeSignals);
    return { ...trendData, compositeRisk: composite.compositeRisk, compositeScore: composite.score, compositeSignals, composite,
      report: `不可可靠预测：${thresholdInfo.reason || '有效测厚历史不足2个时点'}。
${formatTheoryDetails(thresholdInfo)}
${replacementWarning.label}

${composite.report}` };
  }
  const model = robustTheilSenModel(sorted);
  const robustRate = Math.max(0, -model.slope);
  const recentPoints = sorted.slice(-Math.min(4, sorted.length));
  const recentModel = robustTheilSenModel(recentPoints);
  const recentRate = Math.max(0, -recentModel.slope);
  const averageRate = Math.max(0, (first.val - last.val) / Math.max(0.25, last.year - first.year));
  const conservativeRate = Math.max(robustRate * 0.5 + recentRate * 0.3 + averageRate * 0.2, 0);
  const p50Rate = Math.max(robustRate, 0);
  const acceleratedRate = Math.max(conservativeRate * 1.35, p50Rate * 1.2, 0.001);
  const residualBand = Math.max(0.05, model.mad * 1.4826);
  const outliers = sorted.filter((point, index) => Math.abs(model.residuals[index]) > Math.max(0.18, residualBand * 2.5));
  const quality = assessPredictionQuality(sorted, outliers.length);
  const p50Year = yearWhenCrosses(last.year, last.val, threshold, p50Rate);
  const conservativeYear = yearWhenCrosses(last.year, last.val, threshold, conservativeRate);
  const acceleratedYear = yearWhenCrosses(last.year, last.val, threshold, acceleratedRate);
  const reliable = Boolean(quality.reliable && thresholdInfo.matched);
  const horizonEnd = Math.min(Math.ceil(Math.max(last.year + 4, Number.isFinite(conservativeYear) ? conservativeYear : last.year + 8)), Math.ceil(last.year + 12));
  const prediction = [];
  for(let y = Math.ceil(last.year) + 1; y <= horizonEnd; y += 1) {
    const dt = y - last.year;
    const p50 = last.val - p50Rate * dt;
    const band = residualBand + Math.max(0.03, Math.abs(conservativeRate - p50Rate) * dt);
    prediction.push({ year: y, baseline: Math.max(0, last.val - conservativeRate * dt), accelerated: Math.max(0, last.val - acceleratedRate * dt), val: parseFloat(p50.toFixed(2)), low: parseFloat((p50 - band).toFixed(2)), high: parseFloat((p50 + band).toFixed(2)) });
  }
  if(prediction.length === 0) prediction.push({ year: Math.ceil(last.year + 1), val: last.val, low: last.val - residualBand, high: last.val + residualBand });
  const yearsToThreshold = Number.isFinite(conservativeYear) ? Math.max(0, conservativeYear - last.year) : Infinity;
  const status = ['replace','replace-soon'].includes(replacementWarning.level) ? replacementWarning.label : !reliable ? '数据不足' : yearsToThreshold <= 1 ? '高危' : yearsToThreshold <= 3 ? '预警' : yearsToThreshold <= 6 ? '关注' : '正常';
  const confidence = reliable ? quality.score : Math.min(54, quality.score);
  const rulHours = Number.isFinite(yearsToThreshold) ? Math.max(0, Math.round(yearsToThreshold * 8000)) : 999999;
  const thresholdYearText = reliable && Number.isFinite(conservativeYear) ? conservativeYear.toFixed(1) : '不可可靠预测';
  const twoYear = buildTwoYearForecast(last.val, threshold, conservativeRate, acceleratedRate, 'measured');
  const trendReport = `【稳健壁厚减薄趋势预测】\n对象：${code}\n模型：Theil-Sen鲁棒趋势 + 近期窗口 + 三情景退化\n\n数据质量：${quality.points} 个测点，时间跨度 ${quality.span.toFixed(1)} 年，置信度 ${confidence}%\n${reliable ? '' : '结论：当前数据不足以支持可靠寿命预测，仅作趋势筛查。'}\n\n测厚历史：\n${sorted.map(p => `${p.dateStr}：${p.val}mm（${p.source || '记录'}）`).join('\n')}\n\n规格预警阈值：${threshold.toFixed(2)}mm\n阈值来源：${thresholdInfo.source}\n\n趋势预测结果：\n- 当前壁厚：${last.val}mm\n- 稳健减薄速率：${robustRate.toFixed(3)} mm/y\n- 近期减薄速率：${recentRate.toFixed(3)} mm/y\n- 偏乐观评估速率：${conservativeRate.toFixed(3)} mm/y\n- 偏保守速率（防加速劣化）：${acceleratedRate.toFixed(3)} mm/y\n- 最可能触阈（P50）：${Number.isFinite(p50Year) ? p50Year.toFixed(1) : '未触及'} 年\n- 偏乐观估计触阈：${Number.isFinite(conservativeYear) ? conservativeYear.toFixed(1) : '未触及'} 年\n- 偏保守估计触阈（防最坏情况）：${Number.isFinite(acceleratedYear) ? acceleratedYear.toFixed(1) : '未触及'} 年\n- 异常候选测点：${outliers.length ? outliers.map(p => p.dateStr).join('、') : '未识别明显异常'}\n${twoYear ? '两年后预测：' + formatTwoYearText(twoYear) : ''}\n\n诊断提示：预测不能替代现场检验；若存在裂纹、鼓包、泄漏、严重蠕变或阈值未匹配，应立即转专业寿命评估。`;
  const trendData = {
    target: code, current: last.val, threshold, thresholdInfo, replacementWarning, rateValue: conservativeRate, rate: `${conservativeRate.toFixed(3)} mm/y`, rul: reliable ? rulHours : null,
    rulText: reliable ? (rulHours >= 999999 ? '>999,999' : rulHours.toLocaleString()) : '不可可靠预测', conf: confidence, status, history: sorted, prediction,
    twoYear,
    thresholdYear: thresholdYearText, p50ThresholdYear: Number.isFinite(p50Year) ? p50Year.toFixed(1) : '未触及', acceleratedThresholdYear: Number.isFinite(acceleratedYear) ? acceleratedYear.toFixed(1) : '未触及',
    baselineThresholdYear: Number.isFinite(conservativeYear) ? conservativeYear.toFixed(1) : '未触及', outliers, quality, reliable, modelName: 'Theil-Sen + 近期窗口 + 三情景'
  };
  const compositeSignals = collectAICompositeSignals(code, sorted);
  const composite = buildCompositeAIReport(trendData, compositeSignals);
  return { ...trendData, compositeRisk: composite.compositeRisk, compositeScore: composite.score, compositeSignals, composite, report: `${formatTheoryDetails(thresholdInfo)}\n更换判定：${replacementWarning.label}；实测 ${last.val}mm，裕量 ${replacementWarning.margin.toFixed(2)}mm，提前预警裕量≤0.20mm。\n${trendReport}\n\n${composite.report}` };
}function buildTrendAnalysisPrompt(data) {
  return `炉管综合寿命风险大模型深度分析。\n\n分析对象：${data.target}\n\n测厚历史：\n${data.history.map(p => `- ${p.dateStr}: ${p.val}mm (${p.source || '记录'})`).join('\n')}\n\n趋势预测结果：\n- 当前壁厚：${data.current}mm\n- 保守年化减薄速率：${data.rate}\n- 对应规格理论厚度预警值：${data.threshold === null ? '未匹配，不可可靠预测' : data.threshold + 'mm'}\n- ${formatTheoryDetails(data.thresholdInfo)}\n- 更换预警：${data.replacementWarning.label}\n- 阈值来源：${data.thresholdInfo?.source || '未匹配'}\n- 最可能触阈年份（P50）：${data.p50ThresholdYear}\n- 偏乐观估计触阈年份：${data.thresholdYear}（留有余量的估算，不代表概率保证）\n- 偏乐观触阈估算小时：${data.rulText}h\n- 趋势评级：${data.status}\n- 本地综合风险：${data.compositeRisk || data.status}\n- 数据置信度：${data.conf}%\n\n硬度历史：\n${data.composite?.hardnessText || '暂无硬度历史'}\n硬度预测：${data.compositeSignals?.hardnessForecast ? `${data.compositeSignals.hardnessForecast.direction}，1年 ${data.compositeSignals.hardnessForecast.oneYear}HB，3年 ${data.compositeSignals.hardnessForecast.threeYear}HB，置信度 ${data.compositeSignals.hardnessForecast.confidence}%` : '数据不足，不能可靠预测'}\n\n金相组织/材料劣化证据：\n${data.composite?.metallographyText || '暂无金相组织记录'}\n\n无损检测、割管取样和检修结论：\n${data.composite?.inspectionText || '暂无无损/割管/检修结论'}\n\n请调用大模型专家能力，在不编造现场数据的前提下，综合减薄趋势、当前厚度、硬度变化、金相组织、裂纹/蠕变/脱碳/球化等证据，输出该炉管综合风险等级、主要失效机理、相邻管排排查范围、复测项目、检修优先级和需要补充的数据。`;
}
async function runDeepAIAnalysisFromTrend(data) {
  const promptBox = document.getElementById('llm-prompt');
  if(promptBox) promptBox.value = buildTrendAnalysisPrompt(data);
  const aiLLMBox = document.getElementById('ai-llm-report');
  if(aiLLMBox) aiLLMBox.textContent = '正在复用总览模型配置，调用大模型进行综合分析...';
  setLLMStatus('AI模块正在调用大模型综合分析...', 'info');
  try {
    const evidenceText = buildTrendAnalysisPrompt(data);
    const text = await callLLMChatCompletions(evidenceText, 2200);
    if(window.__activeTubeAnalysis !== data) return;
    const audit = auditLLMText(text, evidenceText);
    const notice = auditLLMNotice(audit);
    if(aiLLMBox) aiLLMBox.textContent = (notice ? notice + '\n\n' : '') + text;
    renderLLMResult(text);
    if(notice) prependLLMNotice(notice, audit && !audit.ok && !audit.skipped ? 'warn' : 'ok');
    if(audit && !audit.ok && !audit.skipped) {
      setLLMStatus('AI模块分析完成，但发现 ' + audit.count + ' 处数值无本地依据，请核对。', 'warn');
      setAIVisibilityStatus('本地预测已完成；大模型报告中存在无本地依据的数值，请核对后再引用。', 'warn');
    } else {
      setLLMStatus('AI模块大模型综合分析完成。', 'ok');
      setAIVisibilityStatus('本地预测与大模型综合分析均已完成。', 'info');
    }
  } catch (err) {
    if(window.__activeTubeAnalysis !== data) return;
    const message = formatLLMError(err, 'AI大模型调用');
    if(aiLLMBox) aiLLMBox.textContent = message;
    renderLLMResult(message);
    setLLMStatus('AI模块大模型调用失败，详情见结果框。', 'error');
    setAIVisibilityStatus('本地预测已完成，但大模型调用失败；请查看下方错误说明。', 'warn');
  }
}
function scrollToAIResults() {
  const box = document.getElementById('ai-results');
  if(!box) return;
  requestAnimationFrame(() => setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40));
}
function setAIVisibilityStatus(text, level = 'info') {
  const box = document.getElementById('ai-visibility-status');
  if(!box) return;
  box.className = `alert alert-${level}`;
  box.innerHTML = `<strong>预测模型结果</strong><span>${escapeHTML(text)}</span>`;
}
function analyzeTubeDetails(code) {
  const info = resolveMaterialTheoryThickness(code, selectedTubePipeType(code));
  document.getElementById('ai-custom-target').value = code;
  document.getElementById('ai-pipe-type').value = info.pipeType || '';
  return runAIAnalysis(code, info.pipeType || '');
}
function changeAnalysisPipeType(value) {
  const code = document.getElementById('ai-custom-target').value.trim().toUpperCase() || document.getElementById('ai-target').value;
  if(!code) return;
  window.__tubePipeTypes = { ...window.__tubePipeTypes, [code]: value };
  for(const id of ['searchResult', 'lcContent']) {
    const box = document.getElementById(id);
    if(box?.querySelector('.tube-detail h3')?.textContent.includes(code)) box.innerHTML = buildTubeProfileHTML(code, { context: id === 'lcContent' ? 'lifecycle' : 'search', pipeType: value });
  }
  renderDashboardWarnings();
  return runAIAnalysis(code, value);
}
async function runAIAnalysis(explicitTarget, pipeType) {
  const manualTarget = document.getElementById('ai-custom-target')?.value.trim().toUpperCase();
  const target = explicitTarget || manualTarget || document.getElementById('ai-target').value;
  if(!target) { showToast('请选择或输入管段编码。', 'warn'); return; }
  pipeType = pipeType ?? (document.getElementById('ai-pipe-type').value || selectedTubePipeType(target));
  const history = extractThicknessData(target, { includeSystem: false });
  const data = predictThicknessTrendFromHistory(target, history, pipeType);
  window.__activeTubeAnalysis = data;
  setAIVisibilityStatus('本地预测模型已完成：正在展示壁厚/硬度趋势、理论阈值与风险判定。', 'info');
  document.getElementById('ai-pipe-type').value = data.thresholdInfo.pipeType || '';
  renderAIResults(data);
  scrollToAIResults();
  const report = document.getElementById('ai-llm-report');
  const config = getLLMFormConfig();
  if(config.baseUrl && config.apiKey && config.model) {
    await runDeepAIAnalysisFromTrend(data);
  } else {
    if(report) report.textContent = '本地预测模型已完成分析；大模型接口未配置，未发起远程请求。';
    setAIVisibilityStatus('本地预测已完成；远程大模型未配置，当前结果可直接用于现场判定。', 'info');
  }
  return data;
}

function renderHardnessChart(data) {
  const svg = document.getElementById('hardnessChart');
  const signal = data.compositeSignals;
  if(!svg || !signal) return;
  const points = signal.hardnessHistory.map(p => ({ ...p, year: new Date(p.date).getFullYear() + new Date(p.date).getMonth() / 12 })).filter(p => Number.isFinite(p.value));
  const label = document.getElementById('hardnessTrendLabel');
  const one = document.getElementById('hardnessOneYear');
  const three = document.getElementById('hardnessThreeYear');
  const conf = document.getElementById('hardnessConfidence');
  if(label) label.textContent = signal.hardnessForecast ? `${signal.hardnessForecast.direction} · ${signal.hardnessRate.toFixed(1)} HB/年` : '数据不足，不能可靠预测';
  if(one) one.textContent = signal.hardnessForecast ? `${signal.hardnessForecast.oneYear} HB` : '--';
  if(three) three.textContent = signal.hardnessForecast ? `${signal.hardnessForecast.threeYear} HB` : '--';
  if(conf) conf.textContent = signal.hardnessForecast ? `${signal.hardnessForecast.confidence}%` : '--';
  if(points.length < 1) { svg.innerHTML = '<text x="24" y="44" fill="var(--chart-label)" font-size="14">暂无硬度数据</text>'; return; }
  const width=980,height=260,p={top:30,right:28,bottom:42,left:58}; const vals=points.map(x=>x.value).concat(signal.hardnessForecast ? [signal.hardnessForecast.oneYear,signal.hardnessForecast.threeYear] : []); const min=Math.min(...vals)-10,max=Math.max(...vals)+10; const minY=Math.min(...points.map(x=>x.year)), maxY=Math.max(...points.map(x=>x.year), points[points.length-1].year + (signal.hardnessForecast ? 3 : 1), minY+1); const xs=y=>p.left+(y-minY)/Math.max(1,maxY-minY)*(width-p.left-p.right); const ys=v=>p.top+(height-p.top-p.bottom)-((v-min)/Math.max(1,max-min))*(height-p.top-p.bottom); const path=points.map((x,i)=>`${i?'L':'M'} ${xs(x.year)} ${ys(x.value)}`).join(' '); const materialRef = getHardnessMaterialRef(getTubeMaterialText(data.target));
  const hardnessVerdict = signal.hardnessForecast ? `趋势判断：${signal.hardnessForecast.direction}，${signal.hardnessRate.toFixed(1)} HB/年（置信度 ${signal.hardnessForecast.confidence}%）；预计 1 年后 ${signal.hardnessForecast.oneYear} HB、3 年后 ${signal.hardnessForecast.threeYear} HB${materialRef ? '；' + materialRef.label + '典型区间 ' + materialRef.low + '~' + materialRef.high + 'HB' : ''}` : (points.length ? `趋势判断：硬度记录仅 ${points.length} 条（需 3 条以上），暂无法可靠判断${materialRef ? '；按材质（' + materialRef.label + '）经验：' + materialRef.direction + '，' + materialRef.rate : ''}，建议补充检测` : '趋势判断：暂无硬度数据');
  svg.innerHTML=`<rect x="${p.left}" y="${p.top}" width="${width-p.left-p.right}" height="${height-p.top-p.bottom}" rx="6" fill="var(--chart-panel)" stroke="var(--chart-panel-stroke)"/><text x="${p.left}" y="18" fill="var(--chart-title)" font-size="14" font-weight="700">硬度趋势预测（HB）</text><text x="${p.left}" y="34" fill="var(--chart-label)" font-size="11">${hardnessVerdict}</text><path d="${path}" fill="none" stroke="var(--chart-orange)" stroke-width="3"/>${points.map(x=>`<circle cx="${xs(x.year)}" cy="${ys(x.value)}" r="5" fill="var(--chart-dot-fill)" stroke="var(--chart-orange)" stroke-width="2"><title>${x.date} ${x.value}HB</title></circle>`).join('')}<line x1="${p.left}" y1="${ys(points[points.length-1].value)}" x2="${width-p.right}" y2="${ys(points[points.length-1].value)}" stroke="var(--chart-orange)" stroke-opacity="0.25" stroke-dasharray="5 5"/><text x="${p.left-8}" y="${p.top+4}" text-anchor="end" fill="var(--chart-label)" font-size="11">${max.toFixed(0)}</text><text x="${p.left-8}" y="${height-p.bottom+4}" text-anchor="end" fill="var(--chart-label)" font-size="11">${min.toFixed(0)}</text>`;
  for(let year = Math.ceil(minY); year <= maxY; year++) svg.innerHTML += `<text x="${xs(year)}" y="${height-12}" text-anchor="middle" fill="var(--chart-label)" font-size="11">${year}</text>`;
  if(signal.hardnessForecast) {
    const y0 = points[points.length - 1].year;
    const v0 = points[points.length - 1].value;
    const fp = Array.isArray(signal.hardnessForecast.points) && signal.hardnessForecast.points.length
      ? signal.hardnessForecast.points
      : [{ year: y0 + 1, val: signal.hardnessForecast.oneYear, low: signal.hardnessForecast.oneYear, high: signal.hardnessForecast.oneYear },
         { year: y0 + 2, val: Math.round((signal.hardnessForecast.oneYear + signal.hardnessForecast.threeYear) / 2), low: 0, high: 0 },
         { year: y0 + 3, val: signal.hardnessForecast.threeYear, low: signal.hardnessForecast.threeYear, high: signal.hardnessForecast.threeYear }];
    /* 不确定性区间带：由实测残差(MAD)外推，随时间展宽 */
    const bandTop = [{ x: xs(y0), y: ys(v0) }].concat(fp.map(pt => ({ x: xs(pt.year), y: ys(pt.high) })));
    const bandBottom = [{ x: xs(y0), y: ys(v0) }].concat(fp.map(pt => ({ x: xs(pt.year), y: ys(pt.low) }))).reverse();
    const bandPoints = bandTop.concat(bandBottom).map(pt => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    const pathD = [{ x: xs(y0), y: ys(v0) }].concat(fp.map(pt => ({ x: xs(pt.year), y: ys(pt.val) })))
      .map((pt, i) => `${i ? 'L' : 'M'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
    svg.innerHTML += `<polygon points="${bandPoints}" fill="var(--chart-violet)" fill-opacity="0.13" stroke="none"/>` +
      `<path d="${pathD}" fill="none" stroke="var(--chart-violet)" stroke-width="3" stroke-dasharray="8 5"/>` +
      fp.map((pt, i) => `<circle cx="${xs(pt.year)}" cy="${ys(pt.val)}" r="4" fill="var(--chart-violet)"><title>${(pt.year - y0).toFixed(0)}年后预测 ${pt.val} HB${pt.low !== pt.high ? `（区间 ${pt.low}~${pt.high}）` : ''}</title></circle>` +
        `<text x="${xs(pt.year)}" y="${ys(pt.val) - 10}" text-anchor="middle" fill="var(--chart-violet)" font-size="10">${(pt.year - y0).toFixed(0)}年 ${pt.val}</text>`).join('') +
      `<text x="${xs(y0) + 6}" y="${ys(v0) + 16}" fill="var(--chart-violet)" font-size="10">┄ 预测（带=不确定性区间）</text>`;
  }
  if(materialRef && Number.isFinite(ys(materialRef.high)) && Number.isFinite(ys(materialRef.low))) {
    const yTop = ys(materialRef.high), yBottom = ys(materialRef.low);
    if(yTop < height - p.bottom && yBottom > p.top) {
      const clipTop = Math.max(p.top, yTop), clipBottom = Math.min(height - p.bottom, yBottom);
      svg.innerHTML += `<rect x="${p.left}" y="${clipTop.toFixed(1)}" width="${width - p.left - p.right}" height="${Math.max(2, clipBottom - clipTop).toFixed(1)}" fill="var(--chart-grid)" fill-opacity="0.14" stroke="var(--chart-label)" stroke-opacity="0.25" stroke-dasharray="4 4"/><text x="${width - p.right}" y="${(clipTop - 4).toFixed(1)}" text-anchor="end" fill="var(--chart-label)" font-size="10">${materialRef.label}典型 ${materialRef.low}~${materialRef.high}HB（参考）</text>`;
    }
  }

}function renderAIResults(data) {
  document.getElementById('ai-loading').style.display = 'none';
  document.getElementById('ai-results').style.display = 'block';
  document.getElementById('ai-rul').textContent = data.rulText || data.rul.toLocaleString();
  document.getElementById('ai-rate').textContent = data.rate;
  const twoYearEl = document.getElementById('ai-twoyear');
  if(twoYearEl) {
    twoYearEl.textContent = data.twoYear ? formatTwoYearText(data.twoYear) : '--';
    twoYearEl.style.color = data.twoYear?.certainlyBelow ? 'var(--danger)' : data.twoYear?.touchesThreshold ? 'var(--warn)' : 'var(--ok)';
  }
  const thresholdEl = document.getElementById('ai-threshold-detail');
  if(thresholdEl) thresholdEl.textContent = formatTheoryDetails(data.thresholdInfo);
  document.getElementById('ai-conf').textContent = data.conf;
  document.getElementById('ai-status').textContent = data.status;
  document.getElementById('ai-status').style.color = data.status === '正常' ? 'var(--ok)' : data.status === '关注' ? 'var(--warn)' : 'var(--danger)';
  const compositeEl = document.getElementById('ai-composite');
  const replacementEl = document.getElementById('ai-replacement-warning');
  if(replacementEl) { replacementEl.textContent = data.replacementWarning?.label || '无法判定更换预警'; replacementEl.style.color = data.replacementWarning?.level === 'normal' ? 'var(--ok)' : data.replacementWarning?.level === 'unknown' ? 'var(--warn)' : 'var(--danger)'; }
  if(compositeEl) {
    compositeEl.textContent = data.compositeRisk || data.status;
    compositeEl.style.color = data.compositeRisk === '正常' ? 'var(--ok)' : data.compositeRisk === '关注' ? 'var(--warn)' : 'var(--danger)';
  }
  renderAIChart(data);
  renderHardnessChart(data);
  document.getElementById('ai-report-text').textContent = data.report || '不可可靠预测';
}
function renderThicknessHistoryOnly(data) {
  const svg = document.getElementById('aiChart'), points = data.history;
  const minYear = points[0].year, span = Math.max(1, points[points.length-1].year - minYear);
  const min = Math.max(0, Math.min(...points.map(p => p.val))-0.4), max = Math.max(...points.map(p => p.val))+0.4;
  const x = y => 76 + (y-minYear)/span*720, y = v => 350-(v-min)/(max-min)*260;
  svg.innerHTML = `<text x="24" y="30" fill="var(--chart-orange)" font-size="14">不可可靠预测 · 仅展示实测历史，不生成临时阈值或预测线</text><path d="${points.map((p,i) => `${i?'L':'M'} ${x(p.year)} ${y(p.val)}`).join(' ')}" fill="none" stroke="var(--chart-accent)" stroke-width="3"/>${points.map(p => `<circle cx="${x(p.year)}" cy="${y(p.val)}" r="5" fill="var(--chart-accent)"><title>${escapeHTML(p.dateStr || p.year)} ${p.val}mm</title></circle><text x="${x(p.year)}" y="380" fill="var(--chart-label)" font-size="12">${p.year}</text>`).join('')}`;
}
function renderAIChart(data) {
  if(!document.getElementById('aiChart')) return;
  if(!data || !Array.isArray(data.history) || data.history.length === 0) { document.getElementById('aiChart').innerHTML = '<text x="24" y="44" fill="var(--chart-label)" font-size="14">暂无可绘制的测厚数据</text>'; return; }
  if(!Number.isFinite(data.threshold)) { renderThicknessHistoryOnly(data); return; }
  const svg = document.getElementById('aiChart');
  svg.innerHTML = '';
  const width = 980, height = 420, padding = { top: 56, right: 230, bottom: 62, left: 76 };
  const chartW = width - padding.left - padding.right, chartH = height - padding.top - padding.bottom;
  const allPoints = [...data.history, ...data.prediction];
  const minYear = Math.floor(Math.min(...allPoints.map(p => p.year)));
  const numericP50 = parseFloat(data.p50ThresholdYear);
  const numericP90 = parseFloat(data.thresholdYear);
  const markerYears = [numericP50, numericP90].filter(y => Number.isFinite(y) && y <= data.history[data.history.length-1].year + 12);
  const maxYear = Math.ceil(Math.max(...allPoints.map(p => p.year), ...markerYears));
  const allVals = [
    data.threshold,
    ...data.history.map(p => p.val),
    ...data.prediction.flatMap(p => [p.val, p.low, p.high, p.baseline, p.accelerated].filter(Number.isFinite))
  ];
  const minVal = Math.max(0, Math.min(...allVals) - 0.4);
  const maxVal = Math.max(...allVals) + 0.4;
  const xScale = (year) => padding.left + ((year - minYear) / Math.max(1, maxYear - minYear)) * chartW;
  const yScale = (val) => padding.top + chartH - ((val - minVal) / Math.max(0.1, maxVal - minVal)) * chartH;
  const plotRight = width - padding.right, plotBottom = height - padding.bottom;
  svg.innerHTML += `<defs>
    <linearGradient id="aiBand" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" style="stop-color:var(--chart-green-soft)"/><stop offset="100%" style="stop-color:var(--chart-accent-faint)"/></linearGradient>
    <linearGradient id="riskZone" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" style="stop-color:var(--chart-red-zone-1)"/><stop offset="100%" style="stop-color:var(--chart-red-zone-2)"/></linearGradient>
    <linearGradient id="panelFill" x1="0" x2="1"><stop offset="0%" style="stop-color:var(--chart-panel-1)"/><stop offset="100%" style="stop-color:var(--chart-panel-2)"/></linearGradient>
    <filter id="aiGlow"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
  svg.innerHTML += `<rect x="${padding.left}" y="${padding.top}" width="${chartW}" height="${chartH}" rx="6" fill="var(--chart-panel)" stroke="var(--chart-panel-stroke)" />`;
  const threshY = yScale(data.threshold);
  svg.innerHTML += `<rect x="${padding.left}" y="${threshY}" width="${chartW}" height="${Math.max(0, plotBottom - threshY)}" fill="url(#riskZone)" />`;
  for(let i=0; i<=5; i++) {
    const y = padding.top + (chartH / 5) * i, val = maxVal - ((maxVal - minVal) / 5) * i;
    svg.innerHTML += `<line x1="${padding.left}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="var(--chart-grid)" stroke-opacity="0.14" stroke-width="1" /><text x="${padding.left-12}" y="${y+4}" fill="var(--chart-label)" font-size="11" text-anchor="end">${val.toFixed(1)}</text>`;
  }
  for(let y = minYear; y <= maxYear; y++) {
    const x = xScale(y);
    svg.innerHTML += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${plotBottom}" stroke="var(--chart-grid)" stroke-opacity="0.08" stroke-width="1" /><text x="${x}" y="${height - 22}" fill="var(--chart-label)" font-size="11" text-anchor="middle">${y}</text>`;
  }
  svg.innerHTML += `<line x1="${padding.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="var(--chart-grid)" stroke-opacity="0.36" /><line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${plotBottom}" stroke="var(--chart-grid)" stroke-opacity="0.36" />`;
  svg.innerHTML += `<text x="${padding.left}" y="28" fill="var(--chart-title)" font-size="15" font-weight="700">壁厚减薄趋势预测</text><text x="${padding.left}" y="45" fill="var(--chart-label)" font-size="11">单位 mm · 预警阈值按材料库规格匹配</text><text x="22" y="${padding.top + 14}" fill="var(--chart-label)" font-size="11" transform="rotate(-90 22 ${padding.top + 14})">厚度 / mm</text>`;
  const bandTop = data.prediction.map(p => `${xScale(p.year)},${yScale(p.high)}`).join(' ');
  const bandBottom = [...data.prediction].reverse().map(p => `${xScale(p.year)},${yScale(p.low)}`).join(' ');
  if(data.prediction.length > 1) svg.innerHTML += `<polygon points="${bandTop} ${bandBottom}" fill="url(#aiBand)" stroke="var(--chart-green-line)" stroke-width="1" />`;
  svg.innerHTML += `<line x1="${padding.left}" y1="${threshY}" x2="${plotRight}" y2="${threshY}" stroke="var(--chart-red)" stroke-width="2.4" stroke-dasharray="10 8" stroke-linecap="butt" />`;
  svg.innerHTML += `<text x="${padding.left + 8}" y="${Math.max(padding.top + 14, threshY - 8)}" fill="var(--chart-red-soft)" font-size="11" font-weight="700">理论阈值 ${data.threshold.toFixed(2)}mm</text>`;
  const histPath = data.history.map((p, i) => `${i===0?'M':'L'} ${xScale(p.year)} ${yScale(p.val)}`).join(' ');
  svg.innerHTML += `<path d="${histPath}" fill="none" stroke="var(--chart-accent)" stroke-width="3.4" filter="url(#aiGlow)" />`;
  data.history.forEach(p => {
    const isOutlier = data.outliers?.some(o => o.dateStr === p.dateStr && o.val === p.val);
    svg.innerHTML += `<circle cx="${xScale(p.year)}" cy="${yScale(p.val)}" r="${isOutlier ? 6.5 : 5.5}" fill="var(--chart-dot-fill)" stroke="${isOutlier ? 'var(--chart-orange)' : 'var(--chart-accent)'}" stroke-width="2.5" style="cursor:pointer"><title>${p.dateStr} ${p.val}mm ${isOutlier ? '异常候选' : ''}</title></circle>`;
  });
  const lastHist = data.history[data.history.length - 1];
  const predPath = `M ${xScale(lastHist.year)} ${yScale(lastHist.val)} ` + data.prediction.map(p => `L ${xScale(p.year)} ${yScale(p.val)}`).join(' ');
  svg.innerHTML += `<path d="${predPath}" fill="none" stroke="var(--chart-green)" stroke-width="3.2" stroke-dasharray="10,6" filter="url(#aiGlow)" />`;
  data.prediction.forEach(p => svg.innerHTML += `<circle cx="${xScale(p.year)}" cy="${yScale(p.val)}" r="4.3" fill="var(--chart-green)"><title>${p.year} 最可能 ${p.val}mm；区间 ${p.low}~${p.high}mm</title></circle>`);
  for(const [key, color, label] of [['baseline','var(--chart-orange)','偏乐观情景'],['accelerated','var(--chart-red)','偏保守情景']]) {
    const points = data.prediction.filter(point => Number.isFinite(point[key]));
    if(points.length) svg.innerHTML += `<path d="M ${xScale(lastHist.year)} ${yScale(lastHist.val)} ${points.map(point => `L ${xScale(point.year)} ${yScale(point[key])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 5"><title>${label}</title></path>`;
  }
  const currentX = xScale(lastHist.year), currentY = yScale(lastHist.val);
  if(['replace','replace-soon'].includes(data.replacementWarning?.level)) svg.innerHTML += `<circle cx="${currentX}" cy="${currentY}" r="10" fill="none" stroke="var(--chart-red)" stroke-width="3"><title>${escapeHTML(data.replacementWarning.label)}</title></circle>`;
  svg.innerHTML += `<line x1="${currentX}" y1="${currentY}" x2="${currentX + 54}" y2="${currentY - 34}" stroke="var(--chart-accent)" stroke-opacity="0.48" /><rect x="${currentX + 56}" y="${currentY - 52}" width="126" height="34" rx="5" fill="var(--chart-tip-bg)" stroke="var(--chart-tip-stroke)" /><text x="${currentX + 66}" y="${currentY - 31}" fill="var(--chart-title)" font-size="11">当前 ${lastHist.val.toFixed(2)}mm</text>`;
  if(Number.isFinite(numericP50) && numericP50 <= maxYear) {
    const x = xScale(numericP50);
    svg.innerHTML += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${plotBottom}" stroke="var(--chart-green)" stroke-opacity="0.38" stroke-width="1.5" stroke-dasharray="4,5" /><text x="${x+6}" y="${padding.top+16}" fill="var(--chart-green)" font-size="11">最可能 ${data.p50ThresholdYear}</text>`;
  }
  if(Number.isFinite(numericP90) && numericP90 <= maxYear) {
    const x = xScale(numericP90);
    svg.innerHTML += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${plotBottom}" stroke="var(--chart-orange)" stroke-opacity="0.68" stroke-width="2" stroke-dasharray="7,5" /><rect x="${Math.min(x + 8, plotRight - 150)}" y="${plotBottom - 36}" width="142" height="26" rx="5" fill="var(--chart-accent-soft)" stroke="var(--chart-orange)" stroke-opacity="0.48" /><text x="${Math.min(x + 16, plotRight - 142)}" y="${plotBottom - 18}" fill="var(--chart-orange)" font-size="11" font-weight="700">偏乐观触阈估算 ${data.thresholdYear}</text>`;
  }
  const panelX = plotRight + 22;
  svg.innerHTML += `<rect x="${panelX}" y="${padding.top}" width="184" height="204" rx="8" fill="url(#panelFill)" stroke="var(--chart-panel-stroke)" />`;
  svg.innerHTML += `<text x="${panelX + 14}" y="${padding.top + 26}" fill="var(--chart-title)" font-size="13" font-weight="700">预测模型参数</text>`;
  const panelRows = [
    ['方法', 'Theil-Sen + MAD'],
    ['风险评级', data.status],
    ['减薄速率', data.rate],
    ['预警阈值', `${data.threshold.toFixed(2)} mm`],
    ['最可能触阈年', data.p50ThresholdYear],
    ['偏乐观触阈年', data.thresholdYear],
    ['置信度', `${data.conf}%`]
  ];
  panelRows.forEach((row, index) => {
    const y = padding.top + 52 + index * 20;
    svg.innerHTML += `<text x="${panelX + 14}" y="${y}" fill="var(--chart-label)" font-size="10">${row[0]}</text><text x="${panelX + 92}" y="${y}" fill="var(--chart-title)" font-size="10" font-weight="700">${escapeHTML(row[1])}</text>`;
  });
  const hoverPoints = [
    ...data.history.map(p => ({ year: p.year, val: p.val, label: `${p.dateStr} · 实测 ${p.val}mm` })),
    ...data.prediction.map(p => ({ year: p.year, val: p.val, label: `${p.year} · 最可能 ${p.val}mm` }))
  ];
  const tipW = 158, tipH = 30;
  svg.innerHTML += `<g id="aiChartHover" opacity="0" pointer-events="none">
    <line y1="${padding.top}" y2="${plotBottom}" stroke="var(--chart-hover-line)" stroke-width="1" stroke-dasharray="3 3" />
    <circle r="5" fill="var(--chart-dot-fill)" stroke="var(--chart-accent-2)" stroke-width="2" filter="url(#aiGlow)" />
    <rect rx="5" ry="5" width="${tipW}" height="${tipH}" fill="var(--chart-tip-bg)" stroke="var(--chart-tip-stroke)" />
    <text id="aiChartTipText" fill="var(--chart-tip-val)" font-size="11" font-weight="700" text-anchor="middle"></text>
  </g>
  <rect id="aiChartHit" x="${padding.left}" y="${padding.top}" width="${chartW}" height="${chartH}" fill="transparent" style="cursor:crosshair" />`;
  const hover = svg.querySelector('#aiChartHover');
  const hit = svg.querySelector('#aiChartHit');
  if(hover && hit) {
    const cross = hover.querySelector('line');
    const marker = hover.querySelector('circle');
    const tipRect = hover.querySelector('rect');
    const tipText = svg.querySelector('#aiChartTipText');
    const showAt = (point) => {
      const px = xScale(point.year), py = yScale(point.val);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px);
      marker.setAttribute('cx', px); marker.setAttribute('cy', py);
      let tx = px - tipW / 2;
      tx = Math.max(padding.left, Math.min(plotRight - tipW, tx));
      const ty = Math.max(padding.top + 2, py - tipH - 10);
      tipRect.setAttribute('x', tx); tipRect.setAttribute('y', ty);
      tipText.setAttribute('x', tx + tipW / 2); tipText.setAttribute('y', ty + 19);
      tipText.textContent = point.label;
      hover.setAttribute('opacity', '1');
    };
    const nearestPoint = (evt) => {
      const rect = svg.getBoundingClientRect();
      const vx = ((evt.clientX - rect.left) / rect.width) * width;
      let best = hoverPoints[0], bestD = Infinity;
      hoverPoints.forEach(p => { const d = Math.abs(xScale(p.year) - vx); if(d < bestD) { bestD = d; best = p; } });
      return best;
    };
    hit.addEventListener('mousemove', evt => showAt(nearestPoint(evt)));
    hit.addEventListener('mouseleave', () => hover.setAttribute('opacity', '0'));
    hit.addEventListener('touchstart', evt => { if(evt.touches.length) showAt(nearestPoint(evt.touches[0])); }, { passive: true });
    hit.addEventListener('touchmove', evt => { if(evt.touches.length) showAt(nearestPoint(evt.touches[0])); evt.preventDefault(); }, { passive: false });
    hit.addEventListener('touchend', () => setTimeout(() => hover.setAttribute('opacity', '0'), 1600));
  }
}
function typeWriter(elementId, text, speed = 20) { const el = document.getElementById(elementId); el.innerHTML = ''; let i = 0; const cursor = '<span class="ai-cursor"></span>'; function type() { if (i < text.length) { el.innerHTML = text.substring(0, i + 1).replace(/\n/g, '<br>') + cursor; i++; setTimeout(type, speed); } else { el.innerHTML = text.replace(/\n/g, '<br>'); } } type(); }
function generateMockAIData(target, model) { if (model === 'thickness') { return { current: 7.1, threshold: 5.5, rate: '0.085 mm/y', rul: 18500, conf: 92, status: '关注', history: [{year:2018,val:8.0},{year:2020,val:7.8},{year:2023,val:7.4},{year:2025,val:7.1}], prediction: [{year:2026,val:6.9},{year:2028,val:6.5},{year:2030,val:6.1},{year:2032,val:5.7},{year:2033,val:5.5}], report: `【AI 壁厚减薄趋势分析报告】\n对象：${target}\n模型：LSTM 时序预测网络 + 物理约束\n\n1. 趋势分析：历史数据显示该管段壁厚呈非线性减薄趋势，近3年劣化速率从 0.05mm/y 加速至 0.085mm/y，表明内壁可能存在轻微的酸性腐蚀或外壁高温氧化加剧。\n2. 寿命预测：根据当前轨迹，预计将于 2032年底 触及设计最小壁厚阈值(5.5mm)。\n3. 剩余寿命(RUL)：折算运行小时数约 18,500 小时。\n4. AI 建议：建议在下次A级检修中对该管段及同屏相邻管进行超声波测厚(UT)复测，并检查烟气侧是否存在局部冲刷磨损。若减薄速率持续>0.1mm/y，请提前列入更换计划。` }; } else { return { current: 68, threshold: 90, rate: '1.2 %/y', rul: 22000, conf: 88, status: '预警', history: [{year:2018,val:10},{year:2020,val:25},{year:2023,val:45},{year:2025,val:68}], prediction: [{year:2026,val:75},{year:2028,val:82},{year:2030,val:88},{year:2031,val:90}], report: `【AI 蠕变损伤评估报告】\n对象：${target}\n模型：Larson-Miller 参数融合神经网络\n\n1. 损伤评估：当前蠕变损伤度已达 68%，进入加速蠕变阶段(第三阶段)。金相组织可能已出现明显的碳化物球化和晶界微裂纹。\n2. 趋势预测：预计在未来 5 年内损伤度将突破 90% 的安全红线。\n3. AI 建议：立即安排现场金相复型检验，重点关注热影响区(HAZ)。建议降低该区域管段的运行壁温控制设定值 5-10℃，以延缓蠕变进程。` }; } }

const ZONES = { qdp: {title:'全大屏过热器', sys:'DPGRQ', spec:'Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91', count:'6片×4小屏', desc:'位于炉膛上方，全辐射式受热面。工作条件极为恶劣，屏底外圈采用 SA-213T91 耐热钢。', params:'吸收炉膛高温辐射热 | 烟气侧易结渣 | 需重点监控夹持管状态'}, hp: {title:'后屏/屏式过热器', sys:'HPGRQ', spec:'Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG', count:'21屏', desc:'布置于炉膛出口处，辐射对流式受热面。最外圈及包扎管底部采用奥氏体不锈钢 TP347H。', params:'承受炉膛出口高温烟气冲刷 | 易发生高温腐蚀 | 节距 S1=685.8'}, gg: {title:'高温过热器 (高过)', sys:'GGRQ', spec:'Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG', count:'32片', desc:'悬吊于水平烟道内，顺列顺流布置。12管圈U形绕制，暴露在最外侧的管子采用 TP304H。', params:'蒸汽温度最高区 | 烟气流向转折区 | 需防范管排晃动磨损'}, gz: {title:'高温再热器 (高再)', sys:'GZRQ', spec:'Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG', count:'64片', desc:'位于水平烟道后部，7根管圈绕制。入口设有喷水减温器，控制再热汽温。', params:'带喷水减温控制 | 烟气温度开始下降 | 管间由带状机械管夹定位'}, dwgr: {title:'低温过热器 (低过)', sys:'DGRQ', spec:'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', count:'112排', desc:'布置于尾部竖井前烟道，顺列逆流布置。水平段分4组，留有检修空间。', params:'入口烟温 876.6℃ | 出口烟温 382.7℃ | 压降 -0.3kPa | 易积灰'}, dwzr: {title:'低温再热器 (低再)', sys:'DZRQ', spec:'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', count:'112片+56片', desc:'布置于尾部竖井后烟道，与低过并列。水平段5组，垂直段每2排并1排。', params:'入口烟温 840.3℃ | 出口烟温 349.4℃ | 压降 -0.2kPa | 支撑块承重'}, scr: {title:'SCR 脱硝反应器', sys:'SCR', spec:'氨注射栅格 + 催化剂', count:'A/B侧', desc:'位于尾部烟道下方，喷氨格栅将氨气与烟气均匀混合，通过催化剂还原 NOx。', params:'入口NOx ~278 mg/Nm³ | 出口NOx 25.1 mg/Nm³ | 脱硝效率 99.9% | 氨逃逸 <3ppm'}, smq: {title:'省煤器', sys:'SMQ', spec:'Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G', count:'124管', desc:'分上、下两级串联布置于烟气挡板之后的下行竖井内，利用尾部烟气余热加热锅炉给水，降低排烟温度。', params:'上/下两级分级串联 | 烟温 287.5℃ → 289.0℃ | 易发生低温腐蚀与飞灰磨损'} };
function showZone(z) { const info = ZONES[z]; const el = document.getElementById('zoneDetail'); el.style.display = 'block'; el.innerHTML = `<div class="card-title"><span class="badge badge-ww">${info.sys}</span> ${info.title}</div><div class="info-grid"><div class="info-item"><div class="k">规格/材质</div><div class="v">${info.spec}</div></div><div class="info-item"><div class="k">数量/规模</div><div class="v">${info.count}</div></div><div class="info-item" style="grid-column:span 2;"><div class="k">湛江#1机组 实时运行参数</div><div class="v" style="font-size:13px; color:var(--warn);">${info.params}</div></div><div class="info-item" style="grid-column:span 2;"><div class="k">工艺与防磨防爆描述</div><div class="v" style="font-size:12px;">${info.desc}</div></div></div>`; el.scrollIntoView({behavior:'smooth', block:'nearest'}); }

// ========== AI 数据助手桥接（assistant-v1.js 复用，不得改变既有行为） ==========
const ASSISTANT_EDIT_FIELDS = ['date', 'code', 'type', 'desc', 'thickness', 'hardness', 'spec', 'material'];
const ASSISTANT_EDIT_FIELD_LABELS = { date: '日期', code: '管段编码', type: '事件类型', desc: '描述', thickness: '厚度', hardness: '硬度', spec: '规格', material: '材质' };

function normalizeAssistantDateText(value) {
  const text = String(value ?? '').trim();
  if(!text) return null;
  const match = text.match(/^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?$/);
  if(!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if(!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if(month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if(date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function updateEventRecord(ts, field, value) {
  const key = String(field ?? '').trim();
  if(ASSISTANT_EDIT_FIELDS.indexOf(key) < 0) return { ok: false, error: `不支持的字段：${field || '空'}` };
  const target = userDB.events.find(record => Number(record.ts) === Number(ts));
  if(!target) return { ok: false, error: '没有找到这条记录，可能已被删除，请重新查询。' };
  let next = String(value ?? '').trim();
  if(key === 'date') {
    const normalized = normalizeAssistantDateText(next);
    if(!normalized) return { ok: false, error: '日期无法识别，请使用 YYYY-MM-DD 格式。' };
    next = normalized;
  } else if(key === 'thickness') {
    const num = Number(next);
    if(!Number.isFinite(num) || num < 0.1 || num > 100) return { ok: false, error: '厚度必须是 0.1 ~ 100 之间的数字（mm）。' };
    next = String(num);
  } else if(key === 'hardness') {
    const num = Number(next);
    if(!Number.isFinite(num) || num < 1 || num > 600) return { ok: false, error: '硬度必须是 1 ~ 600 之间的数字（HB）。' };
    next = String(num);
  } else if(key === 'code') {
    next = next.toUpperCase();
    if(!isValidTubeCodeStructure(next)) return { ok: false, error: '管段编码格式不正确，示例：2G-SLB-WB-F000-R025-Q16。' };
    const boiler = getBoilerFromCode(next);
    if(boiler) target.boiler = boiler;
  } else if(!next) {
    return { ok: false, error: `${ASSISTANT_EDIT_FIELD_LABELS[key]}不能为空。` };
  }
  const before = String(target[key] ?? '');
  if(before === next) return { ok: true, unchanged: true, before, after: next, record: target };
  target[key] = next;
  saveDB();
  mlog('update', { record: target, field: key, before, after: next });
  return { ok: true, unchanged: false, before, after: next, record: target };
}

function collectAssistantSnapshot(options = {}) {
  const events = Array.isArray(userDB.events) ? userDB.events : [];
  const replacements = Array.isArray(userDB.replacements) ? userDB.replacements : [];
  let materialLibrary = [];
  try { materialLibrary = getMaterialLibrary() || []; } catch (err) { materialLibrary = []; }
  let warnings = [];
  try { warnings = collectDashboardWarnings({ limit: 500 }) || []; } catch (err) { warnings = []; }
  let overdueRows = [];
  try {
    const year = Number(document.getElementById('maintenanceCycleStart')?.value) || new Date().getFullYear();
    overdueRows = buildMaintenanceOverdueRows(year, 'all') || [];
  } catch (err) { overdueRows = []; }
  let retiredCodes = [];
  try { retiredCodes = [...collectRetiredTubeCodes()]; } catch (err) { retiredCodes = []; }
  const snapshot = {
    events,
    replacements,
    materialLibrary,
    matrix: Array.isArray(matrix) ? matrix : [],
    retiredCodes,
    warnings,
    overdueRows,
    ledgerRows: [],
    role: getAssistantRole(),
    session: currentAuthSession || null,
    now: new Date().toISOString()
  };
  if(options.withLedger) {
    try { snapshot.ledgerRows = getGeneratedTubeLedgerRows(options.boiler || 'all') || []; } catch (err) { snapshot.ledgerRows = []; }
  }
  return snapshot;
}

function getAssistantRole() {
  try {
    const forced = new URLSearchParams(location.search || '').get('assistantRole');
    if(forced === 'viewer' || forced === 'editor' || forced === 'admin') return forced;
  } catch (err) { /* 非标准环境忽略 */ }
  const role = currentAuthSession && currentAuthSession.role;
  if(role === 'admin') return 'admin';
  if(role === 'viewer') return 'viewer';
  // 已登录的普通账号或本地离线模式：数据都在本机，按编辑权限处理
  return 'editor';
}

// ========== INIT ==========
initNav();
animateCounters();
buildBarChart();
populateCodeGeneratorOptions();
genCode();
renderComponent('ww');
renderHeaders();
loadLifecycle();
renderMatrix();
renderDataManagerTables();
updateLifecycleDropdown();
populateAIThicknessTargets();
loadLLMConfigToForm();
renderDashboardWarnings(); syncDashboardSnapshot();
renderMaintenancePlan();
loadAuthSession();
bootstrapCloudStorage();
refreshLLMServerStatus();
runLLMVisualAnalysis();
applyDemoDataToggle();
