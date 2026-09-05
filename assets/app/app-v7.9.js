
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
  if(remoteUserDB?.found && remoteUserDB.value && typeof remoteUserDB.value === 'object') {
    userDB = remoteUserDB.value;
    localStorage.setItem('boiler_user_db', JSON.stringify(userDB));
    changed = true;
  }
  if(remoteMaterialLibrary?.found && Array.isArray(remoteMaterialLibrary.value)) {
    localStorage.setItem('boiler_material_library', JSON.stringify(remoteMaterialLibrary.value));
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
    renderDMTable();
    updateLifecycleDropdown();
    populateAIThicknessTargets();
    renderDashboardWarnings();
    syncDashboardSnapshot();
    renderMaintenancePlan();
    renderComponent('ww');
    const activeComp = document.querySelector('.comp-tab.active')?.dataset.comp || 'ww';
    renderMaterialLibrary(activeComp);
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
function saveDB() { localStorage.setItem('boiler_user_db', JSON.stringify(userDB)); queueCloudStorageSave('boiler_user_db', userDB); renderDMTable(); updateLifecycleDropdown(); populateAIThicknessTargets(); renderDashboardWarnings(); syncDashboardSnapshot(); }
function getBoilerFromCode(code) {
  const match = String(code || '').trim().match(/^([12])-/);
  return match ? match[1] : '';
}
function normalizeBoiler(value) {
  const match = String(value || '').trim().match(/[12]/);
  return match ? match[0] : '';
}
function getBatchBoilerFilter() {
  return document.getElementById('dm-batch-boiler')?.value || 'all';
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
  const code = document.getElementById('dm-code').value.trim().toUpperCase();
  const spec = document.getElementById('dm-spec').value.trim();
  const material = document.getElementById('dm-material').value.trim();
  const thickness = document.getElementById('dm-thickness').value.trim();
  const hardness = document.getElementById('dm-hardness').value.trim();
  const type = document.getElementById('dm-type').value;
  const date = document.getElementById('dm-date').value;
  const desc = document.getElementById('dm-desc').value.trim();
  if(!boiler || !code || !date || !desc) { showToast('请填写机组、管段编码、日期和详细数据/结论', 'warn'); return; }
  if(getBoilerFromCode(code) && getBoilerFromCode(code) !== boiler) { showToast('所选机组与管段编码开头不一致，请核对。', 'warn'); return; }
  userDB.events.push({boiler, code, spec, material, thickness, hardness, type, date, desc, ts: Date.now()});
  saveDB();
  showToast('保存成功，请前往【管段综合分析】验证', 'ok');
  ['dm-code','dm-spec','dm-material','dm-thickness','dm-hardness','dm-desc'].forEach(id => document.getElementById(id).value = '');
}
function addReplacement() {
  const boiler = document.getElementById('dm-rep-boiler').value;
  const oldCode = document.getElementById('dm-oldcode').value.trim().toUpperCase();
  const newCode = document.getElementById('dm-newcode').value.trim().toUpperCase();
  const reason = document.getElementById('dm-reason').value.trim();
  const date = document.getElementById('dm-rep-date').value;
  if(!boiler || !oldCode || !newCode || !date) { showToast('请填写机组、旧管段编码、新管段编码和更换日期', 'warn'); return; }
  if((getBoilerFromCode(oldCode) && getBoilerFromCode(oldCode) !== boiler) || (getBoilerFromCode(newCode) && getBoilerFromCode(newCode) !== boiler)) { showToast('所选机组与旧/新管段编码开头不一致，请核对。', 'warn'); return; }
  userDB.replacements.push({boiler, oldCode, newCode, reason, date, ts: Date.now()});
  userDB.events.push({boiler, code: oldCode, type: '报废更换', date, desc: `更换为 ${newCode}，原因：${reason}`, ts: Date.now()});
  userDB.events.push({boiler, code: newCode, type: '安装投运', date, desc: `替换 ${oldCode}，继承历史`, ts: Date.now()});
  saveDB();
  showToast('更换登记成功', 'ok');
}
function renderDMTable() { const tbody = document.getElementById('dm-table-body'); if(!tbody) return; const filter = getBatchBoilerFilter(); const all = [...userDB.events].filter(r => filter === 'all' || eventBoiler(r) === filter).sort((a,b) => b.ts - a.ts); tbody.innerHTML = all.map(r => `<tr><td>${escapeHTML(r.date)}</td><td>${escapeHTML(eventBoiler(r) || '-')}号</td><td style="color:var(--accent)">${escapeHTML(r.code)}</td><td>${escapeHTML(r.spec || '-')}</td><td style="font-family:inherit">${escapeHTML(r.material || '-')}</td><td>${escapeHTML(r.thickness || '-')}</td><td>${escapeHTML(r.hardness || '-')}</td><td><span class="badge badge-sh">${escapeHTML(r.type)}</span></td><td style="font-family:inherit; max-width:300px; white-space:normal;">${escapeHTML(r.desc)}</td><td><button class="btn btn-outline" style="padding:2px 8px; font-size:11px; border-color:var(--danger); color:var(--danger);" onclick="deleteEvent(${Number(r.ts)})">删除</button></td></tr>`).join('') || '<tr><td colspan="10" style="text-align:center; padding:20px;">暂无数据</td></tr>'; }
function deleteEvent(ts) { if(confirm('确定删除？')) { userDB.events = userDB.events.filter(e => e.ts !== ts); saveDB(); } }
const EVENT_CSV_COLUMNS = ['数据分类','炉号','日期','管段编码','规格','材质','厚度(mm)','硬度(HB)','事件类型/更换原因','关联新管码','详细描述/结论'];
function downloadCSVTemplate() {
  const rows = [
    EVENT_CSV_COLUMNS.join(','),
    ['事件','1','2022-04-15','1-WW-FR-015-0042-000','Φ63.5×7.5','SA-210C','7.10','185','测厚','','标高18m处壁厚7.10mm'].map(csvEscape).join(','),
    ['事件','2','2024-05-20','2-HSH-E-012-0005-W02','Φ51×8','SA-213T91','6.90','210','测厚','','高过入口第12屏第5管测厚6.90mm'].map(csvEscape).join(','),
    ['更换','1','2026-05-22','1-WW-FL-010-0005-000','','','','','爆管更换','1-WW-FL-010-0005-000-R1','运行中发生泄漏，紧急割管更换'].map(csvEscape).join(',')
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
function importCSV(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
      if (lines.length < 2) { showToast('CSV 文件为空', 'warn'); return; }
      
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

      const headers = parseCSVLine(lines[0]).map(item => item.replace(/^\uFEFF/, '').trim());
      const hasNewColumns = headers.includes('炉号') && headers.includes('厚度(mm)');
      const batchFilter = getBatchBoilerFilter();
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

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length < 5) continue;
        
        const category = cols[0].trim();
        const boiler = normalizeBoiler(hasNewColumns ? cols[1] : getBoilerFromCode(cols[2] || ''));
        const date = (hasNewColumns ? cols[2] : cols[1] || '').trim();
        const code = (hasNewColumns ? cols[3] : cols[2] || '').trim().toUpperCase();
        const spec = hasNewColumns ? (cols[4] || '').trim() : '';
        const material = hasNewColumns ? (cols[5] || '').trim() : '';
        const thickness = hasNewColumns ? (cols[6] || '').trim() : '';
        const hardness = hasNewColumns ? (cols[7] || '').trim() : '';
        const typeOrReason = (hasNewColumns ? cols[8] : cols[3] || '').trim();
        const relatedCode = (hasNewColumns ? cols[9] : cols[4] || '').trim().toUpperCase();
        const desc = hasNewColumns ? ((cols[10] || '').trim()) : (cols[5] ? cols[5].trim() : '');
        const ts = Date.now() + i; 
        const rowBoiler = boiler || getBoilerFromCode(code) || getBoilerFromCode(relatedCode);
        const codeMismatch = (getBoilerFromCode(code) && rowBoiler && getBoilerFromCode(code) !== rowBoiler) || (relatedCode && getBoilerFromCode(relatedCode) && rowBoiler && getBoilerFromCode(relatedCode) !== rowBoiler);
        const filterMismatch = batchFilter !== 'all' && rowBoiler !== batchFilter;
        if(!rowBoiler || codeMismatch || filterMismatch) {
          skipBoilerMismatch++;
          continue;
        }

        if (category === '事件' || category === 'event') {
          const eventRecord = { boiler: rowBoiler, code, spec, material, thickness, hardness, type: typeOrReason, date, desc, ts };
          if (!isEventExist(eventRecord)) {
              userDB.events.push(eventRecord);
              importEvents++;
          } else {
              skipDuplicates++;
          }
        } else if (category === '更换' || category === 'replacement') {
          const replacementBoiler = rowBoiler;
          if (!isReplacementExist(replacementBoiler, code, relatedCode, date, typeOrReason)) {
              userDB.replacements.push({ boiler: replacementBoiler, oldCode: code, newCode: relatedCode, reason: typeOrReason, date, ts });
              
              const 报废desc = `更换为新管 ${relatedCode}，原因：${typeOrReason}`;
              const 报废event = { boiler: replacementBoiler, code: code, type: '报废更换', date, desc: 报废desc, ts: ts + 0.1 };
              if(!isEventExist(报废event)) {
                  userDB.events.push(报废event);
              }
              const 投运desc = `替换旧管 ${code}，继承历史数据`;
              const 投运event = { boiler: replacementBoiler, code: relatedCode, type: '安装投运', date, desc: 投运desc, ts: ts + 0.2 };
              if(!isEventExist(投运event)) {
                  userDB.events.push(投运event);
              }
              importReplacements++;
          } else {
              skipDuplicates++;
          }
        }
      }
      saveDB();
      showToast(`导入完成：新增事件 ${importEvents} 条、更换 ${importReplacements} 条，跳过重复 ${skipDuplicates} 条${skipBoilerMismatch ? `、机组不匹配 ${skipBoilerMismatch} 条` : ''}`, 'ok', 6000);
    } catch (err) {
      console.error(err);
      showToast('CSV 解析失败，请检查文件格式是否正确。', 'error');
    }
  };
  reader.readAsText(file, 'UTF-8'); event.target.value = '';
}

function backupLocalData() { const backup = JSON.stringify({ version: 'v6.7-local-backup', exportedAt: new Date().toISOString(), data: userDB }, null, 2); downloadBlob(`锅炉本地数据备份_${new Date().toISOString().slice(0,10)}.json`, backup, 'application/json;charset=utf-8;'); }
function clearLocalData() { const total = userDB.events.length + userDB.replacements.length; if(total === 0) { showToast('当前没有可清空的本地数据', 'info'); return; } if(confirm(`即将清空 ${total} 条本地数据。清空前将自动导出备份，是否继续？`) && confirm('请再次确认：备份下载后将清空浏览器本地数据。')) { backupLocalData(); userDB = {events:[], replacements:[]}; saveDB(); showToast(`已备份并清空 ${total} 条本地数据`, 'ok'); } }

// ========== DATA (基础数据库) ==========
const COMPONENTS = { ww: { name: '炉膛水冷壁', sys: 'WW', badge: 'badge-ww', spec: 'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat: '按材料库分项', count: 722, detail: {'前墙':'192根','后墙':'192根','侧墙':'169*2根','循环回路':'24个'} }, rsh: { name: '顶棚过热器', sys: 'RSH', badge: 'badge-sh', spec: 'Φ159×18 20G、Φ48.5×6 15CrMoG', mat: '按材料库分项', count: 128, detail: {'区域':'顶棚 CE','屏/排':'1排','管数':'128根'} }, wsh: { name: '包墙过热器', sys: 'WSH', badge: 'badge-sh', spec: 'Φ51×6 12Cr1MoVG、Φ51×7 12Cr1MoVG、Φ63.5×12 12Cr1MoVG', mat: '按材料库分项', count: 260, detail: {'区域':'前/后/侧包墙','屏/排':'1排','管数':'260根'} }, lsh: { name: '低温过热器', sys: 'LSH', badge: 'badge-sh', spec: 'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', mat: '按材料库分项', count: 112, detail: {'排数':'112排','管圈':'5根','布置':'顺列逆流'} }, psh: { name: '全大屏过热器', sys: 'PSH', badge: 'badge-sh', spec: 'Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91', mat: '按材料库分项', count: '6片', detail: {'小屏':'4小屏/片','管数':'14根/小屏'} }, 'hsh-p': { name: '屏式过热器', sys: 'ISH', badge: 'badge-sh', spec: 'Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG', mat: '按材料库分项', count: 21, detail: {'屏数':'21屏','管数':'13根/屏'} }, hsh: { name: '高温过热器', sys: 'HSH', badge: 'badge-sh', spec: 'Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG', mat: '按材料库分项', count: 32, detail: {'片数':'32片','管圈':'12管圈'} }, lrh: { name: '低温再热器', sys: 'LRH', badge: 'badge-rh', spec: 'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', mat: '按材料库分项', count: 112, detail: {'水平':'112片','垂直':'56片'} }, hrh: { name: '高温再热器', sys: 'HRH', badge: 'badge-rh', spec: 'Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG', mat: '按材料库分项', count: 64, detail: {'片数':'64片','管圈':'7管圈'} }, eco: { name: '省煤器', sys: 'ECO', badge: 'badge-eco', spec: 'Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G', mat: '按材料库分项', count: 124, detail: {'管数':'124根'} } };
const MATERIAL_LIBRARY_KEY = 'boiler_material_library';
const MATERIAL_COMPONENT_BY_TAB = { ww:'炉膛水冷壁', rsh:'顶棚过热器', wsh:'包墙过热器', lsh:'低温过热器', psh:'全大屏过热器', 'hsh-p':'屏式过热器', hsh:'高温过热器', lrh:'低温再热器', hrh:'高温再热器', eco:'省煤器' };
const MATERIAL_COLUMNS = ['部件名称','系统代码','分段/位置','结构形式','规格型号','管径','壁厚','材质','库存根数','库存总长度(m)','预留位置','备注'];
const MATERIAL_LIBRARY = [
  { component:'省煤器', sys:'ECO', position:'1 省煤器蛇形管', shape:'蛇形管', spec:'Φ51×6', diameter:'51', wallThickness:'6', material:'SA-210C', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号1；直管附加壁厚0.6mm，弯管附加壁厚1.7475mm' },
  { component:'省煤器', sys:'ECO', position:'2 省煤器吊挂管', shape:'吊挂管', spec:'Φ60×9', diameter:'60', wallThickness:'9', material:'SA-210C', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号2；直管附加壁厚0.9mm，弯管附加壁厚1.872mm' },
  { component:'省煤器', sys:'ECO', position:'3 省煤器至锅筒连接管', shape:'连接管', spec:'Φ159×18', diameter:'159', wallThickness:'18', material:'20G', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号3；直管附加壁厚1.4mm，弯管附加壁厚3.11mm' },
  { component:'炉膛水冷壁', sys:'WW', position:'4 水冷壁管', shape:'直管', spec:'Φ63.5×7.5', diameter:'63.5', wallThickness:'7.5', material:'SA-210C', inUseQty:'722根', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号4；直管附加壁厚0.75mm，弯管附加壁厚1.29mm' },
  { component:'顶棚过热器', sys:'RSH', position:'5 汽包至顶棚连接管', shape:'连接管', spec:'Φ159×18', diameter:'159', wallThickness:'18', material:'20G', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号5；直管附加壁厚1.4mm，弯管附加壁厚3.11mm' },
  { component:'炉膛水冷壁', sys:'WW', position:'6 下水连接管', shape:'连接管', spec:'Φ159×18', diameter:'159', wallThickness:'18', material:'20G', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号6；直管附加壁厚1.4mm，弯管附加壁厚3.11mm' },
  { component:'顶棚过热器', sys:'RSH', position:'7 顶棚管', shape:'直管', spec:'Φ48.5×6', diameter:'48.5', wallThickness:'6', material:'15CrMoG', inUseQty:'128根', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号7；直管附加壁厚1.1mm，弯管附加壁厚1.91mm' },
  { component:'包墙过热器', sys:'WSH', position:'8 包墙管（一；顶部）', shape:'直管', spec:'Φ51×6', diameter:'51', wallThickness:'6', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号8；直管附加壁厚1.1mm，弯管附加壁厚1.64mm' },
  { component:'包墙过热器', sys:'WSH', position:'9 包墙管（二）', shape:'直管', spec:'Φ51×7', diameter:'51', wallThickness:'7', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号9；直管附加壁厚1.2mm，弯管附加壁厚2.145mm' },
  { component:'包墙过热器', sys:'WSH', position:'10 包墙管（三）', shape:'直管', spec:'Φ63.5×12', diameter:'63.5', wallThickness:'12', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号10；直管附加壁厚1.7mm，弯管附加壁厚3.32mm' },
  { component:'低温过热器', sys:'LSH', position:'11 低过管子（一）', shape:'蛇形管', spec:'Φ57×6', diameter:'57', wallThickness:'6', material:'15CrMoG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号11；直管附加壁厚1.1mm，弯管附加壁厚1.748mm' },
  { component:'低温过热器', sys:'LSH', position:'12 低过管子（二）', shape:'蛇形管', spec:'Φ60×8.5', diameter:'60', wallThickness:'8.5', material:'15CrMoG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号12；直管附加壁厚1.35mm，弯管附加壁厚/' },
  { component:'低温过热器', sys:'LSH', position:'13 低过管子（三）', shape:'蛇形管', spec:'Φ57×6', diameter:'57', wallThickness:'6', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号13；直管附加壁厚1.1mm，弯管附加壁厚1.748mm' },
  { component:'低温过热器', sys:'LSH', position:'14 低过管子（四）', shape:'蛇形管', spec:'Φ57×8', diameter:'57', wallThickness:'8', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号14；直管附加壁厚1.3mm，弯管附加壁厚2.164mm' },
  { component:'全大屏过热器', sys:'PSH', position:'15 全大屏管子（一）', shape:'管子', spec:'Φ51×7', diameter:'51', wallThickness:'7', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号15；直管附加壁厚1.2mm，弯管附加壁厚1.956mm' },
  { component:'全大屏过热器', sys:'PSH', position:'16 全大屏管子（二）', shape:'管子', spec:'Φ51×7', diameter:'51', wallThickness:'7', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第47页序号16；直管附加壁厚0.7mm，弯管附加壁厚1.456mm' },
  { component:'屏式过热器', sys:'ISH', position:'17 屏式过热器管（一）', shape:'管子', spec:'Φ54×9', diameter:'54', wallThickness:'9', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号17；直管附加壁厚0.9mm，弯管附加壁厚2.7853mm' },
  { component:'屏式过热器', sys:'ISH', position:'18 屏式过热器管（二）', shape:'管子', spec:'Φ54×8.5', diameter:'54', wallThickness:'8.5', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号18；直管附加壁厚0.85mm，弯管附加壁厚1.9975mm' },
  { component:'屏式过热器', sys:'ISH', position:'19 屏式过热器管（三）', shape:'管子', spec:'Φ54×8.5', diameter:'54', wallThickness:'8.5', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号19；直管附加壁厚1.35mm，弯管附加壁厚2.88mm' },
  { component:'屏式过热器', sys:'ISH', position:'20 屏式过热器管（四）', shape:'管子', spec:'Φ54×8.5', diameter:'54', wallThickness:'8.5', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号20；直管附加壁厚0.85mm，弯管附加壁厚1.9975mm' },
  { component:'屏式过热器', sys:'ISH', position:'21 屏式过热器管（五）', shape:'管子', spec:'Φ60×8', diameter:'60', wallThickness:'8', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号21；直管附加壁厚0.8mm，弯管附加壁厚1.88mm' },
  { component:'屏式过热器', sys:'ISH', position:'22 屏式过热器管（六）', shape:'管子', spec:'Φ60×9', diameter:'60', wallThickness:'9', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号22；直管附加壁厚0.9mm，弯管附加壁厚2.115mm' },
  { component:'屏式过热器', sys:'ISH', position:'23 屏式过热器管（七）', shape:'管子', spec:'Φ60×8', diameter:'60', wallThickness:'8', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号23；直管附加壁厚1.3mm，弯管附加壁厚2.74mm' },
  { component:'高温过热器', sys:'HSH', position:'24 高过管子（一）', shape:'管子', spec:'Φ51×9', diameter:'51', wallThickness:'9', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号24；直管附加壁厚1.4mm，弯管附加壁厚2.615mm' },
  { component:'高温过热器', sys:'HSH', position:'25 高过管子（二）', shape:'管子', spec:'Φ51×8', diameter:'51', wallThickness:'8', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号25；直管附加壁厚0.8mm，弯管附加壁厚1.88mm' },
  { component:'高温过热器', sys:'HSH', position:'26 高过管子（三）', shape:'管子', spec:'Φ51×8', diameter:'51', wallThickness:'8', material:'SA-213TP304H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号26；直管附加壁厚0.8mm，弯管附加壁厚1.88mm' },
  { component:'高温过热器', sys:'HSH', position:'27 高过管子（四）', shape:'管子', spec:'Φ51×11', diameter:'51', wallThickness:'11', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号27；直管附加壁厚1.1mm，弯管附加壁厚2.585mm' },
  { component:'高温过热器', sys:'HSH', position:'28 高过管子（五）', shape:'管子', spec:'Φ54×7.5', diameter:'54', wallThickness:'7.5', material:'SA-213TP347H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号28；直管附加壁厚0.75mm，弯管附加壁厚1.7625mm' },
  { component:'高温过热器', sys:'HSH', position:'29 高过管子（六）', shape:'管子', spec:'Φ54×9', diameter:'54', wallThickness:'9', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号29；直管附加壁厚0.9mm，弯管附加壁厚/' },
  { component:'高温过热器', sys:'HSH', position:'30 高过管子（七）', shape:'管子', spec:'Φ54×11', diameter:'54', wallThickness:'11', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号30；直管附加壁厚1.1mm，弯管附加壁厚2.585mm' },
  { component:'高温过热器', sys:'HSH', position:'31 高过管子（八）', shape:'管子', spec:'Φ54×9', diameter:'54', wallThickness:'9', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号31；直管附加壁厚1.4mm，弯管附加壁厚2.615mm' },
  { component:'高温再热器', sys:'HRH', position:'32 高温再热器管（一）', shape:'管子', spec:'Φ60×4', diameter:'60', wallThickness:'4', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号32；直管附加壁厚0.9mm，弯管附加壁厚1.332mm' },
  { component:'高温再热器', sys:'HRH', position:'33 高温再热器管（二）', shape:'管子', spec:'Φ51×4', diameter:'51', wallThickness:'4', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第48页序号33；直管附加壁厚0.9mm，弯管附加壁厚1.26mm' },
  { component:'高温再热器', sys:'HRH', position:'34 高温再热器管（三）', shape:'管子', spec:'Φ60×4', diameter:'60', wallThickness:'4', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号34；直管附加壁厚0.4mm，弯管附加壁厚0.832mm' },
  { component:'高温再热器', sys:'HRH', position:'35 高温再热器管（四）', shape:'管子', spec:'Φ60×4', diameter:'60', wallThickness:'4', material:'SA-213TP304H', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号35；直管附加壁厚0.9mm，弯管附加壁厚1.332mm' },
  { component:'高温再热器', sys:'HRH', position:'36 高温再热器管（五）', shape:'管子', spec:'Φ60×6', diameter:'60', wallThickness:'6', material:'SA-213T91', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号36；直管附加壁厚0.6mm，弯管附加壁厚1.248mm' },
  { component:'高温再热器', sys:'HRH', position:'37 高温再热器管（六）', shape:'管子', spec:'Φ60×5', diameter:'60', wallThickness:'5', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号37；直管附加壁厚0.5mm，弯管附加壁厚1.04mm' },
  { component:'高温再热器', sys:'HRH', position:'38 高温再热器管（七）', shape:'管子', spec:'Φ51×5', diameter:'51', wallThickness:'5', material:'SA-213T22', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号38；直管附加壁厚0.5mm，弯管附加壁厚1.175mm' },
  { component:'高温再热器', sys:'HRH', position:'39 高温再热器管（八）', shape:'管子', spec:'Φ60×5', diameter:'60', wallThickness:'5', material:'12Cr1MoVG', inUseQty:'', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号39；直管附加壁厚1mm，弯管附加壁厚1.54mm' },
  { component:'低温再热器', sys:'LRH', position:'40 低再管（一）', shape:'水平段管圈', spec:'Φ63.5×4', diameter:'63.5', wallThickness:'4', material:'SA-210C', inUseQty:'98片×6管圈', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号40；直管附加壁厚0.4mm，弯管附加壁厚0.832mm；低再水平段下三组材料为SA-210C' },
  { component:'低温再热器', sys:'LRH', position:'41 低再管（二）', shape:'水平段管圈', spec:'Φ63.5×4', diameter:'63.5', wallThickness:'4', material:'15CrMoG', inUseQty:'98片×6管圈', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号41；直管附加壁厚0.9mm，弯管附加壁厚1.332mm；第五级水平管组材料为15CrMoG' },
  { component:'低温再热器', sys:'LRH', position:'42 低再管（三）', shape:'出口垂直段管屏', spec:'Φ63.5×4', diameter:'63.5', wallThickness:'4', material:'12Cr1MoVG', inUseQty:'49屏×12管圈', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号42；直管附加壁厚0.9mm，弯管附加壁厚1.332mm；出口垂直段材料为12Cr1MoVG' },
  { component:'低温再热器', sys:'LRH', position:'43 低再管（四）', shape:'支撑耳板外圈管', spec:'Φ63.5×6', diameter:'63.5', wallThickness:'6', material:'SA-210C', inUseQty:'按支撑耳板位置', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号43；直管附加壁厚1.1mm，弯管附加壁厚1.8144mm；支撑耳板外圈管' },
  { component:'低温再热器', sys:'LRH', position:'44 低再管（五）', shape:'支撑耳板外圈管', spec:'Φ63.5×6', diameter:'63.5', wallThickness:'6', material:'15CrMoG', inUseQty:'按支撑耳板位置', stockQty:'', totalLengthM:'', reserveLocation:'', remark:'第49页序号44；直管附加壁厚1.1mm，弯管附加壁厚1.748mm；支撑耳板外圈管' }
];
const SH_HEADERS = [{n:1,name:'顶棚进口集箱',spec:'φ273×45',mat:'20G'},{n:2,name:'高过出口集箱',spec:'φ609.6×110',mat:'12Cr1MoVG'}];
const RH_HEADERS = [{n:1,name:'低再进口集箱',spec:'φ559×30',mat:'20G'},{n:2,name:'高再出口集箱',spec:'φ711×40',mat:'12Cr1MoVG'}];
const LIFECYCLE_DATA = { '2-HSH-E-012-0005-W02': { name: '2号炉高过入口第12屏第5管焊口', spec: 'Φ51×8 · T91', install: '2018-06-15', hours: 58720, status: 'warn', risk: '蠕变损伤68%', timeline: [{date:'2018-06-15',t:'安装',d:'合格'},{date:'2025-12-15',t:'评估',d:'剩余寿命8.2万h'}] }, '1-WW-FR-008-0003-000': { name: '1号炉水冷壁前墙第8排第3管', spec: 'Φ63.5×7.5 · SA-210C', install: '2016-03-10', hours: 72540, status: 'ok', risk: '状态良好', timeline: [{date:'2016-03-10',t:'安装',d:'壁厚7.5'},{date:'2025-11-11',t:'测厚',d:'壁厚6.8'}] }, '2-HRH-M-032-0001-A01': { name: '2号炉高再第32屏外圈管', spec: 'Φ60×4 · TP304H', install: '2017-11-05', hours: 65830, status: 'danger', risk: '壁厚减薄至3.3mm', timeline: [{date:'2017-11-05',t:'安装',d:'壁厚4.0'},{date:'2025-09-15',t:'测厚',d:'壁厚3.3'}] } };
const matrix = [ {name:'水冷壁-前墙', sys:'WW', zone:'FR', pMin:1, pMax:1, tMin:1, tMax:192, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww'}, {name:'水冷壁-后墙', sys:'WW', zone:'RR', pMin:1, pMax:1, tMin:1, tMax:192, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww'}, {name:'水冷壁-左墙', sys:'WW', zone:'FL', pMin:1, pMax:1, tMin:1, tMax:169, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww'}, {name:'水冷壁-右墙', sys:'WW', zone:'RI', pMin:1, pMax:1, tMin:1, tMax:169, spec:'Φ63.5×7.5 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-ww'}, {name:'顶棚过热器', sys:'RSH', zone:'CE', pMin:1, pMax:1, tMin:1, tMax:128, spec:'Φ159×18 20G、Φ48.5×6 15CrMoG', mat:'按材料库分项', badge:'badge-sh'}, {name:'包墙过热器', sys:'WSH', zone:'SL', pMin:1, pMax:1, tMin:1, tMax:260, spec:'Φ51×6 12Cr1MoVG、Φ51×7 12Cr1MoVG、Φ63.5×12 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh'}, {name:'低过-水平段', sys:'LSH', zone:'E', pMin:1, pMax:112, tMin:1, tMax:5, spec:'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh'}, {name:'低过-垂直段', sys:'LSH', zone:'O', pMin:1, pMax:112, tMin:1, tMax:5, spec:'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh'}, {name:'全大屏过热器', sys:'PSH', zone:'M', pMin:1, pMax:24, tMin:1, tMax:14, spec:'Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91', mat:'按材料库分项', badge:'badge-sh'}, {name:'屏式过热器', sys:'ISH', zone:'E', pMin:1, pMax:21, tMin:1, tMax:13, spec:'Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh'}, {name:'高温过热器', sys:'HSH', zone:'O', pMin:1, pMax:32, tMin:1, tMax:12, spec:'Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG', mat:'按材料库分项', badge:'badge-sh'}, {name:'低再-水平段', sys:'LRH', zone:'E', pMin:1, pMax:112, tMin:1, tMax:6, spec:'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', mat:'按材料库分项', badge:'badge-rh'}, {name:'低再-垂直段', sys:'LRH', zone:'O', pMin:1, pMax:56, tMin:1, tMax:12, spec:'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', mat:'按材料库分项', badge:'badge-rh'}, {name:'高温再热器', sys:'HRH', zone:'M', pMin:1, pMax:64, tMin:1, tMax:7, spec:'Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG', mat:'按材料库分项', badge:'badge-rh'}, {name:'省煤器', sys:'ECO', zone:'IN', pMin:1, pMax:124, tMin:1, tMax:1, spec:'Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G', mat:'按材料库分项', badge:'badge-eco'} ];
const CODE_SYSTEMS = [
  { sys:'WW', label:'水冷壁', zones:['FR','FL','RR','RI','CE','BF'] },
  { sys:'RSH', label:'顶棚过热器', zones:['E','M','O'] },
  { sys:'WSH', label:'包墙过热器', zones:['E','M','O'] },
  { sys:'LSH', label:'低温过热器', zones:['E','M','O'] },
  { sys:'PSH', label:'全大屏过热器', zones:['E','M','O'] },
  { sys:'ISH', label:'屏式过热器', zones:['E','M','O'] },
  { sys:'HSH', label:'高温过热器', zones:['E','M','O'] },
  { sys:'LRH', label:'低温再热器', zones:['E','M','O'] },
  { sys:'HRH', label:'高温再热器', zones:['E','M','O'] },
  { sys:'ECO', label:'省煤器', zones:['IN','OT'] }
];
const WALL_THICKNESS_WARNING_RULES = [
  { no:1, sys:'ECO', name:'省煤器蛇形管', diameter:'51', wall:'6', material:'SA-210C', pressure:20.2, temperature:348, allowableStress:135.2, straight:3.80, bendRadius:60, bend:3.23 },
  { no:2, sys:'ECO', name:'省煤器吊挂管', diameter:'60', wall:'9', material:'SA-210C', pressure:20.2, temperature:358, allowableStress:131.1, straight:4.59, bendRadius:200, bend:4.29 },
  { no:3, sys:'ECO', name:'省煤器至锅筒连接管', diameter:'159', wall:'18', material:'20G', pressure:20.2, temperature:328, allowableStress:106, straight:13.83, bendRadius:650, bend:13.08 },
  { no:4, sys:'WW', name:'水冷壁管', diameter:'63.5', wall:'7.5', material:'SA-210C', pressure:20.1, temperature:411, allowableStress:93.4, straight:6.49, bendRadius:150, bend:5.92 },
  { no:5, sys:'RSH', name:'汽包至顶棚连接管', diameter:'159', wall:'18', material:'20G', pressure:19.78, temperature:361, allowableStress:97, straight:14.71, bendRadius:650, bend:13.91 },
  { no:6, sys:'WW', name:'下水连接管', diameter:'159', wall:'18', material:'20G', pressure:20.1, temperature:361, allowableStress:97, straight:14.93, bendRadius:650, bend:14.11 },
  { no:7, sys:'RSH', name:'顶棚管', diameter:'48.5', wall:'6', material:'15CrMoG', pressure:19.78, temperature:475, allowableStress:119, straight:3.72, bendRadius:90, bend:3.33 },
  { no:8, sys:'WSH', name:'包墙管（一；顶部）', diameter:'51', wall:'6', material:'12Cr1MoVG', pressure:19.68, temperature:415, allowableStress:132.9, straight:3.52, bendRadius:120, bend:3.21 },
  { no:9, sys:'WSH', name:'包墙管（二）', diameter:'51', wall:'7', material:'12Cr1MoVG', pressure:19.68, temperature:415, allowableStress:132.9, straight:3.52, bendRadius:120, bend:3.21 },
  { no:10, sys:'WSH', name:'包墙管（三）', diameter:'63.5', wall:'12', material:'12Cr1MoVG', pressure:19.68, temperature:415, allowableStress:132.9, straight:4.38, bendRadius:120, bend:3.92 },
  { no:11, sys:'LSH', zone:'E', name:'低过管子（一）', diameter:'57', wall:'6', material:'15CrMoG', pressure:19.36, temperature:460, allowableStress:121.6, straight:4.49, bendRadius:150, bend:4.13 },
  { no:12, sys:'LSH', name:'低过管子（二）', diameter:'60', wall:'8.5', material:'15CrMoG', pressure:19.36, temperature:384, allowableStress:130, straight:4.16, bendRadius:'/', bend:'/' },
  { no:13, sys:'LSH', zone:'O', name:'低过管子（三）', diameter:'57', wall:'6', material:'12Cr1MoVG', pressure:19.36, temperature:507, allowableStress:110, straight:4.61, bendRadius:150, bend:4.24 },
  { no:14, sys:'LSH', name:'低过管子（四）', diameter:'57', wall:'8', material:'12Cr1MoVG', pressure:19.36, temperature:540, allowableStress:79, straight:6.22, bendRadius:150, bend:5.73 },
  { no:15, sys:'PSH', name:'全大屏管子（一）', diameter:'51', wall:'7', material:'12Cr1MoVG', pressure:19.12, temperature:486, allowableStress:122, straight:3.71, bendRadius:160, bend:3.45 },
  { no:16, sys:'PSH', name:'全大屏管子（二）', diameter:'51', wall:'7', material:'SA-213T91', pressure:19.12, temperature:514, allowableStress:120, straight:4.02, bendRadius:160, bend:3.74 },
  { no:17, sys:'ISH', name:'屏式过热器管（一）', diameter:'54', wall:'9', material:'SA-213TP347H', pressure:18.86, temperature:596, allowableStress:95, straight:5.15, bendRadius:58, bend:4.33 },
  { no:18, sys:'ISH', name:'屏式过热器管（二）', diameter:'54', wall:'8.5', material:'SA-213T91', pressure:18.86, temperature:545, allowableStress:109, straight:4.57, bendRadius:120, bend:4.15 },
  { no:19, sys:'ISH', name:'屏式过热器管（三）', diameter:'54', wall:'8.5', material:'12Cr1MoVG', pressure:18.86, temperature:527, allowableStress:90, straight:5.12, bendRadius:96, bend:4.56 },
  { no:20, sys:'ISH', name:'屏式过热器管（四）', diameter:'54', wall:'8.5', material:'SA-213TP347H', pressure:18.86, temperature:565, allowableStress:110, straight:4.53, bendRadius:120, bend:4.12 },
  { no:21, sys:'ISH', name:'屏式过热器管（五）', diameter:'60', wall:'8', material:'SA-213T91', pressure:18.86, temperature:529, allowableStress:115, straight:4.85, bendRadius:120, bend:4.36 },
  { no:22, sys:'ISH', name:'屏式过热器管（六）', diameter:'60', wall:'9', material:'SA-213TP347H', pressure:18.86, temperature:597, allowableStress:94, straight:5.77, bendRadius:120, bend:5.19 },
  { no:23, sys:'ISH', name:'屏式过热器管（七）', diameter:'60', wall:'8', material:'12Cr1MoVG', pressure:18.86, temperature:442, allowableStress:129, straight:4.09, bendRadius:120, bend:3.68 },
  { no:24, sys:'HSH', name:'高过管子（一）', diameter:'51', wall:'9', material:'12Cr1MoVG', pressure:18.49, temperature:553, allowableStress:69, straight:6.03, bendRadius:120, bend:5.50 },
  { no:25, sys:'HSH', name:'高过管子（二）', diameter:'51', wall:'8', material:'SA-213T91', pressure:18.49, temperature:578, allowableStress:78, straight:5.66, bendRadius:120, bend:5.16 },
  { no:26, sys:'HSH', name:'高过管子（三）', diameter:'51', wall:'8', material:'SA-213TP304H', pressure:18.49, temperature:579, allowableStress:77, straight:5.72, bendRadius:120, bend:5.22 },
  { no:27, sys:'HSH', name:'高过管子（四）', diameter:'51', wall:'11', material:'SA-213T22', pressure:18.49, temperature:547, allowableStress:49, straight:8.35, bendRadius:120, bend:7.62 },
  { no:28, sys:'HSH', name:'高过管子（五）', diameter:'54', wall:'7.5', material:'SA-213TP347H', pressure:18.49, temperature:574, allowableStress:109, straight:4.49, bendRadius:120, bend:4.08 },
  { no:29, sys:'HSH', name:'高过管子（六）', diameter:'54', wall:'9', material:'SA-213T91', pressure:18.49, temperature:547, allowableStress:108, straight:4.53, bendRadius:'/', bend:'/' },
  { no:30, sys:'HSH', name:'高过管子（七）', diameter:'54', wall:'11', material:'SA-213T22', pressure:18.49, temperature:542, allowableStress:52, straight:8.42, bendRadius:120, bend:7.65 },
  { no:31, sys:'HSH', name:'高过管子（八）', diameter:'54', wall:'9', material:'12Cr1MoVG', pressure:18.49, temperature:496, allowableStress:119, straight:3.89, bendRadius:120, bend:3.54 },
  { no:32, sys:'HRH', name:'高温再热器管（一）', diameter:'60', wall:'4', material:'12Cr1MoVG', pressure:4.81, temperature:558, allowableStress:66, straight:2.11, bendRadius:200, bend:1.97 },
  { no:33, sys:'HRH', name:'高温再热器管（二）', diameter:'51', wall:'4', material:'12Cr1MoVG', pressure:4.81, temperature:454, allowableStress:127, straight:0.95, bendRadius:200, bend:0.89 },
  { no:34, sys:'HRH', name:'高温再热器管（三）', diameter:'60', wall:'4', material:'SA-213T91', pressure:4.81, temperature:598, allowableStress:66, straight:2.41, bendRadius:200, bend:2.25 },
  { no:35, sys:'HRH', name:'高温再热器管（四）', diameter:'60', wall:'4', material:'SA-213TP304H', pressure:4.81, temperature:601, allowableStress:64, straight:2.47, bendRadius:200, bend:2.31 },
  { no:36, sys:'HRH', name:'高温再热器管（五）', diameter:'60', wall:'6', material:'SA-213T91', pressure:4.81, temperature:601, allowableStress:102, straight:1.68, bendRadius:200, bend:1.57 },
  { no:37, sys:'HRH', name:'高温再热器管（六）', diameter:'60', wall:'5', material:'SA-213T22', pressure:4.81, temperature:551, allowableStress:47, straight:3.22, bendRadius:200, bend:3.01 },
  { no:38, sys:'HRH', name:'高温再热器管（七）', diameter:'51', wall:'5', material:'SA-213T22', pressure:4.81, temperature:539, allowableStress:54, straight:2.43, bendRadius:120, bend:2.22 },
  { no:39, sys:'HRH', name:'高温再热器管（八）', diameter:'60', wall:'5', material:'12Cr1MoVG', pressure:4.81, temperature:454, allowableStress:127, straight:1.12, bendRadius:200, bend:1.04 },
  { no:40, sys:'LRH', name:'低再管（一）', diameter:'63.5', wall:'4', material:'SA-210C', pressure:4.81, temperature:428, allowableStress:81, straight:2.15, bendRadius:160, bend:1.97 },
  { no:41, sys:'LRH', name:'低再管（二）', diameter:'63.5', wall:'4', material:'15CrMoG', pressure:4.81, temperature:452, allowableStress:122, straight:1.23, bendRadius:160, bend:1.13 },
  { no:42, sys:'LRH', name:'低再管（三）', diameter:'63.5', wall:'4', material:'12Cr1MoVG', pressure:4.81, temperature:552, allowableStress:69, straight:2.14, bendRadius:160, bend:1.96 },
  { no:43, sys:'LRH', name:'低再管（四）', diameter:'63.5', wall:'6', material:'SA-210C', pressure:4.81, temperature:444, allowableStress:71, straight:2.40, bendRadius:120, bend:2.15 },
  { no:44, sys:'LRH', name:'低再管（五）', diameter:'63.5', wall:'6', material:'15CrMoG', pressure:4.81, temperature:474, allowableStress:119, straight:1.26, bendRadius:150, bend:1.15 }
];

function getSysLabel(sys) { const rule = CODE_SYSTEMS.find(item => item.sys === sys); if(rule) return `${sys} · ${rule.label}`; const m = matrix.find(item => item.sys === sys); return m ? `${sys} · ${m.name.replace(/[-－].*$/, '')}` : sys; }
function getZoneLabel(zone) { const labels = {FR:'前墙', FL:'左墙', RR:'后墙', RI:'右墙', CE:'炉顶', BF:'冷灰斗', E:'入口', M:'中间', O:'出口', IN:'入口', OT:'出口'}; return labels[zone] || zone; }
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
  const lifecycle = code ? LIFECYCLE_DATA[code] : null;
  const meta = typeof target === 'string'
    ? { sys: getCodeSystem(code), zone: code.split('-')[2], spec: [lifecycle?.spec, inventory?.row?.spec, component?.spec].filter(Boolean).join(' '), material: [lifecycle?.spec, inventory?.row?.mat, component?.mat].filter(Boolean).join(' ') }
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
function populateCodeGeneratorOptions() {
  const sysSelect = document.getElementById('f-system');
  const zoneSelect = document.getElementById('f-zone');
  const systems = CODE_SYSTEMS.map(item => item.sys);
  sysSelect.innerHTML = systems.map(sys => `<option value="${escapeHTML(sys)}">${escapeHTML(getSysLabel(sys))}</option>`).join('');
  function updateZoneOptions() {
    const rule = CODE_SYSTEMS.find(item => item.sys === sysSelect.value);
    const zones = rule ? rule.zones : [];
    zoneSelect.innerHTML = [...new Set(zones)].map(zone => `<option value="${escapeHTML(zone)}">${escapeHTML(zone)} · ${escapeHTML(getZoneLabel(zone))}</option>`).join('');
    genCode();
  }
  sysSelect.addEventListener('change', updateZoneOptions);
  updateZoneOptions();
}
function matchComponentFromCode(code) { const parts = code.split('-'); if(parts.length < 3) return null; const sys = parts[1]; const zone = parts[2]; return matrix.find(m => m.sys === sys && m.zone === zone) || matrix.find(m => m.sys === sys); }
function validateCodeAgainstMatrix(code) {
  const parts = code.split('-');
  if (parts.length < 6) return null;
  const [boiler, sys, zone, panelRaw, tubeRaw] = parts;
  const panel = Number(panelRaw), tube = Number(tubeRaw);
  if (!['1','2'].includes(boiler) || !Number.isInteger(panel) || !Number.isInteger(tube)) return null;
  const row = matrix.find(m => m.sys === sys && m.zone === zone && panel >= m.pMin && panel <= m.pMax && tube >= m.tMin && tube <= m.tMax);
  return row ? { boiler, code, row, panel, tube } : null;
}
function validateCodeAgainstRules(code) {
  const parts = code.split('-');
  if (parts.length < 6) return null;
  const [boiler, sys, zone, panelRaw, tubeRaw] = parts;
  const panel = Number(panelRaw), tube = Number(tubeRaw);
  const rule = CODE_SYSTEMS.find(item => item.sys === sys);
  if (!['1','2'].includes(boiler) || !rule || !rule.zones.includes(zone) || !Number.isInteger(panel) || !Number.isInteger(tube)) return null;
  if (panel < 1 || panel > 999 || tube < 1 || tube > 9999) return null;
  return { boiler, code, rule, panel, tube };
}
function classifyWarningLevel(text, status = '') {
  const value = `${text || ''} ${status || ''}`.toLowerCase();
  if(status === 'danger' || /爆管|泄漏|报废|更换|danger|high|蠕变损伤[6-9]\d|壁厚减薄至\s*[0-3]\.?[0-9]?/.test(value)) return 'HIGH';
  if(status === 'warn' || /warn|medium|预警|关注|减薄|腐蚀|蠕变|金相|裂纹|超标/.test(value)) return 'MEDIUM';
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
  return retiredCodes.has(code);
}
const DASHBOARD_SURFACE_HEALTH = [
  { sys: 'WW', name: '水冷壁', score: 88, unit1: 1, unit2: -1, meta: '磨损/腐蚀' },
  { sys: 'LSH', name: '低温过热器', score: 76, unit1: 2, unit2: -2, meta: '积灰/低温腐蚀' },
  { sys: 'PSH', name: '全大屏过热器', score: 68, unit1: 1, unit2: -3, meta: '结渣/夹持管' },
  { sys: 'ISH', name: '屏式过热器', score: 71, unit1: 2, unit2: -2, meta: '高温腐蚀' },
  { sys: 'HSH', name: '高温过热器', score: 58, unit1: 2, unit2: -5, meta: '蠕变/氧化皮' },
  { sys: 'HRH', name: '高温再热器', score: 52, unit1: 3, unit2: -6, meta: '减薄/烟温偏差' },
  { sys: 'ECO', name: '省煤器', score: 82, unit1: 1, unit2: -2, meta: '冲刷/低温腐蚀' }
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
  const systemWarnings = Object.entries(LIFECYCLE_DATA)
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
    return `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" stroke="rgba(127,179,213,0.12)" /><text x="${pad.left - 9}" y="${yy + 4}" text-anchor="end" fill="#7fb3d5" font-size="10">${value}</text>`;
  }).join('');
  const labelEls = labels.map((label, index) => `<text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="#7fb3d5" font-size="10">${label}</text>`).join('');
  const dots = points.map((point, index) => {
    const isLast = index === points.length - 1;
    return `<circle cx="${point[0]}" cy="${point[1]}" r="${isLast ? 5 : 3.6}" fill="${isLast ? '#001122' : '#00d4ff'}" stroke="#2fd4e8" stroke-width="${isLast ? 2.5 : 1.6}"${isLast ? ' filter="url(#dashboardTrendGlow)"' : ''}><title>${labels[index]} ${point[2]}%</title></circle>`;
  }).join('');
  svg.innerHTML = `<defs>
    <linearGradient id="dashboardTrendFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.34" />
      <stop offset="70%" stop-color="#00d4ff" stop-opacity="0.06" />
      <stop offset="100%" stop-color="#00d4ff" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="dashboardTrendLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#17a9c4" /><stop offset="100%" stop-color="#2fd4e8" />
    </linearGradient>
    <filter id="dashboardTrendGlow"><feGaussianBlur stdDeviation="2.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
  ${grid}
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="rgba(127,179,213,0.24)" />
  <path d="${area}" fill="url(#dashboardTrendFill)" />
  <path d="${line}" fill="none" stroke="url(#dashboardTrendLine)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" filter="url(#dashboardTrendGlow)" />
  ${dots}
  ${labelEls}
  <text x="${pad.left}" y="16" fill="#e6f7ff" font-size="12" font-weight="700">综合健康度趋势</text>
  <text x="${width - pad.right}" y="16" text-anchor="end" fill="${stats.delta >= 0 ? '#22c07e' : '#f0574a'}" font-size="12" font-weight="700">${stats.delta >= 0 ? '+' : ''}${stats.delta}%</text>
  <g id="dashboardTrendHover" opacity="0" pointer-events="none">
    <line y1="${pad.top}" y2="${pad.top + plotH}" stroke="rgba(47,212,232,0.45)" stroke-width="1" stroke-dasharray="3 3" />
    <circle r="5" fill="#001122" stroke="#2fd4e8" stroke-width="2" filter="url(#dashboardTrendGlow)" />
    <g id="dashboardTrendTip">
      <rect rx="5" ry="5" fill="rgba(4,16,28,0.96)" stroke="rgba(72,202,228,0.4)" stroke-width="1" width="86" height="40" />
      <text id="dashboardTrendTipVal" x="43" y="18" text-anchor="middle" fill="#8ce6f2" font-size="15" font-weight="700"></text>
      <text id="dashboardTrendTipLbl" x="43" y="32" text-anchor="middle" fill="#7fb3d5" font-size="10"></text>
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
  const ledgerCount = dashboardUnit === 'all' ? 5139 * 2 : 5139;
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
  if(ledgerNote) ledgerNote.textContent = dashboardUnit === 'all' ? '全厂两台炉，按六段式编码规则覆盖全受热面' : `${unitLabel}，按六段式编码规则覆盖全受热面`;
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
    return;
  }
  box.innerHTML = warnings.map(item => `<button type="button" class="command-warning ${warningClass(item.level)}" onclick="openTubeProfile('${escapeHTML(item.code)}')"><strong>${escapeHTML(item.code)}</strong><span>${escapeHTML(item.text)}</span></button>`).join('');
}
function formatDashboardWarningsForPrompt() {
  const warnings = getDashboardScopedWarnings();
  return warnings.length
    ? `${getDashboardUnitLabel()}视角：\n` + warnings.map(item => `[${item.level}] ${item.code} ${item.text} (${item.source})`).join('\n')
    : `${getDashboardUnitLabel()}当前未发现需要展示的预警。`;
}
function extractThicknessData(code, options = {}) {
  const includeSystem = options.includeSystem !== false;
  const timelineEvents = includeSystem ? (LIFECYCLE_DATA[code]?.timeline || []).map(item => ({ code, type: item.t || '', date: item.date, desc: item.d || '', source: '系统寿命样例' })) : [];
  const localEvents = userDB.events.filter(e => e.code === code).map(e => ({ ...e, source: '本地录入' }));
  const data = [];
  [...timelineEvents, ...localEvents]
    .filter(e => e.code === code && (positiveThickness(e.thickness) !== null || String(e.type).includes('测厚') || String(e.desc).includes('壁厚') || String(e.desc).includes('减薄')))
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
  const VIEW_TITLES = { dashboard: '炉管风险驾驶舱', 'tube-analysis': '管段综合分析', 'maintenance-plan': '检修计划指挥', datamgr: '数据录入与管理', generator: '编码生成器', inventory: '全量管段台账', components: '受热面材料库', headers: '集箱库', diagram: '炉管分布图' };
  if(titleEl) titleEl.textContent = VIEW_TITLES[viewId] || (btn ? btn.querySelector('span')?.textContent : '') || titleEl.textContent;
  if(window.scrollY > 8) window.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.classList.remove('rail-open');
  if(btn) btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
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
function toggleRail() { document.body.classList.toggle('rail-open'); }

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
function buildBarChart() { const box = document.getElementById('barChart'); if(!box) return; const data = [{l:'水冷壁',sys:'WW',v:722,c:'var(--ok)'},{l:'低过',sys:'LSH',v:1120,c:'var(--accent-3)'},{l:'大屏',sys:'PSH',v:336,c:'var(--accent)'},{l:'屏过',sys:'ISH',v:273,c:'#ff9f43'},{l:'高过',sys:'HSH',v:384,c:'var(--danger)'},{l:'低再',sys:'LRH',v:1344,c:'#a29bfe'},{l:'高再',sys:'HRH',v:448,c:'#fd79a8'},{l:'省煤器',sys:'ECO',v:124,c:'var(--ok)'}]; const max = Math.max(...data.map(d => d.v)); box.innerHTML = data.map(d => `<button type="button" class="bar-item" data-sys="${escapeHTML(d.sys)}" onclick="openComponentLifecycle('${escapeHTML(d.sys)}','${escapeHTML(d.l)}')" title="查看${escapeHTML(d.l)}检修记录"><div class="bar" data-val="${d.v}" style="height:${(d.v/max)*85}%; background:linear-gradient(180deg, ${d.c}, rgba(0,29,61,0.8));"></div><div class="bar-label">${escapeHTML(d.l)}</div></button>`).join(''); }
function genCode() { const b=document.getElementById('f-boiler').value, s=document.getElementById('f-system').value, z=document.getElementById('f-zone').value; if(!s || !z) return; const p=String(document.getElementById('f-panel').value).padStart(3,'0'), t=String(document.getElementById('f-tube').value).padStart(4,'0'), g=document.getElementById('f-seg').value; const code = `${b}-${s}-${z}-${p}-${t}-${g}`; document.getElementById('codeOut').innerHTML = `<span class="code-segment">${escapeHTML(b)}</span>-<span class="code-segment">${escapeHTML(s)}</span>-<span class="code-segment">${escapeHTML(z)}</span>-<span class="code-segment">${escapeHTML(p)}</span>-<span class="code-segment">${escapeHTML(t)}</span>-<span class="code-segment">${escapeHTML(g)}</span>`; const matched = validateCodeAgainstMatrix(code); document.getElementById('codeDesc').textContent = matched ? `${matched.row.name} · ${matched.row.spec} · ${matched.row.mat}` : '当前编号超出台账矩阵范围，请核对屏/排与管圈编号。'; window._curCode = code; }
['f-boiler','f-zone','f-panel','f-tube','f-seg'].forEach(id => document.getElementById(id).addEventListener('input', genCode));
function copyCode() { if(window._curCode) { navigator.clipboard?.writeText(window._curCode); showToast(`已复制编码：${window._curCode}`, 'ok'); } }

function getTubeProfileData(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if(!code) return null;
  const localEvents = userDB.events
    .filter(e => e.code === code)
    .sort((a,b) => new Date(a.date) - new Date(b.date));
  let d = LIFECYCLE_DATA[code];
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
        spec: `${ruleMatch.rule.sys} · ${ruleMatch.rule.zone}`,
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
  const localEvts = localEvents.map(e => ({date: e.date, t: e.type, d: `${escapeHTML(e.desc)} <span style="color:var(--accent);font-size:10px;border:1px solid var(--accent);padding:1px 4px;border-radius:3px;">手工录入</span>`}));
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
      miniChartSVG = `<svg class="mini-chart" viewBox="0 0 ${w} ${h}"><path d="${path}" fill="none" stroke="#00d4ff" stroke-width="2"/><path d="${path} L ${xS(maxX)} ${h-p} L ${xS(minX)} ${h-p} Z" fill="rgba(0,212,255,0.1)"/>${thicknessData.map(d=>`<circle cx="${xS(d.year)}" cy="${yS(d.val)}" r="3" fill="#00d4ff"/>`).join('')}</svg>`;
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
  Object.keys(LIFECYCLE_DATA).forEach(k => { if(k.includes(q)) { matches.push({code:k, data:LIFECYCLE_DATA[k], source: 'system'}); matchedCodes.add(k); } });
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
  const parts = String(code || '').toUpperCase().split('-');
  return ['1','2'].includes(parts[0]) ? parts[0] : '';
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
  const systemExamples = Object.entries(LIFECYCLE_DATA)
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
        <input type="text" id="componentGlobalSearchInput" placeholder="全受热面管段查询：输入任意系统管码，例如 2-HSH-E-012-0005-W02" onkeypress="if(event.key==='Enter')openTubeProfile(this.value.trim().toUpperCase())" />
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
  { sys:'ECO', start:1, end:3 },
  { sys:'WW', nums:[4, 6] },
  { sys:'RSH', nums:[5, 7] },
  { sys:'WSH', start:8, end:10 },
  { sys:'LSH', start:11, end:14 },
  { sys:'PSH', start:15, end:16 },
  { sys:'ISH', start:17, end:23 },
  { sys:'HSH', start:24, end:31 },
  { sys:'HRH', start:32, end:39 },
  { sys:'LRH', start:40, end:44 }
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
      merged.set(materialKey(standard), {
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
function saveMaterialLibrary(items) {
  localStorage.setItem(MATERIAL_LIBRARY_KEY, JSON.stringify(items));
  queueCloudStorageSave(MATERIAL_LIBRARY_KEY, items);
  const active = document.querySelector('.comp-tab.active')?.dataset.comp || 'ww';
  renderMaterialLibrary(active);
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
function importMaterialCSV(event) {
  const file = event.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const lines = e.target.result.split(/\r?\n/).filter(line => line.trim() !== '');
      if(lines.length < 2) { showToast('材料库 CSV 文件为空', 'warn'); return; }
      const merged = new Map(getMaterialLibrary().map(item => [materialKey(item), item]));
      let imported = 0;
      for(let i = 1; i < lines.length; i++) {
        const item = materialCSVToItem(parseCSVLine(lines[i]));
        if(!item.component || !item.spec || !item.material) continue;
        merged.set(materialKey(item), item);
        imported++;
      }
      saveMaterialLibrary([...merged.values()]);
      showToast(`材料库导入完成，更新/新增 ${imported} 条记录`, 'ok');
    } catch (err) {
      console.error(err);
      showToast('材料库 CSV 解析失败，请检查文件格式。', 'error');
    }
  };
  reader.readAsText(file, 'UTF-8'); event.target.value = '';
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
    </tr>`;
  }).join('') || '<tr><td colspan="14" style="text-align:center; padding:20px;">暂无材料记录，可通过材料库 CSV 导入维护。</td></tr>';
  document.getElementById('compContent').innerHTML = `
    <div class="card">
      <div class="card-title"><span class="badge ${c?.badge || 'badge-sh'}">${escapeHTML(c?.sys || '')}</span> ${escapeHTML(componentName)} 材料清单</div>
      <div class="info-grid">
        <div class="info-item"><div class="k">材料记录</div><div class="v">${rows.length} 条</div></div>
        <div class="info-item"><div class="k">库存维护项</div><div class="v">${stockRows} 条</div></div>
        <div class="info-item"><div class="k">维护方式</div><div class="v">CSV 导入/导出</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">样表分类清单</div>
      <div class="table-wrap"><table><thead><tr><th>序号</th><th>名称</th><th>外径(mm)</th><th>取用壁厚(mm)</th><th>材料</th><th>设计压力(MPa)</th><th>设计温度(℃)</th><th>直管理论计算厚度(mm)</th><th>弯管半径(mm)</th><th>弯管外侧理论计算厚度(mm)</th><th>规格型号</th><th>库存根数</th><th>库存总长度(m)</th><th>备注</th></tr></thead><tbody>${tableRows}</tbody></table></div>
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

function renderMatrix() { const tbody = document.getElementById('matrixBody'); let total = 0; tbody.innerHTML = matrix.map(m => { const count = (m.pMax - m.pMin + 1) * (m.tMax - m.tMin + 1); total += count; return `<tr><td style="font-family:inherit">${m.name}</td><td><span class="badge ${m.badge}">${m.sys}</span></td><td>${m.zone}</td><td>${m.pMin}~${m.pMax}</td><td>${m.tMin}~${m.tMax}</td><td style="color:var(--accent)">${count}</td><td>${m.spec}</td><td style="font-family:inherit;font-size:11px">${m.mat}</td></tr>`; }).join(''); document.getElementById('invTotal').textContent = total.toLocaleString(); }
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
const MAINTENANCE_SYSTEM_PRIORITY = ['HRH', 'HSH', 'ISH', 'PSH', 'LRH', 'LSH', 'WW', 'RSH', 'WSH', 'ECO'];
function maintenanceFocusForSurface(sys) {
  if(['HSH', 'HRH', 'ISH', 'PSH'].includes(sys)) return '高温蠕变、氧化皮堆积、异种钢焊口和弯头外弧减薄';
  if(['LSH', 'LRH', 'ECO'].includes(sys)) return '烟气冲刷、磨损减薄、支吊卡涩和积灰腐蚀';
  if(sys === 'WW') return '水冷壁高热负荷区、防磨瓦、鳍片焊缝和局部鼓包';
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
  Object.entries(LIFECYCLE_DATA).forEach(([code, item]) => {
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
    const ledgerCount = (row.pMax - row.pMin + 1) * (row.tMax - row.tMin + 1);
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
    current.zones.add(row.zone);
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
  Object.entries(LIFECYCLE_DATA).forEach(([code, item]) => {
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
    WW: '扩大检查范围：高热负荷区、燃烧器周边、卫燃带边界、相邻±3排及鳍片焊缝',
    HSH: '扩大检查范围：同屏相邻±2屏、外圈弯头、夹持管、异种钢焊口和吹灰器覆盖区',
    HRH: '扩大检查范围：同屏相邻±2屏、外圈弯头、定位管夹、入口喷水影响区和烟气走廊',
    ISH: '扩大检查范围：屏底外圈、包扎管、相邻±2屏、管排晃动磨损和高温腐蚀区',
    PSH: '扩大检查范围：屏底夹持管、外圈迎烟面、结渣冲刷区和相邻小屏',
    LSH: '扩大检查范围：水平段迎烟面、吹灰器附近、积灰桥接区、同排上下游管组',
    LRH: '扩大检查范围：水平段下部、支撑块/管卡接触点、低速积灰区和垂直段过渡区',
    ECO: '扩大检查范围：蛇形管迎烟面、弯头外弧、灰斗上方、低温腐蚀和飞灰磨损区',
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
  const date = new Date(dateText || 0);
  if(Number.isNaN(date.getTime())) return null;
  return Math.max(0, (getInspectionAsOfDate(asOfYear) - date) / (365.25 * 24 * 60 * 60 * 1000));
}
function getGeneratedTubeLedgerRows(boiler = 'all') {
  const boilers = boiler === 'all' ? ['1', '2'] : [String(boiler)];
  const rows = [];
  boilers.forEach(boilerId => {
    matrix.forEach(item => {
      for(let p = item.pMin; p <= item.pMax; p += 1) {
        for(let t = item.tMin; t <= item.tMax; t += 1) {
          const code = `${boilerId}-${item.sys}-${item.zone}-${pad(p, 3)}-${pad(t, 4)}-000`;
          rows.push({
            code,
            boiler: boilerId,
            sys: item.sys,
            label: CODE_SYSTEMS.find(sys => sys.sys === item.sys)?.label || item.name,
            surface: item.name,
            location: `${item.zone} · 屏/排${pad(p, 3)} · 管${pad(t, 4)}`,
            spec: item.spec,
            material: item.mat,
            badge: item.badge
          });
        }
      }
    });
  });
  const byCode = new Map(rows.map(row => [row.code, row]));
  userDB.events.forEach(event => {
    const code = String(event.code || '').toUpperCase();
    if(!code || byCode.has(code)) return;
    if(boiler !== 'all' && eventBoiler(event) !== String(boiler)) return;
    const comp = matchComponentFromCode(code);
    byCode.set(code, {
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
  const parts = String(code || '').toUpperCase().split('-');
  if(parts.length < 6) return '-';
  return `${parts[2]} · 屏/排${parts[3]} · 管${parts[4]} · ${parts[5]}`;
}
function collectTubeInspectionRecords(boiler = 'all') {
  const records = new Map();
  const add = (code, date, type, desc, source) => {
    const normalized = String(code || '').toUpperCase();
    if(!normalized || !date) return;
    const recordBoiler = getCodeBoiler(normalized);
    if(boiler !== 'all' && recordBoiler !== String(boiler)) return;
    const candidate = { code: normalized, date, type: type || '检查', desc: desc || '', source };
    const old = records.get(normalized);
    if(!old || new Date(candidate.date) > new Date(old.date)) records.set(normalized, candidate);
  };
  Object.entries(LIFECYCLE_DATA).forEach(([code, item]) => {
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
    const latest = inspectionMap.get(row.code);
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
function generateCSV(boilerId) { const logBox = document.getElementById('invLogBox'); const progBar = document.getElementById('invProgBar'); const progFill = document.getElementById('invProgFill'); const previewBox = document.getElementById('invPreview'); logBox.style.display = 'block'; progBar.style.display = 'block'; logBox.innerHTML = ''; progFill.style.width = '0%'; const boilers = boilerId === 0 ? [1, 2] : [boilerId]; let csvContent = "\uFEFF炉号,系统代码,位置区域,屏/排编号,管圈/管编号,分段特征,完整管码,部件名称,规格,材质\n"; let rowCount = 0; let previewLines = []; invLog(`[INIT] 启动生成引擎... 目标: ${boilers.join(', ')}`); let bIdx = 0, mIdx = 0, p = 0, t = 0; function processChunk() { const startTime = performance.now(); while (performance.now() - startTime < 50 && bIdx < boilers.length) { const b = boilers[bIdx]; const m = matrix[mIdx]; for (; p <= m.pMax; p++) { if (p < m.pMin) p = m.pMin; for (; t <= m.tMax; t++) { if (t < m.tMin) t = m.tMin; const code = `${b}-${m.sys}-${m.zone}-${pad(p,3)}-${pad(t,4)}-000`; csvContent += `${b},${m.sys},${m.zone},${pad(p,3)},${pad(t,4)},000,${code},${m.name},${m.spec},${m.mat}\n`; rowCount++; if (rowCount <= 10) previewLines.push(`<span>${code}</span> | ${m.name}`); } t = m.tMin; } invLog(`[OK] ${b}号炉 - ${m.name} 完毕`); mIdx++; p = 0; t = 0; if (mIdx >= matrix.length) { mIdx = 0; bIdx++; } progFill.style.width = `${((bIdx * matrix.length + mIdx) / (boilers.length * matrix.length)) * 100}%`; } if (bIdx < boilers.length) { requestAnimationFrame(processChunk); } else { progFill.style.width = '100%'; invLog(`[DONE] 总计 ${rowCount.toLocaleString()} 条。正在打包...`); previewBox.innerHTML = previewLines.join('<br>') + '<br><span>... (共 ' + rowCount.toLocaleString() + ' 条)</span>'; const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `锅炉管段台账_${boilerId===0?'全厂':boilerId+'号炉'}_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(a.href); } } requestAnimationFrame(processChunk); }
function invLog(msg) { const logBox = document.getElementById('invLogBox'); logBox.innerHTML += `<div>[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${msg}</div>`; logBox.scrollTop = logBox.scrollHeight; }

function normalizeLLMBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}
function getLLMConfig() {
  const saved = JSON.parse(localStorage.getItem(LLM_CONFIG_KEY) || '{}');
  return {
    provider: document.getElementById('llm-provider')?.value || saved.provider || 'custom',
    baseUrl: normalizeLLMBaseUrl(document.getElementById('llm-base-url')?.value || saved.baseUrl || ''),
    apiKey: document.getElementById('llm-api-key')?.value || saved.apiKey || '',
    model: (document.getElementById('llm-model')?.value || '').trim(),
    temperature: Number(document.getElementById('llm-temperature')?.value || saved.temperature || 0.2)
  };
}
function saveLLMConfig() {
  const config = getLLMConfig();
  localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
  setLLMStatus('配置已保存到本浏览器。', 'ok');
}
function loadLLMConfigToForm() {
  const saved = JSON.parse(localStorage.getItem(LLM_CONFIG_KEY) || '{}');
  const preset = LLM_PROVIDER_PRESETS[saved.provider || 'deepseek'];
  const config = { provider: saved.provider || 'deepseek', baseUrl: saved.baseUrl || preset.baseUrl, apiKey: saved.apiKey || '', model: saved.model || '', temperature: saved.temperature ?? 0.2 };
  const ids = { provider:'llm-provider', baseUrl:'llm-base-url', apiKey:'llm-api-key', temperature:'llm-temperature' };
  Object.entries(ids).forEach(([key, id]) => { const el = document.getElementById(id); if(el) el.value = config[key]; });
  renderLLMModelOptions(saved.models || (config.model ? [config.model] : []), config.model);
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
  const lifecycle = Object.entries(LIFECYCLE_DATA).slice(0, 4).map(([code, d]) => `${code}: ${d.name}, ${d.spec}, 投运/记录 ${d.install}, 风险 ${d.risk}`).join('\n');
  return [
    '系统：锅炉炉管全生命周期管理系统，覆盖 1#/2# 机组炉管台账、寿命跟踪、预警与检修记录。',
    '总览：单炉管管理单元 5139；水冷壁 722；过热器系统 2681；再热+省煤器 1736。',
    `当前实际预警：\n${formatDashboardWarningsForPrompt()}`,
    `本地录入：事件 ${userDB.events.length} 条，更换 ${userDB.replacements.length} 条；涉及管码：${localCodes.join(', ') || '暂无'}`,
    `寿命样例：\n${lifecycle}`,
    `最近本地事件：\n${recentEvents}`
  ].join('\n\n');
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
function renderLLMResult(text) {
  const value = text || '模型没有返回可显示内容。';
  const el = document.getElementById('llm-result');
  const raw = document.getElementById('llm-raw-view');
  if(el) el.textContent = value;
  if(raw) raw.textContent = value;
  renderLLMReport(value);
  setLLMViewMode('report');
}
function exportLLMReportPDF() {
  const report = document.getElementById('llm-report-view');
  const prompt = document.getElementById('llm-prompt')?.value || '';
  const raw = document.getElementById('llm-result')?.textContent || '';
  if(!report || !raw || raw.includes('模型返回的深度分析会整理成报告显示在这里')) {
    showToast('请先生成结构化报告，再导出 PDF。', 'warn');
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
  setLLMStatus('结果已清空。', 'info');
}
async function discoverLLMModels(options = {}) {
  const config = getLLMConfig();
  if(!config.baseUrl) throw new Error('请填写 API Base URL。');
  if(!config.apiKey) throw new Error('请填写 API Key。');
  if(!options.silent) {
    setLLMStatus('正在识别可用模型...', 'info');
    renderLLMResult('正在请求 /models 获取模型列表...');
  }
  const response = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (err) { throw new Error(`模型列表接口返回非JSON内容：${raw.slice(0, 240)}`); }
  if(!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || raw.slice(0, 240) || '模型列表请求失败'}`);
  const models = extractLLMModels(data);
  if(models.length === 0) throw new Error('接口已响应，但未在 /models 返回中找到可用模型 id。');
  const previous = JSON.parse(localStorage.getItem(LLM_CONFIG_KEY) || '{}');
  const selected = previous.model && models.includes(previous.model) ? previous.model : models[0];
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
  let config = getLLMConfig();
  if(config.model) return config;
  await discoverLLMModels({ silent: true });
  config = getLLMConfig();
  if(!config.model) throw new Error('未选择可用模型，请先识别模型并选择。');
  return config;
}
async function callLLMChatCompletions(promptText, maxTokens = 1800) {
  const config = await ensureLLMModelSelected();
  if(!config.baseUrl) throw new Error('请填写 API Base URL。');
  if(!config.apiKey) throw new Error('请填写 API Key。');
  if(!config.model) throw new Error('未识别到可用模型。');
  localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages: buildLLMMessages(promptText), temperature: config.temperature, max_tokens: maxTokens })
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (err) { throw new Error(`接口返回非JSON内容：${raw.slice(0, 240)}`); }
  if(!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || raw.slice(0, 240) || '接口请求失败'}`);
  const text = extractLLMResponseText(data);
  if(!text) throw new Error('接口返回成功，但未找到 choices[0].message.content。');
  return text;
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
    setLLMStatus('深度分析完成。', 'ok');
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
      const meta = LIFECYCLE_DATA[code] || {};
      const compInfo = matchComponentFromCode(code);
      const label = meta.name || compInfo?.name || '本地录入管段';
      if(thicknessData.length >= 2) return { code, label, points: thicknessData.length, latest: thicknessData[thicknessData.length - 1] };
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
  const lifecycle = LIFECYCLE_DATA[code];
  const events = userDB.events.filter(event => event.code === code)
    .sort((a,b) => new Date(b.date) - new Date(a.date));
  const localSpec = events.find(event => event.spec)?.spec;
  const localMaterial = events.find(event => event.material)?.material;
  const spec = localSpec || lifecycle?.spec || inventory?.spec || component?.spec || '';
  // Explicit tube metadata takes precedence over multi-spec component descriptions.
  const material = localMaterial || extractMaterialHint(localSpec || lifecycle?.spec) || inventory?.mat || component?.mat || '';
  const pairs = specPairs(spec);
  const sizes = [...new Map(pairs.map(pair => [`${Number(pair.diameter)}x${Number(pair.wall)}`, pair])).values()];
  const materials = materialAliases(material);
  const sys = getCodeSystem(code), zone = code.split('-')[2];
  const meta = { sys, zone, spec, material };
  const candidates = sizes.length === 1 && materials.length === 1 ? getMaterialLibrary().filter(item =>
    item.sys === sys && (!item.theoryZone || item.theoryZone === zone) &&
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
function selectedTubePipeType(code) { return window.__tubePipeTypes?.[code]; }
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
  const events = userDB.events
    .filter(event => event.code === code)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const hardnessHistory = events
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
    ? (latestHardness ? `单点硬度 ${latestHardness.value}HB，需后续复测形成趋势` : '暂无硬度数据')
    : `硬度 ${firstHardness.value}HB → ${latestHardness.value}HB，变化 ${hardnessDelta >= 0 ? '+' : ''}${hardnessDelta.toFixed(0)}HB，变化率 ${hardnessRate >= 0 ? '+' : ''}${hardnessRate.toFixed(1)} HB/年`;
  const hardnessForecast = latestHardness && hardnessHistory.length >= 3 && hardnessQuality.reliable
    ? { oneYear: Math.round(latestHardness.value + hardnessRate), threeYear: Math.round(latestHardness.value + hardnessRate * 3), direction: Math.abs(hardnessRate) < 1 ? '稳定' : hardnessRate < 0 ? '软化' : '硬化', confidence: hardnessQuality.reliable ? hardnessQuality.score : Math.min(54, hardnessQuality.score) }
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
    const status = ['replace','replace-soon'].includes(replacementWarning.level) ? replacementWarning.label : '数据不足';
    const trendData = { target: code, current: currentValue, threshold, thresholdInfo, replacementWarning,
      rateValue: null, rate: '不可可靠预测', rul: null, rulText: '不可可靠预测', conf: 0, status,
      history: sorted, prediction: [], thresholdYear: '不可可靠预测', p50ThresholdYear: '不可可靠预测',
      acceleratedThresholdYear: '不可可靠预测', baselineThresholdYear: '不可可靠预测', outliers: [], quality, reliable: false,
      modelName: 'Theil-Sen + 近期窗口 + 三情景' };
    const composite = buildCompositeAIReport(trendData, compositeSignals);
    return { ...trendData, compositeRisk: composite.compositeRisk, compositeScore: composite.score, compositeSignals, composite,
      report: `不可可靠预测：${thresholdInfo.reason || '有效测厚历史不足2个时点'}。\n${formatTheoryDetails(thresholdInfo)}\n${replacementWarning.label}\n\n${composite.report}` };
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
  const trendReport = `【稳健壁厚减薄趋势预测】\n对象：${code}\n模型：Theil-Sen鲁棒趋势 + 近期窗口 + 三情景退化\n\n数据质量：${quality.points} 个测点，时间跨度 ${quality.span.toFixed(1)} 年，置信度 ${confidence}%\n${reliable ? '' : '结论：当前数据不足以支持可靠寿命预测，仅作趋势筛查。'}\n\n测厚历史：\n${sorted.map(p => `${p.dateStr}：${p.val}mm（${p.source || '记录'}）`).join('\n')}\n\n规格预警阈值：${threshold.toFixed(2)}mm\n阈值来源：${thresholdInfo.source}\n\n趋势预测结果：\n- 当前壁厚：${last.val}mm\n- 稳健减薄速率：${robustRate.toFixed(3)} mm/y\n- 近期减薄速率：${recentRate.toFixed(3)} mm/y\n- 基准评估速率：${conservativeRate.toFixed(3)} mm/y\n- 加速情景速率：${acceleratedRate.toFixed(3)} mm/y\n- P50预计触阈：${Number.isFinite(p50Year) ? p50Year.toFixed(1) : '未触及'} 年\n- 基准预计触阈：${Number.isFinite(conservativeYear) ? conservativeYear.toFixed(1) : '未触及'} 年\n- 加速情景触阈：${Number.isFinite(acceleratedYear) ? acceleratedYear.toFixed(1) : '未触及'} 年\n- 异常候选测点：${outliers.length ? outliers.map(p => p.dateStr).join('、') : '未识别明显异常'}\n\n诊断提示：预测不能替代现场检验；若存在裂纹、鼓包、泄漏、严重蠕变或阈值未匹配，应立即转专业寿命评估。`;
  const trendData = {
    target: code, current: last.val, threshold, thresholdInfo, replacementWarning, rateValue: conservativeRate, rate: `${conservativeRate.toFixed(3)} mm/y`, rul: reliable ? rulHours : null,
    rulText: reliable ? (rulHours >= 999999 ? '>999,999' : rulHours.toLocaleString()) : '不可可靠预测', conf: confidence, status, history: sorted, prediction,
    thresholdYear: thresholdYearText, p50ThresholdYear: Number.isFinite(p50Year) ? p50Year.toFixed(1) : '未触及', acceleratedThresholdYear: Number.isFinite(acceleratedYear) ? acceleratedYear.toFixed(1) : '未触及',
    baselineThresholdYear: Number.isFinite(conservativeYear) ? conservativeYear.toFixed(1) : '未触及', outliers, quality, reliable, modelName: 'Theil-Sen + 近期窗口 + 三情景'
  };
  const compositeSignals = collectAICompositeSignals(code, sorted);
  const composite = buildCompositeAIReport(trendData, compositeSignals);
  return { ...trendData, compositeRisk: composite.compositeRisk, compositeScore: composite.score, compositeSignals, composite, report: `${formatTheoryDetails(thresholdInfo)}\n更换判定：${replacementWarning.label}；实测 ${last.val}mm，裕量 ${replacementWarning.margin.toFixed(2)}mm，提前预警裕量≤0.20mm。\n${trendReport}\n\n${composite.report}` };
}function buildTrendAnalysisPrompt(data) {
  return `炉管综合寿命风险大模型深度分析。\n\n分析对象：${data.target}\n\n测厚历史：\n${data.history.map(p => `- ${p.dateStr}: ${p.val}mm (${p.source || '记录'})`).join('\n')}\n\n趋势预测结果：\n- 当前壁厚：${data.current}mm\n- 保守年化减薄速率：${data.rate}\n- 对应规格理论厚度预警值：${data.threshold === null ? '未匹配，不可可靠预测' : data.threshold + 'mm'}\n- ${formatTheoryDetails(data.thresholdInfo)}\n- 更换预警：${data.replacementWarning.label}\n- 阈值来源：${data.thresholdInfo?.source || '未匹配'}\n- P50触阈年份：${data.p50ThresholdYear}\n- 基准触阈估算年份：${data.thresholdYear}（基准情景估算，不代表概率保证）\n- 基准触阈估算小时：${data.rulText}h\n- 趋势评级：${data.status}\n- 本地综合风险：${data.compositeRisk || data.status}\n- 数据置信度：${data.conf}%\n\n硬度历史：\n${data.composite?.hardnessText || '暂无硬度历史'}\n硬度预测：${data.compositeSignals?.hardnessForecast ? `${data.compositeSignals.hardnessForecast.direction}，1年 ${data.compositeSignals.hardnessForecast.oneYear}HB，3年 ${data.compositeSignals.hardnessForecast.threeYear}HB，置信度 ${data.compositeSignals.hardnessForecast.confidence}%` : '数据不足，不能可靠预测'}\n\n金相组织/材料劣化证据：\n${data.composite?.metallographyText || '暂无金相组织记录'}\n\n无损检测、割管取样和检修结论：\n${data.composite?.inspectionText || '暂无无损/割管/检修结论'}\n\n请调用大模型专家能力，在不编造现场数据的前提下，综合减薄趋势、当前厚度、硬度变化、金相组织、裂纹/蠕变/脱碳/球化等证据，输出该炉管综合风险等级、主要失效机理、相邻管排排查范围、复测项目、检修优先级和需要补充的数据。`;
}
async function runDeepAIAnalysisFromTrend(data) {
  const promptBox = document.getElementById('llm-prompt');
  if(promptBox) promptBox.value = buildTrendAnalysisPrompt(data);
  const aiLLMBox = document.getElementById('ai-llm-report');
  if(aiLLMBox) aiLLMBox.textContent = '正在复用总览模型配置，调用大模型进行综合分析...';
  setLLMStatus('AI模块正在调用大模型综合分析...', 'info');
  try {
    const text = await callLLMChatCompletions(buildTrendAnalysisPrompt(data), 2200);
    if(window.__activeTubeAnalysis !== data) return;
    if(aiLLMBox) aiLLMBox.textContent = text;
    renderLLMResult(text);
    setLLMStatus('AI模块大模型综合分析完成。', 'ok');
    setAIVisibilityStatus('本地预测与大模型综合分析均已完成。', 'info');
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
  const config = getLLMConfig();
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
  if(points.length < 1) { svg.innerHTML = '<text x="24" y="44" fill="#7fb3d5" font-size="14">暂无硬度数据</text>'; return; }
  const width=980,height=260,p={top:30,right:28,bottom:42,left:58}; const vals=points.map(x=>x.value).concat(signal.hardnessForecast ? [signal.hardnessForecast.oneYear,signal.hardnessForecast.threeYear] : []); const min=Math.min(...vals)-10,max=Math.max(...vals)+10; const minY=Math.min(...points.map(x=>x.year)), maxY=Math.max(...points.map(x=>x.year), points[points.length-1].year + (signal.hardnessForecast ? 3 : 1), minY+1); const xs=y=>p.left+(y-minY)/Math.max(1,maxY-minY)*(width-p.left-p.right); const ys=v=>p.top+(height-p.top-p.bottom)-((v-min)/Math.max(1,max-min))*(height-p.top-p.bottom); const path=points.map((x,i)=>`${i?'L':'M'} ${xs(x.year)} ${ys(x.value)}`).join(' '); svg.innerHTML=`<rect x="${p.left}" y="${p.top}" width="${width-p.left-p.right}" height="${height-p.top-p.bottom}" rx="6" fill="rgba(0,12,28,.72)" stroke="rgba(127,179,213,.18)"/><text x="${p.left}" y="18" fill="#e6f7ff" font-size="14" font-weight="700">Hardness Forecast · HB</text><path d="${path}" fill="none" stroke="#ffb454" stroke-width="3"/>${points.map(x=>`<circle cx="${xs(x.year)}" cy="${ys(x.value)}" r="5" fill="#001122" stroke="#ffb454" stroke-width="2"><title>${x.date} ${x.value}HB</title></circle>`).join('')}<line x1="${p.left}" y1="${ys(points[points.length-1].value)}" x2="${width-p.right}" y2="${ys(points[points.length-1].value)}" stroke="rgba(255,180,84,.25)" stroke-dasharray="5 5"/><text x="${p.left-8}" y="${p.top+4}" text-anchor="end" fill="#7fb3d5" font-size="11">${max.toFixed(0)}</text><text x="${p.left-8}" y="${height-p.bottom+4}" text-anchor="end" fill="#7fb3d5" font-size="11">${min.toFixed(0)}</text>`;
  for(let year = Math.ceil(minY); year <= maxY; year++) svg.innerHTML += `<text x="${xs(year)}" y="${height-12}" text-anchor="middle" fill="#7fb3d5" font-size="11">${year}</text>`;
  if(signal.hardnessForecast) { const y=points[points.length-1].year; svg.innerHTML += `<path d="M ${xs(y)} ${ys(points[points.length-1].value)} L ${xs(y+1)} ${ys(signal.hardnessForecast.oneYear)} L ${xs(y+3)} ${ys(signal.hardnessForecast.threeYear)}" fill="none" stroke="#a78bfa" stroke-width="3" stroke-dasharray="8 5"/><circle cx="${xs(y+1)}" cy="${ys(signal.hardnessForecast.oneYear)}" r="4" fill="#a78bfa"/><circle cx="${xs(y+3)}" cy="${ys(signal.hardnessForecast.threeYear)}" r="4" fill="#a78bfa"/>`; }
}function renderAIResults(data) {
  document.getElementById('ai-loading').style.display = 'none';
  document.getElementById('ai-results').style.display = 'block';
  document.getElementById('ai-rul').textContent = data.rulText || data.rul.toLocaleString();
  document.getElementById('ai-rate').textContent = data.rate;
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
  svg.innerHTML = `<text x="24" y="30" fill="#ffb454" font-size="14">不可可靠预测 · 仅展示实测历史，不生成临时阈值或预测线</text><path d="${points.map((p,i) => `${i?'L':'M'} ${x(p.year)} ${y(p.val)}`).join(' ')}" fill="none" stroke="#00d4ff" stroke-width="3"/>${points.map(p => `<circle cx="${x(p.year)}" cy="${y(p.val)}" r="5" fill="#00d4ff"><title>${escapeHTML(p.dateStr || p.year)} ${p.val}mm</title></circle><text x="${x(p.year)}" y="380" fill="#7fb3d5" font-size="12">${p.year}</text>`).join('')}`;
}
function renderAIChart(data) {
  if(!document.getElementById('aiChart')) return;
  if(!data || !Array.isArray(data.history) || data.history.length === 0) { document.getElementById('aiChart').innerHTML = '<text x="24" y="44" fill="#7fb3d5" font-size="14">暂无可绘制的测厚数据</text>'; return; }
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
    <linearGradient id="aiBand" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="rgba(34,192,126,0.26)"/><stop offset="100%" stop-color="rgba(0,212,255,0.04)"/></linearGradient>
    <linearGradient id="riskZone" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="rgba(240,87,74,0.04)"/><stop offset="100%" stop-color="rgba(240,87,74,0.18)"/></linearGradient>
    <linearGradient id="panelFill" x1="0" x2="1"><stop offset="0%" stop-color="rgba(0,29,61,0.72)"/><stop offset="100%" stop-color="rgba(0,6,15,0.88)"/></linearGradient>
    <filter id="aiGlow"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
  svg.innerHTML += `<rect x="${padding.left}" y="${padding.top}" width="${chartW}" height="${chartH}" rx="6" fill="rgba(0,12,28,0.72)" stroke="rgba(127,179,213,0.18)" />`;
  const threshY = yScale(data.threshold);
  svg.innerHTML += `<rect x="${padding.left}" y="${threshY}" width="${chartW}" height="${Math.max(0, plotBottom - threshY)}" fill="url(#riskZone)" />`;
  for(let i=0; i<=5; i++) {
    const y = padding.top + (chartH / 5) * i, val = maxVal - ((maxVal - minVal) / 5) * i;
    svg.innerHTML += `<line x1="${padding.left}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="rgba(127,179,213,0.14)" stroke-width="1" /><text x="${padding.left-12}" y="${y+4}" fill="#7fb3d5" font-size="11" text-anchor="end">${val.toFixed(1)}</text>`;
  }
  for(let y = minYear; y <= maxYear; y++) {
    const x = xScale(y);
    svg.innerHTML += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${plotBottom}" stroke="rgba(127,179,213,0.08)" stroke-width="1" /><text x="${x}" y="${height - 22}" fill="#7fb3d5" font-size="11" text-anchor="middle">${y}</text>`;
  }
  svg.innerHTML += `<line x1="${padding.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="rgba(127,179,213,0.36)" /><line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${plotBottom}" stroke="rgba(127,179,213,0.36)" />`;
  svg.innerHTML += `<text x="${padding.left}" y="28" fill="#e6f7ff" font-size="15" font-weight="700">Wall Thickness Forecast</text><text x="${padding.left}" y="45" fill="#7fb3d5" font-size="11">unit: mm · threshold by tube specification</text><text x="22" y="${padding.top + 14}" fill="#7fb3d5" font-size="11" transform="rotate(-90 22 ${padding.top + 14})">厚度 / mm</text>`;
  const bandTop = data.prediction.map(p => `${xScale(p.year)},${yScale(p.high)}`).join(' ');
  const bandBottom = [...data.prediction].reverse().map(p => `${xScale(p.year)},${yScale(p.low)}`).join(' ');
  if(data.prediction.length > 1) svg.innerHTML += `<polygon points="${bandTop} ${bandBottom}" fill="url(#aiBand)" stroke="rgba(34,192,126,0.24)" stroke-width="1" />`;
  svg.innerHTML += `<line x1="${padding.left}" y1="${threshY}" x2="${plotRight}" y2="${threshY}" stroke="#f0574a" stroke-width="2.4" stroke-dasharray="10 8" stroke-linecap="butt" />`;
  svg.innerHTML += `<text x="${padding.left + 8}" y="${Math.max(padding.top + 14, threshY - 8)}" fill="#ffb3c1" font-size="11" font-weight="700">理论阈值 ${data.threshold.toFixed(2)}mm</text>`;
  const histPath = data.history.map((p, i) => `${i===0?'M':'L'} ${xScale(p.year)} ${yScale(p.val)}`).join(' ');
  svg.innerHTML += `<path d="${histPath}" fill="none" stroke="#00d4ff" stroke-width="3.4" filter="url(#aiGlow)" />`;
  data.history.forEach(p => {
    const isOutlier = data.outliers?.some(o => o.dateStr === p.dateStr && o.val === p.val);
    svg.innerHTML += `<circle cx="${xScale(p.year)}" cy="${yScale(p.val)}" r="${isOutlier ? 6.5 : 5.5}" fill="#001122" stroke="${isOutlier ? '#ff9f43' : '#00d4ff'}" stroke-width="2.5" style="cursor:pointer"><title>${p.dateStr} ${p.val}mm ${isOutlier ? '异常候选' : ''}</title></circle>`;
  });
  const lastHist = data.history[data.history.length - 1];
  const predPath = `M ${xScale(lastHist.year)} ${yScale(lastHist.val)} ` + data.prediction.map(p => `L ${xScale(p.year)} ${yScale(p.val)}`).join(' ');
  svg.innerHTML += `<path d="${predPath}" fill="none" stroke="#22c07e" stroke-width="3.2" stroke-dasharray="10,6" filter="url(#aiGlow)" />`;
  data.prediction.forEach(p => svg.innerHTML += `<circle cx="${xScale(p.year)}" cy="${yScale(p.val)}" r="4.3" fill="#22c07e"><title>${p.year} P50 ${p.val}mm；区间 ${p.low}~${p.high}mm</title></circle>`);
  for(const [key, color, label] of [['baseline','#ffb454','基准情景'],['accelerated','#f0574a','加速情景']]) {
    const points = data.prediction.filter(point => Number.isFinite(point[key]));
    if(points.length) svg.innerHTML += `<path d="M ${xScale(lastHist.year)} ${yScale(lastHist.val)} ${points.map(point => `L ${xScale(point.year)} ${yScale(point[key])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 5"><title>${label}</title></path>`;
  }
  const currentX = xScale(lastHist.year), currentY = yScale(lastHist.val);
  if(['replace','replace-soon'].includes(data.replacementWarning?.level)) svg.innerHTML += `<circle cx="${currentX}" cy="${currentY}" r="10" fill="none" stroke="#f0574a" stroke-width="3"><title>${escapeHTML(data.replacementWarning.label)}</title></circle>`;
  svg.innerHTML += `<line x1="${currentX}" y1="${currentY}" x2="${currentX + 54}" y2="${currentY - 34}" stroke="rgba(0,212,255,0.48)" /><rect x="${currentX + 56}" y="${currentY - 52}" width="126" height="34" rx="5" fill="rgba(0,29,61,0.88)" stroke="rgba(0,212,255,0.36)" /><text x="${currentX + 66}" y="${currentY - 31}" fill="#e6f7ff" font-size="11">当前 ${lastHist.val.toFixed(2)}mm</text>`;
  if(Number.isFinite(numericP50) && numericP50 <= maxYear) {
    const x = xScale(numericP50);
    svg.innerHTML += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${plotBottom}" stroke="rgba(34,192,126,0.38)" stroke-width="1.5" stroke-dasharray="4,5" /><text x="${x+6}" y="${padding.top+16}" fill="#8cf7c5" font-size="11">P50 ${data.p50ThresholdYear}</text>`;
  }
  if(Number.isFinite(numericP90) && numericP90 <= maxYear) {
    const x = xScale(numericP90);
    svg.innerHTML += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${plotBottom}" stroke="rgba(255,159,67,0.68)" stroke-width="2" stroke-dasharray="7,5" /><rect x="${Math.min(x + 8, plotRight - 150)}" y="${plotBottom - 36}" width="142" height="26" rx="5" fill="rgba(255,159,67,0.14)" stroke="rgba(255,159,67,0.48)" /><text x="${Math.min(x + 16, plotRight - 142)}" y="${plotBottom - 18}" fill="#ffd29a" font-size="11" font-weight="700">基准触阈估算 ${data.thresholdYear}</text>`;
  }
  const panelX = plotRight + 22;
  svg.innerHTML += `<rect x="${panelX}" y="${padding.top}" width="184" height="204" rx="8" fill="url(#panelFill)" stroke="rgba(127,179,213,0.22)" />`;
  svg.innerHTML += `<text x="${panelX + 14}" y="${padding.top + 26}" fill="#e6f7ff" font-size="13" font-weight="700">ENGINEERING MODEL</text>`;
  const panelRows = [
    ['Method', 'Theil-Sen + MAD'],
    ['Risk', data.status],
    ['Rate', data.rate],
    ['Threshold', `${data.threshold.toFixed(2)} mm`],
    ['P50 year', data.p50ThresholdYear],
    ['Baseline', data.thresholdYear],
    ['Confidence', `${data.conf}%`]
  ];
  panelRows.forEach((row, index) => {
    const y = padding.top + 52 + index * 20;
    svg.innerHTML += `<text x="${panelX + 14}" y="${y}" fill="#7fb3d5" font-size="10">${row[0]}</text><text x="${panelX + 92}" y="${y}" fill="#ffffff" font-size="10" font-weight="700">${escapeHTML(row[1])}</text>`;
  });
  const hoverPoints = [
    ...data.history.map(p => ({ year: p.year, val: p.val, label: `${p.dateStr} · 实测 ${p.val}mm` })),
    ...data.prediction.map(p => ({ year: p.year, val: p.val, label: `${p.year} · P50 ${p.val}mm` }))
  ];
  const tipW = 158, tipH = 30;
  svg.innerHTML += `<g id="aiChartHover" opacity="0" pointer-events="none">
    <line y1="${padding.top}" y2="${plotBottom}" stroke="rgba(47,212,232,0.5)" stroke-width="1" stroke-dasharray="3 3" />
    <circle r="5" fill="#001122" stroke="#2fd4e8" stroke-width="2" filter="url(#aiGlow)" />
    <rect rx="5" ry="5" width="${tipW}" height="${tipH}" fill="rgba(4,16,28,0.96)" stroke="rgba(72,202,228,0.4)" />
    <text id="aiChartTipText" fill="#8ce6f2" font-size="11" font-weight="700" text-anchor="middle"></text>
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

const ZONES = { qdp: {title:'全大屏过热器', sys:'PSH', spec:'Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91', count:'6片×4小屏', desc:'位于炉膛上方，全辐射式受热面。工作条件极为恶劣，屏底外圈采用 SA-213T91 耐热钢。', params:'吸收炉膛高温辐射热 | 烟气侧易结渣 | 需重点监控夹持管状态'}, hp: {title:'后屏/屏式过热器', sys:'ISH', spec:'Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG', count:'21屏', desc:'布置于炉膛出口处，辐射对流式受热面。最外圈及包扎管底部采用奥氏体不锈钢 TP347H。', params:'承受炉膛出口高温烟气冲刷 | 易发生高温腐蚀 | 节距 S1=685.8'}, gg: {title:'高温过热器 (高过)', sys:'HSH', spec:'Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG', count:'32片', desc:'悬吊于水平烟道内，顺列顺流布置。12管圈U形绕制，暴露在最外侧的管子采用 TP304H。', params:'蒸汽温度最高区 | 烟气流向转折区 | 需防范管排晃动磨损'}, gz: {title:'高温再热器 (高再)', sys:'HRH', spec:'Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG', count:'64片', desc:'位于水平烟道后部，7根管圈绕制。入口设有喷水减温器，控制再热汽温。', params:'带喷水减温控制 | 烟气温度开始下降 | 管间由带状机械管夹定位'}, dwgr: {title:'低温过热器 (低过)', sys:'LSH', spec:'Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG', count:'112排', desc:'布置于尾部竖井前烟道，顺列逆流布置。水平段分4组，留有检修空间。', params:'入口烟温 876.6℃ | 出口烟温 382.7℃ | 压降 -0.3kPa | 易积灰'}, dwzr: {title:'低温再热器 (低再)', sys:'LRH', spec:'Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG', count:'112片+56片', desc:'布置于尾部竖井后烟道，与低过并列。水平段5组，垂直段每2排并1排。', params:'入口烟温 840.3℃ | 出口烟温 349.4℃ | 压降 -0.2kPa | 支撑块承重'}, scr: {title:'SCR 脱硝反应器', sys:'SCR', spec:'氨注射栅格 + 催化剂', count:'A/B侧', desc:'位于尾部烟道下方，喷氨格栅将氨气与烟气均匀混合，通过催化剂还原 NOx。', params:'入口NOx ~278 mg/Nm³ | 出口NOx 25.1 mg/Nm³ | 脱硝效率 99.9% | 氨逃逸 <3ppm'}, smq: {title:'省煤器', sys:'ECO', spec:'Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G', count:'124管', desc:'分上、下两级串联布置于烟气挡板之后的下行竖井内，利用尾部烟气余热加热锅炉给水，降低排烟温度。', params:'上/下两级分级串联 | 烟温 287.5℃ → 289.0℃ | 易发生低温腐蚀与飞灰磨损'} };
function showZone(z) { const info = ZONES[z]; const el = document.getElementById('zoneDetail'); el.style.display = 'block'; el.innerHTML = `<div class="card-title"><span class="badge badge-ww">${info.sys}</span> ${info.title}</div><div class="info-grid"><div class="info-item"><div class="k">规格/材质</div><div class="v">${info.spec}</div></div><div class="info-item"><div class="k">数量/规模</div><div class="v">${info.count}</div></div><div class="info-item" style="grid-column:span 2;"><div class="k">湛江#1机组 实时运行参数</div><div class="v" style="font-size:13px; color:var(--warn);">${info.params}</div></div><div class="info-item" style="grid-column:span 2;"><div class="k">工艺与防磨防爆描述</div><div class="v" style="font-size:12px;">${info.desc}</div></div></div>`; el.scrollIntoView({behavior:'smooth', block:'nearest'}); }

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
renderDMTable();
updateLifecycleDropdown();
populateAIThicknessTargets();
loadLLMConfigToForm();
renderDashboardWarnings(); syncDashboardSnapshot();
renderMaintenancePlan();
loadAuthSession();
bootstrapCloudStorage();
