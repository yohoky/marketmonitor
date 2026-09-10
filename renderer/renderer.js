// Marketmonitor - 小组件显示逻辑
// 核心：按高度计算可显示行数 + 滚动/跳动两种切换 + 涨跌配色 + 异动提醒

const GAP = 4;              // 行间距（与 CSS .row margin-bottom 一致）
const FALLBACK_ROW_H = 25;  // 单行高度兜底（实际以 DOM 测量为准）

let quotes = [];
let displayMode = 'scroll'; // scroll 滚动 / jump 跳动
let rotationMs = 3000;
let visibleRows = 2;
let jumpOffset = 0;         // jump 模式：当前起始索引
let scrollY = 0;            // scroll 模式：当前 translateY
let rafId = 0;
let lastTs = 0;
let jumpTimer = null;
const flashed = new Map();  // 触发过异动的股票 symbol -> up?（用于闪烁高亮）

const rowsBox = document.getElementById('rows');
const track = document.getElementById('track');
const updateTimeEl = document.getElementById('update-time');
const tradingEl = document.getElementById('trading');
const dot = document.querySelector('.dot');
const alertPop = document.getElementById('alert-pop');

// ---------- 透明度（只作用于背景；文字/数字恒定清晰）----------
function applyOp(op) {
  const v = Math.max(0.05, Math.min(1.0, parseFloat(op) || 1));
  // 背景 alpha 跟随设置；最低 0.08 保证卡片轮廓仍可见
  document.documentElement.style.setProperty('--card-a', String(Math.max(0.08, v)));
}
window.stockApi?.onOpacity?.(applyOp);
window.stockApi?.getWidgetConfig?.().then(c => {
  if (!c) return;
  if (c.opacity != null) applyOp(c.opacity);
  if (c.displayMode) setDisplayMode(c.displayMode);
  if (c.rotationMs) setRotationMs(c.rotationMs);
}).catch(() => {});

window.stockApi?.onDisplayMode?.((m) => setDisplayMode(m));
window.stockApi?.onRotationMs?.((ms) => setRotationMs(ms));

function setDisplayMode(m) {
  displayMode = (m === 'jump') ? 'jump' : 'scroll';
  restart();
}
function setRotationMs(ms) {
  rotationMs = Math.max(500, Math.min(60000, parseInt(ms) || 3000));
  restart();
}

// ---------- 工具 ----------
function fmtPrice(p) {
  if (p === null || p === undefined || p === 0) return '--';
  return Number(p).toFixed(2);
}
function fmtPct(v) {
  if (v === null || v === undefined) return '--';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}
function clsFromChange(v) {
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

// ---------- 行数：按窗口高度能放几只就放几只 ----------
function computeVisibleRows() {
  const h = rowsBox ? rowsBox.clientHeight : (window.innerHeight - 27);
  const first = track ? track.firstElementChild : null;
  const rh = (first && first.offsetHeight) ? first.offsetHeight : FALLBACK_ROW_H;
  return Math.max(1, Math.floor((h + GAP) / (rh + GAP)));
}

// ---------- 构建行 ----------
function buildRow(q) {
  const el = document.createElement('div');
  if (!q) {
    el.className = 'row flat';
    el.innerHTML = '<div class="empty">无数据 - 右键 设置股票</div>';
    return el;
  }
  el.className = 'row ' + clsFromChange(q.changePct);
  if (flashed.has(q.symbol)) {
    el.classList.add('flash');
    if (flashed.get(q.symbol) === false) el.classList.add('down-flash');
  }
  el.dataset.symbol = q.symbol;
  el.innerHTML = `
    <div class="name" title="${q.name} (${q.symbol})">${q.name}</div>
    <div class="price">${fmtPrice(q.price)}</div>
    <div class="pct">${fmtPct(q.changePct)}</div>
  `;
  return el;
}

// 渲染全部行（scroll 模式会复制一份用于无缝循环）
function renderAll() {
  if (!track) return;
  track.innerHTML = '';
  if (quotes.length === 0) {
    track.appendChild(buildRow(null));
    return;
  }
  const list = quotes.slice();
  const needLoop = displayMode === 'scroll' && list.length > 1;
  const src = needLoop ? list.concat(list) : list;
  for (const q of src) track.appendChild(buildRow(q));
}

// ---------- 跳动模式：翻页 ----------
function startJump() {
  stopJump();
  const total = quotes.length;
  if (total <= visibleRows) { scrollY = 0; applyTransform(0); return; }
  jumpTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    jumpOffset = (jumpOffset + visibleRows) % total;
    const rh = rowHeight();
    applyTransform(-jumpOffset * (rh + GAP));
  }, rotationMs);
}

function stopJump() {
  if (jumpTimer) { clearInterval(jumpTimer); jumpTimer = null; }
}

// ---------- 滚动模式：平滑连续 ----------
function startScroll() {
  stopScroll();
  const total = quotes.length;
  const rh = rowHeight();
  const oneSet = total * (rh + GAP);
  if (total <= visibleRows || oneSet <= 0) { scrollY = 0; applyTransform(0); return; }
  // 速度：每 rotationMs 滚动一行的高度
  const speed = (rh + GAP) / (rotationMs / 1000);   // px / 秒
  lastTs = 0;
  const step = (ts) => {
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (document.visibilityState !== 'hidden') {
      scrollY += speed * dt;
      if (scrollY >= oneSet) scrollY -= oneSet;
      applyTransform(-scrollY);
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopScroll() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function rowHeight() {
  const first = track ? track.firstElementChild : null;
  return (first && first.offsetHeight) ? first.offsetHeight : FALLBACK_ROW_H;
}

function applyTransform(y) {
  if (track) track.style.transform = `translateY(${y}px)`;
}

// ---------- 统一刷新 ----------
function restart() {
  stopScroll();
  stopJump();
  visibleRows = computeVisibleRows();
  scrollY = 0;
  if (jumpOffset >= quotes.length) jumpOffset = 0;
  renderAll();
  applyTransform(0);
  // 等一帧让布局稳定后再精确计算行数
  requestAnimationFrame(() => {
    const n = computeVisibleRows();
    if (n !== visibleRows) {
      visibleRows = n;
      renderAll();
    }
    if (displayMode === 'scroll') startScroll(); else startJump();
  });
}

// ---------- 异动提醒：闪烁 + 提示音 + 内容弹窗 ----------
function showAlertPop(a) {
  if (!alertPop) return;
  const sign = a.up ? '+' : '';
  alertPop.innerHTML = `
    <span class="ap-arrow">${a.up ? '📈' : '📉'}</span>
    <span class="ap-name">${a.name}</span>
    <span class="ap-pct ${a.up ? 'up' : 'down'}">${sign}${Number(a.changePct).toFixed(2)}%</span>
  `;
  alertPop.classList.add('show', a.up ? 'up' : 'down');
  clearTimeout(showAlertPop._t);
  showAlertPop._t = setTimeout(() => {
    alertPop.classList.remove('show');
  }, 6000);
}

function beep(up) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    // 涨：上扬两声；跌：下沉两声
    const freqs = up ? [880, 1180] : [660, 440];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.13);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.15);
    });
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 900);
  } catch (_) {}
}

window.stockApi?.onAlert?.((a) => {
  if (!a) return;
  flashed.set(a.symbol, !!a.up);
  // 给对应行加闪烁（不整体重建，避免打断滚动）
  if (track) {
    track.querySelectorAll('.row').forEach(el => {
      if (el.dataset.symbol === a.symbol) {
        el.classList.add('flash');
        if (!a.up) el.classList.add('down-flash');
      }
    });
  }
  if (dot) dot.classList.add('alert');
  showAlertPop(a);
  if (window.stockApi) {
    window.stockApi.getAlertsConfig?.().then(c => { if (c && c.sound !== false) beep(a.up); }).catch(() => beep(a.up));
  }
  // 20 秒后停止闪烁
  setTimeout(() => {
    flashed.delete(a.symbol);
    if (track) {
      track.querySelectorAll('.row').forEach(el => {
        if (el.dataset.symbol === a.symbol) el.classList.remove('flash');
      });
    }
    if (dot) dot.classList.remove('alert');
  }, 20000);
});

// ---------- 交易时段 ----------
function isTradingNow() {
  const d = new Date();
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const hm = d.getHours() * 100 + d.getMinutes();
  return (hm >= 925 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
}
function refreshTradingUI() {
  const t = isTradingNow();
  tradingEl.textContent = t ? '交易中' : '休市';
  dot.classList.toggle('trading', t);
  dot.classList.toggle('paused', !t);
}
setInterval(refreshTradingUI, 30_000);
refreshTradingUI();

// ---------- 时间显示 ----------
function refreshTime() {
  const d = new Date();
  updateTimeEl.textContent = d.toTimeString().slice(0, 8);
}
setInterval(refreshTime, 1000);
refreshTime();

// ---------- 退出按钮 ----------
document.getElementById('close-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  window.stockApi?.quit();
});

// ---------- 拖动窗口（IPC 实现）----------
// 不用 CSS -webkit-app-region: drag：拖拽区由系统接管后右键 contextmenu 会被吞掉，
// 改为 pointer 事件 + IPC，主进程按光标屏幕位移移动窗口。
const widgetEl = document.getElementById('widget');
let dragPointerId = null;
let dragPending = false;

function scheduleDragMove() {
  if (dragPending) return;
  dragPending = true;
  requestAnimationFrame(() => {
    dragPending = false;
    if (dragPointerId !== null) window.stockApi?.dragMove?.();
  });
}

function endDrag(e) {
  if (dragPointerId === null) return;
  if (e && e.pointerId != null && e.pointerId !== dragPointerId) return;
  try { widgetEl?.releasePointerCapture(dragPointerId); } catch (_) {}
  dragPointerId = null;
  window.stockApi?.dragEnd?.();
}

widgetEl?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;                                  // 仅左键拖动
  if (e.target && e.target.closest && e.target.closest('#close-btn')) return;
  dragPointerId = e.pointerId;
  try { widgetEl.setPointerCapture(e.pointerId); } catch (_) {}  // 拖出窗口也能收到事件
  window.stockApi?.dragStart?.();
});
widgetEl?.addEventListener('pointermove', (e) => {
  if (dragPointerId === null || e.pointerId !== dragPointerId) return;
  scheduleDragMove();
});
widgetEl?.addEventListener('pointerup', endDrag);
widgetEl?.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => endDrag());

// ---------- 右键菜单 ----------
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  try { window.stockApi?.showSettings?.(); } catch (_) {}
});

// ---------- 接收数据 ----------
window.stockApi?.onQuotes((data) => {
  quotes = data || [];
  restart();
});

// 初始拉取一次（主进程可能已有缓存）
window.stockApi?.getQuotes?.().then((data) => {
  if (data && data.length) {
    quotes = data;
    restart();
  } else {
    restart();
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(restart, 150);
});
