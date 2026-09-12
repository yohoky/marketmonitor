// Marketmonitor - Electron 主进程
// 职责：无边框透明窗口 + 系统托盘 + 位置持久化 + 股票数据服务调度 + 异动提醒

const electron = require('electron');

// 防御：若被以纯 Node 方式启动（环境变量 ELECTRON_RUN_AS_NODE=1），
// require('electron') 不含 app，后续会静默崩溃，这里显式提示并退出
if (!electron || !electron.app) {
  console.error('[Marketmonitor] 未以 Electron 主进程方式启动（请检查环境变量 ELECTRON_RUN_AS_NODE），程序退出。');
  process.exit(1);
}

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, Notification } = electron;
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');

// Windows 通知需要 AppUserModelID，否则 toast 不显示
try { app.setAppUserModelId('Marketmonitor'); } catch (_) {}

// 应用目录：与 config.ini 同目录（打包后为 exe 同级，开发时为源码目录）
const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
// 自检/自测触发器：命令行参数在部分 Electron 便携版会被拦截，
// 因此同时支持在应用目录放一个同名 .trigger 文件来触发（更可靠）
function triggered(name) {
  if (process.argv.includes('--' + name)) return true;
  try { return fs.existsSync(path.join(APP_DIR, name + '.trigger')); } catch (_) { return false; }
}

// ---------- 配置文件（exe 同级的 config.ini）----------
const CONFIG_PATH = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'config.ini')
  : path.join(__dirname, 'config.ini');

// ---------- 全局错误兜底 ----------
// 主进程未捕获异常默认会弹出阻断式错误对话框（"A JavaScript error occurred in the main process"），
// 一旦弹出整个程序就点不动了。这里改成写日志，保证程序继续可用。
function logErr(tag, err) {
  const msg = `[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || String(err)}\n`;
  console.error(msg);
  try { fs.appendFileSync(path.join(path.dirname(CONFIG_PATH), 'error.log'), msg, 'utf8'); } catch (_) {}
}
process.on('uncaughtException', (e) => logErr('uncaughtException', e));
process.on('unhandledRejection', (e) => logErr('unhandledRejection', e));

const INI_TEMPLATE = `; ==================================================
;  Marketmonitor 配置
;
;  [stocks]  一行一个代码，支持 6 位数字 或 sh/sz 前缀
;            直接粘贴即可（自动识别沪深）
;
;  [widget]  外观/尺寸/刷新，格式 key=value
;            displayMode = scroll(滚动) / jump(跳动)
;
;  [alerts]  异动提醒
;            threshold   触发阈值(%) 绝对值
;            direction   up(仅涨) / down(仅跌) / both(涨跌都提醒)
;            sound       true 播放提示音
;            cooldownMs  同一只股票的提醒冷却时间(毫秒)，防刷屏
;            tradingHours 仅开盘时段提醒 true/false（默认 true）
;                         时段=A股北京时间 09:25–11:35 / 12:55–15:05，周末除外
; ==================================================

[stocks]
sh603993
sz000783
sz002616
sz002670
sz300251
sh600588
sh603556
sz000400
sz000977
sz300001 特锐德
sh600362

[widget]
width=220
height=84
topMost=true
fetchIntervalMs=30000
rotationMs=3000
opacity=1.0
displayMode=scroll
position-x=0
position-y=0

[alerts]
enabled=true
thresholdUp=3.9
thresholdDown=3.9
direction=both
sound=true
cooldownMs=180000
tradingHours=true
`;

// 简单 INI 解析（满足本项目需求即可）
function parseIni(text) {
  const sections = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      cur = line.slice(1, -1).trim();
      sections[cur] = [];
    } else if (cur) {
      sections[cur].push(line);
    }
  }
  return sections;
}

// ---------- 异动提醒配置 ----------
const DEFAULT_ALERTS = {
  enabled: true,
  thresholdUp: 3.9,      // 涨幅阈值(%)：当日涨幅 ≥ 该值触发
  thresholdDown: 3.9,    // 跌幅阈值(%)：当日跌幅绝对值 ≥ 该值触发
  direction: 'both',     // up(仅涨) / down(仅跌) / both(涨跌都提醒)
  sound: true,
  cooldownMs: 180000,    // 同一只 3 分钟内不重复提醒，防刷屏
  tradingHours: true,    // 仅开盘时段提醒（A股北京时间两个连续竞价时段，周末除外）
};

// 阈值取值：优先用 thresholdUp / thresholdDown；旧配置的 threshold 作为兜底
function clampTh(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.min(50, n);
}

function normalizeAlerts(raw) {
  const r = raw || {};
  const dirRaw = String(r['direction'] || 'both').toLowerCase();
  const legacy = clampTh(r['threshold']);          // 兼容旧版单一阈值
  const up = clampTh(r['thresholdUp']);
  const down = clampTh(r['thresholdDown']);
  const cd = parseInt(r['cooldownMs'], 10);
  return {
    enabled: r['enabled'] !== undefined ? (String(r['enabled']) !== 'false') : DEFAULT_ALERTS.enabled,
    thresholdUp: up !== null ? up : (legacy !== null ? legacy : DEFAULT_ALERTS.thresholdUp),
    thresholdDown: down !== null ? down : (legacy !== null ? legacy : DEFAULT_ALERTS.thresholdDown),
    // up 仅涨 / down 仅跌 / both 涨跌都提醒 / none 都关闭
    direction: (dirRaw === 'up' || dirRaw === 'down' || dirRaw === 'none') ? dirRaw : 'both',
    sound: r['sound'] !== undefined ? (String(r['sound']) !== 'false') : DEFAULT_ALERTS.sound,
    cooldownMs: isFinite(cd) && cd >= 0 ? cd : DEFAULT_ALERTS.cooldownMs,
    tradingHours: r['tradingHours'] !== undefined ? (String(r['tradingHours']) !== 'false') : DEFAULT_ALERTS.tradingHours,
  };
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const sections = parseIni(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const stocks = (sections['stocks'] || []).map(code => {
        // 代码行：支持 "600519" / "sh600519" / "600519 贵州茅台"
        const parts = code.split(/\s+/);
        let sym = parts[0].trim().toLowerCase();
        const name = parts.slice(1).join(' ');
        // 纯 6 位数字 → 自动加 sh/sz 前缀
        if (/^\d{6}$/.test(sym)) {
          const h = sym[0];
          sym = (h === '6' || h === '9') ? 'sh' + sym : 'sz' + sym;
        } else if (/^\d{5}$/.test(sym)) {
          sym = 'sh' + ('0' + sym);
        }
        return { symbol: sym, name: name || sym };
      });
      const cfg = {};
      for (const line of (sections['widget'] || [])) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        cfg[key] = val;
      }
      const ac = {};
      for (const line of (sections['alerts'] || [])) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        ac[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return {
        stocks,
        widget: {
          width: parseInt(cfg['width']) || 220,
          height: parseInt(cfg['height']) || 84,
          topMost: cfg['topMost'] !== 'false',
          fetchIntervalMs: parseInt(cfg['fetchIntervalMs']) || 30000,
          rotationMs: parseInt(cfg['rotationMs']) || 3000,
          opacity: parseFloat(cfg['opacity']) || 1.0,
          displayMode: (cfg['displayMode'] === 'jump') ? 'jump' : 'scroll',
          position: {
            x: parseInt(cfg['position-x']) || 0,
            y: parseInt(cfg['position-y']) || 0,
          },
        },
        alerts: normalizeAlerts(ac),
      };
    } catch (_) { /* fall through to template */ }
  }
  // 首次运行：写模板
  try { fs.writeFileSync(CONFIG_PATH, INI_TEMPLATE, 'utf8'); } catch (_) {}
  return {
    stocks: [
      { symbol: 'sh603993', name: 'sh603993' },
      { symbol: 'sz000783', name: 'sz000783' },
      { symbol: 'sz002616', name: 'sz002616' },
      { symbol: 'sz002670', name: 'sz002670' },
      { symbol: 'sz300251', name: 'sz300251' },
      { symbol: 'sh600588', name: 'sh600588' },
      { symbol: 'sh603556', name: 'sh603556' },
      { symbol: 'sz000400', name: 'sz000400' },
      { symbol: 'sz000977', name: 'sz000977' },
      { symbol: 'sz300001', name: '特锐德' },
      { symbol: 'sh600362', name: 'sh600362' },
    ],
    widget: {
      width: 220, height: 84, topMost: true,
      fetchIntervalMs: 30000, rotationMs: 3000, opacity: 1.0,
      displayMode: 'scroll',
      position: { x: 0, y: 0 },
    },
    alerts: { ...DEFAULT_ALERTS },
  };
}

function saveConfig() {
  try {
    const lines = [];
    lines.push('; ==================================================');
    lines.push(';  Marketmonitor 配置  (此文件由程序自动生成/更新)');
    lines.push(';');
    lines.push(';  [stocks]  一行一个代码，支持 6 位数字 或 sh/sz 前缀');
    lines.push(';  [widget]  外观/尺寸/刷新，displayMode = scroll | jump');
    lines.push(';  [alerts]  异动提醒：threshold 阈值% / direction up|down|both');
    lines.push('; ==================================================');
    lines.push('');
    lines.push('[stocks]');
    for (const s of store.stocks) {
      lines.push(s.symbol + (s.name && s.name !== s.symbol ? ' ' + s.name : ''));
    }
    lines.push('');
    lines.push('[widget]');
    lines.push('width=' + store.widget.width);
    lines.push('height=' + store.widget.height);
    lines.push('topMost=' + (store.widget.topMost ? 'true' : 'false'));
    lines.push('fetchIntervalMs=' + store.widget.fetchIntervalMs);
    lines.push('rotationMs=' + store.widget.rotationMs);
    lines.push('opacity=' + store.widget.opacity);
    lines.push('displayMode=' + (store.widget.displayMode || 'scroll'));
    lines.push('position-x=' + (store.widget.position?.x || 0));
    lines.push('position-y=' + (store.widget.position?.y || 0));
    lines.push('');
    const a = store.alerts || DEFAULT_ALERTS;
    lines.push('[alerts]');
    lines.push('enabled=' + (a.enabled ? 'true' : 'false'));
    lines.push('thresholdUp=' + (a.thresholdUp ?? DEFAULT_ALERTS.thresholdUp));
    lines.push('thresholdDown=' + (a.thresholdDown ?? DEFAULT_ALERTS.thresholdDown));
    lines.push('direction=' + a.direction);
    lines.push('sound=' + (a.sound ? 'true' : 'false'));
    lines.push('cooldownMs=' + a.cooldownMs);
    lines.push('tradingHours=' + (a.tradingHours ? 'true' : 'false'));
    lines.push('');
    fs.writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf8');
  } catch (_) {}
}

const store = loadConfig();

let widgetWindow = null;
let settingsWindow = null;
let tray = null;
let fetchTimer = null;
let lastQuotes = [];

// ---------- 异动提醒引擎 ----------
// alertState: symbol -> { ts, pct }  用于去刷屏（冷却期 + 数值未变化不重复提醒）
const alertState = new Map();

/**
 * 纯函数：某时刻是否处于 A 股开盘时段（北京时间 UTC+8，与本地时区无关，保证 CI/任意时区行为一致）。
 * 时段：周一~周五，上午 09:25–11:35（含集合竞价）、下午 12:55–15:05（含尾盘收盘前后），与小组件"交易中"标识一致。
 */
function isInTradingHours(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return false;
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);   // 换算成北京时间
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return false;               // 周末不开市
  const hm = bj.getUTCHours() * 100 + bj.getUTCMinutes();
  return (hm >= 925 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
}

/**
 * 纯函数：按配置判定一批行情中哪些触发异动。
 * 规则：|涨跌幅| >= threshold，且方向匹配；同一只在 cooldownMs 内不重复；数值未变化不重复。
 * 额外：tradingHours(默认 true) 时，仅在 A 股开盘时段内提醒，其余时段静默。
 */
function evalAlerts(quotes, cfg, now) {
  const out = [];
  const ts = now == null ? Date.now() : now;
  if (!cfg || !cfg.enabled || !Array.isArray(quotes)) return out;
  // 仅开盘时段提醒：非 A 股成交时段（北京时间）整体静默，避免收盘后/夜间/周末仍轰炸
  if (cfg.tradingHours !== false && !isInTradingHours(new Date(ts))) return out;
  // 涨 / 跌阈值可分别设置；只有旧字段 threshold 时作为兜底
  const legacy = Math.abs(parseFloat(cfg.threshold) || 0);
  const thUp = cfg.thresholdUp != null ? Math.abs(parseFloat(cfg.thresholdUp) || 0) : legacy;
  const thDown = cfg.thresholdDown != null ? Math.abs(parseFloat(cfg.thresholdDown) || 0) : legacy;
  const dir = cfg.direction || 'both';
  const cooldown = parseInt(cfg.cooldownMs, 10) || 0;
  for (const q of quotes) {
    if (!q || !q.symbol) continue;
    const pct = parseFloat(q.changePct);
    if (!isFinite(pct) || pct === 0) continue;
    const up = pct > 0;
    if (dir === 'none') continue;
    if (dir === 'up' && !up) continue;
    if (dir === 'down' && up) continue;
    if (Math.abs(pct) < (up ? thUp : thDown)) continue;   // 涨用涨幅阈值，跌用跌幅阈值
    const prev = alertState.get(q.symbol);
    if (prev) {
      if (ts - prev.ts < cooldown) continue;       // 冷却期内静默
      if (prev.pct === pct) continue;              // 数值没变化，不重复打扰
    }
    alertState.set(q.symbol, { ts, pct });
    out.push({
      symbol: q.symbol,
      name: q.name || q.symbol,
      price: q.price || 0,
      changePct: pct,
      up,
    });
  }
  return out;
}

// 触发一次提醒：系统通知 + 推送到小组件（提示音 / 闪烁 / 弹窗）
function fireAlert(a) {
  const arrow = a.up ? '📈' : '📉';
  const sign = a.up ? '+' : '';
  const title = `${arrow} 异动提醒 · ${a.name}`;
  const body = `${a.symbol}  ${Number(a.price).toFixed(2)}  ${sign}${a.changePct.toFixed(2)}%`;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        silent: !(store.alerts && store.alerts.sound),
      });
      n.on('click', () => {
        if (widgetWindow && !widgetWindow.isDestroyed()) { widgetWindow.show(); widgetWindow.focus(); }
      });
      n.show();
    }
  } catch (_) {}
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    try { widgetWindow.webContents.send('alert', a); } catch (_) {}
  }
  console.log('[alert]', title, body);
}

function checkAlerts(quotes) {
  const hits = evalAlerts(quotes, store.alerts, Date.now());
  for (const a of hits) fireAlert(a);
  return hits;
}

// 首次运行不做"历史补报"：把已存在的异动标记为已提醒，避免启动瞬间弹一堆
function primeAlertState(quotes) {
  const now = Date.now();
  for (const q of (quotes || [])) {
    if (q && q.symbol) alertState.set(q.symbol, { ts: now, pct: parseFloat(q.changePct) || 0 });
  }
}

// ---------- 应用窗口尺寸 ----------
// 重要坑：Electron 每调用一次 setSize()，都会把 window.minimumSize 悄悄更新为
// 刚设置的尺寸。结果是"只能调大、不能调小"——想改小会被自己上次设的 min 拦住
// （实测：400→300 成功且 min 变 300，之后再 setSize(200/120/84) 全部无效）。
// 因此每次 setSize 前必须先放开下限。
const MIN_W = 160, MIN_H = 60, MAX_W = 480, MAX_H = 600;   // 尺寸允许的范围
const SNAP_TOL = 80;   // 贴角判定容差(px)：距边缘在此范围内即认为"贴着这一边"

// 判断窗口当前贴在哪个角；不贴任何角则返回 null（用户在中间随意摆放时不打扰）
function detectCorner(pos, size) {
  const work = screen.getPrimaryDisplay().workArea;
  const near = (a) => Math.abs(a) <= SNAP_TOL;
  const gapL = pos.x - (work.x + EDGE_MARGIN);
  const gapT = pos.y - (work.y + EDGE_MARGIN);
  const gapR = (work.x + work.width - EDGE_MARGIN) - (pos.x + size.width);
  const gapB = (work.y + work.height - EDGE_MARGIN) - (pos.y + size.height);
  const L = near(gapL), T = near(gapT), R = near(gapR), B = near(gapB);
  // 只有当"水平方向的某一侧"与"垂直方向的某一侧"同时贴边，才算贴角
  if (L && T) return 'top-left';
  if (R && T) return 'top-right';
  if (L && B) return 'bottom-left';
  if (R && B) return 'bottom-right';
  return null;
}

// 按当前 store.widget 尺寸，把窗口重新精确贴到指定角
function snapToCorner(anchor) {
  if (!widgetWindow || widgetWindow.isDestroyed() || !anchor) return false;
  const np = computeAnchoredPosition(anchor);
  try {
    widgetWindow.setPosition(np.x, np.y);
    store.widget.position = np;
    return true;
  } catch (e) { logErr('snapToCorner', e); return false; }
}

function applyWidgetSize() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const w = store.widget.width, h = store.widget.height;
  try {
    // 改尺寸【之前】先看贴的是哪个角（此时getSize还是旧值）
    const p = widgetWindow.getPosition();
    const old = widgetWindow.getSize();
    const anchor = detectCorner({ x: p[0], y: p[1] }, { width: old[0], height: old[1] });

    widgetWindow.setMinimumSize(MIN_W, MIN_H);   // 先解除隐式下限
    widgetWindow.setMaximumSize(MAX_W, MAX_H);   // 放开上限到允许范围，确保 setSize 能达到
    widgetWindow.setSize(w, h);
    saveConfig();

    // 改完尺寸按新尺寸重新贴回那个角，保证始终严丝合缝贴边
    // （否则右下角位置是基于旧宽高算的，一改尺寸就会偏移）
    snapToCorner(anchor);
  } catch (e) { logErr('applyWidgetSize', e); }
}

// ---------- 屏幕位置（九宫格锚点）----------
// anchor: top-left / top / top-right / left / center / right / bottom-left / bottom / bottom-right
const EDGE_MARGIN = 12;   // 距屏幕边缘留白
function computeAnchoredPosition(anchor) {
  const { width, height } = store.widget;
  const display = screen.getPrimaryDisplay();
  const w = display.workArea;          // 排除任务栏
  const xL = w.x + EDGE_MARGIN;
  const xC = w.x + Math.round((w.width - width) / 2);
  const xR = w.x + w.width - width - EDGE_MARGIN;
  const yT = w.y + EDGE_MARGIN;
  const yM = w.y + Math.round((w.height - height) / 2);
  const yB = w.y + w.height - height - EDGE_MARGIN;
  const map = {
    'top-left': [xL, yT], 'top': [xC, yT], 'top-right': [xR, yT],
    'left': [xL, yM], 'center': [xC, yM], 'right': [xR, yM],
    'bottom-left': [xL, yB], 'bottom': [xC, yB], 'bottom-right': [xR, yB],
  };
  const [x, y] = map[anchor] || map['bottom-right'];
  return { x, y };
}

// 默认位置 = 右下角
function computeDefaultPosition() {
  return computeAnchoredPosition('bottom-right');
}

// ---------- 创建小组件窗口 ----------
function createWidgetWindow() {
  const cfg = store.widget;
  let pos = cfg.position;
  if (!pos || pos.x === 0 && pos.y === 0) pos = computeDefaultPosition();

  widgetWindow = new BrowserWindow({
    width: cfg.width,
    height: cfg.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,           // 关键修复：透明窗口，让"摸鱼透明度"真正透出桌面
    backgroundColor: '#00000000',    // 全透明底，卡片由渲染层 CSS 绘制
    resizable: false,
    movable: true,
    alwaysOnTop: cfg.topMost,
    skipTaskbar: true,           // 不占任务栏
    hasShadow: false,           // 透明窗口关闭系统阴影，卡片自带 box-shadow
    paintWhenInitiallyHidden: true,   // 避免首帧白闪
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  widgetWindow.setMenuBarVisibility(false);
  // 显式声明边界，避免 Electron 把创建尺寸当成 minimumSize（否则后续无法调小）
  try {
    widgetWindow.setMinimumSize(MIN_W, MIN_H);
    widgetWindow.setMaximumSize(MAX_W, MAX_H);
    widgetWindow.setResizable(false);   // 再次确认：小组件不允许被手动/边角拖拽改变大小
  } catch (_) {}

  // 尺寸守卫（双保险）：小组件尺寸只能由设置页 IPC 决定。
  // 若因旧进程残留 / Windows 无边框窗口边角 resize / 多屏 DPR 变化导致尺寸漂移，
  // debounce 后立即弹回 store 期望值。设置页改尺寸时先更新 store 再 setSize，
  // 因而守卫比较的是最新目标值，不会误伤。
  let _sizeGuardTimer = null;
  widgetWindow.on('resize', () => {
    if (_sizeGuardTimer) return;
    _sizeGuardTimer = setTimeout(() => {
      _sizeGuardTimer = null;
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      try {
        const s = widgetWindow.getSize();
        const tw = store.widget.width, th = store.widget.height;
        if (s[0] !== tw || s[1] !== th) {
          widgetWindow.setMinimumSize(MIN_W, MIN_H);
          widgetWindow.setMaximumSize(MAX_W, MAX_H);
          widgetWindow.setSize(tw, th);
        }
      } catch (_) {}
    }, 15);
  });
  widgetWindow.once('ready-to-show', () => {
    widgetWindow.show();
    // 透明度交给渲染层用 CSS 应用（按 config 值重算，启动必然持久），
    // 这里仅兜底调用一次，保证透明窗口也能立刻生效
    const op = Math.max(0.05, Math.min(1.0, parseFloat(store.widget.opacity) || 1.0));
    try { widgetWindow.webContents.send('opacity-change', op); } catch (_) {}
    try { widgetWindow.webContents.send('display-mode', store.widget.displayMode || 'scroll'); } catch (_) {}
    try { widgetWindow.webContents.send('rotation-ms', store.widget.rotationMs || 3000); } catch (_) {}

    // 启动贴角精修：若 config 保存的位置在贴角容差内，帮用户对齐到精确像素；
    // 用户拖到中间时不打扰。两次 ready-to-show 只挂第二个监听，里面只挂一次。
  });
  // 单独挂第二个 ready-to-show 完成贴角精修
  widgetWindow.once('ready-to-show', () => {
    try {
      const p = widgetWindow.getPosition();
      const sz = widgetWindow.getSize();
      const a = detectCorner({ x: p[0], y: p[1] }, { width: sz[0], height: sz[1] });
      if (a) {
        const np = computeAnchoredPosition(a);
        if (np.x !== p[0] || np.y !== p[1]) {
          widgetWindow.setPosition(np.x, np.y);
          store.widget.position = np;
          saveConfig();
        }
      }
    } catch (e) { logErr('startup-snap', e); }
  });
  widgetWindow.loadFile('renderer/index.html');

  // 右键兜底：即便渲染层 contextmenu 未触发，主进程也能打开设置
  widgetWindow.webContents.on('context-menu', () => {
    try { openSettings(); } catch (e) { logErr('context-menu', e); }
  });

  // 一次自检：用 --selfcheck 启动时，渲染稳定后自动截图 + 记录透明度参数并退出（便于验证，正常启动完全不受影响）
  if (triggered('selfcheck')) {
    const baseDir = APP_DIR;
    const logPath = path.join(baseDir, 'selfcheck.log');
    widgetWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let capMsg = '';
        try {
          const img = await widgetWindow.webContents.capturePage();
          fs.writeFileSync(path.join(baseDir, 'selfcheck.png'), img.toPNG());
          capMsg = 'CAPTURED ' + path.join(baseDir, 'selfcheck.png');
        } catch (e) { capMsg = 'CAP_ERR ' + e.message; }
        // 从渲染层读取真实运行状态：可见行数 / 总行数 / 切换方式 / 背景 alpha
        let ui = {};
        try {
          ui = await widgetWindow.webContents.executeJavaScript(`(function(){
            var rows = document.getElementById('rows');
            var track = document.getElementById('track');
            var first = track ? track.firstElementChild : null;
            var rh = first ? first.offsetHeight : 0;
            var boxH = rows ? rows.clientHeight : 0;
            return {
              winH: window.innerHeight,
              rowsBoxH: boxH,
              rowH: rh,
              visibleRows: Math.max(1, Math.floor((boxH + 4) / (rh + 4))),
              totalRows: track ? track.children.length : 0,
              transform: track ? track.style.transform : '',
              cardAlpha: getComputedStyle(document.documentElement).getPropertyValue('--card-a').trim(),
              widgetOpacity: getComputedStyle(document.getElementById('widget')).opacity,
              firstRowText: first ? first.innerText.replace(/\\s+/g, ' ') : ''
            };
          })()`);
        } catch (e) { ui = { uiErr: e.message }; }
        let diag = {};
        try {
          const exists = fs.existsSync(CONFIG_PATH);
          const raw = exists ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
          const opLine = raw ? raw.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('opacity=')) : null;
          diag = { exists, opLine, fileLen: raw ? raw.length : 0, stocksLen: (store.stocks || []).length };
        } catch (e) { diag = { diagErr: e.message }; }
        try {
          fs.writeFileSync(logPath, capMsg + '\n' + JSON.stringify({
            widget: store.widget,
            alerts: store.alerts,
            diag,
            ui,
          }, null, 2) + '\n', 'utf8');
        } catch (_) {}
        setTimeout(() => app.quit(), 800);
      }, 4000);
    });
  }

  // 拖动后保存位置（拖动过程中会高频触发，做防抖，避免每帧写盘）
  widgetWindow.on('moved', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const [x, y] = widgetWindow.getPosition();
    store.widget.position = { x, y };
    if (posSaveTimer) clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(() => { posSaveTimer = null; saveConfig(); }, 400);
  });

  widgetWindow.on('closed', () => { widgetWindow = null; });
}

// ---------- 设置窗口 ----------
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 520,
    title: 'Marketmonitor 设置',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile('renderer/settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------- 股票数据获取 ----------
// 使用腾讯财经 API：https://qt.gtimg.cn/q=sh600519,sz000858
async function fetchQuotes(symbols) {
  if (!symbols || symbols.length === 0) return [];
  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // 模拟浏览器请求，降低被 ban 概率
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://gu.qq.com/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
      },
    });
    clearTimeout(t);
    // 腾讯 API 返回 GBK 编码，用 iconv-lite 正确解码
    const buf = Buffer.from(await res.arrayBuffer());
    const text = iconv.decode(buf, 'gbk');
    return parseQuotes(text);
  } catch (e) {
    console.error('[fetchQuotes] error:', e.message);
    return lastQuotes || [];
  }
}

// 解析腾讯财经返回格式
// v_pv_2_sz000858="51~五粮液~000858~29.30~29.25~29.35~...~..."
function parseQuotes(text) {
  const out = [];
  const regex = /=(?:"([^"]*)")/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const payload = m[1];
    const parts = String(payload).split('~');
    // 腾讯字段索引：
    // 0=市场  1=名称  2=代码  3=现价  4=昨收  5=今开  6=成交量
    // ...
    // 31=涨跌  32=涨跌幅(%)  33=最高  34=最低  35=最新价
    if (parts.length < 35) continue;
    out.push({
      symbol: parts[0] || '',
      name: parts[1] || '',
      code: parts[2] || '',
      price: parseFloat(parts[3]) || 0,
      prevClose: parseFloat(parts[4]) || 0,
      open: parseFloat(parts[5]) || 0,
      change: parseFloat(parts[31]) || 0,
      changePct: parseFloat(parts[32]) || 0,
      high: parseFloat(parts[33]) || 0,
      low: parseFloat(parts[34]) || 0,
    });
  }
  if (out.length > 0) lastQuotes = out;
  return out;
}

// ---------- 主循环：拉取数据并推送到窗口 ----------
// 刷新策略：统一 30s 一次（用户要求）。
// 风险：30s 间隔在腾讯侧的封禁阈值之上，不会触发限频。
let alertPrimed = false;

async function tick() {
  const symbols = (store.stocks || []).map(s => s.symbol);
  const quotes = await fetchQuotes(symbols);
  if (!alertPrimed && quotes && quotes.length) {
    primeAlertState(quotes);   // 启动首帧只记录不提醒，避免历史异动补报
    alertPrimed = true;
  } else {
    checkAlerts(quotes);
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('quotes', quotes);
  }
  // 重排定时
  clearTimeout(fetchTimer);
  const interval = store.widget.fetchIntervalMs || 30000;
  fetchTimer = setTimeout(tick, interval);
}

// ---------- IPC 通信 ----------
ipcMain.handle('get-stocks', () => store.stocks);
ipcMain.handle('save-stocks', (_e, stocks) => {
  const arr = Array.isArray(stocks) ? stocks : [];
  store.stocks = arr; saveConfig();
  tick();
  return store.stocks;
});
ipcMain.handle('get-quote-cache', () => lastQuotes);
ipcMain.handle('get-widget-config', () => ({
  opacity: store.widget.opacity ?? 1.0,
  topMost: store.widget.topMost,
  width: store.widget.width,
  height: store.widget.height,
  displayMode: store.widget.displayMode || 'scroll',
  rotationMs: store.widget.rotationMs || 3000,
}));

ipcMain.handle('get-alerts-config', () => ({ ...(store.alerts || DEFAULT_ALERTS) }));
ipcMain.handle('save-alerts-config', (_e, cfg) => {
  store.alerts = normalizeAlerts(cfg || {});
  saveConfig();
  return { ...store.alerts };
});
// 手动测试提醒（设置页"试一下"用）：直接用当前真实行情判定，不走冷却
ipcMain.handle('test-alert', () => {
  const demo = (lastQuotes || []).slice(0, 1).map(q => ({
    symbol: q.symbol, name: q.name || q.symbol, price: q.price,
    changePct: q.changePct, up: (q.changePct || 0) > 0,
  }));
  const a = demo[0] || {
    symbol: 'sh600519', name: '贵州茅台', price: 1500,
    changePct: ((store.alerts && store.alerts.thresholdUp) || 3.9), up: true,
  };
  fireAlert(a);
  return a;
});
ipcMain.handle('save-widget-config', (_e, cfg) => {
  // 透明度（下限 0.05，支持深度摸鱼）
  if (cfg.opacity != null) {
    const op = Math.max(0.05, Math.min(1.0, parseFloat(cfg.opacity) || 1.0));
    store.widget.opacity = op;
    // 透明度由渲染层用 CSS 应用（持久），实时同步给小组件窗口
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      try { widgetWindow.webContents.send('opacity-change', op); } catch (_) {}
    }
  }
  // 置顶
  if (cfg.topMost != null) {
    const tm = !!cfg.topMost;
    if (tm !== store.widget.topMost) {
      store.widget.topMost = tm;
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.setAlwaysOnTop(tm);
    }
  }
  // 尺寸：实时调整窗口大小
  if (cfg.width != null || cfg.height != null) {
    store.widget.width = Math.max(160, Math.min(480, parseInt(cfg.width) || store.widget.width));
    store.widget.height = Math.max(60, Math.min(600, parseInt(cfg.height) || store.widget.height));
    applyWidgetSize();
  }
  // 展示方式：scroll 滚动 / jump 跳动
  if (cfg.displayMode != null) {
    store.widget.displayMode = (cfg.displayMode === 'jump') ? 'jump' : 'scroll';
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      try { widgetWindow.webContents.send('display-mode', store.widget.displayMode); } catch (_) {}
    }
  }
  // 切换间隔
  if (cfg.rotationMs != null) {
    store.widget.rotationMs = Math.max(500, Math.min(60000, parseInt(cfg.rotationMs) || 3000));
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      try { widgetWindow.webContents.send('rotation-ms', store.widget.rotationMs); } catch (_) {}
    }
  }
  saveConfig();
  return {
    opacity: store.widget.opacity,
    topMost: store.widget.topMost,
    width: store.widget.width,
    height: store.widget.height,
    displayMode: store.widget.displayMode,
    rotationMs: store.widget.rotationMs,
  };
});

// 渲染进程请求获取股票名（GBK 解码）
ipcMain.handle('fetch-stock-name', async (_e, symbol) => {
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
      headers: { 'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = iconv.decode(buf, 'gbk');
    const m = text.match(/~([^~]+)~/);
    return m ? m[1] : symbol;
  } catch (_) { return symbol; }
});

// 位置：按九宫格锚点归位（设置页"位置"卡片用）
ipcMain.handle('set-widget-position', (_e, anchor) => {
  const pos = computeAnchoredPosition(String(anchor || 'bottom-right'));
  store.widget.position = pos;
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    try { widgetWindow.setPosition(pos.x, pos.y); } catch (e) { logErr('setPosition', e); }
  }
  saveConfig();
  return pos;
});
// 查询当前位置 + 屏幕信息，供设置页显示
ipcMain.handle('get-widget-position', () => {
  const cur = (widgetWindow && !widgetWindow.isDestroyed())
    ? (() => { const p = widgetWindow.getPosition(); return { x: p[0], y: p[1] }; })()
    : (store.widget.position || { x: 0, y: 0 });
  const work = screen.getPrimaryDisplay().workArea;
  return { ...cur, screenW: work.width, screenH: work.height };
});

ipcMain.handle('widget-show-settings', () => openSettings());
ipcMain.handle('widget-quit', () => { app.quit(); });
// ---------- 窗口拖动 ----------
// 说明：不用 CSS 的 -webkit-app-region: drag —— 拖拽区由系统接管会吞掉右键 contextmenu 事件。
// 改为主进程按光标位移移动窗口，拖动和右键都能正常工作。
let dragBase = null;      // 拖动开始时窗口位置
let dragOrigin = null;    // 拖动开始时光标屏幕坐标
let posSaveTimer = null;

ipcMain.on('widget-drag-start', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  try {
    dragBase = widgetWindow.getPosition();
    dragOrigin = screen.getCursorScreenPoint();
  } catch (e) { logErr('drag-start', e); }
});

ipcMain.on('widget-drag-move', () => {
  if (!dragBase || !dragOrigin) return;
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  try {
    const cur = screen.getCursorScreenPoint();
    widgetWindow.setPosition(
      dragBase[0] + (cur.x - dragOrigin.x),
      dragBase[1] + (cur.y - dragOrigin.y),
    );
  } catch (e) { logErr('drag-move', e); }
});

ipcMain.on('widget-drag-end', () => {
  dragBase = null;
  dragOrigin = null;
  try { saveConfig(); } catch (e) { logErr('drag-end', e); }
});

ipcMain.handle('widget-toggle-topmost', () => {
  if (!widgetWindow) return;
  const cur = widgetWindow.isAlwaysOnTop();
  widgetWindow.setAlwaysOnTop(!cur);
  const w = { ...store.widget };
  w.topMost = !cur;
  store.widget = w; saveConfig();
  return !cur;
});

// ---------- 小组件显隐（托盘用）----------
// 注意：BrowserWindow **没有** toggle() 方法，直接调用会抛 TypeError，
// 弹出阻断式错误框导致程序再也切不回来。这里统一用 show/hide 实现。
function ensureWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) createWidgetWindow();
  return widgetWindow;
}

function showWidget() {
  const w = ensureWidget();
  if (!w) return;
  try {
    if (!w.isVisible()) w.show();
    if (w.isMinimized()) w.restore();
    w.focus();
  } catch (e) { logErr('showWidget', e); }
}

function hideWidget() {
  const w = widgetWindow;
  if (!w || w.isDestroyed()) return;
  try { w.hide(); } catch (e) { logErr('hideWidget', e); }
}

function toggleWidget() {
  const w = ensureWidget();
  if (!w) return;
  if (w.isVisible()) hideWidget(); else showWidget();
}

// ---------- 系统托盘 ----------
// 内置 16x16 兜底图标（assets 缺失时也不会因空图标导致 Tray 构造失败）
const FALLBACK_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR42mNQTX79nxLMACKsm76RhUcNGDVg1ABqG0AJBgACQqMf3oj8SAAAAABJRU5ErkJggg==';

function createTray() {
  let icon = null;
  try { icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')); } catch (_) {}
  if (!icon || icon.isEmpty()) {
    try { icon = nativeImage.createFromBuffer(Buffer.from(FALLBACK_ICON_B64, 'base64')); } catch (_) {}
  }
  if (!icon || icon.isEmpty()) {
    // 极端兜底：1x1 不透明像素
    try { icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); } catch (_) {}
  }

  try { tray = new Tray(icon); } catch (e) { logErr('createTray', e); return; }
  tray.setToolTip('Marketmonitor · 左键显示/隐藏 · 右键菜单');

  const menu = Menu.buildFromTemplate([
    { label: '显示小组件', click: () => showWidget() },
    { label: '隐藏小组件', click: () => hideWidget() },
    { type: 'separator' },
    { label: '股票与提醒设置...', click: () => { try { openSettings(); } catch (e) { logErr('openSettings', e); } } },
    { type: 'separator' },
    { label: '立即刷新', click: () => { try { tick(); } catch (e) { logErr('tick', e); } } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  void shell;
  tray.setContextMenu(menu);
  // 左键单击：切换显示/隐藏（不再用不存在的 toggle()）。
  // 防御性 try/catch：若 toggleWidget 内部抛错（旧版残留或极端状态），
  // 让进程继续存活；否则 Electron 会弹阻断式"A JavaScript error occurred"，
  // 一旦弹出就完全无法再操作托盘。
  tray.on('click', () => { try { toggleWidget(); } catch (e) { logErr('tray-click', e); } });
}

// ---------- 生命周期 ----------
// --test-alert：不启动窗口，纯逻辑自测阈值/方向/冷却，结果写入 exe 同级 alerttest.log 后退出
if (triggered('test-alert') || process.env.MM_TEST_ALERT === '1') {
  const log = [];
  const fake = [
    { symbol: 'sh600000', name: '浦发银行', price: 10, changePct: 3.89 },   // 3.89 < 3.9 不触发
    { symbol: 'sz000001', name: '平安银行', price: 12, changePct: 3.90 },   // 边界 = 3.9 触发(涨)
    { symbol: 'sh600519', name: '贵州茅台', price: 1500, changePct: 5.20 }, // 触发(涨)
    { symbol: 'sz300750', name: '宁德时代', price: 200, changePct: -4.10 }, // 触发(跌)
    { symbol: 'sh601318', name: '中国平安', price: 50, changePct: 1.20 },   // 不触发
  ];
  const base = { enabled: true, thresholdUp: 3.9, thresholdDown: 3.9, direction: 'both', sound: false, cooldownMs: 180000 };
  // 用固定 UTC 时间戳，换算成北京时间后落在盘中（周三 10:00），保证自检不受本机时区影响
  const t0 = Date.UTC(2026, 8, 9, 2, 0, 0);   // = 北京 2026-09-09（周三）10:00，开盘窗口内

  log.push('--- case1 both/3.9 ---');
  log.push(JSON.stringify(evalAlerts(fake, base, t0).map(x => x.symbol + ':' + x.changePct)));
  alertState.clear();

  log.push('--- case2 only up ---');
  log.push(JSON.stringify(evalAlerts(fake, { ...base, direction: 'up' }, t0).map(x => x.symbol)));
  alertState.clear();

  log.push('--- case3 only down ---');
  log.push(JSON.stringify(evalAlerts(fake, { ...base, direction: 'down' }, t0).map(x => x.symbol)));
  alertState.clear();

  log.push('--- case4 dedupe (same tick again) ---');
  alertState.clear();
  const r1 = evalAlerts(fake, base, t0);
  const r2 = evalAlerts(fake, base, t0 + 1000);          // 数值未变 → 不重复
  const r3 = evalAlerts(fake, base, t0 + 1000 + base.cooldownMs); // 过冷却 → 再提醒
  log.push('first=' + r1.length + ' sameVal=' + r2.length + ' afterCooldown=' + r3.length);
  alertState.clear();

  log.push('--- case5 disabled ---');
  log.push('count=' + evalAlerts(fake, { ...base, enabled: false }, t0).length);

  log.push('--- case6 涨/跌阈值分开 (up=5 / down=3) ---');
  const split = { ...base, thresholdUp: 5, thresholdDown: 3 };
  const mk = (sym, pct) => [{ symbol: sym, name: sym, price: 10, changePct: pct }];
  const s1 = evalAlerts([...mk('u', 4.5), ...mk('d', -4.5)], split, t0);
  log.push('涨4.5/跌-4.5 -> ' + JSON.stringify(s1.map(x => x.symbol)) + '  (期望 ["d"])');
  alertState.clear();
  const s2 = evalAlerts([...mk('u', 5.5), ...mk('d', -2.0)], split, t0);
  log.push('涨5.5/跌-2.0 -> ' + JSON.stringify(s2.map(x => x.symbol)) + '  (期望 ["u"])');
  alertState.clear();
  const s3 = evalAlerts([...mk('u', 4.9), ...mk('d', -2.9)], split, t0);
  log.push('涨4.9/跌-2.9 -> ' + JSON.stringify(s3.map(x => x.symbol)) + '  (期望 [])');
  alertState.clear();

  const tEvening = Date.UTC(2026, 8, 9, 12, 0, 0);   // = 北京 周三 20:00，收盘后
  const tWeekend = Date.UTC(2026, 8, 12, 2, 0, 0);   // = 北京 周六 10:00，周末

  log.push('--- case7 开盘窗口：北京 周三10:00（盘内）应触发 ---');
  alertState.clear();
  log.push('count=' + evalAlerts(fake, base, t0).length + '  (期望 3：平安/茅台/宁德)');

  log.push('--- case8 开盘窗口：北京 周三20:00（收盘后）应静默 ---');
  alertState.clear();
  log.push('count=' + evalAlerts(fake, base, tEvening).length + '  (期望 0)');

  log.push('--- case9 开盘窗口：周六（周末）应静默 ---');
  alertState.clear();
  log.push('count=' + evalAlerts(fake, base, tWeekend).length + '  (期望 0)');

  log.push('--- case10 关闭开盘窗口限制：收盘后也提醒 ---');
  alertState.clear();
  log.push('count=' + evalAlerts(fake, { ...base, tradingHours: false }, tEvening).length + '  (期望 3)');
  alertState.clear();

  try {
    fs.writeFileSync(path.join(APP_DIR, 'alerttest.log'), log.join('\n') + '\n', 'utf8');
  } catch (_) {}
  console.log(log.join('\n'));
  const done = () => { try { app.quit(); } catch (_) {} setTimeout(() => process.exit(0), 1500); };
  if (app.isReady()) done(); else app.once('ready', done);
} else {
  app.whenReady().then(() => {
    createWidgetWindow();
    createTray();
    tick();
  });
}

app.on('window-all-closed', (e) => {
  // 不退出，托盘驻留
});

app.on('before-quit', () => {
  clearTimeout(fetchTimer);
});
