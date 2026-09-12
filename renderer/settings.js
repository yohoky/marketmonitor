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
// 支持：A 股 / 基金(ETF/LOF) / 可转债
// 规则（6 位数字）：
//   沪 sh：6xxxxx(A股)  9xxxxx  5xxxxx(基金)  11xxxx(可转债)
//   深 sz：0xxxxx/2xxxxx/3xxxxx(A股)  15xxxx/16xxxx/18xxxx(基金)  12xxxx(可转债)
// 北交所(4/8 开头)暂不支持，可用 sh/sz 前缀手动加
function normalizeSymbol(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  // 去除空格
  s = s.replace(/\s+/g, '');
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
  // 5 位 = 沪市 A 股（老式）
  if (/^\d{5}$/.test(s)) return 'sh' + ('0' + s);
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
        <button class="s-up" data-idx="${idx}" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="s-down" data-idx="${idx}" title="下移" ${idx === stocks.length - 1 ? 'disabled' : ''}>↓</button>
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
    alert(`未找到匹配「${raw}」的品种，请输入 6 位代码（股票/基金/可转债）或更精确的拼音缩写`);
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
      // A 股 + 基金 + 可转债（按市场号 沪1/深0 判 sh/sz，指数等排除）
      .filter((x) => {
        const mkt = Number(x.MktNum);
        if ([0, 1, 105, 106].includes(mkt) && x.Code && String(x.Code).length === 6) return true;
        return x.Classify === 'AStock';
      })
      .map(x => ({
        code: x.Code,
        symbol: buildSymbol(x.Code, x.MktNum),
        name: x.Name,
        pinYin: x.PinYin,
      }))
      .filter((x) => x.symbol && /^(sh|sz)\d{6}$/.test(x.symbol) && !/指数|指数$/.test(x.name || ''));
  } catch (e) {
    console.error('[searchStocks]', e.message);
    return [];
  }
}

// 根据市场号构造 sh/sz 前缀
function buildSymbol(code, mktNum) {
  const n = Number(mktNum);
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
    // 尝试提取 6 位数字代码（跳过可能的名称前缀，比如 "600519 贵州茅台"）
    const m = t.match(/(\d{5,6})/);
    if (!m) continue;
    const sym = normalizeSymbol(m[1]);
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

let widgetCfg = null;   // 缓存 widget 配置 {opacity, topMost, width, height}

async function loadWidgetCfg() {
  // 从主进程获取 widget 配置（扩展 preload API）
  try {
    const cfg = await window.stockApi.getWidgetConfig();
    widgetCfg = cfg;
  } catch (_) {
    widgetCfg = { opacity: 1.0, topMost: true, width: 220, height: 84 };
  }
  if (opacitySlider) {
    opacitySlider.value = widgetCfg.opacity || 1.0;
    opacityVal.textContent = (widgetCfg.opacity || 1.0).toFixed(2);
  }
  if (topmostChk) {
    topmostChk.checked = widgetCfg.topMost !== false;
  }
  if (widthInput) widthInput.value = widgetCfg.width || 220;
  if (heightInput) heightInput.value = widgetCfg.height || 84;
  if (displayModeSel) displayModeSel.value = widgetCfg.displayMode || 'scroll';
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
let alertsCfg = {
  enabled: true, thresholdUp: 3.9, thresholdDown: 3.9,
  direction: 'both', sound: true, cooldownMs: 180000, tradingHours: true,
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
alertThresholdUp?.addEventListener('change', () => {
  saveAlertsCfg({ thresholdUp: readThreshold(alertThresholdUp, 3.9) });
});
alertThresholdDown?.addEventListener('change', () => {
  saveAlertsCfg({ thresholdDown: readThreshold(alertThresholdDown, 3.9) });
});
document.getElementById('alert-test')?.addEventListener('click', async () => {
  try { await window.stockApi.testAlert(); } catch (_) {}
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

// ---------- 实时拼音搜索（debounce 250ms）----------
let searchTimer = null;
let searchSeq = 0;
symbolInput.addEventListener('input', () => {
  const v = symbolInput.value.trim().toLowerCase();
  if (searchTimer) clearTimeout(searchTimer);
  if (!v || v.length < 2) { hideCandidates(); return; }
  // 6 位纯代码直接跳过候选
  if (/^\d{6}$/.test(v) || /^(sh|sz)\d{6}$/.test(v)) { hideCandidates(); return; }
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
  if (v.length >= 2 && !/^\d{6}$/.test(v)) {
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

// ---------- 初始化 ----------
(async function init() {
  stocks = await window.stockApi.getStocks();
  renderList();
  await loadWidgetCfg();   // 载入透明度/置顶/尺寸/切换方式当前值
  await loadAlertsCfg();   // 载入异动提醒配置

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
