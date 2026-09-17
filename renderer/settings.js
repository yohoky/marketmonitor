// 设置页逻辑：添加 / 批量 / 删除 / 实时价格展示

const listEl = document.getElementById('stock-list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const countFootEl = document.getElementById('count-foot');
const symbolInput = document.getElementById('symbol-input');
const bulkInput = document.getElementById('bulk-input');
const candidateList = document.getElementById('candidate-list');

// 东方财富拼音搜索 API（免费无 key）
const PINYIN_API = 'https://searchapi.eastmoney.com/api/suggest/get';
const PINYIN_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

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

// ---------- 渲染列表 ----------
let stocks = [];
let quotesMap = {};
let lastQuotes = [];

function renderList() {
  listEl.innerHTML = '';
  emptyEl.style.display = stocks.length === 0 ? 'block' : 'none';
  countEl.textContent = stocks.length;
  countFootEl.textContent = stocks.length;

  stocks.forEach((s, idx) => {
    const q = quotesMap[s.symbol] || lastQuotes.find(x => x.symbol === s.symbol);
    const pct = q ? (q.changePct || 0) : 0;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const sign = pct > 0 ? '+' : '';
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="s-name" title="${s.name || s.symbol}">${s.name || s.symbol}</div>
      <div class="s-code">${s.symbol}</div>
      <div class="s-price">${q ? q.price.toFixed(2) : '--'}</div>
      <div class="s-pct ${cls}">${q ? `${sign}${pct.toFixed(2)}%` : '--'}</div>
      <div class="s-sort">
        <button class="s-top" data-idx="${idx}" title="一键置顶（移到最前）" ${idx === 0 ? 'disabled' : ''}>⇧</button>
        <button class="s-up" data-idx="${idx}" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="s-down" data-idx="${idx}" title="下移" ${idx === stocks.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="s-bottom" data-idx="${idx}" title="一键置底（移到末尾）" ${idx === stocks.length - 1 ? 'disabled' : ''}>⇩</button>
      </div>
      <button class="s-del" data-idx="${idx}" title="删除">×</button>
    `;
    listEl.appendChild(li);
  });

  // 删除按钮
  listEl.querySelectorAll('.s-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const idx = +e.currentTarget.dataset.idx;
      stocks.splice(idx, 1);
      await window.stockApi.saveStocks(stocks);
      renderList();
    });
  });
  // 一键置顶：把该条移到列表最前，其余保持原有相对顺序
  listEl.querySelectorAll('.s-top').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const i = +e.currentTarget.dataset.idx;
      if (i <= 0) return;
      const [item] = stocks.splice(i, 1);
      stocks.unshift(item);
      await window.stockApi.saveStocks(stocks);
      renderList();
    });
  });
  // 排序按钮：上移 / 下移
  listEl.querySelectorAll('.s-up').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const i = +e.currentTarget.dataset.idx;
      if (i <= 0) return;
      [stocks[i - 1], stocks[i]] = [stocks[i], stocks[i - 1]];
      await window.stockApi.saveStocks(stocks);
      renderList();
    });
  });
  listEl.querySelectorAll('.s-down').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const i = +e.currentTarget.dataset.idx;
      if (i >= stocks.length - 1) return;
      [stocks[i], stocks[i + 1]] = [stocks[i + 1], stocks[i]];
      await window.stockApi.saveStocks(stocks);
      renderList();
    });
  });
  // 一键置底：把该条移到列表末尾，其余保持原有相对顺序（与一键置顶对称）
  listEl.querySelectorAll('.s-bottom').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const i = +e.currentTarget.dataset.idx;
      if (i >= stocks.length - 1) return;
      const [item] = stocks.splice(i, 1);
      stocks.push(item);
      await window.stockApi.saveStocks(stocks);
      renderList();
    });
  });
}

// ---------- 添加单只 ----------
async function addOne(raw) {
  const sym = normalizeSymbol(raw);
  if (!sym) {
    // 尝试按拼音搜索
    const candidates = await searchStocks(raw);
    if (candidates.length === 1) {
      return addByCandidate(candidates[0]);
    }
    if (candidates.length > 1) {
      // 弹出选择
      const pick = await showPicker(candidates);
      if (pick) return addByCandidate(pick);
      return false;
    }
    alert(`未找到匹配「${raw}」的品种，请输入代码（A股/基金/可转债 6 位，港股 5 位或 hk 前缀）或更精确的拼音缩写`);
    return false;
  }
  if (stocks.find(s => s.symbol === sym)) {
    alert(`已存在：${sym}`);
    return false;
  }
  const name = await fetchStockName(sym);
  stocks.push({ symbol: sym, name });
  await window.stockApi.saveStocks(stocks);
  symbolInput.value = '';
  symbolInput.focus();
  renderList();
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
        // 港股：东财市场号 116 / Classify=HK；只保留 5 位以内的正股，滤掉窝轮牛熊证(14567 这类 1xxxx)
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
      .filter((x) => x.symbol && /^((sh|sz)\d{6}|hk\d{5})$/.test(x.symbol) && !/指数|指数$/.test(x.name || ''));
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
      <div class="c-name" title="${c.pinYin}">${c.name}</div>
      <div class="c-code">${c.symbol}</div>
      <div class="c-pinyin">${c.pinYin}</div>
    `;
    div.addEventListener('click', async () => {
      await addByCandidate(c);
    });
    candidateList.appendChild(div);
  });
}
function hideCandidates() {
  candidateList.style.display = 'none';
}

// 模态选择器（候选多时弹一层）
function showPicker(candidates) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'picker-mask';
    const box = document.createElement('div');
    box.className = 'picker-box';
    box.innerHTML = '<div class="picker-title">请选择要添加的股票（最多前 10 个）</div>' +
      candidates.slice(0, 10).map((c, i) => `
        <div class="picker-item" data-i="${i}">
          <div class="p-name">${c.name}</div>
          <div class="p-code">${c.symbol}</div>
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
      if (e.target === mask) {
        mask.remove();
        resolve(null);
      }
    });
  });
}

async function addByCandidate(c) {
  if (stocks.find(s => s.symbol === c.symbol)) {
    alert(`已存在：${c.name} ${c.symbol}`);
    return false;
  }
  stocks.push({ symbol: c.symbol, name: c.name });
  await window.stockApi.saveStocks(stocks);
  symbolInput.value = '';
  hideCandidates();
  renderList();
  return true;
}

// ---------- 批量添加 ----------
function parseBulk(text) {
  if (!text) return [];
  // 拆分：换行 / 空格 / 逗号 / 分号
  const toks = String(text)
    .split(/[\s,;，；，]+/)
    .filter(Boolean);
  const out = [];
  const seen = new Set(stocks.map(s => s.symbol));
  for (const t of toks) {
    // 提取代码：可带 sh/sz/hk 前缀（跳过可能的名称前缀，比如 "600519 贵州茅台"）
    // 5~6 位 = A股/基金/可转债/港股；hk 前缀另允许 1~4 位（hk981）
    const m = t.match(/(?:hk|sh|sz)?\d{5,6}/i) || t.match(/hk\d{1,4}/i);
    if (!m) continue;
    const sym = normalizeSymbol(m[0]);
    if (!sym) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    // 名字：取数字之后的文字
    let name = '';
    const spaceMatch = t.split(/\s+/);
    for (const piece of spaceMatch) {
      if (!/^\d+$/.test(piece)) { name = piece; break; }
    }
    out.push({ raw: sym, name });
  }
  return out;
}

async function bulkAdd() {
  const arr = parseBulk(bulkInput.value);
  if (arr.length === 0) {
    alert('未识别到任何有效代码');
    return;
  }
  for (const { raw, name } of arr) {
    const finalName = name || await fetchStockName(raw);
    stocks.push({ symbol: raw, name: finalName });
  }
  await window.stockApi.saveStocks(stocks);
  bulkInput.value = '';
  renderList();
}

// ---------- 清空 ----------
async function clearAll() {
  if (stocks.length === 0) return;
  if (!confirm(`确定清空 ${stocks.length} 条记录？`)) return;
  stocks = [];
  await window.stockApi.saveStocks(stocks);
  renderList();
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
// 监控列表里凡是"名称缺失"（name 为空 或 name===symbol）的品种，
// 自动解析成中文名称：优先用实时行情已带的名称，其次向主进程查一次，
// 成功后落库并刷新，只此一次（成功后 pending 为空，不再重复请求）。
async function backfillNames() {
  const pending = stocks.filter(s => !s.name || s.name === s.symbol);
  if (pending.length === 0) return;
  let dirty = false;
  for (const s of pending) {
    const q = lastQuotes.find(x => x.symbol === s.symbol);
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
    try { await window.stockApi.saveStocks(stocks); renderList(); } catch (_) {}
  }
}

// ---------- 透明度 + 置顶 + 尺寸 ----------
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
// 滚动速率 / 跳动间隔：v1.4.4 起由原来的单一 rotationMs 拆成两个独立参数
const scrollSpeedSlider = document.getElementById('scroll-speed-slider');
const scrollSpeedVal = document.getElementById('scroll-speed-val');
const jumpIntervalSlider = document.getElementById('jump-interval-slider');
const jumpIntervalVal = document.getElementById('jump-interval-val');

let widgetCfg = null;   // 缓存 widget 配置 {opacity, topMost, width, height}

async function loadWidgetCfg() {
  // 从主进程获取 widget 配置（扩展 preload API）
  try {
    const cfg = await window.stockApi.getWidgetConfig();
    widgetCfg = cfg;
  } catch (_) {
    widgetCfg = { opacity: 1.0, textOpacity: 1.0, mono: false, topMost: true, width: 220, height: 84 };
  }
  if (opacitySlider) {
    opacitySlider.value = widgetCfg.opacity || 1.0;
    opacityVal.textContent = (widgetCfg.opacity || 1.0).toFixed(2);
  }
  if (textOpacitySlider) {
    const t = widgetCfg.textOpacity ?? 1.0;
    textOpacitySlider.value = t;
    textOpacityVal.textContent = Number(t).toFixed(2);
  }
  if (monoChk) monoChk.checked = !!widgetCfg.mono;
  if (topmostChk) {
    topmostChk.checked = widgetCfg.topMost !== false;
  }
  if (widthInput) widthInput.value = widgetCfg.width || 220;
  if (heightInput) heightInput.value = widgetCfg.height || 84;
  if (displayModeSel) displayModeSel.value = widgetCfg.displayMode || 'scroll';
  if (scrollSpeedSlider) {
    const v = widgetCfg.scrollMs || 3000;
    scrollSpeedSlider.value = v;
    scrollSpeedVal.textContent = (Number(v) / 1000).toFixed(1) + 's/行';
  }
  if (jumpIntervalSlider) {
    const v = widgetCfg.jumpMs || 3000;
    jumpIntervalSlider.value = v;
    jumpIntervalVal.textContent = (Number(v) / 1000).toFixed(1) + 's/页';
  }
}

// ---------- 大盘指数 ----------
const idxGrid = document.getElementById('idx-grid');
const indexCount = document.getElementById('index-count');
let indexPresets = [];
let indexList = [];      // 已勾选：[{symbol, name}]

function idxNameOf(sym) {
  const key = String(sym).toLowerCase();
  const hit = indexPresets.find(p => p.symbol.toLowerCase() === key);
  return hit ? hit.name : sym;
}

function renderIdxGrid() {
  if (!idxGrid) return;
  const onMap = new Map(indexList.map(x => [String(x.symbol).toLowerCase(), x]));
  // 预设 + 配置里出现过的额外代码（保证手写在 config.ini 里的指数不丢）
  const all = indexPresets.slice();
  for (const x of indexList) {
    if (!all.some(p => p.symbol.toLowerCase() === String(x.symbol).toLowerCase())) all.push(x);
  }
  idxGrid.innerHTML = '';
  all.forEach((p) => {
    const key = String(p.symbol).toLowerCase();
    const on = onMap.has(key);
    const label = document.createElement('label');
    label.className = 'idx-item' + (on ? ' on' : '');
    label.innerHTML = `
      <input type="checkbox"${on ? ' checked' : ''} />
      <span>${(onMap.get(key) && onMap.get(key).name) || p.name || idxNameOf(p.symbol)}</span>
      <span class="idx-sym">${p.symbol}</span>
    `;
    label.querySelector('input').addEventListener('change', async (e) => {
      if (e.target.checked) {
        if (!indexList.some(x => String(x.symbol).toLowerCase() === key)) {
          indexList.push({ symbol: p.symbol, name: idxNameOf(p.symbol) });
        }
      } else {
        indexList = indexList.filter(x => String(x.symbol).toLowerCase() !== key);
      }
      await saveIdx();
    });
    idxGrid.appendChild(label);
  });
  if (indexCount) indexCount.textContent = indexList.length;
}

async function saveIdx() {
  try {
    const saved = await window.stockApi.saveIndexes(indexList);
    if (Array.isArray(saved)) indexList = saved;
  } catch (e) { console.error('saveIndexes 失败', e); }
  renderIdxGrid();
}

async function loadIdx() {
  try {
    const r = await window.stockApi.getIndexes();
    indexPresets = (r && r.presets) || [];
    indexList = (r && r.list) || [];
  } catch (e) { console.error('getIndexes 失败', e); }
  renderIdxGrid();
}

// ---------- 邮件推送 ----------
const emailEnabled = document.getElementById('email-enabled');
const emailHost = document.getElementById('email-host');
const emailPort = document.getElementById('email-port');
const emailSecure = document.getElementById('email-secure');
const emailUser = document.getElementById('email-user');
const emailPass = document.getElementById('email-pass');
const emailPassHint = document.getElementById('email-pass-hint');
const emailTo = document.getElementById('email-to');
const emailFollow = document.getElementById('email-follow');
const emailThUp = document.getElementById('email-threshold-up');
const emailThDown = document.getElementById('email-threshold-down');
const emailTestBtn = document.getElementById('email-test');
const emailTestResult = document.getElementById('email-test-result');
const emailDigest = document.getElementById('email-digest');
const emailDigestMin = document.getElementById('email-digest-min');
const emailDigestNowBtn = document.getElementById('email-digest-now');
const emailDigestResult = document.getElementById('email-digest-result');
let emailCfg = {};

// 跟随异动阈值时，独立阈值输入框置灰并回显当前异动阈值
function syncEmailThresholdUI() {
  const follow = !emailFollow || emailFollow.checked;
  const up = (alertsCfg && alertsCfg.thresholdUp != null) ? alertsCfg.thresholdUp : 3.9;
  const down = (alertsCfg && alertsCfg.thresholdDown != null) ? alertsCfg.thresholdDown : 3.9;
  if (emailThUp) {
    emailThUp.disabled = follow;
    if (follow) emailThUp.value = up;
  }
  if (emailThDown) {
    emailThDown.disabled = follow;
    if (follow) emailThDown.value = down;
  }
}

// 汇总开关关闭时，间隔输入框与「立即发一封」置灰，避免误以为已经生效
function syncDigestUI() {
  const on = !!(emailDigest && emailDigest.checked);
  if (emailDigestMin) emailDigestMin.disabled = !on;
  if (emailDigestNowBtn) emailDigestNowBtn.disabled = !on;
}

async function loadEmailCfg() {
  try {
    const c = await window.stockApi.getEmailConfig();
    if (c) emailCfg = c;
  } catch (e) { console.error('getEmailConfig 失败', e); }
  if (emailEnabled) emailEnabled.checked = !!emailCfg.enabled;
  if (emailHost) emailHost.value = emailCfg.host || '';
  if (emailPort) emailPort.value = emailCfg.port || 465;
  if (emailSecure) emailSecure.checked = emailCfg.secure !== false;
  if (emailUser) emailUser.value = emailCfg.user || '';
  if (emailTo) emailTo.value = emailCfg.to || '';
  if (emailFollow) emailFollow.checked = emailCfg.followAlerts !== false;
  if (emailThUp) emailThUp.value = emailCfg.thresholdUp ?? 3.9;
  if (emailThDown) emailThDown.value = emailCfg.thresholdDown ?? 3.9;
  if (emailDigest) emailDigest.checked = !!emailCfg.digestEnabled;
  if (emailDigestMin) emailDigestMin.value = emailCfg.digestIntervalMin || 30;
  if (emailPass) emailPass.value = '';
  if (emailPassHint) {
    emailPassHint.textContent = emailCfg.hasPass ? '已保存授权码（留空则不修改）' : '尚未设置授权码';
    emailPassHint.style.color = emailCfg.hasPass ? '#16a34a' : '#94a3b8';
  }
  syncEmailThresholdUI();
  syncDigestUI();
}

async function saveEmailCfg(patch) {
  try {
    const r = await window.stockApi.saveEmailConfig({ ...(emailCfg || {}), ...patch });
    if (r) {
      emailCfg = r;
      if (emailPassHint) {
        emailPassHint.textContent = r.hasPass ? '已保存授权码（留空则不修改）' : '尚未设置授权码';
        emailPassHint.style.color = r.hasPass ? '#16a34a' : '#94a3b8';
      }
    }
  } catch (e) { console.error('saveEmailConfig 失败', e); }
}

// ---------- 异动提醒配置 ----------
const alertEnabled = document.getElementById('alert-enabled');
const alertUpOn = document.getElementById('alert-up-on');
const alertDownOn = document.getElementById('alert-down-on');
const alertThresholdUp = document.getElementById('alert-threshold-up');
const alertThresholdDown = document.getElementById('alert-threshold-down');
const alertCooldown = document.getElementById('alert-cooldown');
const alertSound = document.getElementById('alert-sound');
const alertTrading = document.getElementById('alert-trading');
const alertMarket = document.getElementById('alert-market');
let alertsCfg = {
  enabled: true, thresholdUp: 3.9, thresholdDown: 3.9,
  direction: 'both', sound: true, cooldownMs: 180000, tradingHours: true, market: 'a',
};

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

async function loadAlertsCfg() {
  try {
    const c = await window.stockApi.getAlertsConfig();
    if (c) alertsCfg = c;
  } catch (_) {}
  const chk = checksFromDir(alertsCfg.direction || 'both');
  if (alertEnabled) alertEnabled.checked = alertsCfg.enabled !== false;
  if (alertUpOn) alertUpOn.checked = chk.up;
  if (alertDownOn) alertDownOn.checked = chk.down;
  if (alertThresholdUp) alertThresholdUp.value = alertsCfg.thresholdUp ?? alertsCfg.threshold ?? 3.9;
  if (alertThresholdDown) alertThresholdDown.value = alertsCfg.thresholdDown ?? alertsCfg.threshold ?? 3.9;
  if (alertSound) alertSound.checked = alertsCfg.sound !== false;
  if (alertTrading) alertTrading.checked = alertsCfg.tradingHours !== false;
  if (alertMarket) alertMarket.value = ['a', 'hk', 'both'].includes(alertsCfg.market) ? alertsCfg.market : 'a';
  if (alertCooldown) {
    const cd = String(alertsCfg.cooldownMs ?? 180000);
    const opts = Array.from(alertCooldown.options).map(o => o.value);
    alertCooldown.value = opts.includes(cd) ? cd : '180000';
  }
}

async function saveAlertsCfg(patch) {
  alertsCfg = { ...alertsCfg, ...patch };
  try {
    alertsCfg = await window.stockApi.saveAlertsConfig(alertsCfg) || alertsCfg;
  } catch (_) {}
}

opacitySlider?.addEventListener('input', () => {
  const v = parseFloat(opacitySlider.value);
  opacityVal.textContent = v.toFixed(2);
  if (v >= 0.7) opacityHint.textContent = '';
  else if (v >= 0.35) opacityHint.textContent = '摸鱼模式 🐟';
  else opacityHint.textContent = '深度摸鱼 🐟🐟🐟';
});

opacitySlider?.addEventListener('change', async () => {
  const v = parseFloat(opacitySlider.value);
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), opacity: v });
});

// 文字透明度：只淡文字/数字，与背景透明度互不影响
textOpacitySlider?.addEventListener('input', () => {
  textOpacityVal.textContent = parseFloat(textOpacitySlider.value).toFixed(2);
});
textOpacitySlider?.addEventListener('change', async () => {
  const v = parseFloat(textOpacitySlider.value);
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), textOpacity: v });
});

// 黑白模式：涨跌改深浅灰
monoChk?.addEventListener('change', async () => {
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), mono: monoChk.checked });
});

topmostChk?.addEventListener('change', async () => {
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), topMost: topmostChk.checked });
});

// 尺寸调整：原来的 'change' 事件只在输入框失焦/回车时才触发，
// 导致"边输边看毫无反应，要重启才生效"（重启才发现值其实早就存了）。
// 改为 'input' 实时应用 + debounce 节流，避免每敲一个字符都 setSize 造成窗口抖动。
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

async function commitSize() {
  if (!widthInput || !heightInput) return;
  const wr = readRange(widthInput, 160, 480);
  const hr = readRange(heightInput, 60, 600);
  const w = parseInt(widthInput.value, 10);
  const h = parseInt(heightInput.value, 10);

  // 关键：只应用在合法区间内的值。
  // 用户把 84 改成 240 的过程中会依次出现 "2"、"24" 这类半成品，
  // 若照单全收，窗口会先被 clamp 到下限（一路塌到最小）再弹回来，非常抖动。
  const patch = {};
  if (Number.isFinite(w) && w >= wr.min && w <= wr.max) patch.width = w;
  if (Number.isFinite(h) && h >= hr.min && h <= hr.max) patch.height = h;
  // 值没变就不发 IPC：blur/change 兜底和 input 会重复触发同一结果，省掉冗余调用
  const changed =
    (patch.width !== undefined && patch.width !== (widgetCfg && widgetCfg.width)) ||
    (patch.height !== undefined && patch.height !== (widgetCfg && widgetCfg.height));
  if (!changed) return;

  try {
    widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), ...patch });
  } catch (e) { console.error('saveWidgetConfig(size) 失败', e); }
}

const applySize = debounce(commitSize, 220);

widthInput?.addEventListener('input', applySize);
heightInput?.addEventListener('input', applySize);
// 失焦/回车兜底：立即落值（debounce 还在等的时候用户直接关窗也不会丢）
widthInput?.addEventListener('change', commitSize);
heightInput?.addEventListener('change', commitSize);
// 回车：立即提交，不等 debounce
[widthInput, heightInput].forEach((el) => {
  el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }   // blur 会触发 change → commitSize
  });
});
displayModeSel?.addEventListener('change', async () => {
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), displayMode: displayModeSel.value });
});

// 滚动速率 / 跳动间隔：拖动时只更新文字（顺滑），松手才落库并下发给小组件
scrollSpeedSlider?.addEventListener('input', () => {
  scrollSpeedVal.textContent = (parseInt(scrollSpeedSlider.value, 10) / 1000).toFixed(1) + 's/行';
});
scrollSpeedSlider?.addEventListener('change', async () => {
  const v = parseInt(scrollSpeedSlider.value, 10);
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), scrollMs: v });
});
jumpIntervalSlider?.addEventListener('input', () => {
  jumpIntervalVal.textContent = (parseInt(jumpIntervalSlider.value, 10) / 1000).toFixed(1) + 's/页';
});
jumpIntervalSlider?.addEventListener('change', async () => {
  const v = parseInt(jumpIntervalSlider.value, 10);
  widgetCfg = await window.stockApi.saveWidgetConfig({ ...(widgetCfg || {}), jumpMs: v });
});

// ---------- 屏幕位置：九宫格归位 ----------
const posGrid = document.getElementById('pos-grid');
const posReadout = document.getElementById('pos-readout');
const posDefaultBtn = document.getElementById('pos-default');

function markActiveCell(anchor) {
  posGrid?.querySelectorAll('.pos-cell').forEach((c) => {
    c.classList.toggle('active', c.dataset.anchor === anchor);
  });
}

async function moveTo(anchor) {
  markActiveCell(anchor);
  try {
    const p = await window.stockApi.setWidgetPosition(anchor);
    if (posReadout && p) posReadout.textContent = `X ${p.x} · Y ${p.y}`;
  } catch (e) { console.error('setWidgetPosition 失败', e); }
}

posGrid?.addEventListener('click', (e) => {
  const cell = e.target.closest?.('.pos-cell');
  if (cell && cell.dataset.anchor) moveTo(cell.dataset.anchor);
});
posDefaultBtn?.addEventListener('click', () => moveTo('bottom-right'));

// 打开设置页时显示当前坐标
(async () => {
  try {
    const p = await window.stockApi.getWidgetPosition();
    if (posReadout && p) posReadout.textContent = `X ${p.x} · Y ${p.y}`;
  } catch (_) { /* 主进程未就绪时忽略 */ }
})();

// ---------- 异动提醒事件 ----------
alertEnabled?.addEventListener('change', () => saveAlertsCfg({ enabled: alertEnabled.checked }));
alertSound?.addEventListener('change', () => saveAlertsCfg({ sound: alertSound.checked }));
alertTrading?.addEventListener('change', () => saveAlertsCfg({ tradingHours: alertTrading.checked }));
alertMarket?.addEventListener('change', () => saveAlertsCfg({ market: alertMarket.value }));
alertCooldown?.addEventListener('change', () => saveAlertsCfg({ cooldownMs: parseInt(alertCooldown.value) }));

// 涨 / 跌 分开：勾选框决定方向，两个输入框分别设置阈值
function saveDirection() {
  saveAlertsCfg({ direction: dirFromChecks(!!alertUpOn?.checked, !!alertDownOn?.checked) });
}
alertUpOn?.addEventListener('change', saveDirection);
alertDownOn?.addEventListener('change', saveDirection);

function readThreshold(el, fallback) {
  let v = parseFloat(el.value);
  if (!isFinite(v) || v <= 0) v = fallback;
  v = Math.min(50, v);
  el.value = v;
  return v;
}
alertThresholdUp?.addEventListener('change', async () => {
  await saveAlertsCfg({ thresholdUp: readThreshold(alertThresholdUp, 3.9) });
  syncEmailThresholdUI();       // 邮件阈值若跟随异动，这里同步回显
});
alertThresholdDown?.addEventListener('change', async () => {
  await saveAlertsCfg({ thresholdDown: readThreshold(alertThresholdDown, 3.9) });
  syncEmailThresholdUI();
});
document.getElementById('alert-test')?.addEventListener('click', async () => {
  try { await window.stockApi.testAlert(); } catch (_) {}
});

// ---------- 邮件推送事件 ----------
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
emailTo?.addEventListener('change', () => saveEmailCfg({ to: emailTo.value.trim() }));
emailFollow?.addEventListener('change', () => {
  syncEmailThresholdUI();
  saveEmailCfg({ followAlerts: emailFollow.checked });
});
emailThUp?.addEventListener('change', () => saveEmailCfg({ thresholdUp: readThreshold(emailThUp, 3.9) }));
emailThDown?.addEventListener('change', () => saveEmailCfg({ thresholdDown: readThreshold(emailThDown, 3.9) }));
emailTestBtn?.addEventListener('click', async () => {
  if (emailTestResult) { emailTestResult.textContent = '发送中…'; emailTestResult.style.color = '#94a3b8'; }
  try {
    const r = await window.stockApi.testEmail();
    if (r && r.ok) {
      emailTestResult.textContent = `已发送到 ${r.to}，请查收（注意垃圾箱）`;
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
// 定时汇总开关 / 间隔（后端会按"开关或间隔变化"重置计时基准，避免刚开就发一封）
emailDigest?.addEventListener('change', () => {
  syncDigestUI();
  saveEmailCfg({ digestEnabled: emailDigest.checked });
});
emailDigestMin?.addEventListener('change', () => {
  let n = parseInt(emailDigestMin.value, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 1440) n = 1440;
  emailDigestMin.value = n;
  saveEmailCfg({ digestIntervalMin: n });
});
// 立即发一封汇总：不等间隔，验证配置是否真的通
emailDigestNowBtn?.addEventListener('click', async () => {
  if (emailDigestResult) { emailDigestResult.textContent = '发送中…'; emailDigestResult.style.color = '#94a3b8'; }
  try {
    const r = await window.stockApi.testDigest();
    if (r && r.ok) {
      emailDigestResult.textContent = `已发送 ${r.count} 只行情到 ${r.to}，请查收（注意垃圾箱）`;
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

// ---------- 事件 ----------
document.getElementById('add-btn').addEventListener('click', async () => {
  const val = symbolInput.value.trim();
  if (!val) return;
  await addOne(val);
});
symbolInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    await addOne(symbolInput.value.trim());
  } else if (e.key === 'Escape') {
    hideCandidates();
  }
});
document.getElementById('bulk-add').addEventListener('click', bulkAdd);
document.getElementById('clear-btn').addEventListener('click', clearAll);
// 关于：点仓库地址用系统浏览器打开（URL 固定在主进程，不走渲染层跳转）
document.getElementById('about-repo')?.addEventListener('click', () => {
  try { window.stockApi.openRepo?.(); } catch (_) {}
});

// ---------- 实时拼音搜索（debounce 250ms）----------
let searchTimer = null;
let searchSeq = 0;

// 已经是完整可识别的代码（6 位 A 股 / sh80 / 5 位港股 / hk 前缀），不必再查候选
function isCompleteSymbol(v) {
  return /^\d{6}$/.test(v) || /^(sh|sz)\d{6}$/.test(v) || /^\d{5}$/.test(v) || /^hk\d{1,5}$/.test(v);
}

symbolInput.addEventListener('input', () => {
  const v = symbolInput.value.trim().toLowerCase();
  if (searchTimer) clearTimeout(searchTimer);
  if (!v || v.length < 2) { hideCandidates(); return; }
  // 完整代码直接跳过候选
  if (isCompleteSymbol(v)) { hideCandidates(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const list = await searchStocks(v, 8);
    if (seq !== searchSeq) return;   // 旧请求丢弃
    if (list.length > 1) renderCandidates(list);
    else if (list.length === 1) renderCandidates(list);
    else hideCandidates();
  }, 250);
});
symbolInput.addEventListener('blur', () => {
  setTimeout(hideCandidates, 200);   // 候选被点击前稍作延迟
});
symbolInput.addEventListener('focus', () => {
  const v = symbolInput.value.trim().toLowerCase();
  if (v.length >= 2 && !isCompleteSymbol(v)) {
    // 焦点时重新触发搜索（如果之前被 blur 隐藏了）
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const list = await searchStocks(v, 8);
      if (seq !== searchSeq) return;
      if (list.length) renderCandidates(list);
    }, 250);
  }
});

// ---------- 关于页：版本改动记录 ----------
// 数据来自主进程的 CHANGELOG 常量（只记 1.4.x），已是最新在前，直接渲染即可
function renderChangelog(list) {
  const box = document.getElementById('about-changelog');
  if (!box) return;
  if (!Array.isArray(list) || list.length === 0) {
    box.innerHTML = '<div class="cl-empty">暂无记录</div>';
    return;
  }
  box.innerHTML = list.map((it) => `
    <div class="cl-item">
      <div class="cl-head"><b>v${String(it.v || '').replace(/^v/i, '')}</b><span>${it.date || ''}</span></div>
      <ul class="cl-list">${(it.items || []).map(x => `<li>${x}</li>`).join('')}</ul>
    </div>
  `).join('');
}

// ---------- 初始化 ----------
(async function init() {
  stocks = await window.stockApi.getStocks();
  renderList();
  await loadWidgetCfg();   // 载入透明度 / 置顶 / 尺寸 / 切换方式 / 滚动速率 / 跳动间隔
  await loadAlertsCfg();   // 载入异动提醒配置（邮件阈值回显依赖它，必须排在前面）
  await loadEmailCfg();    // 载入邮件推送配置
  await loadIdx();         // 载入大盘指数勾选状态

  // 版本号 / 发布日期：与"帮助 → 关于"同源，取自打包后的 package.json（不会和安装包对不上）
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

  // 初次拉一次行情（拿到名称后顺带补全列表里的名称）
  window.stockApi.getQuotes?.().then((d) => {
    if (d && d.length) {
      lastQuotes = d;
      renderList();
    }
    backfillNames();   // 用行情名称 / IPC 查名，把"只有代码"的条目补全成名称
  });

  // 实时行情推送（每 30s：刷新价格 + 若有未补全名称则用行情名补）
  window.stockApi.onQuotes((data) => {
    lastQuotes = data || [];
    renderList();
    backfillNames();
  });
})();
