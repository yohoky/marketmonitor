// 设置页逻辑（v1.5.1：多监控列表 / 收件邮箱槽位 / 配置导出导入 / 自动更新）
//
// 数据流：主进程持有唯一真相（store），本页只保存一份镜像 state。
// 所有改动都走 saveList(id, patch) / saveEmailConfig(patch)，成功后用主进程返回的对象回写镜像，
// 避免"界面显示的值"和"实际落盘的值"不一致（归一化逻辑只在主进程里存在一份）。

// ---------- 元素句柄 ----------
const listEl = document.getElementById('stock-list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const countFootEl = document.getElementById('count-foot');
const symbolInput = document.getElementById('symbol-input');
const bulkInput = document.getElementById('bulk-input');
const candidateList = document.getElementById('candidate-list');
const tabsEl = document.getElementById('list-tabs');

// 东方财富拼音搜索 API（免费无 key）
const PINYIN_API = 'https://searchapi.eastmoney.com/api/suggest/get';
const PINYIN_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

// ---------- 全局状态镜像 ----------
let state = { lists: [], email: {}, presetIndexes: [], maxLists: 6, maxBoxes: 5 };
let activeId = null;
let lastQuotes = [];       // 全量行情缓存（多列表合并请求的那一份）
let quotesMap = {};        // symbol(小写) -> quote

function activeList() {
  return state.lists.find(l => l.id === activeId) || null;
}

// ---------- 代码识别 ----------
// 支持：A 股 / 基金(ETF/LOF) / 可转债 / 港股
// A股规则（6 位数字）：
//   沪 sh：6xxxxx(A股)  9xxxxx  5xxxxx(基金)  11xxxx(可转债)
//   深 sz：0xxxxx/2xxxxx/3xxxxx(A股)  15xxxx/16xxxx/18xxxx(基金)  12xxxx(可转债)
// 港股规则：hk 前缀（hk981 / hk00981，位数自动补零到 5 位）或纯 5 位数字（00981 = 中芯国际）
// 北交所(4/8 开头)暂不支持，可用 sh/sz 前缀手动加
function normalizeSymbol(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  // 允许 "600519 贵州茅台" / "600519贵州茅台" 这类带名称的写法：先摘出代码段
  const seg = s.match(/(?:hk|sh|sz)?\d{5,6}|hk\d{1,4}/i);
  s = seg ? seg[0] : s.replace(/\s+/g, '');
  // hk 前缀 = 港股（位数不足 5 位自动补零：hk981 → hk00981）
  if (/^hk\d{1,5}$/.test(s)) return 'hk' + s.slice(2).padStart(5, '0');
  // 已有 sh/sz 前缀（A股/基金/可转债都可用前缀直接传）
  if (/^(sh|sz)\d{6}$/.test(s)) return s;
  // 6 位纯数字
  if (/^\d{6}$/.test(s)) {
    const head = s[0];
    // 沪市
    if (head === '6' || head === '9' || head === '5') return 'sh' + s;   // A股(6)/沪(9)/基金(5)
    if (s.indexOf('11') === 0) return 'sh' + s;                          // 沪可转债
    // 深市
    if (head === '0' || head === '2' || head === '3') return 'sz' + s;   // A股
    if (s.indexOf('12') === 0 || s.indexOf('15') === 0 ||
        s.indexOf('16') === 0 || s.indexOf('18') === 0) return 'sz' + s; // 深可转债(12)/基金(15/16/18)
    return null;   // 其余(北交所 4/8 等)暂不支持
  }
  // 5 位纯数字 = 港股（A 股代码一律 6 位，港股为 5 位）
  if (/^\d{5}$/.test(s)) return 'hk' + s;
  return null;
}

// ---------- Tab ----------
function renderTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  state.lists.forEach((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (l.id === activeId ? ' active' : '');
    b.innerHTML = `<span class="t-name">${escapeHtml(l.name || l.id)}</span><span class="t-num">${(l.symbols || []).length}</span>`;
    b.title = `${l.name || l.id}（${(l.symbols || []).length} 只）${l.visible === false ? ' · 启动不显示' : ''}`;
    b.addEventListener('click', () => selectList(l.id));
    tabsEl.appendChild(b);
  });
  const addBtn = document.getElementById('new-list-btn');
  if (addBtn) {
    const full = state.lists.length >= state.maxLists;
    addBtn.disabled = full;
    addBtn.textContent = full ? `已达上限 ${state.maxLists} 个` : '+ 新建列表';
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 切换列表 Tab：把这一份配置铺到所有控件上
function selectList(id) {
  if (!state.lists.some(l => l.id === id)) return;
  activeId = id;
  renderTabs();
  renderList();
  renderListMeta();
  renderAppearance();
  renderAlerts();
  renderMailPick();
  renderDigest();
  renderIdxGrid();
  renderPosition();
  renderFooter();
}

// ---------- 当前列表：元信息 ----------
function renderListMeta() {
  const l = activeList();
  if (!l) return;
  const nameEl = document.getElementById('list-name');
  const visEl = document.getElementById('list-visible');
  const delBtn = document.getElementById('list-delete');
  const hint = document.getElementById('list-hint');
  if (nameEl) nameEl.value = l.name || '';
  if (visEl) visEl.checked = l.visible !== false;
  if (delBtn) {
    const only = state.lists.length <= 1;
    delBtn.disabled = only;
    delBtn.title = only ? '至少要保留一个列表' : '删除后该列表的窗口会关闭';
  }
  if (hint) {
    const pos = l.position || { x: 0, y: 0 };
    hint.innerHTML = `列表 ID <b>${escapeHtml(l.id)}</b> · 窗口 ${l.width}×${l.height} · 位置 X ${pos.x} / Y ${pos.y}`
      + (l.visible === false ? ' · <b>启动时不显示</b>（可从托盘「监控列表」里手动打开）' : '');
  }
}

// ---------- 当前列表：标的列表 ----------
function renderList() {
  const l = activeList();
  if (!listEl || !l) return;
  const symbols = l.symbols || [];
  listEl.innerHTML = '';
  if (emptyEl) emptyEl.style.display = symbols.length === 0 ? 'block' : 'none';
  if (countEl) countEl.textContent = symbols.length;
  if (countFootEl) countFootEl.textContent = symbols.length;

  symbols.forEach((s, idx) => {
    const q = quotesMap[String(s.symbol).toLowerCase()];
    const pct = q ? (q.changePct || 0) : 0;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const sign = pct > 0 ? '+' : '';
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="s-name" title="${escapeHtml(s.name || s.symbol)}">${escapeHtml(s.name || s.symbol)}</div>
      <div class="s-code">${escapeHtml(s.symbol)}</div>
      <div class="s-price">${q ? Number(q.price).toFixed(2) : '--'}</div>
      <div class="s-pct ${cls}">${q ? `${sign}${pct.toFixed(2)}%` : '--'}</div>
      <div class="s-sort">
        <button class="s-top" data-idx="${idx}" title="一键置顶（移到最前）" ${idx === 0 ? 'disabled' : ''}>⇧</button>
        <button class="s-up" data-idx="${idx}" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="s-down" data-idx="${idx}" title="下移" ${idx === symbols.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="s-bottom" data-idx="${idx}" title="一键置底（移到末尾）" ${idx === symbols.length - 1 ? 'disabled' : ''}>⇩</button>
      </div>
      <button class="s-del" data-idx="${idx}" title="删除">×</button>
    `;
    listEl.appendChild(li);
  });

  const edit = (fn) => async (e) => {
    const arr = (activeList().symbols || []).slice();
    const next = fn(arr, +e.currentTarget.dataset.idx);
    if (next) await commitSymbols(next);
  };

  listEl.querySelectorAll('.s-del').forEach((btn) => {
    btn.addEventListener('click', edit((arr, i) => { arr.splice(i, 1); return arr; }));
  });
  listEl.querySelectorAll('.s-top').forEach((btn) => {
    btn.addEventListener('click', edit((arr, i) => {
      if (i <= 0) return null;
      const [x] = arr.splice(i, 1); arr.unshift(x); return arr;
    }));
  });
  listEl.querySelectorAll('.s-bottom').forEach((btn) => {
    btn.addEventListener('click', edit((arr, i) => {
      if (i >= arr.length - 1) return null;
      const [x] = arr.splice(i, 1); arr.push(x); return arr;
    }));
  });
  listEl.querySelectorAll('.s-up').forEach((btn) => {
    btn.addEventListener('click', edit((arr, i) => {
      if (i <= 0) return null;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; return arr;
    }));
  });
  listEl.querySelectorAll('.s-down').forEach((btn) => {
    btn.addEventListener('click', edit((arr, i) => {
      if (i >= arr.length - 1) return null;
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; return arr;
    }));
  });
  renderFooter();
}

function renderFooter() {
  const l = activeList();
  const n = l ? (l.symbols || []).length : 0;
  if (countFootEl) countFootEl.textContent = n;
  if (countEl) countEl.textContent = n;
}

// 保存当前列表的标的（完整数组），成功后回写镜像并刷新 UI
async function commitSymbols(symbols) {
  const l = activeList();
  if (!l) return;
  try {
    const r = await window.stockApi.saveList(l.id, { symbols });
    if (r && r.ok && r.list) applyListUpdate(r.list);
    else if (r && r.error) alert(r.error);
  } catch (e) { console.error('saveList(symbols) 失败', e); }
  renderTabs();
  renderList();
  renderListMeta();
  renderIdxGrid();
}

// 用主进程返回的权威对象替换镜像里那一条
function applyListUpdate(u) {
  const i = state.lists.findIndex(l => l.id === u.id);
  if (i >= 0) state.lists[i] = u; else state.lists.push(u);
}

// ---------- 添加单只 ----------
async function addOne(raw) {
  const l = activeList();
  if (!l) return false;
  const symbols = (l.symbols || []).slice();
  const sym = normalizeSymbol(raw);
  if (!sym) {
    const candidates = await searchStocks(raw);
    if (candidates.length === 1) return addByCandidate(candidates[0]);
    if (candidates.length > 1) {
      const pick = await showPicker(candidates);
      if (pick) return addByCandidate(pick);
      return false;
    }
    alert(`未找到匹配「${raw}」的品种，请输入代码（A股/基金/可转债 6 位，港股 5 位或 hk 前缀）或更精确的拼音缩写`);
    return false;
  }
  if (symbols.find(s => String(s.symbol).toLowerCase() === sym.toLowerCase())) {
    alert(`本列表已存在：${sym}`);
    return false;
  }
  const name = await fetchStockName(sym);
  symbols.push({ symbol: sym, name });
  await commitSymbols(symbols);
  symbolInput.value = '';
  symbolInput.focus();
  return true;
}

// ---------- 拼音搜索（东方财富 API）----------
async function searchStocks(query, count = 5) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const url = `${PINYIN_API}?input=${encodeURIComponent(q)}&type=14&token=${PINYIN_TOKEN}&count=${count}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        'Referer': 'https://so.eastmoney.com/',
      },
    });
    clearTimeout(t);
    const json = await res.json();
    const data = json?.QuotationCodeTable?.Data || [];
    return data
      // A 股 + 基金 + 可转债 + 港股（指数等排除）
      .filter((x) => {
        const mkt = Number(x.MktNum);
        // 港股：东财市场号 116 / Classify=HK；只保留 5 位以内的正股，滤掉窝轮牛熊证
        if (mkt === 116 || x.Classify === 'HK') {
          const c = String(x.Code || '');
          if (!/^\d{5}$/.test(c)) return false;
          if (Number(c) >= 10000) return false;
          if (/购|沽|牛|熊|权证|窝轮/.test(x.Name || '')) return false;
          return true;
        }
        if ([0, 1, 105, 106].includes(mkt) && x.Code && String(x.Code).length === 6) return true;
        return x.Classify === 'AStock';
      })
      .map(x => ({
        code: x.Code,
        symbol: buildSymbol(x.Code, x.MktNum),
        name: x.Name,
        pinYin: x.PinYin,
      }))
      .filter((x) => x.symbol && /^((sh|sz)\d{6}|hk\d{5})$/.test(x.symbol) && !/指数/.test(x.name || ''));
  } catch (e) {
    console.error('[searchStocks]', e.message);
    return [];
  }
}

// 根据市场号构造 sh/sz/hk 前缀
function buildSymbol(code, mktNum) {
  const n = Number(mktNum);
  if (n === 116) return 'hk' + String(code).padStart(5, '0');   // 港股
  if (n === 1 || n === 105) return 'sh' + code;   // 沪 / 沪B
  if (n === 0 || n === 106) return 'sz' + code;   // 深 / 深B
  return normalizeSymbol(code) || ('sh' + code);
}

// ---------- 候选展示 ----------
function renderCandidates(list) {
  if (!candidateList) return;
  if (!list || list.length === 0) {
    candidateList.style.display = 'none';
    candidateList.innerHTML = '';
    return;
  }
  candidateList.innerHTML = '';
  candidateList.style.display = 'block';
  list.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'candidate';
    div.innerHTML = `
      <div class="c-name" title="${escapeHtml(c.pinYin)}">${escapeHtml(c.name)}</div>
      <div class="c-code">${escapeHtml(c.symbol)}</div>
      <div class="c-pinyin">${escapeHtml(c.pinYin)}</div>
    `;
    div.addEventListener('click', () => addByCandidate(c));
    candidateList.appendChild(div);
  });
}
function hideCandidates() {
  if (candidateList) candidateList.style.display = 'none';
}

// 模态选择器（候选多时弹一层）
function showPicker(candidates) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'picker-mask';
    const box = document.createElement('div');
    box.className = 'picker-box';
    box.innerHTML = '<div class="picker-title">请选择要添加的品种（最多前 10 个）</div>' +
      candidates.slice(0, 10).map((c, i) => `
        <div class="picker-item" data-i="${i}">
          <div class="p-name">${escapeHtml(c.name)}</div>
          <div class="p-code">${escapeHtml(c.symbol)}</div>
        </div>`).join('') +
      '<div class="picker-cancel" data-cancel>取消</div>';
    mask.appendChild(box);
    document.body.appendChild(mask);

    box.querySelectorAll('.picker-item').forEach((el) => {
      el.addEventListener('click', () => {
        const i = +el.dataset.i;
        mask.remove();
        resolve(candidates[i]);
      });
    });
    box.querySelector('.picker-cancel').addEventListener('click', () => {
      mask.remove();
      resolve(null);
    });
    mask.addEventListener('click', (e) => {
      if (e.target === mask) { mask.remove(); resolve(null); }
    });
  });
}

async function addByCandidate(c) {
  const l = activeList();
  if (!l) return false;
  const symbols = (l.symbols || []).slice();
  if (symbols.find(s => String(s.symbol).toLowerCase() === String(c.symbol).toLowerCase())) {
    alert(`本列表已存在：${c.name} ${c.symbol}`);
    return false;
  }
  symbols.push({ symbol: c.symbol, name: c.name });
  await commitSymbols(symbols);
  symbolInput.value = '';
  hideCandidates();
  return true;
}

// ---------- 批量添加 ----------
function parseBulk(text, existing) {
  if (!text) return [];
  const toks = String(text).split(/[\s,;，；]+/).filter(Boolean);
  const out = [];
  const seen = new Set(existing.map(s => String(s.symbol).toLowerCase()));
  for (const t of toks) {
    // 5~6 位 = A股/基金/可转债/港股；hk 前缀另允许 1~4 位（hk981）
    const m = t.match(/(?:hk|sh|sz)?\d{5,6}/i) || t.match(/hk\d{1,4}/i);
    if (!m) continue;
    const sym = normalizeSymbol(m[0]);
    if (!sym) continue;
    const key = sym.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // 名字：取数字之后的文字
    let name = '';
    for (const piece of t.split(/\s+/)) {
      if (!/^\d+$/.test(piece)) { name = piece; break; }
    }
    out.push({ symbol: sym, name });
  }
  return out;
}

async function bulkAdd() {
  const l = activeList();
  if (!l) return;
  const arr = parseBulk(bulkInput.value, l.symbols || []);
  if (arr.length === 0) {
    alert('未识别到任何有效代码（或全部已存在于本列表）');
    return;
  }
  const symbols = (l.symbols || []).slice();
  for (const it of arr) {
    const finalName = it.name || await fetchStockName(it.symbol);
    symbols.push({ symbol: it.symbol, name: finalName });
  }
  await commitSymbols(symbols);
  bulkInput.value = '';
}

// ---------- 清空 ----------
async function clearAll() {
  const l = activeList();
  if (!l) return;
  const n = (l.symbols || []).length;
  if (n === 0) return;
  if (!confirm(`确定清空「${l.name}」的 ${n} 条记录？`)) return;
  await commitSymbols([]);
}

// ---------- 拉取股票名（走 IPC 由主进程 GBK 解码）----------
async function fetchStockName(sym) {
  try {
    const name = await window.stockApi.fetchStockName(sym);
    if (name) return name;
  } catch (_) {}
  return sym;
}

// ---------- 名称自动补全 ----------
// 当前列表里凡是"名称缺失"（name 为空 或 name===symbol）的品种，自动解析成中文名称：
// 优先用实时行情已带的名称，其次向主进程查一次，成功后落库并刷新，只此一次。
async function backfillNames() {
  const l = activeList();
  if (!l) return;
  const symbols = (l.symbols || []).slice();
  const pending = symbols.filter(s => !s.name || s.name === s.symbol);
  if (pending.length === 0) return;
  let dirty = false;
  for (const s of pending) {
    const q = quotesMap[String(s.symbol).toLowerCase()];
    let resolved = (q && q.name && q.name !== s.symbol) ? q.name : null;
    if (!resolved) {
      try {
        const n = await window.stockApi.fetchStockName(s.symbol);
        resolved = (n && n !== s.symbol) ? n : null;
      } catch (_) { resolved = null; }
    }
    if (resolved) { s.name = resolved; dirty = true; }
  }
  if (dirty) {
    try { await commitSymbols(symbols); } catch (_) {}
  }
}

// ---------- 外观与尺寸 ----------
const opacitySlider = document.getElementById('opacity-slider');
const opacityVal = document.getElementById('opacity-val');
const opacityHint = document.getElementById('opacity-hint');
const topmostChk = document.getElementById('topmost-chk');
const widthInput = document.getElementById('width-input');
const heightInput = document.getElementById('height-input');
const displayModeSel = document.getElementById('display-mode');
const textOpacitySlider = document.getElementById('text-opacity-slider');
const textOpacityVal = document.getElementById('text-opacity-val');
const monoChk = document.getElementById('mono-chk');
const scrollSpeedSlider = document.getElementById('scroll-speed-slider');
const scrollSpeedVal = document.getElementById('scroll-speed-val');
const jumpIntervalSlider = document.getElementById('jump-interval-slider');
const jumpIntervalVal = document.getElementById('jump-interval-val');

// 把当前列表的外观配置铺到控件上
function renderAppearance() {
  const l = activeList();
  if (!l) return;
  const op = l.opacity ?? 1.0;
  if (opacitySlider) { opacitySlider.value = op; }
  if (opacityVal) opacityVal.textContent = Number(op).toFixed(2);
  const tp = l.textOpacity ?? 1.0;
  if (textOpacitySlider) textOpacitySlider.value = tp;
  if (textOpacityVal) textOpacityVal.textContent = Number(tp).toFixed(2);
  if (monoChk) monoChk.checked = !!l.mono;
  if (topmostChk) topmostChk.checked = l.topMost !== false;
  if (widthInput) widthInput.value = l.width || 220;
  if (heightInput) heightInput.value = l.height || 84;
  if (displayModeSel) displayModeSel.value = l.displayMode || 'scroll';
  const sm = l.scrollMs || 3000;
  if (scrollSpeedSlider) { scrollSpeedSlider.value = sm; }
  if (scrollSpeedVal) scrollSpeedVal.textContent = (Number(sm) / 1000).toFixed(1) + 's/行';
  const jm = l.jumpMs || 3000;
  if (jumpIntervalSlider) { jumpIntervalSlider.value = jm; }
  if (jumpIntervalVal) jumpIntervalVal.textContent = (Number(jm) / 1000).toFixed(1) + 's/页';
}

// 列表级配置保存：patch 里放哪几项就改哪几项（主进程与现有值合并后归一化）
async function saveActive(patch) {
  const l = activeList();
  if (!l) return null;
  try {
    const r = await window.stockApi.saveList(l.id, patch);
    if (r && r.ok && r.list) { applyListUpdate(r.list); return r.list; }
    if (r && r.error) console.warn('saveList 失败：', r.error);
  } catch (e) { console.error('saveList 失败', e); }
  return null;
}

opacitySlider?.addEventListener('input', () => {
  const v = parseFloat(opacitySlider.value);
  if (opacityVal) opacityVal.textContent = v.toFixed(2);
  if (opacityHint) {
    if (v >= 0.7) opacityHint.textContent = '';
    else if (v >= 0.35) opacityHint.textContent = '摸鱼模式 🐟';
    else opacityHint.textContent = '深度摸鱼 🐟🐟🐟';
  }
});
opacitySlider?.addEventListener('change', async () => {
  await saveActive({ opacity: parseFloat(opacitySlider.value) });
});

textOpacitySlider?.addEventListener('input', () => {
  if (textOpacityVal) textOpacityVal.textContent = parseFloat(textOpacitySlider.value).toFixed(2);
});
textOpacitySlider?.addEventListener('change', async () => {
  await saveActive({ textOpacity: parseFloat(textOpacitySlider.value) });
});

monoChk?.addEventListener('change', async () => { await saveActive({ mono: monoChk.checked }); });
topmostChk?.addEventListener('change', async () => { await saveActive({ topMost: topmostChk.checked }); });
displayModeSel?.addEventListener('change', async () => { await saveActive({ displayMode: displayModeSel.value }); });

scrollSpeedSlider?.addEventListener('input', () => {
  if (scrollSpeedVal) scrollSpeedVal.textContent = (parseInt(scrollSpeedSlider.value, 10) / 1000).toFixed(1) + 's/行';
});
scrollSpeedSlider?.addEventListener('change', async () => {
  await saveActive({ scrollMs: parseInt(scrollSpeedSlider.value, 10) });
});
jumpIntervalSlider?.addEventListener('input', () => {
  if (jumpIntervalVal) jumpIntervalVal.textContent = (parseInt(jumpIntervalSlider.value, 10) / 1000).toFixed(1) + 's/页';
});
jumpIntervalSlider?.addEventListener('change', async () => {
  await saveActive({ jumpMs: parseInt(jumpIntervalSlider.value, 10) });
});

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// 读 min/max 属性作为校验依据（避免把用户的半成品输入当成最终值）
function readRange(el, fbMin, fbMax) {
  const lo = parseFloat(el && el.min);
  const hi = parseFloat(el && el.max);
  return {
    min: Number.isFinite(lo) ? lo : fbMin,
    max: Number.isFinite(hi) ? hi : fbMax,
  };
}

// 尺寸：边输边看，但只提交落在合法区间内的值 —— 否则 84→240 的中间态 "2"/"24" 会让窗口先塌到最小再弹回
async function commitSize() {
  const l = activeList();
  if (!widthInput || !heightInput || !l) return;
  const wr = readRange(widthInput, 160, 480);
  const hr = readRange(heightInput, 60, 600);
  const w = parseInt(widthInput.value, 10);
  const h = parseInt(heightInput.value, 10);
  const patch = {};
  if (Number.isFinite(w) && w >= wr.min && w <= wr.max) patch.width = w;
  if (Number.isFinite(h) && h >= hr.min && h <= hr.max) patch.height = h;
  const changed = (patch.width !== undefined && patch.width !== l.width)
    || (patch.height !== undefined && patch.height !== l.height);
  if (!changed) return;
  await saveActive(patch);
  renderListMeta();
}

const applySize = debounce(commitSize, 220);
widthInput?.addEventListener('input', applySize);
heightInput?.addEventListener('input', applySize);
widthInput?.addEventListener('change', commitSize);
heightInput?.addEventListener('change', commitSize);
[widthInput, heightInput].forEach((el) => {
  el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }   // blur 触发 change → commitSize
  });
});

// ---------- 屏幕位置 ----------
const posGrid = document.getElementById('pos-grid');
const posReadout = document.getElementById('pos-readout');
const posDefaultBtn = document.getElementById('pos-default');

function markActiveCell(anchor) {
  posGrid?.querySelectorAll('.pos-cell').forEach((c) => {
    c.classList.toggle('active', c.dataset.anchor === anchor);
  });
}

async function moveTo(anchor) {
  const l = activeList();
  if (!l) return;
  markActiveCell(anchor);
  try {
    const p = await window.stockApi.setWidgetPosition(l.id, anchor);
    if (posReadout && p) posReadout.textContent = `X ${p.x} · Y ${p.y}`;
    const cur = activeList();
    if (cur && p) { cur.position = { x: p.x, y: p.y }; cur.anchor = anchor; }
    renderListMeta();
  } catch (e) { console.error('setWidgetPosition 失败', e); }
}

posGrid?.addEventListener('click', (e) => {
  const cell = e.target.closest?.('.pos-cell');
  if (cell && cell.dataset.anchor) moveTo(cell.dataset.anchor);
});
posDefaultBtn?.addEventListener('click', () => moveTo('bottom-right'));

// 打开设置页 / 切换列表时，刷新坐标读数 + 高亮当前锚点
// （位置现在以「锚点」持久化，换分辨率也贴对；高亮让用户一眼看出当前是哪个方位）
async function renderPosition() {
  const l = activeList();
  if (!l) return;
  markActiveCell(l.anchor || null);
  try {
    const p = await window.stockApi.getWidgetPosition(l.id);
    if (posReadout && p) posReadout.textContent = `X ${p.x} · Y ${p.y}`;
  } catch (_) {
    const pos = l.position || { x: 0, y: 0 };
    if (posReadout) posReadout.textContent = `X ${pos.x} · Y ${pos.y}`;
  }
}

// ---------- 指数库（勾选即加入当前列表）----------
const idxGrid = document.getElementById('idx-grid');
const indexCount = document.getElementById('index-count');
const idxSearch = document.getElementById('idx-search');
const idxManualInput = document.getElementById('idx-manual-input');
const idxManualBtn = document.getElementById('idx-manual-btn');
const idxManualMsg = document.getElementById('idx-manual-msg');

// 预设按「宽基 / 行业板块 / 主题概念」三组展示；手写在 config.ini 里的清单外代码归到"其它"，
// 保证用户自己加的指数在页面上也看得见、能取消勾选。
const IDX_GROUPS = [
  { key: 'broad', title: '宽基指数' },
  { key: 'sector', title: '行业板块' },
  { key: 'theme', title: '主题概念' },
  { key: 'other', title: '其它（当前列表里已有的指数）' },
];
// 属于"预设分组"的 group 值；其余一律归入"其它"
const PRESET_GROUPS = ['broad', 'sector', 'theme'];

// 指数库搜索词（空格分隔的多关键词按「与」匹配，命中名称或代码即可）
let idxQuery = '';

// 判断一个代码"是不是指数"：上证指数系列 sh000xxx、深证指数系列 sz399xxx、
// 国证指数 sz980xxx，以及港股/外盘指数（hk 开头）。
// 个股（sh6xxxxx / sz00xxxx / sz30xxxx）与基金（sh5xxxxx / sz1[5-8]xxxx）、可转债一律不算。
// 这个过滤是必须的：早期版本把列表里的【个股】也当成候选项塞进指数勾选区，
// 表现为"指数区里混着一堆个股"，用户一眼就看出不对。
function looksLikeIndex(sym) {
  const s = String(sym || '').toLowerCase();
  // sh93xxxx（中证新代码段）目前腾讯行情取不到数，但格式合法 —— 留着，
  // 这样主进程手动添加若要放行同类代码，指数库里也看得见、能取消勾选。
  return /^sh(000\d{3}|93\d{4})$/.test(s) || /^sz(399\d{3}|980\d{3})$/.test(s) || /^hk[a-z]+$/.test(s);
}

function renderIdxGrid() {
  if (!idxGrid) return;
  const l = activeList();
  const symbols = (l && l.symbols) || [];
  const onMap = new Map(symbols.map(s => [String(s.symbol).toLowerCase(), s]));
  // 预设 + 当前列表里出现过的额外【指数】代码（保证手写在 config.ini 里的指数不丢）；
  // 个股 / 基金 / 可转债不进这个网格（looksLikeIndex 过滤），否则指数区会混进个股。
  const all = state.presetIndexes.slice();
  for (const s of symbols) {
    const key = String(s.symbol).toLowerCase();
    if (!looksLikeIndex(s.symbol)) continue;
    if (!all.some(p => String(p.symbol).toLowerCase() === key)) all.push({ symbol: s.symbol, name: s.name, group: 'other' });
  }
  // 搜索：清单有 70+ 项，输入关键字即过滤，省得上下翻。
  const words = String(idxQuery || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (p) => {
    if (!words.length) return true;
    const hay = `${p.name || ''} ${p.symbol || ''}`.toLowerCase();
    return words.every(w => hay.indexOf(w) >= 0);
  };
  idxGrid.innerHTML = '';
  let shown = 0;
  IDX_GROUPS.forEach((g) => {
    const items = all.filter((p) => (g.key === 'other'
      ? PRESET_GROUPS.indexOf(String(p.group)) < 0
      : p.group === g.key)).filter(match);
    if (!items.length) return;
    shown += items.length;
    const title = document.createElement('div');
    title.className = 'idx-group-title';
    title.innerHTML = `${escapeHtml(g.title)}<span class="idx-group-num">${items.length}</span>`;
    idxGrid.appendChild(title);
    const bucket = document.createElement('div');
    bucket.className = 'idx-group-items';
    items.forEach((p) => bucket.appendChild(makeIdxItem(p, onMap)));
    idxGrid.appendChild(bucket);
  });
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'idx-empty';
    empty.textContent = `没有匹配「${String(idxQuery).trim()}」的指数，换个关键词试试`;
    idxGrid.appendChild(empty);
  }
  if (indexCount) {
    const n = all.filter(p => onMap.has(String(p.symbol).toLowerCase())).length;
    indexCount.textContent = n;
  }
}

// 单个指数勾选项：勾 / 取消 → 立即写回当前列表
function makeIdxItem(p, onMap) {
  const key = String(p.symbol).toLowerCase();
  const on = onMap.has(key);
  const label = document.createElement('label');
  label.className = 'idx-item' + (on ? ' on' : '');
  label.innerHTML = `
    <input type="checkbox"${on ? ' checked' : ''} />
    <span>${escapeHtml((onMap.get(key) && onMap.get(key).name) || p.name || p.symbol)}</span>
    <span class="idx-sym">${escapeHtml(p.symbol)}</span>
  `;
  label.querySelector('input').addEventListener('change', async (e) => {
    const cur = activeList();
    if (!cur) return;
    let arr = (cur.symbols || []).slice();
    if (e.target.checked) {
      if (!arr.some(x => String(x.symbol).toLowerCase() === key)) arr.push({ symbol: p.symbol, name: p.name || p.symbol });
    } else {
      arr = arr.filter(x => String(x.symbol).toLowerCase() !== key);
    }
    await commitSymbols(arr);
  });
  return label;
}

// 搜索框：输入即过滤（本地数组过滤，70+ 项也无需防抖）
if (idxSearch) {
  idxSearch.addEventListener('input', (e) => {
    idxQuery = e.target.value || '';
    renderIdxGrid();
  });
}

// 手动添加指数：清单只收常用项，想要的没在里面就自己按代码加。
// 必须走主进程真实行情校验 —— 腾讯行情对"段内但不存在的号"返回空串，
// 敲错一位就会往列表里加进一个永远空着的标的，界面上一眼看不出来。
async function addIndexManual() {
  const raw = String((idxManualInput && idxManualInput.value) || '').trim();
  if (!raw) { if (idxManualInput) idxManualInput.focus(); return; }
  const say = (msg, ok) => {
    if (!idxManualMsg) return;
    idxManualMsg.textContent = msg;
    idxManualMsg.style.color = ok ? '#16a34a' : '#ef4444';
  };
  say('校验中…', true);
  let r = null;
  try { r = await window.stockApi.probeIndex(raw); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { say((r && r.error) || '校验失败', false); return; }

  const l = activeList();
  if (!l) { say('没有选中的列表', false); return; }
  const symbols = (l.symbols || []).slice();
  const key = String(r.symbol).toLowerCase();
  if (symbols.some(s => String(s.symbol).toLowerCase() === key)) {
    say(`当前列表已有：${r.name}（${r.symbol}）`, false);
    return;
  }
  symbols.push({ symbol: r.symbol, name: r.name });
  await commitSymbols(symbols);
  if (idxManualInput) idxManualInput.value = '';
  say(`已加入当前列表：${r.name}（${r.symbol}）`, true);
}
if (idxManualBtn) idxManualBtn.addEventListener('click', addIndexManual);
if (idxManualInput) {
  idxManualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addIndexManual(); }
  });
}

// ---------- 异动提醒（当前列表）----------
const alertEnabled = document.getElementById('alert-enabled');
const alertUpOn = document.getElementById('alert-up-on');
const alertDownOn = document.getElementById('alert-down-on');
const alertThresholdUp = document.getElementById('alert-threshold-up');
const alertThresholdDown = document.getElementById('alert-threshold-down');
const alertCooldown = document.getElementById('alert-cooldown');
const alertSound = document.getElementById('alert-sound');
const alertBigCard = document.getElementById('alert-bigcard');
const alertTrading = document.getElementById('alert-trading');
const alertMarket = document.getElementById('alert-market');

// 「涨幅 / 跌幅」两个勾选框 ⇄ direction 字段互转
function dirFromChecks(upOn, downOn) {
  if (upOn && downOn) return 'both';
  if (upOn) return 'up';
  if (downOn) return 'down';
  return 'none';                 // 两个都不勾 = 不提醒
}
function checksFromDir(dir) {
  return { up: dir !== 'down' && dir !== 'none', down: dir !== 'up' && dir !== 'none' };
}

function renderAlerts() {
  const l = activeList();
  if (!l) return;
  const a = l.alerts || {};
  const chk = checksFromDir(a.direction || 'both');
  if (alertEnabled) alertEnabled.checked = a.enabled !== false;
  if (alertUpOn) alertUpOn.checked = chk.up;
  if (alertDownOn) alertDownOn.checked = chk.down;
  if (alertThresholdUp) alertThresholdUp.value = a.thresholdUp ?? 3.9;
  if (alertThresholdDown) alertThresholdDown.value = a.thresholdDown ?? 3.9;
  if (alertSound) alertSound.checked = a.sound !== false;
  if (alertBigCard) alertBigCard.checked = a.bigCard !== false;
  if (alertTrading) alertTrading.checked = a.tradingHours !== false;
  if (alertMarket) alertMarket.value = ['a', 'hk', 'both'].includes(a.market) ? a.market : 'a';
  if (alertCooldown) {
    const cd = String(a.cooldownMs ?? 180000);
    const opts = Array.from(alertCooldown.options).map(o => o.value);
    alertCooldown.value = opts.includes(cd) ? cd : '180000';
  }
  syncEmailThresholdUI();   // 邮件阈值若跟随异动，需要回显当前列表的阈值
}

// 只改 alerts 里指定的几项，其余保持当前列表原值
async function saveAlerts(patch) {
  const l = activeList();
  if (!l) return;
  const next = { ...(l.alerts || {}), ...patch };
  await saveActive({ alerts: next });
  renderAlerts();
}

function readThreshold(el, fallback) {
  let v = parseFloat(el.value);
  if (!isFinite(v) || v <= 0) v = fallback;
  v = Math.min(50, v);
  el.value = v;
  return v;
}

alertEnabled?.addEventListener('change', () => saveAlerts({ enabled: alertEnabled.checked }));
alertSound?.addEventListener('change', () => saveAlerts({ sound: alertSound.checked }));
alertBigCard?.addEventListener('change', () => saveAlerts({ bigCard: alertBigCard.checked }));
alertTrading?.addEventListener('change', () => saveAlerts({ tradingHours: alertTrading.checked }));
alertMarket?.addEventListener('change', () => saveAlerts({ market: alertMarket.value }));
alertCooldown?.addEventListener('change', () => saveAlerts({ cooldownMs: parseInt(alertCooldown.value, 10) }));
function saveDirection() {
  saveAlerts({ direction: dirFromChecks(!!alertUpOn?.checked, !!alertDownOn?.checked) });
}
alertUpOn?.addEventListener('change', saveDirection);
alertDownOn?.addEventListener('change', saveDirection);
alertThresholdUp?.addEventListener('change', () => saveAlerts({ thresholdUp: readThreshold(alertThresholdUp, 3.9) }));
alertThresholdDown?.addEventListener('change', () => saveAlerts({ thresholdDown: readThreshold(alertThresholdDown, 3.9) }));
document.getElementById('alert-test')?.addEventListener('click', async () => {
  try { await window.stockApi.testAlert(activeId); } catch (_) {}
});

// ---------- 邮件：全局发件账号 + 收件槽位 ----------
const emailEnabled = document.getElementById('email-enabled');
const emailHost = document.getElementById('email-host');
const emailPort = document.getElementById('email-port');
const emailSecure = document.getElementById('email-secure');
const emailUser = document.getElementById('email-user');
const emailPass = document.getElementById('email-pass');
const emailPassHint = document.getElementById('email-pass-hint');
const emailFollow = document.getElementById('email-follow');
const emailThUp = document.getElementById('email-threshold-up');
const emailThDown = document.getElementById('email-threshold-down');
const emailTestBtn = document.getElementById('email-test');
const emailTestResult = document.getElementById('email-test-result');
const slotsEl = document.getElementById('mail-slots');
const pickEl = document.getElementById('mail-pick');
const mailToReadout = document.getElementById('mail-to-readout');
const emailDigest = document.getElementById('email-digest');
const emailDigestMin = document.getElementById('email-digest-min');
const emailDigestMode = document.getElementById('email-digest-mode');
const emailDigestTimes = document.getElementById('email-digest-times');
const digestTimesRow = document.getElementById('digest-times-row');
const digestIntervalLabel = document.getElementById('digest-interval-label');
const digestHint = document.getElementById('digest-hint');
// 默认时点：仅用于界面回显（真正兜底在主进程的 DEFAULT_DIGEST_TIMES）
const DEFAULT_DIGEST_TIMES_UI = '09:30,09:35,09:55,14:35,14:48,14:54';
const emailDigestNowBtn = document.getElementById('email-digest-now');
const emailDigestResult = document.getElementById('email-digest-result');

function looksLikeMail(s) {
  return /^[^\s@,;，；]+@[^\s@,;，；]+\.[^\s@,;，；]+$/.test(String(s || '').trim());
}

// 发件账号部分
function renderEmailGlobal() {
  const c = state.email || {};
  if (emailEnabled) emailEnabled.checked = !!c.enabled;
  if (emailHost) emailHost.value = c.host || '';
  if (emailPort) emailPort.value = c.port || 465;
  if (emailSecure) emailSecure.checked = c.secure !== false;
  if (emailUser) emailUser.value = c.user || '';
  if (emailPass) emailPass.value = '';
  if (emailPassHint) {
    emailPassHint.textContent = c.hasPass ? '已保存授权码（留空则不修改）' : '尚未设置授权码';
    emailPassHint.style.color = c.hasPass ? '#16a34a' : '#94a3b8';
  }
  // 邮件阈值已下移到列表级，由 syncEmailThresholdUI() 按当前列表回显
}

// 收件槽位（1~5）：地址 + 启用
function renderSlots() {
  if (!slotsEl) return;
  const boxes = (state.email && state.email.boxes) || [];
  const max = state.maxBoxes || 5;
  slotsEl.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const b = boxes[i] || { addr: '', on: i === 0 };
    const row = document.createElement('div');
    row.className = 'slot-row' + (b.on ? '' : ' off');
    const bad = b.addr && !looksLikeMail(b.addr) ? '<span class="slot-bad">格式有误</span>' : '';
    row.innerHTML = `
      <span class="slot-no">${i + 1}</span>
      <input type="text" data-i="${i}" placeholder="收件邮箱地址（留空即不用这个槽位）" value="${escapeHtml(b.addr || '')}" autocomplete="off" />
      ${bad}
      <label class="chk-label" style="flex:0 0 auto"><input type="checkbox" data-on="${i}" ${b.on ? 'checked' : ''} /> 启用</label>
    `;
    const addrIn = row.querySelector('input[type="text"]');
    const onIn = row.querySelector('input[type="checkbox"]');
    addrIn.addEventListener('change', () => saveSlots(i, addrIn.value.trim(), onIn.checked));
    onIn.addEventListener('change', () => saveSlots(i, addrIn.value.trim(), onIn.checked));
    slotsEl.appendChild(row);
  }
}

// 写回某个槽位（把 5 个槽位整体提交，主进程会做去重与归一化）
async function saveSlots(index, addr, on) {
  const boxes = [];
  const max = state.maxBoxes || 5;
  const cur = (state.email && state.email.boxes) || [];
  for (let i = 0; i < max; i++) {
    const b = cur[i] || { addr: '', on: false };
    if (i === index) boxes.push({ addr, on: !!on });
    else boxes.push({ addr: b.addr || '', on: !!b.on });
  }
  try {
    const r = await window.stockApi.saveEmailConfig({ ...(state.email || {}), boxes });
    if (r) { state.email = r; }
  } catch (e) { console.error('saveEmailConfig(boxes) 失败', e); }
  renderSlots();
  renderMailPick();
  renderEmailGlobal();
}

// 当前列表的收件人勾选（mailboxes = 槽位序号数组）
function renderMailPick() {
  if (!pickEl) return;
  const l = activeList();
  const boxes = (state.email && state.email.boxes) || [];
  const chosen = new Set((l && l.mail && l.mail.mailboxes) || []);
  pickEl.innerHTML = '';
  let usable = 0;
  boxes.forEach((b, i) => {
    const no = i + 1;
    const addr = String(b.addr || '').trim();
    if (!addr || !looksLikeMail(addr)) return;   // 空槽位 / 格式错误的不列入
    usable++;
    const on = chosen.has(no);
    const item = document.createElement('label');
    item.className = 'pick-item' + (on ? ' on' : '') + (b.on ? '' : ' disabled');
    item.title = b.on ? '' : '该槽位已在上面停用，即使勾选也不会收到';
    item.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''} data-no="${no}" />`
      + `<span>${no} 号 · ${escapeHtml(addr)}</span>`;
    item.querySelector('input').addEventListener('change', async (e) => {
      const set = new Set((activeList().mail && activeList().mail.mailboxes) || []);
      if (e.target.checked) set.add(no); else set.delete(no);
      await saveActive({ mail: { ...(activeList().mail || {}), mailboxes: [...set].sort((a, b2) => a - b2) } });
      renderMailPick();
    });
    pickEl.appendChild(item);
  });
  if (!usable) {
    pickEl.innerHTML = '<span class="pick-empty">还没有可用的收件邮箱，先在上面的槽位里填好地址</span>';
  }
  renderMailToReadout();
}

// 回显"这个列表实际会发给谁"
function renderMailToReadout() {
  if (!mailToReadout) return;
  const l = activeList();
  const boxes = (state.email && state.email.boxes) || [];
  const idx = (l && l.mail && l.mail.mailboxes) || [];
  const to = [];
  for (const no of idx) {
    const b = boxes[no - 1];
    if (b && b.on && looksLikeMail(b.addr)) to.push(String(b.addr).trim());
  }
  if (!to.length) {
    mailToReadout.innerHTML = '<b style="color:#ef4444">该列表目前不会发出任何邮件</b>：请勾选至少一个已启用的收件槽位。';
  } else {
    mailToReadout.innerHTML = `将发送到：<b>${escapeHtml(to.join(', '))}</b>（共 ${to.length} 个）`;
  }
}

// 邮件阈值（按列表各设一套）：
//   跟随 = 用本列表「异动提醒」的阈值；不跟随 = 本列表单独设一个邮件阈值。
// 跟随时独立输入框置灰，并回显本列表的异动阈值（不再是全局值）。
function syncEmailThresholdUI() {
  const l = activeList();
  if (!l) return;
  const m = l.mail || {};
  const a = l.alerts || {};
  const follow = m.followAlerts !== false;
  const aUp = a.thresholdUp != null ? a.thresholdUp : 3.9;
  const aDown = a.thresholdDown != null ? a.thresholdDown : 3.9;
  const mUp = m.thresholdUp != null ? m.thresholdUp : 3.9;
  const mDown = m.thresholdDown != null ? m.thresholdDown : 3.9;
  if (emailFollow) emailFollow.checked = follow;
  if (emailThUp) {
    emailThUp.disabled = follow;
    emailThUp.value = follow ? aUp : mUp;
  }
  if (emailThDown) {
    emailThDown.disabled = follow;
    emailThDown.value = follow ? aDown : mDown;
  }
  const hint = document.getElementById('email-thr-hint');
  if (hint) {
    hint.textContent = follow
      ? `% 才发邮件（跟随本列表异动阈值：涨 ${aUp}% / 跌 ${aDown}%）`
      : '% 才发邮件（本列表单独设定）';
  }
}

async function saveEmailCfg(patch) {
  try {
    const r = await window.stockApi.saveEmailConfig({ ...(state.email || {}), ...patch });
    if (r) state.email = r;
  } catch (e) { console.error('saveEmailConfig 失败', e); }
  renderEmailGlobal();
}

// ---------- 当前列表的定时汇总 ----------
function renderDigest() {
  const l = activeList();
  if (!l || !emailDigest) return;
  const m = l.mail || {};
  emailDigest.checked = !!m.digestEnabled;
  const mode = m.digestMode === 'interval' ? 'interval' : 'fixed';
  const off = !m.digestEnabled;
  if (emailDigestMode) { emailDigestMode.value = mode; emailDigestMode.disabled = off; }
  if (emailDigestMin) { emailDigestMin.value = m.digestIntervalMin || 30; emailDigestMin.disabled = off; }
  if (emailDigestTimes) { emailDigestTimes.value = m.digestTimes || DEFAULT_DIGEST_TIMES_UI; emailDigestTimes.disabled = off; }
  // 两种方式二选一：只显示当前方式对应的输入项
  if (digestTimesRow) digestTimesRow.style.display = (mode === 'fixed') ? '' : 'none';
  if (digestIntervalLabel) digestIntervalLabel.style.display = (mode === 'interval') ? '' : 'none';
  if (digestHint) {
    if (!m.digestEnabled) digestHint.textContent = '（仅对当前列表生效）';
    else if (mode === 'fixed') {
      const n = String(m.digestTimes || DEFAULT_DIGEST_TIMES_UI).split(/[,，;；\s]+/).filter(Boolean).length;
      digestHint.textContent = `该列表每天按 ${n} 个固定时点汇总一封（仅开盘时段，独立计时）`;
    } else {
      digestHint.textContent = `该列表每 ${m.digestIntervalMin || 30} 分钟汇总一封（独立计时）`;
    }
  }
  if (emailDigestResult) emailDigestResult.textContent = '';
}

async function saveMail(patch) {
  const l = activeList();
  if (!l) return;
  const next = { ...(l.mail || {}), ...patch };
  await saveActive({ mail: next });
  renderDigest();
  renderMailPick();
  syncEmailThresholdUI();
}

emailEnabled?.addEventListener('change', () => saveEmailCfg({ enabled: emailEnabled.checked }));
emailHost?.addEventListener('change', () => saveEmailCfg({ host: emailHost.value.trim() }));
emailPort?.addEventListener('change', () => saveEmailCfg({ port: parseInt(emailPort.value, 10) || 465 }));
emailSecure?.addEventListener('change', () => saveEmailCfg({ secure: emailSecure.checked }));
emailUser?.addEventListener('change', () => saveEmailCfg({ user: emailUser.value.trim() }));
// 授权码：留空表示"不修改"，填了才覆盖；保存后立即清空输入框（不回显明文）
emailPass?.addEventListener('change', async () => {
  const v = emailPass.value;
  if (v === '') return;
  await saveEmailCfg({ pass: v });
  emailPass.value = '';
});
emailFollow?.addEventListener('change', () => {
  saveMail({ followAlerts: emailFollow.checked });
});
emailThUp?.addEventListener('change', () => saveMail({ thresholdUp: readThreshold(emailThUp, 3.9) }));
emailThDown?.addEventListener('change', () => saveMail({ thresholdDown: readThreshold(emailThDown, 3.9) }));

emailTestBtn?.addEventListener('click', async () => {
  if (emailTestResult) { emailTestResult.textContent = '发送中…'; emailTestResult.style.color = '#94a3b8'; }
  try {
    const r = await window.stockApi.testEmail();
    if (r && r.ok) {
      emailTestResult.textContent = `已发送到 ${r.to}（${r.count} 个），请查收（注意垃圾箱）`;
      emailTestResult.style.color = '#16a34a';
    } else {
      emailTestResult.textContent = '失败：' + ((r && r.error) || '未知错误');
      emailTestResult.style.color = '#ef4444';
    }
  } catch (e) {
    emailTestResult.textContent = '失败：' + e.message;
    emailTestResult.style.color = '#ef4444';
  }
});

emailDigest?.addEventListener('change', () => saveMail({ digestEnabled: emailDigest.checked }));
emailDigestMode?.addEventListener('change', () => {
  saveMail({ digestMode: emailDigestMode.value === 'interval' ? 'interval' : 'fixed' });
});
emailDigestMin?.addEventListener('change', () => {
  let n = parseInt(emailDigestMin.value, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 1440) n = 1440;
  emailDigestMin.value = n;
  saveMail({ digestIntervalMin: n });
});
// 时点：失焦 / 回车才提交。主进程负责去重、排序、丢弃非法项，并把规范化结果回显到输入框
emailDigestTimes?.addEventListener('change', () => {
  saveMail({ digestTimes: emailDigestTimes.value.trim() });
});
// 立即给当前列表发一封汇总：不等间隔，验证配置是否真的通
emailDigestNowBtn?.addEventListener('click', async () => {
  if (emailDigestResult) { emailDigestResult.textContent = '发送中…'; emailDigestResult.style.color = '#94a3b8'; }
  try {
    const r = await window.stockApi.testDigest(activeId);
    if (r && r.ok) {
      emailDigestResult.textContent = `已把「${r.list}」的 ${r.count} 只行情发到 ${r.to}`;
      emailDigestResult.style.color = '#16a34a';
    } else {
      emailDigestResult.textContent = '失败：' + ((r && r.error) || '未知错误');
      emailDigestResult.style.color = '#ef4444';
    }
  } catch (e) {
    emailDigestResult.textContent = '失败：' + e.message;
    emailDigestResult.style.color = '#ef4444';
  }
});

// ---------- 列表的增删改 ----------
// ⚠️ 这里【绝不能】用 window.prompt()：Electron 渲染进程不支持它，调用会直接抛
//    "prompt() is and will not be supported."。原来这行写在 try 之外，异常变成
//    静默的 unhandled rejection —— 表现就是"点「+ 新建列表」毫无反应"（v1.5.4 修复）。
// 现在的做法：直接建一个默认名的新列表并选中，再把光标送进「列表名称」输入框，
// 用户当场改名即可（比弹框少一步，也不用依赖任何原生对话框）。
document.getElementById('new-list-btn')?.addEventListener('click', async () => {
  try {
    const r = await window.stockApi.createList('');
    if (!r || !r.ok) { alert((r && r.error) || '创建失败'); return; }
    applyListUpdate(r.list);
    selectList(r.list.id);
    const nameEl = document.getElementById('list-name');
    if (nameEl) { nameEl.focus(); nameEl.select(); }
    const hint = document.getElementById('list-hint');
    if (hint) {
      hint.innerHTML = `新列表已创建（ID <b>${escapeHtml(r.list.id)}</b>）· 在<b>列表名称</b>里改成你想要的名字`
        + '（如「基金」「港股」）—— 标的、窗口、异动阈值、收件邮箱、定时汇总都与其它列表<b>各自独立</b>';
    }
  } catch (e) { alert('创建失败：' + e.message); }
});

document.getElementById('list-delete')?.addEventListener('click', async () => {
  const l = activeList();
  if (!l) return;
  if (state.lists.length <= 1) { alert('至少要保留一个列表'); return; }
  if (!confirm(`确定删除列表「${l.name}」？该列表的小组件窗口会关闭，其标的与设置一并移除。`)) return;
  try {
    const r = await window.stockApi.deleteList(l.id);
    if (!r || !r.ok) { alert((r && r.error) || '删除失败'); return; }
    state.lists = state.lists.filter(x => x.id !== l.id);
    selectList(state.lists[0].id);
  } catch (e) { alert('删除失败：' + e.message); }
});

// 名称：失焦 / 回车时提交
document.getElementById('list-name')?.addEventListener('change', async (e) => {
  const v = String(e.target.value || '').trim();
  if (!v) { renderListMeta(); return; }
  await saveActive({ name: v });
  renderTabs();
  renderListMeta();
});

document.getElementById('list-visible')?.addEventListener('change', async (e) => {
  await saveActive({ visible: e.target.checked });
  renderTabs();
  renderListMeta();
});

// ---------- 配置导出 / 导入 ----------
const ioResult = document.getElementById('io-result');
function showIo(msg, color) {
  if (!ioResult) return;
  ioResult.textContent = msg;
  ioResult.style.color = color || '#2563eb';
}

document.getElementById('export-btn')?.addEventListener('click', async () => {
  const includePass = !!document.getElementById('export-pass')?.checked;
  showIo('导出中…', '#94a3b8');
  try {
    const r = await window.stockApi.exportConfig({ includePass });
    if (r && r.ok) showIo(`已导出到 ${r.path}${r.includePass ? '（含授权码）' : '（不含授权码）'}`, '#16a34a');
    else if (r && r.canceled) showIo('');
    else showIo('导出失败：' + ((r && r.error) || '未知错误'), '#ef4444');
  } catch (e) { showIo('导出失败：' + e.message, '#ef4444'); }
});

document.getElementById('import-btn')?.addEventListener('click', async () => {
  if (!confirm('导入会覆盖当前全部监控列表与邮件设置（原配置会备份为 config.ini.bak）。继续？')) return;
  showIo('导入中…', '#94a3b8');
  try {
    const r = await window.stockApi.importConfig();
    if (r && r.ok) {
      showIo(`已导入 ${r.lists} 个列表、共 ${r.symbolCount} 个标的（原配置已备份为 config.ini.bak）`, '#16a34a');
      await reloadAll();
    } else if (r && r.canceled) showIo('');
    else showIo('导入失败：' + ((r && r.error) || '未知错误'), '#ef4444');
  } catch (e) { showIo('导入失败：' + e.message, '#ef4444'); }
});

// ---------- 自动更新 ----------
const updateStatus = document.getElementById('update-status');
const updateNotes = document.getElementById('update-notes');
const downloadBtn = document.getElementById('download-update-btn');
const checkBtn = document.getElementById('check-update-btn');

function fmtSize(n) {
  if (!n) return '';
  return (n / 1048576).toFixed(1) + ' MB';
}

// 显示更新状态：有新版才露出「下载并安装」按钮
function showUpdate(r) {
  if (!updateStatus) return;
  if (!r) { updateStatus.textContent = ''; return; }
  if (!r.ok && r.error) {
    updateStatus.textContent = r.error;
    updateStatus.style.color = '#ef4444';
    if (downloadBtn) downloadBtn.style.display = 'none';
    return;
  }
  if (r.hasNew) {
    updateStatus.innerHTML = `发现新版本 <b>v${escapeHtml(r.latest)}</b>（当前 v${escapeHtml(r.current)}）`
      + (r.size ? ` · 安装包 ${fmtSize(r.size)}` : '');
    updateStatus.style.color = '#2563eb';
    if (downloadBtn) downloadBtn.style.display = '';
  } else {
    updateStatus.textContent = `已是最新版本（v${r.current}）`;
    updateStatus.style.color = '#16a34a';
    if (downloadBtn) downloadBtn.style.display = 'none';
  }
  if (updateNotes) {
    updateNotes.textContent = r.notes ? '本次更新内容：\n' + r.notes : '';
    updateNotes.style.whiteSpace = 'pre-wrap';
  }
}

checkBtn?.addEventListener('click', async () => {
  if (updateStatus) { updateStatus.textContent = '检查中…'; updateStatus.style.color = '#94a3b8'; }
  try { showUpdate(await window.stockApi.checkUpdate()); }
  catch (e) { if (updateStatus) { updateStatus.textContent = '检查失败：' + e.message; updateStatus.style.color = '#ef4444'; } }
});

downloadBtn?.addEventListener('click', async () => {
  if (!confirm('将从 GitHub 下载安装包并启动安装程序。程序不会自动静默覆盖，需要你在安装向导里确认。继续？')) return;
  if (updateStatus) { updateStatus.textContent = '下载中…（视网速可能需要一会儿）'; updateStatus.style.color = '#94a3b8'; }
  downloadBtn.disabled = true;
  try {
    const r = await window.stockApi.downloadUpdate();
    if (r && r.ok) {
      if (updateStatus) { updateStatus.textContent = `已下载并启动安装程序（${fmtSize(r.size)}），请按向导完成升级`; updateStatus.style.color = '#16a34a'; }
    } else {
      if (updateStatus) { updateStatus.textContent = '失败：' + ((r && r.error) || '未知错误'); updateStatus.style.color = '#ef4444'; }
    }
  } catch (e) {
    if (updateStatus) { updateStatus.textContent = '失败：' + e.message; updateStatus.style.color = '#ef4444'; }
  }
  downloadBtn.disabled = false;
});

// ---------- 关于 ----------
document.getElementById('about-repo')?.addEventListener('click', () => {
  try { window.stockApi.openRepo?.(); } catch (_) {}
});

function renderChangelog(list) {
  const box = document.getElementById('about-changelog');
  if (!box) return;
  if (!Array.isArray(list) || list.length === 0) {
    box.innerHTML = '<div class="cl-empty">暂无记录</div>';
    return;
  }
  box.innerHTML = list.map((it) => `
    <div class="cl-item">
      <div class="cl-head"><b>v${escapeHtml(String(it.v || '').replace(/^v/i, ''))}</b><span>${escapeHtml(it.date || '')}</span></div>
      <ul class="cl-list">${(it.items || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    </div>
  `).join('');
}

// ---------- 事件：添加 / 批量 ----------
document.getElementById('add-btn')?.addEventListener('click', async () => {
  const val = symbolInput.value.trim();
  if (!val) return;
  await addOne(val);
});
symbolInput?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') { e.preventDefault(); await addOne(symbolInput.value.trim()); }
  else if (e.key === 'Escape') hideCandidates();
});
document.getElementById('bulk-add')?.addEventListener('click', bulkAdd);
document.getElementById('clear-btn')?.addEventListener('click', clearAll);

// ---------- 实时拼音搜索（debounce 250ms）----------
let searchTimer = null;
let searchSeq = 0;

// 已经是完整可识别的代码，不必再查候选
function isCompleteSymbol(v) {
  return /^\d{6}$/.test(v) || /^(sh|sz)\d{6}$/.test(v) || /^\d{5}$/.test(v) || /^hk\d{1,5}$/.test(v);
}

symbolInput?.addEventListener('input', () => {
  const v = symbolInput.value.trim().toLowerCase();
  if (searchTimer) clearTimeout(searchTimer);
  if (!v || v.length < 2) { hideCandidates(); return; }
  if (isCompleteSymbol(v)) { hideCandidates(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const list = await searchStocks(v, 8);
    if (seq !== searchSeq) return;   // 旧请求丢弃
    if (list.length) renderCandidates(list); else hideCandidates();
  }, 250);
});
symbolInput?.addEventListener('blur', () => { setTimeout(hideCandidates, 200); });
symbolInput?.addEventListener('focus', () => {
  const v = symbolInput.value.trim().toLowerCase();
  if (v.length >= 2 && !isCompleteSymbol(v)) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const list = await searchStocks(v, 8);
      if (seq !== searchSeq) return;
      if (list.length) renderCandidates(list);
    }, 250);
  }
});

// ---------- 行情刷新 ----------
function applyQuotes(data) {
  lastQuotes = data || [];
  quotesMap = {};
  for (const q of lastQuotes) {
    if (q && q.symbol) quotesMap[String(q.symbol).toLowerCase()] = q;
  }
  renderList();
}

window.stockApi?.onQuotes?.((data) => {
  applyQuotes(data);
  backfillNames();
});

// ---------- 初始化 ----------
async function reloadAll() {
  try {
    const s = await window.stockApi.getState();
    if (s) state = s;
  } catch (e) { console.error('getState 失败', e); }
  if (!state.lists || !state.lists.length) {
    state.lists = [{ id: 'l1', name: '自选股', symbols: [], width: 220, height: 84, alerts: {}, mail: { mailboxes: [1] } }];
  }
  if (!activeId || !state.lists.some(l => l.id === activeId)) activeId = state.lists[0].id;
  renderTabs();
  renderEmailGlobal();
  renderSlots();
  selectList(activeId);   // 会连带渲染 list/meta/appearance/alerts/mail/digest/idx/pos
}

(async function init() {
  await reloadAll();

  // 版本号 / 发布日期：与"帮助 → 关于"同源，取自打包后的 package.json
  try {
    const info = await window.stockApi.getAppInfo?.();
    if (info && info.version) {
      const v = 'v' + info.version;
      for (const id of ['app-ver', 'about-ver', 'about-version']) {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      }
      const bd = document.getElementById('about-builddate');
      if (bd) bd.textContent = info.buildDate || '—';
    }
    renderChangelog(info && info.changelog);
  } catch (_) {}

  // 更新状态（启动时主进程可能已经静默查过一次）
  try { showUpdate(await window.stockApi.getUpdateState()); } catch (_) {}

  // 初次拉一次全量行情缓存
  try {
    const d = await window.stockApi.getQuotes();
    applyQuotes(d);
    backfillNames();
  } catch (_) {}

  // 从某个小组件右键进来时，主进程会指定要定位的列表（也可能在 URL query 里）
  const qList = new URLSearchParams(location.search).get('list');
  if (qList && state.lists.some(l => l.id === qList)) selectList(qList);
  window.stockApi?.onFocusList?.((id) => {
    if (state.lists.some(l => l.id === id)) selectList(id);
  });
})();
