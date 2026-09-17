// Marketmonitor - Electron 主进程
// 职责：无边框透明窗口 + 系统托盘 + 位置持久化 + 股票数据服务调度 + 异动提醒

const electron = require('electron');

// 防御：若被以纯 Node 方式启动（环境变量 ELECTRON_RUN_AS_NODE=1），
// require('electron') 不含 app，后续会静默崩溃，这里显式提示并退出
if (!electron || !electron.app) {
  console.error('[Marketmonitor] 未以 Electron 主进程方式启动（请检查环境变量 ELECTRON_RUN_AS_NODE），程序退出。');
  process.exit(1);
}

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, Notification, dialog } = electron;
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');

// Windows 通知需要 AppUserModelID，否则 toast 不显示
try { app.setAppUserModelId('Marketmonitor'); } catch (_) {}

// 部分机器显卡驱动下 GPU 进程会崩溃（GPU process exited unexpectedly），一旦独立 GPU 进程崩溃，
// 透明 + alwaysOnTop 窗口的合成输出会变空白（进程活着、任务栏有预览，但屏上没内容）。
// 用 in-process-gpu 让 GPU 跑在主进程内，规避"独立进程被杀"的崩溃场景，
// 同时【保留硬件合成】，透明窗口正常绘制（比 blanket 关闭硬件加速更安全，不会把透明变黑块）。
try { app.commandLine.appendSwitch('in-process-gpu'); } catch (_) {}

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
;  Marketmonitor 配置  (此文件由程序自动生成/更新)
;
;  结构：
;    · 可以有多个「监控列表」，每个列表 = 一个独立的悬浮小窗口，
;      各自有标的 / 外观 / 提醒阈值 / 收件邮箱 / 定时汇总设置。
;    · SMTP 发件账号与 1~5 个收件邮箱槽位是全局共用（见 [email]）。
;    · 旧版单列表配置（[stocks] / [indexes] / [widget] / [alerts]）升级时会
;      自动迁移为 [list:l1] / [list:l2]，原文件备份为 config.ini.legacy。
;
;  [general] 通用
;            fetchIntervalMs  行情刷新间隔(毫秒)，默认 30000。所有列表共用同一次请求。
;
;  [email]   全局邮件设置（发件账号 + 收件邮箱槽位）
;            enabled          true 开启邮件推送（默认 false，需先填好账号授权码）
;            host             SMTP 服务器，如 smtp.qq.com / smtp.163.com / smtp.exmail.qq.com
;            port             465(SSL) / 587(STARTTLS) / 25
;            secure           true=SSL 直连(配 465)，false=STARTTLS 或明文(配 587/25)
;            user             发件邮箱账号（完整邮箱地址）
;            pass             邮箱「授权码」——不是登录密码！QQ/163 需先在邮箱设置里开启 SMTP 并生成授权码
;            box1 ~ box5      收件邮箱槽位（最多 5 个）；列表用 mailboxes= 选择用哪几个
;            on1 ~ on5        槽位是否启用 true/false（地址留着但不启用 = 临时停用，不用删）
;            followAlerts     true=邮件阈值跟随该列表的异动阈值（默认）；false=用下面的独立阈值
;            thresholdUp      邮件涨幅阈值(%)，followAlerts=false 时生效
;            thresholdDown    邮件跌幅阈值(%)，followAlerts=false 时生效
;
;  [list:xx] 单个监控列表。这个段里：
;            · 不含 "=" 的行 = 一个标的（一行一个）
;            · 含 "=" 的行 = 该列表的设置
;            标的写法：6 位数字(A股/基金/可转债) / 5 位数字(港股) / sh|sz 前缀 / hk 前缀(hk981 位数自动补零)
;            name             列表名称（显示在设置页）
;            width / height   该窗口宽高（宽 160~480，高 60~600）
;            topMost          是否总在最上层 true/false
;            opacity          背景不透明度 0.05~1.0（只淡卡片底色）
;            textOpacity      文字不透明度 0.05~1.0（只淡文字/数字）
;            mono             true 黑白模式（涨跌不用红绿，改深浅灰，摸鱼更隐蔽）
;            displayMode      scroll(滚动) / jump(跳动)
;            scrollMs         滚动：每滚动一行耗时(毫秒) 800~15000，越小滚得越快
;            jumpMs           跳动：每次翻页停留(毫秒) 1000~20000
;            position-x / position-y  窗口位置（多个列表窗口别放到完全重叠的位置）
;            visible          启动时是否显示该窗口 true/false
;            alertEnabled     该列表是否开启异动提醒
;            alertUp/alertDown 涨 / 跌阈值(%)
;            alertDirection   up(仅涨) / down(仅跌) / both(涨跌都提醒)
;            alertSound       true 播放提示音
;            alertCooldownMs  同一只的提醒冷却时间(毫秒)，防刷屏
;            alertTradingHours 仅开盘时段提醒 true/false（默认 true）
;            alertMarket      a(A股) / hk(港股) / both(两者)，决定按哪个市场的开盘时段静默
;                             A股 09:25–11:35 / 12:55–15:05，港股 09:00–12:00 / 13:00–16:00，周末除外
;            mailboxes        该列表的收件邮箱槽位，如 1,3（对应 [email] 的 boxN）
;            digestEnabled    true 该列表开启「定时汇总」：每隔 digestIntervalMin 分钟，
;                             把该列表当前的全部行情汇总成一封邮件发出，与异动推送互不影响
;            digestIntervalMin 定时汇总间隔（分钟），1~1440，默认 30
;
;  [list:xx] 段可以复制多份（xx 只要互不相同即可），书写顺序 = 列表显示顺序。
;  下面这一段是空列表示例：把标的行加在设置下面即可（一行一个），
;  也可以在「设置 → 列表」里直接添加，程序会自动写回本文件。
; ==================================================

[general]
fetchIntervalMs=30000

[email]
enabled=false
host=smtp.qq.com
port=465
secure=true
user=
pass=
box1=
box2=
box3=
box4=
box5=
on1=true
on2=false
on3=false
on4=false
on5=false
followAlerts=true
thresholdUp=3.9
thresholdDown=3.9

[list:l1]
name=自选股
width=220
height=84
topMost=true
opacity=1
textOpacity=1
mono=false
displayMode=scroll
scrollMs=3000
jumpMs=3000
position-x=0
position-y=0
visible=true
alertEnabled=true
alertUp=3.9
alertDown=3.9
alertDirection=both
alertSound=true
alertCooldownMs=180000
alertTradingHours=true
alertMarket=a
mailboxes=1
digestEnabled=false
digestIntervalMin=30
;  ↓↓↓ 在这里写标的，一行一个，例如：600519 贵州茅台 / 000001 / hk00981 ↓↓↓
;  600519 贵州茅台
;  000001 平安银行
;  ↑↑↑ 以 ";" 开头的是注释，不会当作标的 ↑↑↑
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
  tradingHours: true,    // 仅开盘时段提醒（默认开启，周末除外）
  market: 'a',           // 提醒市场：a(A股) / hk(港股) / both(A股+港股)
};

// ---------- 邮件推送配置（全局：发件账号 + 1~5 个收件邮箱槽位）----------
// 收件人做成 1~5 个「槽位」：每个槽位 = 地址 + 启用开关；
// 每个监控列表再用 mailboxes=[槽位号] 选择自己发给哪几个 —— 不同列表可以发给不同的人。
// 发件账号（SMTP 服务器/账号/授权码）全局只有一个，不按列表分。
const MAILBOX_MAX = 5;
const DEFAULT_DIGEST_MIN = 30;

const DEFAULT_EMAIL = {
  enabled: false,          // 默认关闭：没填账号授权码前不应产生后台报错
  host: 'smtp.qq.com',
  port: 465,
  secure: true,            // 465 用 SSL 直连；587/25 走 STARTTLS
  user: '',
  pass: '',                // 邮箱授权码（不是登录密码）
  boxes: [                 // 1~5 个收件邮箱槽位（默认只有第 1 个启用）
    { addr: '', on: true }, { addr: '', on: false }, { addr: '', on: false },
    { addr: '', on: false }, { addr: '', on: false },
  ],
  followAlerts: true,      // true = 邮件阈值跟随该列表的异动提醒阈值
  thresholdUp: 3.9,        // followAlerts=false 时生效
  thresholdDown: 3.9,
};

function clampPort(v, fb) {
  const n = parseInt(v, 10);
  return (isFinite(n) && n > 0 && n < 65536) ? n : fb;
}

// 定时汇总间隔：1~1440 分钟，非法值回退默认
function clampDigestMin(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n < 1) return DEFAULT_DIGEST_MIN;
  return Math.min(1440, n);
}

// 收件地址粗校验：有 @ 且域名带点即可（不做严格 RFC 校验，避免误拦企业邮箱自定义域）
function looksLikeMail(s) {
  return /^[^\s@,;，；]+@[^\s@,;，；]+\.[^\s@,;，；]+$/.test(String(s || '').trim());
}

// 槽位去重：同一地址只保留第一个，重复的自动停用（否则同一封信会投两次）。
// 注意：空地址也保留它自己的 on 值 —— 否则「模板里 box1 启用」这类默认值会被抹掉，
// 用户填完地址却发现槽位是未启用状态。空地址本来就不会被选进收件人，留着 on 无副作用。
function dedupeBoxes(boxes) {
  const seen = new Set();
  return (boxes || []).map((b) => {
    const addr = String((b && b.addr) || '').trim();
    if (!addr) return { addr: '', on: !!(b && b.on) };
    const key = addr.toLowerCase();
    if (seen.has(key)) return { addr, on: false };
    seen.add(key);
    return { addr, on: !!(b && b.on) };
  });
}

// 已勾选且格式合法的收件地址（真正会写进 RCPT TO 的那些）
function activeBoxAddrs(m) {
  const e = m || DEFAULT_EMAIL;
  return (e.boxes || [])
    .filter(b => b && b.on && looksLikeMail(b.addr))
    .map(b => String(b.addr).trim());
}

// 槽位序号（1 起）→ 地址列表；列表未选任何槽位时返回空数组（= 该列表不投递）
function boxAddrsByIndex(m, idxList) {
  const e = m || DEFAULT_EMAIL;
  const out = [];
  for (const i of (idxList || [])) {
    const b = (e.boxes || [])[i - 1];
    if (b && b.on && looksLikeMail(b.addr)) out.push(String(b.addr).trim());
  }
  return [...new Set(out)];
}

function normalizeEmail(raw) {
  const r = raw || {};
  const bool = (v, fb) => (v === undefined || v === '' ? fb : (String(v) !== 'false'));
  const host = String(r['host'] || '').trim() || DEFAULT_EMAIL.host;
  const port = clampPort(r['port'], DEFAULT_EMAIL.port);
  // 没写 secure 时按端口推断：465 = SSL 直连，其余 = STARTTLS / 明文
  const secure = (r['secure'] === undefined || r['secure'] === '')
    ? (port === 465)
    : (String(r['secure']) !== 'false');
  const up = clampTh(r['thresholdUp']);
  const down = clampTh(r['thresholdDown']);

  // 槽位：优先取 box1~box5 / on1~on5（INI 形态），其次取 boxes 数组（设置页 IPC 形态）
  let boxes;
  if (Array.isArray(r.boxes)) {
    boxes = [];
    for (let i = 0; i < MAILBOX_MAX; i++) {
      const b = r.boxes[i] || {};
      boxes.push({ addr: String(b.addr || '').trim(), on: !!b.on });
    }
  } else {
    boxes = [];
    for (let i = 1; i <= MAILBOX_MAX; i++) {
      boxes.push({
        addr: String(r['box' + i] || '').trim(),
        on: bool(r['on' + i], i === 1),
      });
    }
    // 旧版单个 to= 逗号列表：按顺序灌进槽位，升级后行为不变
    const legacyTo = String(r['to'] || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
    if (legacyTo.length && !boxes.some(b => b.addr)) {
      for (let i = 0; i < Math.min(legacyTo.length, MAILBOX_MAX); i++) {
        boxes[i] = { addr: legacyTo[i], on: true };
      }
    }
  }

  return {
    enabled: bool(r['enabled'], DEFAULT_EMAIL.enabled),
    host,
    port,
    secure,
    user: String(r['user'] || '').trim(),
    pass: String(r['pass'] || ''),
    boxes: dedupeBoxes(boxes),
    followAlerts: bool(r['followAlerts'], DEFAULT_EMAIL.followAlerts),
    thresholdUp: up !== null ? up : DEFAULT_EMAIL.thresholdUp,
    thresholdDown: down !== null ? down : DEFAULT_EMAIL.thresholdDown,
  };
}

// ---------- 大盘指数预设 ----------
// 指数代码必须带前缀：纯 000001 会被识别成平安银行(sz000001)，所以一律写全。
// 腾讯财经对指数的字段布局与个股完全一致（31=涨跌 32=涨跌幅），可共用解析。
const INDEX_PRESETS = [
  { symbol: 'sh000001', name: '上证指数' },
  { symbol: 'sz399001', name: '深证成指' },
  { symbol: 'sz399006', name: '创业板指' },
  { symbol: 'sh000300', name: '沪深300' },
  { symbol: 'sh000905', name: '中证500' },
  { symbol: 'sh000688', name: '科创50' },
  { symbol: 'hkHSI',    name: '恒生指数' },
];

function indexName(sym) {
  const key = String(sym || '').toLowerCase();
  const hit = INDEX_PRESETS.find(x => x.symbol.toLowerCase() === key);
  return hit ? hit.name : sym;
}

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
    market: ['a', 'hk', 'both'].includes((r['market'] || '').toLowerCase()) ? String(r['market']).toLowerCase() : DEFAULT_ALERTS.market,
  };
}

// ---------- 监控列表 ----------
// 每个列表 = 一个独立悬浮窗口，各自拥有标的 / 外观 / 提醒阈值 / 收件邮箱 / 定时汇总。
// 内部结构里窗口几何参数是"平"的（width/height/opacity/...），只有 alerts / mail 嵌套，
// 因为这两个对象会被 evalAlerts / 邮件模块整体复用。
const LIST_WIN_DEFAULTS = {
  width: 220, height: 84, topMost: true,
  opacity: 1.0, textOpacity: 1.0, mono: false,
  displayMode: 'scroll', scrollMs: 3000, jumpMs: 3000,
  position: { x: 0, y: 0 }, visible: true,
};

const DEFAULT_LIST_MAIL = {
  mailboxes: [1],            // 默认投到第 1 个收件槽位
  digestEnabled: false,
  digestIntervalMin: DEFAULT_DIGEST_MIN,
};

// 列表数量上限：窗口太多既挤屏幕也容易误操作，给个明确上限
const LIST_MAX = 6;

// 代码行归一化（INI 的标的行 / 设置页新增标的都走这里）
// 支持 "600519" / "sh600519" / "hk00981" / "600519 贵州茅台"
function normalizeSymbolLine(line) {
  const parts = String(line == null ? '' : line).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  let sym = parts[0].toLowerCase();
  const name = parts.slice(1).join(' ');
  // hk 前缀 = 港股：位数不足 5 位自动补零（hk981 → hk00981）
  if (/^hk\d{1,5}$/.test(sym)) {
    sym = 'hk' + sym.slice(2).padStart(5, '0');
  // 纯 6 位数字 → 自动加 sh/sz 前缀（A股/基金/可转债）
  } else if (/^\d{6}$/.test(sym)) {
    const h = sym[0];
    if (h === '6' || h === '9' || h === '5') sym = 'sh' + sym;                    // 沪 A股/基金
    else if (sym.indexOf('11') === 0) sym = 'sh' + sym;                            // 沪可转债
    else if (h === '0' || h === '2' || h === '3') sym = 'sz' + sym;                // 深 A股
    else if (sym.indexOf('12') === 0 || sym.indexOf('15') === 0 ||
             sym.indexOf('16') === 0 || sym.indexOf('18') === 0) sym = 'sz' + sym; // 深可转债/基金
  // 纯 5 位 = 港股（A 股代码一律 6 位）
  } else if (/^\d{5}$/.test(sym)) {
    sym = 'hk' + sym;
  }
  if (!sym) return null;
  return { symbol: sym, name: name || sym };
}

// 列表的邮件路由：mailboxes 是「[email] 收件槽位序号」数组（1 起）。
// 三种情况要分清楚（关系到"列表不发给任何人"这个选择能不能存住）：
//   键没写过 / 传 undefined  → 默认 [1]（老配置升级后行为不变）
//   显式写空（"" 或 []）      → 保留空数组 = 这个列表不发邮件（否则重启后被悄悄改回 [1]）
//   有值                     → 解析成有序去重的槽位号
function normalizeMail(raw) {
  const r = raw || {};
  const bool = (v, fb) => (v === undefined || v === '' ? fb : (String(v) !== 'false'));
  const src = r.mailboxes;
  let arr;
  if (src === undefined || src === null) {
    arr = [...DEFAULT_LIST_MAIL.mailboxes];
  } else if (Array.isArray(src)) {
    arr = src.map(x => parseInt(x, 10));
  } else if (String(src).trim() === '') {
    arr = [];
  } else {
    arr = String(src).split(/[,，;；\s]+/).map(x => parseInt(x, 10));
  }
  arr = [...new Set(arr.filter(n => isFinite(n) && n >= 1 && n <= MAILBOX_MAX))].sort((a, b) => a - b);
  return {
    mailboxes: arr,
    digestEnabled: bool(r.digestEnabled, DEFAULT_LIST_MAIL.digestEnabled),
    digestIntervalMin: clampDigestMin(r.digestIntervalMin),
  };
}

// 单个列表归一化。入参是"平铺"形态：INI 解出来的 { key: '字符串' }，
// 或设置页 IPC 传来的同名字段对象（值可能是数字/布尔/数组）——两种都能吃。
function normalizeList(raw, id, fallbackName) {
  const r = raw || {};
  const has = (k) => r[k] !== undefined && r[k] !== '';
  const num = (k, d, lo, hi) => {
    const v = parseInt(r[k], 10);
    return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  };
  const flt = (k, d, lo, hi) => {
    const v = parseFloat(r[k]);
    return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  };
  const bool = (k, d) => (has(k) ? String(r[k]) !== 'false' : d);

  const symbols = (Array.isArray(r.symbols) ? r.symbols : []).map((s) => {
    if (typeof s === 'string') return normalizeSymbolLine(s);
    const sym = String((s && s.symbol) || '').trim();
    if (!sym) return null;
    const nm = String((s && s.name) || '').trim();
    return { symbol: sym, name: nm || sym };
  }).filter(Boolean);

  const posX = r['position-x'] !== undefined ? r['position-x']
    : (r.position ? r.position.x : undefined);
  const posY = r['position-y'] !== undefined ? r['position-y']
    : (r.position ? r.position.y : undefined);
  const nested = r.alerts || {};
  const nestedMail = r.mail || {};

  // 旧版单列表配置里的 rotationMs：仅当 scrollMs/jumpMs 缺失时兜底
  const legacyRot = () => {
    const v = parseInt(r['rotationMs'], 10);
    return isFinite(v) ? v : undefined;
  };

  return {
    id,
    name: String(r.name || '').trim() || fallbackName || id,
    symbols,
    width: num('width', LIST_WIN_DEFAULTS.width, 160, 480),
    height: num('height', LIST_WIN_DEFAULTS.height, 60, 600),
    topMost: bool('topMost', LIST_WIN_DEFAULTS.topMost),
    opacity: flt('opacity', LIST_WIN_DEFAULTS.opacity, 0.05, 1.0),
    textOpacity: flt('textOpacity', LIST_WIN_DEFAULTS.textOpacity, 0.05, 1.0),
    mono: bool('mono', LIST_WIN_DEFAULTS.mono),
    displayMode: r.displayMode === 'jump' ? 'jump'
      : (r.displayMode === 'scroll' ? 'scroll' : LIST_WIN_DEFAULTS.displayMode),
    scrollMs: num('scrollMs', legacyRot() !== undefined ? legacyRot() : LIST_WIN_DEFAULTS.scrollMs, 800, 15000),
    jumpMs: num('jumpMs', legacyRot() !== undefined ? legacyRot() : LIST_WIN_DEFAULTS.jumpMs, 1000, 20000),
    position: {
      x: parseInt(posX, 10) || 0,
      y: parseInt(posY, 10) || 0,
    },
    visible: bool('visible', LIST_WIN_DEFAULTS.visible),
    alerts: normalizeAlerts({
      enabled: r.alertEnabled, thresholdUp: r.alertUp, thresholdDown: r.alertDown,
      direction: r.alertDirection, sound: r.alertSound, cooldownMs: r.alertCooldownMs,
      tradingHours: r.alertTradingHours, market: r.alertMarket,
      ...nested,
    }),
    mail: normalizeMail({
      mailboxes: r.mailboxes !== undefined ? r.mailboxes : nestedMail.mailboxes,
      digestEnabled: r.digestEnabled !== undefined ? r.digestEnabled : nestedMail.digestEnabled,
      digestIntervalMin: r.digestIntervalMin !== undefined ? r.digestIntervalMin : nestedMail.digestIntervalMin,
    }),
  };
}

// 按 id 取列表；找不到返回 null
function getList(id) {
  return (store.lists || []).find(l => l.id === id) || null;
}

// 生成一个不冲突的列表 id：l1 / l2 / ...
function nextListId(lists) {
  const used = new Set((lists || []).map(l => l.id));
  let n = 1;
  while (used.has('l' + n)) n++;
  return 'l' + n;
}

// 新建列表时的默认外观：位置留空（0,0），创建窗口时会自动找空位避开已有窗口
function makeList(lists, name) {
  const id = nextListId(lists);
  return normalizeList({
    name: name || ('列表 ' + ((lists || []).length + 1)),
    symbols: [],
  }, id, name);
}

// ---------- 配置解析 ----------
// 把「一段 INI 的行」转成 { key: value } 平铺表（不含 "=" 的行直接忽略）
function flatSection(lines) {
  const out = {};
  for (const line of (lines || [])) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// 旧版单列表配置 → 多列表。
// 旧 [stocks] → 列表 l1「自选股」；旧 [indexes] → 列表 l2「大盘指数」（非空时才建）。
// 旧 [widget] / [alerts] 的外观与提醒原样继承给两个列表；
// l2 的位置置零，由窗口创建时自动找空位，避免和 l1 完全重叠。
function migrateLegacy(sections) {
  const cfg = flatSection(sections['widget']);
  const ac = flatSection(sections['alerts']);
  const em = flatSection(sections['email']);
  const baseWin = {
    width: cfg['width'], height: cfg['height'], topMost: cfg['topMost'],
    opacity: cfg['opacity'], textOpacity: cfg['textOpacity'], mono: cfg['mono'],
    displayMode: cfg['displayMode'], scrollMs: cfg['scrollMs'], jumpMs: cfg['jumpMs'],
    rotationMs: cfg['rotationMs'],
    'position-x': cfg['position-x'], 'position-y': cfg['position-y'],
  };
  const baseAlerts = {
    alertEnabled: ac['enabled'], alertUp: ac['thresholdUp'], alertDown: ac['thresholdDown'],
    alertDirection: ac['direction'], alertSound: ac['sound'], alertCooldownMs: ac['cooldownMs'],
    alertTradingHours: ac['tradingHours'], alertMarket: ac['market'],
  };
  // v1.4.x 的定时汇总是「全局一封」（把自选股 + 大盘指数合成一封）。
  // 1.5.0 起汇总改为按列表走，这里把老设置原样继承给列表 1 —— 用户在升级后
  // 仍然会按时收到一封汇总（内容是该列表的标的），而不是被悄悄关掉。
  const legacyDigest = {
    digestEnabled: em['digestEnabled'],
    digestIntervalMin: em['digestIntervalMin'],
  };
  const stocks = (sections['stocks'] || []).map(normalizeSymbolLine).filter(Boolean);
  const indexes = (sections['indexes'] || []).map((line) => {
    const s = normalizeSymbolLine(line);
    if (!s) return null;
    return { symbol: s.symbol, name: s.name === s.symbol ? indexName(s.symbol) : s.name };
  }).filter(Boolean);

  const lists = [normalizeList({ ...baseWin, ...baseAlerts, ...legacyDigest, symbols: stocks }, 'l1', '自选股')];
  if (indexes.length) {
    const l2 = normalizeList({ ...baseWin, ...baseAlerts, symbols: indexes }, 'l2', '大盘指数');
    l2.position = { x: 0, y: 0 };
    lists.push(l2);
  }
  return { lists, email: normalizeEmail(flatSection(sections['email'])) };
}

// 解析一份配置文本 → { lists, fetchIntervalMs, email, legacy }
// 首次运行写模板后也会走这里，保证「代码默认值」与「模板」永远是同一套。
function parseConfigText(rawText) {
  const sections = parseIni(rawText);
  const general = flatSection(sections['general']);
  const listKeys = Object.keys(sections).filter(k => /^list:/.test(k));
  let lists = [];
  let email;
  let legacy = false;

  if (listKeys.length) {
    lists = listKeys.map((key) => {
      const id = key.slice(5).trim() || 'l1';
      const rows = sections[key] || [];
      const flat = flatSection(rows);
      // 不含 "=" 的行 = 标的
      const syms = rows.filter(l => l.indexOf('=') === -1).map(normalizeSymbolLine).filter(Boolean);
      return normalizeList({ ...flat, symbols: syms }, id, '列表');
    });
    email = normalizeEmail(flatSection(sections['email']));
  } else {
    const m = migrateLegacy(sections);
    lists = m.lists;
    email = m.email;
    legacy = true;
  }

  if (!lists.length) lists = [makeList([], '自选股')];
  return {
    lists: lists.slice(0, LIST_MAX),
    fetchIntervalMs: Math.max(5000, Math.min(300000, parseInt(general['fetchIntervalMs'], 10) || 30000)),
    email,
    legacy,
  };
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const rawText = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = parseConfigText(rawText);
      if (parsed.legacy) {
        // 旧版配置：原文件另存一份，方便用户回退到旧版本时不丢配置
        try { fs.writeFileSync(CONFIG_PATH + '.legacy', rawText, 'utf8'); } catch (_) {}
      }
      return parsed;
    } catch (e) { logErr('loadConfig', e); }
  }
  // 首次运行：写模板，并按模板解析出默认配置
  try { fs.writeFileSync(CONFIG_PATH, INI_TEMPLATE, 'utf8'); } catch (_) {}
  return parseConfigText(INI_TEMPLATE);
}

// 写回 config.ini。格式：[general] + [email] + 每个列表一个 [list:xx] 段，
// 段内先写 key=value 设置，最后写标的行（不含 "=" 的行即标的）。
function saveConfig() {
  try {
    const lines = [];
    lines.push('; ==================================================');
    lines.push(';  Marketmonitor 配置  (此文件由程序自动生成/更新)');
    lines.push(';  [general]  通用；[email]  全局邮件（含 box1~box5 收件槽位）');
    lines.push(';  [list:xx]  每个列表一个段：不含 "=" 的行 = 标的，含 "=" 的行 = 该列表设置');
    lines.push(';  字段含义详见首次运行生成的完整注释版，或仓库 README');
    lines.push('; ==================================================');
    lines.push('');
    lines.push('[general]');
    lines.push('fetchIntervalMs=' + (store.fetchIntervalMs || 30000));
    lines.push('');
    const m = store.email || DEFAULT_EMAIL;
    lines.push('[email]');
    lines.push('enabled=' + (m.enabled ? 'true' : 'false'));
    lines.push('host=' + (m.host || DEFAULT_EMAIL.host));
    lines.push('port=' + (m.port || DEFAULT_EMAIL.port));
    lines.push('secure=' + (m.secure ? 'true' : 'false'));
    lines.push('user=' + (m.user || ''));
    lines.push('pass=' + (m.pass || ''));
    for (let i = 1; i <= MAILBOX_MAX; i++) {
      const b = (m.boxes || [])[i - 1] || { addr: '', on: false };
      lines.push('box' + i + '=' + (b.addr || ''));
      lines.push('on' + i + '=' + (b.on ? 'true' : 'false'));
    }
    lines.push('followAlerts=' + (m.followAlerts !== false ? 'true' : 'false'));
    lines.push('thresholdUp=' + (m.thresholdUp ?? DEFAULT_EMAIL.thresholdUp));
    lines.push('thresholdDown=' + (m.thresholdDown ?? DEFAULT_EMAIL.thresholdDown));
    lines.push('');
    for (const l of (store.lists || [])) {
      lines.push('[list:' + l.id + ']');
      // 名字里若有换行会破坏 INI 结构，先压平
      lines.push('name=' + String(l.name || l.id).replace(/[\r\n]+/g, ' '));
      lines.push('width=' + l.width);
      lines.push('height=' + l.height);
      lines.push('topMost=' + (l.topMost ? 'true' : 'false'));
      lines.push('opacity=' + l.opacity);
      lines.push('textOpacity=' + (l.textOpacity ?? 1.0));
      lines.push('mono=' + (l.mono ? 'true' : 'false'));
      lines.push('displayMode=' + (l.displayMode || 'scroll'));
      lines.push('scrollMs=' + (l.scrollMs ?? 3000));
      lines.push('jumpMs=' + (l.jumpMs ?? 3000));
      lines.push('position-x=' + (l.position?.x || 0));
      lines.push('position-y=' + (l.position?.y || 0));
      lines.push('visible=' + (l.visible ? 'true' : 'false'));
      const a = l.alerts || DEFAULT_ALERTS;
      lines.push('alertEnabled=' + (a.enabled ? 'true' : 'false'));
      lines.push('alertUp=' + (a.thresholdUp ?? DEFAULT_ALERTS.thresholdUp));
      lines.push('alertDown=' + (a.thresholdDown ?? DEFAULT_ALERTS.thresholdDown));
      lines.push('alertDirection=' + a.direction);
      lines.push('alertSound=' + (a.sound ? 'true' : 'false'));
      lines.push('alertCooldownMs=' + a.cooldownMs);
      lines.push('alertTradingHours=' + (a.tradingHours ? 'true' : 'false'));
      lines.push('alertMarket=' + (['a', 'hk', 'both'].includes(a.market) ? a.market : 'a'));
      lines.push('mailboxes=' + ((l.mail?.mailboxes || []).join(',')));
      lines.push('digestEnabled=' + (l.mail?.digestEnabled ? 'true' : 'false'));
      lines.push('digestIntervalMin=' + (l.mail?.digestIntervalMin ?? DEFAULT_DIGEST_MIN));
      for (const s of (l.symbols || [])) {
        lines.push(s.symbol + (s.name && s.name !== s.symbol ? ' ' + s.name : ''));
      }
      lines.push('');
    }
    fs.writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf8');
  } catch (e) { logErr('saveConfig', e); }
}

const store = loadConfig();
// 旧版单列表配置已迁移：立刻按新格式落盘一次（原文件已备份为 config.ini.legacy）
if (store.legacy) { delete store.legacy; saveConfig(); }

let settingsWindow = null;
let tray = null;
let fetchTimer = null;
let lastQuotes = [];

// ---------- 小组件窗口注册表 ----------
// v1.5.0 起每个监控列表拥有自己的悬浮窗口。用 listId -> BrowserWindow 管理，
// 再用 winListId 反向查"这个窗口属于哪个列表"（IPC 里靠 event.sender 拿到窗口）。
const widgetWindows = new Map();     // listId -> BrowserWindow
const winListId = new Map();         // BrowserWindow -> listId
let posSaveTimer = null;             // 拖动写盘防抖

// 遍历所有存活的小组件窗口
function eachWidget(fn) {
  for (const [id, w] of [...widgetWindows]) {
    if (w && !w.isDestroyed()) { try { fn(w, id); } catch (e) { logErr('eachWidget', e); } }
  }
}

// 广播：透明度 / 黑白 / 显示方式这类"所有窗口一起变"的消息
function broadcast(channel, ...args) {
  eachWidget((w) => { try { w.webContents.send(channel, ...args); } catch (_) {} });
}

// 只发给某个列表的窗口
function sendToList(listId, channel, ...args) {
  const w = widgetWindows.get(listId);
  if (w && !w.isDestroyed()) { try { w.webContents.send(channel, ...args); } catch (_) {} }
}

// 由窗口对象反查所属列表
function listOfWindow(w) {
  const id = w ? winListId.get(w) : null;
  return id ? getList(id) : null;
}

// 由 IPC 事件反查列表（发送方窗口所属的列表）
function listOfEvent(e) {
  try { return listOfWindow(BrowserWindow.fromWebContents(e.sender)); } catch (_) { return null; }
}

// 从最近一次全量行情里，挑出属于某个列表的标的（保持列表内的录入顺序）。
// 多列表共用一次行情请求，各窗口/各通道只消费自己那一份。
function quotesForList(l) {
  if (!l || !Array.isArray(lastQuotes)) return [];
  const want = new Map((l.symbols || []).map(s => [String(s.symbol).toLowerCase(), s]));
  const out = [];
  for (const q of lastQuotes) {
    if (!q || !q.symbol) continue;
    if (want.has(String(q.symbol).toLowerCase())) out.push(q);
  }
  return out;
}

// ---------- 异动提醒引擎 ----------
// alertState: symbol -> { ts, pct }  用于去刷屏（冷却期 + 数值未变化不重复提醒）
const alertState = new Map();

// ---------- 各市场连续竞价时段（均为 UTC+8，与本地时区无关，保证 CI/任意时区行为一致）----------
// A股：周一~五，上午 09:25–11:35（含集合竞价）、下午 12:55–15:05（含尾盘收盘前后），与小组件"交易中"标识一致
const A_SHARE_HOURS = [[925, 1135], [1255, 1505]];
// 港股：周一~五，上午 09:00–12:00（含开盘前竞价）、下午 13:00–16:00（含收盘后短暂缓冲）
const HK_SHARE_HOURS = [[900, 1200], [1300, 1605]];
function inWindows(hm, windows) {
  for (const [lo, hi] of windows) if (hm >= lo && hm <= hi) return true;
  return false;
}

/**
 * 纯函数：某时刻是否处于指定市场开盘时段。
 * @param d Date
 * @param market 'a'(A股,默认) / 'hk'(港股) / 'both'(A股+港股)
 */
function isInTradingHours(d, market) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return false;
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);   // 换算成北京时间（与港股同为 UTC+8）
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return false;               // 周末不开市
  const hm = bj.getUTCHours() * 100 + bj.getUTCMinutes();
  const m = market || 'a';
  if (m === 'a') return inWindows(hm, A_SHARE_HOURS);
  if (m === 'hk') return inWindows(hm, HK_SHARE_HOURS);
  if (m === 'both') return inWindows(hm, A_SHARE_HOURS) || inWindows(hm, HK_SHARE_HOURS);
  return inWindows(hm, A_SHARE_HOURS);
}

/**
 * 纯函数：按配置判定一批行情中哪些触发异动。
 * 规则：|涨跌幅| >= threshold，且方向匹配；同一只在 cooldownMs 内不重复；数值未变化不重复。
 * 额外：tradingHours(默认 true) 时，仅在 A 股开盘时段内提醒，其余时段静默。
 * @param state 可选：冷却状态表。本机提醒用默认的 alertState，
 *              邮件推送传入独立的 mailAlertState —— 两条通道的阈值/冷却互不干扰。
 */
function evalAlerts(quotes, cfg, now, state) {
  const out = [];
  const st = state || alertState;
  const ts = now == null ? Date.now() : now;
  if (!cfg || !cfg.enabled || !Array.isArray(quotes)) return out;
  // 仅开盘时段提醒：非成交时段（北京时间，按所选市场 A股/港股）整体静默，避免收盘后/夜间/周末仍轰炸
  if (cfg.tradingHours !== false && !isInTradingHours(new Date(ts), cfg.market)) return out;
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
    const prev = st.get(q.symbol);
    if (prev) {
      if (ts - prev.ts < cooldown) continue;       // 冷却期内静默
      if (prev.pct === pct) continue;              // 数值没变化，不重复打扰
    }
    st.set(q.symbol, { ts, pct });
    out.push({
      symbol: q.symbol,
      name: q.name || q.symbol,
      price: q.price || 0,
      changePct: pct,
      up,
      threshold: up ? thUp : thDown,   // 供邮件正文回显"按哪个阈值触发的"
    });
  }
  return out;
}

// 按列表隔离的状态表：同一个 symbol 同时出现在两个列表时，各自的冷却/去重互不干扰。
// evalAlerts 只用到 get/set，包一层即可，不必改它的实现。
function stateFor(map, listId) {
  const key = (sym) => listId + '\u0000' + sym;
  return {
    get: (sym) => map.get(key(sym)),
    set: (sym, v) => map.set(key(sym), v),
  };
}

// 触发一次提醒：系统通知 + 推送到【该列表】的小组件（提示音 / 闪烁 / 弹窗）
function fireAlert(a, list) {
  const l = list || null;
  const arrow = a.up ? '📈' : '📉';
  const sign = a.up ? '+' : '';
  const title = `${arrow} 异动提醒 · ${a.name}`;
  const body = `${a.symbol}  ${Number(a.price).toFixed(2)}  ${sign}${a.changePct.toFixed(2)}%`;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        silent: !(l && l.alerts && l.alerts.sound),
      });
      n.on('click', () => {
        const w = l ? widgetWindows.get(l.id) : null;
        if (w && !w.isDestroyed()) { w.show(); w.focus(); }
      });
      n.show();
    }
  } catch (_) {}
  if (l) sendToList(l.id, 'alert', a);
  console.log('[alert]', l ? l.id : '-', title, body);
}

function checkAlerts(quotes, list) {
  if (!list) return [];
  const hits = evalAlerts(quotes, list.alerts, Date.now(), stateFor(alertState, list.id));
  for (const a of hits) fireAlert(a, list);
  return hits;
}

// ---------- 邮件推送 ----------
// 设计要点：
//   1) 零依赖：自己实现最小 SMTP 客户端（EHLO / STARTTLS / AUTH LOGIN / MAIL / RCPT / DATA），
//      不引入 nodemailer —— 避免往 app.asar 里塞 node_modules，热部署链路保持"只替换 js 文件"。
//   2) 独立阈值：默认跟随 [alerts]（followAlerts=true），也可单独设置。
//   3) 独立冷却：mailAlertState 与 alertState 分开，同一只股票的"本机提醒"和"邮件"互不吞掉。
//   4) 异步串行发送，失败只写 error.log / maillog.txt，绝不影响行情刷新主循环。
const nodeNet = require('net');
const nodeTls = require('tls');

const mailAlertState = new Map();
let mailQueue = Promise.resolve();

// 发件账号是否可用（全局唯一：SMTP 服务器 / 账号 / 授权码，多列表共用同一个发件人）
function mailCfgReady() {
  const e = store.email || DEFAULT_EMAIL;
  return !!(e.enabled && e.host && e.user && e.pass);
}

// 某个列表能否真的发信 = 发件账号可用 + 该列表至少选中了一个有效收件槽位
function mailReadyForList(list) {
  if (!mailCfgReady() || !list) return false;
  return mailToList(list).length > 0;
}

// 该列表的收件人（按它自己选的槽位，取已启用且格式合法的地址）
function mailToList(list) {
  const idx = (list && list.mail && list.mail.mailboxes) || [];
  return boxAddrsByIndex(store.email || DEFAULT_EMAIL, idx);
}

// 邮件判定配置：followAlerts=true 时阈值/方向/冷却/开盘时段全部跟随【该列表】的异动提醒
function buildMailAlertCfg(list) {
  if (!mailReadyForList(list)) return null;
  const e = store.email;
  const a = (list && list.alerts) || DEFAULT_ALERTS;
  return {
    enabled: true,
    thresholdUp: e.followAlerts !== false ? a.thresholdUp : e.thresholdUp,
    thresholdDown: e.followAlerts !== false ? a.thresholdDown : e.thresholdDown,
    direction: a.direction,
    cooldownMs: a.cooldownMs,
    tradingHours: a.tradingHours,
    market: a.market,
  };
}

// base64 按 76 字符折行（SMTP 行长限制）
function base64Wrap(s) {
  const b = Buffer.from(String(s), 'utf8').toString('base64');
  const out = [];
  for (let i = 0; i < b.length; i += 76) out.push(b.slice(i, i + 76));
  return out;
}

// 组装 RFC5322 报文。
// 带 html 时用 multipart/alternative（纯文本在前、HTML 在后，客户端自动选"最丰富"的那段显示），
// 不带 html 就是原来的纯文本单段。中文主题一律 RFC2047 编码，正文 base64 按 76 折行。
// 注：base64 字母表里没有 '.'，因此正文不会出现行首 "." 的问题，无需 dot-stuffing。
function buildMailMessage({ from, to, subject, text, html }) {
  const head = [
    'From: "Marketmonitor" <' + from + '>',
    'To: ' + to.join(','),
    // 主题含中文必须做 RFC2047 编码，否则收件箱里是乱码
    'Subject: =?UTF-8?B?' + Buffer.from(String(subject), 'utf8').toString('base64') + '?=',
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
  ];
  if (!html) {
    return head.concat([
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
    ]).concat(base64Wrap(text)).join('\r\n');
  }
  const B = '=_mm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const out = head.concat([
    'Content-Type: multipart/alternative; boundary="' + B + '"',
    '',
    '--' + B,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
  ]);
  out.push(...base64Wrap(text));
  out.push('', '--' + B);
  out.push('Content-Type: text/html; charset=UTF-8');
  out.push('Content-Transfer-Encoding: base64');
  out.push('');
  out.push(...base64Wrap(html));
  out.push('', '--' + B + '--', '');
  return out.join('\r\n');
}

// ---------- 邮件 HTML 模板 ----------
// 涨红跌绿（A 股惯例）。邮件客户端大多不认 <style> 标签，所以样式必须全部内联；
// 布局用 table + 百分比宽度，保证手机上是竖排卡片、不需要横向滚动。
const MAIL_C_UP = '#d93025', MAIL_C_DOWN = '#0f9d58', MAIL_C_FLAT = '#8a94a6';
const MAIL_BG_UP = '#fdecea', MAIL_BG_DOWN = '#e7f5ec', MAIL_BG_FLAT = '#f2f4f7';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 按涨跌取色 / 取底色
function pctColor(pct) { return pct > 0 ? MAIL_C_UP : (pct < 0 ? MAIL_C_DOWN : MAIL_C_FLAT); }
function pctBg(pct) { return pct > 0 ? MAIL_BG_UP : (pct < 0 ? MAIL_BG_DOWN : MAIL_BG_FLAT); }

/**
 * 汇总邮件 HTML 版。入参：
 *   title/subtitle  标题与时间副标题
 *   rows            [{ name, code, price, pct }]
 *   counts          { up, down, flat }
 *   subtitleExtra   可选：附加说明（如"列表：自选股"）
 */
function buildDigestHtml({ title, subtitle, rows, counts }) {
  const tdL = 'padding:9px 12px;border-bottom:1px solid #eef0f3;vertical-align:middle;';
  const tdR = tdL + 'text-align:right;white-space:nowrap;';
  const body = rows.map((r) => {
    const c = pctColor(r.pct);
    const bg = pctBg(r.pct);
    const sign = r.pct > 0 ? '+' : '';
    return '<tr>'
      + '<td style="' + tdL + '">'
      + '<div style="font-size:15px;font-weight:600;color:#1f2430;line-height:1.3;">' + escHtml(r.name) + '</div>'
      + '<div style="font-size:11px;color:#9aa4b2;font-family:Consolas,Menlo,monospace;line-height:1.4;">' + escHtml(r.code) + '</div>'
      + '</td>'
      + '<td style="' + tdR + '">'
      + '<div style="font-size:15px;font-weight:600;color:#1f2430;font-family:Consolas,Menlo,monospace;line-height:1.3;">'
      + r.price.toFixed(2) + '</div>'
      + '<div style="display:inline-block;margin-top:2px;padding:1px 7px;border-radius:6px;font-size:12px;font-weight:700;'
      + 'color:' + c + ';background:' + bg + ';font-family:Consolas,Menlo,monospace;">' + sign + r.pct.toFixed(2) + '%</div>'
      + '</td>'
      + '</tr>';
  }).join('');

  // 顶部涨跌概览条：三段色块按比例分配宽度
  const total = Math.max(1, rows.length);
  const seg = (n, color, label) => (n > 0
    ? '<td style="width:' + (n / total * 100).toFixed(2) + '%;background:' + color + ';padding:7px 0;'
      + 'text-align:center;color:#fff;font-size:12px;font-weight:700;">' + label + ' ' + n + '</td>'
    : '');
  const overview = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
    + 'style="border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:8px;">'
    + '<tr>' + seg(counts.up, MAIL_C_UP, '涨') + seg(counts.flat, MAIL_C_FLAT, '平') + seg(counts.down, MAIL_C_DOWN, '跌') + '</tr>'
    + '</table>';

  return [
    '<!DOCTYPE html><html><head>',
    '<meta charset="UTF-8">',
    // 手机端：按设备宽度渲染，避免整页被缩放成"能左右滑的小字"
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '</head>',
    '<body style="margin:0;padding:0;background:#f5f6f8;">',
    '<div style="max-width:600px;margin:0 auto;padding:14px 12px 24px;'
    + 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;'
    + 'color:#1f2430;-webkit-text-size-adjust:100%;">',
    '<div style="background:#ffffff;border-radius:12px;overflow:hidden;'
    + 'box-shadow:0 1px 3px rgba(16,24,40,.06);">',
    '<div style="padding:14px 16px 12px;background:#1f2430;">',
    '<div style="font-size:16px;font-weight:700;color:#ffffff;line-height:1.3;">' + escHtml(title) + '</div>',
    '<div style="margin-top:3px;font-size:12px;color:#aeb8c6;">' + escHtml(subtitle) + '</div>',
    '</div>',
    '<div style="padding:12px 12px 0;">' + overview + '</div>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:10px 0 0;">',
    body,
    '</table>',
    '<div style="padding:11px 14px 14px;font-size:11px;color:#9aa4b2;line-height:1.7;">',
    '由 <b style="color:#64748b;">Marketmonitor</b> 桌面行情小组件定时汇总发送<br>',
    '间隔与收件人可在「设置 → 邮件推送」调整',
    '</div>',
    '</div>',
    '</div>',
    '</body></html>',
  ].join('');
}

/**
 * 最小 SMTP 客户端。支持：
 *   465 → secure=true，直接 TLS；
 *   587/25 → secure=false，若服务器支持 STARTTLS 则先升级再认证（避免明文传授权码）。
 * 返回 Promise，失败时 reject(Error)，错误信息尽量可读（直接告诉用户该改哪里）。
 */
function smtpSend(opts) {
  return new Promise((resolve, reject) => {
    const { host, port, secure, user, pass, from, to, subject, text, html } = opts;
    const TIMEOUT = 20000;
    let sock = null;
    let buf = '';
    let lines = [];
    let stage = 'greet';
    let tlsTried = false;
    let rcptIdx = 0;
    let settled = false;
    const caps = { starttls: false, authLogin: false };

    const timer = setTimeout(() => fail('SMTP 超时（20 秒无响应）：请检查服务器地址 / 端口 / 本机防火墙'), TIMEOUT);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (sock) sock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(true);
    }
    function fail(m) { finish(new Error(m)); }
    function send(line) {
      try { sock.write(line + '\r\n'); } catch (e) { fail('写入失败：' + e.message); }
    }

    function attach(s) {
      s.setEncoding('utf8');
      s.on('data', (chunk) => { buf += chunk; pump(); });
      s.on('error', (e) => fail('网络错误：' + e.message));
      s.on('timeout', () => fail('连接超时'));
      s.on('close', () => { if (!settled && stage !== 'done') fail('连接被服务器提前关闭'); });
    }

    // 按行解析响应；SMTP 多行响应形如 "250-xxx"，第 4 个字符是 '-' 表示还有续行
    function pump() {
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        lines.push(line);
        if (line.length >= 4 && line[3] === '-') continue;
        const code = parseInt(line.slice(0, 3), 10);
        const full = lines.join(' | ');
        lines = [];
        if (settled) return;
        if (!isFinite(code)) continue;
        handle(code, full);
        if (settled) return;
      }
    }

    function handle(code, full) {
      const lower = full.toLowerCase();
      if (code >= 400) {
        return fail('SMTP ' + code + '：' + (full.split(' | ').pop() || '').slice(0, 140));
      }
      switch (stage) {
        case 'greet':
          if (code !== 220) return fail('SMTP 未就绪（' + code + '）');
          stage = 'ehlo';
          return send('EHLO marketmonitor');
        case 'ehlo':
          caps.starttls = /starttls/.test(lower);
          caps.authLogin = /auth[\s\S]*login/.test(lower);
          if (!secure && !tlsTried && caps.starttls) {
            tlsTried = true;
            stage = 'starttls';
            return send('STARTTLS');
          }
          if (!caps.authLogin) return fail('该服务器未提供 AUTH LOGIN 认证方式（可尝试改用 465 端口 + SSL）');
          stage = 'authUser';
          return send('AUTH LOGIN');
        case 'starttls':
          if (code !== 220) return fail('STARTTLS 失败（' + code + '）');
          sock = nodeTls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
            stage = 'ehlo';
            send('EHLO marketmonitor');
          });
          return attach(sock);
        case 'authUser':
          if (code !== 334) return fail('AUTH LOGIN 未被接受（' + code + '）');
          stage = 'authPass';
          return send(Buffer.from(user, 'utf8').toString('base64'));
        case 'authPass':
          if (code !== 334) return fail('AUTH 用户名未被接受（' + code + '）');
          stage = 'authDone';
          return send(Buffer.from(pass, 'utf8').toString('base64'));
        case 'authDone':
          if (code !== 235) {
            return fail('认证失败（' + code + '）：请确认填的是邮箱「授权码」而不是登录密码，并已在邮箱设置里开启 SMTP 服务');
          }
          stage = 'mailFrom';
          return send('MAIL FROM:<' + from + '>');
        case 'mailFrom':
          if (code !== 250) return fail('发件人被拒绝（' + code + '）：' + full.slice(0, 120));
          stage = 'rcpt';
          return send('RCPT TO:<' + to[rcptIdx] + '>');
        case 'rcpt':
          if (code !== 250 && code !== 251) return fail('收件人被拒绝（' + code + '）：' + to[rcptIdx]);
          rcptIdx += 1;
          if (rcptIdx < to.length) return send('RCPT TO:<' + to[rcptIdx] + '>');
          stage = 'data';
          return send('DATA');
        case 'data':
          if (code !== 354) return fail('DATA 未被接受（' + code + '）');
          stage = 'body';
          try { sock.write(buildMailMessage({ from, to, subject, text, html }) + '\r\n.\r\n'); }
          catch (e) { return fail('写正文失败：' + e.message); }
          return;
        case 'body':
          if (code !== 250) return fail('邮件被服务器拒绝（' + code + '）');
          stage = 'done';
          send('QUIT');
          return finish(null);
        default:
          return;
      }
    }

    try {
      sock = secure
        ? nodeTls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : nodeNet.connect({ host, port });
      attach(sock);
    } catch (e) { return fail('无法连接 SMTP：' + e.message); }
  });
}

// 组装邮件内容
function buildAlertMail(a) {
  const sign = a.up ? '+' : '';
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const tstr = bj.toISOString().replace('T', ' ').slice(0, 19);
  const subject = `[Marketmonitor] ${a.name} ${sign}${Number(a.changePct).toFixed(2)}%`;
  const text = [
    `异动提醒：${a.name}（${a.symbol}）${a.up ? '上涨' : '下跌'} ${sign}${Number(a.changePct).toFixed(2)}%`,
    '',
    `名称：${a.name}`,
    `代码：${a.symbol}`,
    `现价：${Number(a.price).toFixed(2)}`,
    `涨跌幅：${sign}${Number(a.changePct).toFixed(2)}%`,
    `触发阈值：${a.threshold != null ? a.threshold + '%' : '（测试邮件）'}`,
    `时间：${tstr}（北京时间）`,
    '',
    '—— 由 Marketmonitor 桌面行情小组件自动发送（阈值可在「设置 → 邮件推送」调整）',
  ].join('\n');
  return { subject, text };
}

function writeMailLog(line) {
  try { fs.appendFileSync(path.join(path.dirname(CONFIG_PATH), 'maillog.txt'), line + '\n', 'utf8'); } catch (_) {}
}

// 排进发送队列：串行执行，单封失败不影响后续
function queueAlertMail(a, list) {
  const e = store.email || DEFAULT_EMAIL;
  const to = mailToList(list);
  if (!to.length) return;
  const mail = buildAlertMail(a);
  const tag = (list && list.name) || (list && list.id) || '-';
  mailQueue = mailQueue
    .then(() => smtpSend({
      host: e.host, port: e.port, secure: e.secure,
      user: e.user, pass: e.pass, from: e.user, to,
      subject: mail.subject, text: mail.text,
    }))
    .then(() => {
      console.log('[mail] 已发送:', mail.subject, '->', to.join(','));
      writeMailLog(`[${new Date().toISOString()}] OK   ${mail.subject} [${tag}] -> ${to.join(',')}`);
    })
    .catch((err) => {
      logErr('sendAlertMail', err);
      writeMailLog(`[${new Date().toISOString()}] FAIL ${mail.subject} [${tag}] -> ${to.join(',')}：${err.message}`);
    });
}

// 每轮行情：用【该列表】的邮件阈值独立判定并推送
function checkEmailAlerts(quotes, list) {
  const cfg = buildMailAlertCfg(list);
  if (!cfg) return [];
  const hits = evalAlerts(quotes, cfg, Date.now(), stateFor(mailAlertState, list.id));
  for (const a of hits) queueAlertMail(a, list);
  return hits;
}

// 设置页「发送测试邮件」：不走冷却与开盘时段限制，直接发一封，返回可读结果。
// 收件人 = 全部已勾选且格式合法的槽位（用来一次性验证所有收件邮箱是否都能收到）。
async function sendTestMail() {
  const e = store.email || DEFAULT_EMAIL;
  if (!mailCfgReady()) {
    return { ok: false, error: '请先填写 SMTP 服务器、账号、授权码，并勾选「启用邮件推送」' };
  }
  const to = activeBoxAddrs(e);
  if (!to.length) {
    return { ok: false, error: '还没有可用的收件邮箱：请在 1~5 号收件槽里填写地址并勾选启用' };
  }
  const demo = (lastQuotes || [])[0] || { symbol: 'sh000001', name: '测试邮件', price: 3000, changePct: 1.23 };
  const pct = parseFloat(demo.changePct) || 1.23;
  const mail = buildAlertMail({
    name: demo.name || demo.symbol,
    symbol: demo.symbol,
    price: demo.price || 0,
    changePct: pct,
    up: pct >= 0,
    threshold: null,
  });
  try {
    await smtpSend({
      host: e.host, port: e.port, secure: e.secure,
      user: e.user, pass: e.pass, from: e.user, to,
      subject: '[测试] ' + mail.subject,
      text: '这是一封来自 Marketmonitor 的测试邮件，收到即表示配置正确。\n\n' + mail.text,
    });
    writeMailLog(`[${new Date().toISOString()}] OK   (测试) -> ${to.join(',')}`);
    return { ok: true, to: to.join(','), count: to.length };
  } catch (err) {
    writeMailLog(`[${new Date().toISOString()}] FAIL (测试) -> ${to.join(',')}：${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------- 邮件定时汇总（digest）----------
// 用户要求：每隔 N 分钟，把"当前全部行情"（自选股 + 大盘指数）汇总成一封邮件发出，开关可选。
// 实现取舍：不另起 setInterval —— 多一个定时器就多一处泄漏/暂停点，
// 直接复用已有的 30s tick，用时间戳判定"到点没到点"即可。
// lastDigestTs 在「开启汇总 / 改间隔」时重置，避免刚打开就立刻收到一封。

// 中文按 2 列宽计算，让纯文本表格在邮件客户端里能对齐
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}
function padEndW(s, n) {
  const str = String(s);
  const w = dispWidth(str);
  return w >= n ? str : str + ' '.repeat(n - w);
}

// 汇总邮件正文：纯文本等宽表格（老客户端兜底）+ HTML 卡片（手机友好、涨红跌绿）
function buildDigestMail(quotes, list) {
  const arr = (quotes || []).filter(q => q && q.symbol);
  if (!arr.length) return null;
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const tstr = bj.toISOString().replace('T', ' ').slice(0, 19);
  const rows = arr.map(q => {
    const pct = parseFloat(q.changePct) || 0;
    return {
      name: String(q.name || q.symbol),
      code: String(q.symbol),
      price: Number(q.price) || 0,
      pct,
    };
  });
  const up = rows.filter(r => r.pct > 0).length;
  const down = rows.filter(r => r.pct < 0).length;
  const flat = rows.length - up - down;

  // ---- 纯文本版：中文按 2 列宽对齐 ----
  const wName = Math.max(8, ...rows.map(r => dispWidth(r.name))) + 2;
  const wCode = Math.max(8, ...rows.map(r => r.code.length)) + 2;
  const body = rows.map(r => {
    const sign = r.pct > 0 ? '+' : '';
    return '  ' + padEndW(r.name, wName) + padEndW(r.code, wCode)
      + padEndW(r.price.toFixed(2), 10) + sign + r.pct.toFixed(2) + '%';
  });
  const lname = String((list && list.name) || '').trim();
  const subject = `[Marketmonitor] ${lname ? lname + ' ' : ''}行情汇总 ${tstr.slice(11, 16)}（${rows.length} 只）`;
  const text = [
    `${lname ? lname + ' ' : ''}行情汇总（北京时间 ${tstr}）`,
    '',
    '  ' + padEndW('名称', wName) + padEndW('代码', wCode) + padEndW('现价', 10) + '涨跌幅',
    '  ' + '-'.repeat(wName + wCode + 16),
    ...body,
    '',
    `共 ${rows.length} 只：上涨 ${up} / 下跌 ${down} / 平盘 ${flat}`,
    '',
    '—— 由 Marketmonitor 桌面行情小组件定时汇总发送（间隔可在「设置 → 邮件推送」调整）',
  ].join('\n');

  // ---- HTML 版：手机友好卡片 ----
  const html = buildDigestHtml({
    title: (lname ? lname + ' · ' : '') + '行情汇总',
    subtitle: `北京时间 ${tstr}　共 ${rows.length} 只`,
    rows,
    counts: { up, down, flat },
  });

  return { subject, text, html };
}

// 每个列表各有一份汇总计时：Map listId -> 上次发送时刻
const digestTs = new Map();

// 重置汇总计时基准（开启/改间隔时调用；不传 id 则全部重置）
function resetDigestTimer(listId) {
  if (listId) digestTs.set(listId, Date.now());
  else digestTs.clear();
}

// tick 内调用：到点就排一封该列表的汇总进队列。返回本次是否真的发出
function checkDigest(quotes, list) {
  if (!list || !mailReadyForList(list)) return false;
  const m = list.mail || DEFAULT_LIST_MAIL;
  if (!m.digestEnabled) return false;
  const now = Date.now();
  const last = digestTs.get(list.id);
  if (!last) { digestTs.set(list.id, now); return false; }   // 首次只对齐时间基准，不立刻发
  const iv = clampDigestMin(m.digestIntervalMin) * 60000;
  if (now - last < iv) return false;
  digestTs.set(list.id, now);
  queueDigestMail(quotes, list);
  return true;
}

function queueDigestMail(quotes, list) {
  const e = store.email || DEFAULT_EMAIL;
  const to = mailToList(list);
  const mail = buildDigestMail(quotes, list);
  if (!to.length || !mail) return;
  const tag = (list && list.name) || '-';
  mailQueue = mailQueue
    .then(() => smtpSend({
      host: e.host, port: e.port, secure: e.secure,
      user: e.user, pass: e.pass, from: e.user, to,
      subject: mail.subject, text: mail.text, html: mail.html,
    }))
    .then(() => {
      console.log('[mail] 已发送汇总:', mail.subject, '->', to.join(','));
      writeMailLog(`[${new Date().toISOString()}] OK   ${mail.subject} [${tag}] -> ${to.join(',')}`);
    })
    .catch((err) => {
      logErr('sendDigestMail', err);
      writeMailLog(`[${new Date().toISOString()}] FAIL ${mail.subject} [${tag}] -> ${to.join(',')}：${err.message}`);
    });
}

// 设置页「立即发一封汇总」：不等间隔，用该列表当前行情直接发一封，返回可读结果
async function sendDigestNow(listId) {
  const e = store.email || DEFAULT_EMAIL;
  if (!mailCfgReady()) {
    return { ok: false, error: '请先填写 SMTP 服务器、账号、授权码，并勾选「启用邮件推送」' };
  }
  const l = getList(listId) || (store.lists || [])[0];
  if (!l) return { ok: false, error: '还没有监控列表' };
  const to = mailToList(l);
  if (!to.length) {
    return { ok: false, error: `「${l.name}」还没选收件邮箱：请在邮件推送里勾选该列表要发往的收件槽` };
  }
  const arr = quotesForList(l).filter(q => q && q.symbol);
  if (!arr.length) return { ok: false, error: '还没有行情数据，等一次刷新（约 30 秒）后再试' };
  const mail = buildDigestMail(arr, l);
  try {
    await smtpSend({
      host: e.host, port: e.port, secure: e.secure,
      user: e.user, pass: e.pass, from: e.user, to,
      subject: mail.subject, text: mail.text, html: mail.html,
    });
    writeMailLog(`[${new Date().toISOString()}] OK   (汇总) [${l.name}] -> ${to.join(',')}`);
    return { ok: true, to: to.join(','), count: arr.length, list: l.name };
  } catch (err) {
    writeMailLog(`[${new Date().toISOString()}] FAIL (汇总) [${l.name}] -> ${to.join(',')}：${err.message}`);
    return { ok: false, error: err.message };
  }
}

// 首次运行不做"历史补报"：把已存在的异动标记为已提醒，避免启动瞬间弹一堆
// （邮件通道同样要 prime，否则一开机就会收到一堆历史异动邮件）
// 多列表后按 listId 分别记录，同一只股票在两个列表里互不干扰。
function primeAlertState(quotes, list) {
  if (!list) return;
  const now = Date.now();
  const s1 = stateFor(alertState, list.id);
  const s2 = stateFor(mailAlertState, list.id);
  for (const q of (quotes || [])) {
    if (!q || !q.symbol) continue;
    const rec = { ts: now, pct: parseFloat(q.changePct) || 0 };
    s1.set(q.symbol, rec);
    s2.set(q.symbol, { ...rec });
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

// 按指定列表的尺寸，把它的窗口精确贴到指定角
function snapToCorner(listId, anchor) {
  const l = getList(listId);
  const w = widgetWindows.get(listId);
  if (!l || !w || w.isDestroyed() || !anchor) return false;
  const np = computeAnchoredPosition(anchor, l);
  try {
    w.setPosition(np.x, np.y);
    l.position = np;
    return true;
  } catch (e) { logErr('snapToCorner', e); return false; }
}

// 把某个列表的窗口调整到 l.width / l.height（先解下限，再按原贴角复位）
function applyWidgetSize(listId) {
  const l = getList(listId);
  const w = widgetWindows.get(listId);
  if (!l || !w || w.isDestroyed()) return;
  try {
    // 改尺寸【之前】先看贴的是哪个角（此时 getSize 还是旧值）
    const p = w.getPosition();
    const old = w.getSize();
    const anchor = detectCorner({ x: p[0], y: p[1] }, { width: old[0], height: old[1] });

    w.setMinimumSize(MIN_W, MIN_H);   // 先解除隐式下限
    w.setMaximumSize(MAX_W, MAX_H);   // 放开上限到允许范围，确保 setSize 能达到
    w.setSize(l.width, l.height);
    saveConfig();

    // 改完尺寸按新尺寸重新贴回那个角，保证始终严丝合缝贴边
    // （否则右下角位置是基于旧宽高算的，一改尺寸就会偏移）
    snapToCorner(listId, anchor);
  } catch (e) { logErr('applyWidgetSize', e); }
}

// ---------- 屏幕位置（九宫格锚点）----------
// anchor: top-left / top / top-right / left / center / right / bottom-left / bottom / bottom-right
const EDGE_MARGIN = 12;   // 距屏幕边缘留白
const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

// 按【该列表自己的宽高】算锚点坐标（多列表尺寸不同，不能再用全局尺寸）
function computeAnchoredPosition(anchor, l) {
  const width = (l && l.width) || LIST_WIN_DEFAULTS.width;
  const height = (l && l.height) || LIST_WIN_DEFAULTS.height;
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
function computeDefaultPosition(l) {
  return computeAnchoredPosition('bottom-right', l);
}

// 校验窗口是否在【当前主屏幕工作区】内可见（换显示器 / 分辨率 / DPI 变化后，
// 旧坐标可能整块跑到屏外，表现为"任务栏有预览但桌面看不到"）。
// 要求至少有 TOL 像素落在屏内，才算"在屏上"。
function ensureOnScreen(pos, winW, winH) {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const TOL = 24;
    const okX = (pos.x + winW) > wa.x + TOL && pos.x < wa.x + wa.width - TOL;
    const okY = (pos.y + winH) > wa.y + TOL && pos.y < wa.y + wa.height - TOL;
    return okX && okY;
  } catch (_) { return true; }
}

// 给一个还没定位置的新窗口找"不和已有窗口重叠"的落点：
// 从右下角起，先在同一列往上排，排满再往左一列。实在找不到就退回右下角（重叠也可见）。
function findFreeSlot(l, others) {
  let wa;
  try { wa = screen.getPrimaryDisplay().workArea; } catch (_) { return { x: 0, y: 0 }; }
  const w = (l && l.width) || LIST_WIN_DEFAULTS.width;
  const h = (l && l.height) || LIST_WIN_DEFAULTS.height;
  const stepX = w + 10, stepY = h + 10;
  const base = { x: wa.x + wa.width - w - EDGE_MARGIN, y: wa.y + wa.height - h - EDGE_MARGIN };
  const taken = (pos) => (others || []).some((o) => o && Math.abs(o.x - pos.x) < 6 && Math.abs(o.y - pos.y) < 6);
  for (let col = 0; col < 6; col++) {
    for (let row = 0; row < 6; row++) {
      const p = { x: base.x - col * stepX, y: base.y - row * stepY };
      if (p.x < wa.x || p.y < wa.y) break;
      if (!taken(p)) return p;
    }
  }
  return base;
}

// 除 excludeId 之外，其它存活窗口当前的位置（用于避让）
function otherWindowPositions(excludeId) {
  const out = [];
  for (const [id, w] of widgetWindows) {
    if (id === excludeId || !w || w.isDestroyed()) continue;
    try { const p = w.getPosition(); out.push({ x: p[0], y: p[1] }); } catch (_) {}
  }
  return out;
}

// ---------- 创建小组件窗口 ----------
// 每个列表一个窗口：位置 / 尺寸 / 外观 / 显示方式 / 提醒全部按该列表自己那份配置。
function createWidgetWindow(listId) {
  const cfg = getList(listId);
  if (!cfg) return null;
  const alive = widgetWindows.get(listId);
  if (alive && !alive.isDestroyed()) return alive;

  let pos = cfg.position;
  // 核心修复：config 里可能存着换屏前的大坐标（如 2008,1260），已跑到当前屏幕外，
  // 导致"任务栏有预览但桌面看不到"。这里检测越界，越界就重找一个可见位置。
  const useDefault = !pos || (pos.x === 0 && pos.y === 0) || !ensureOnScreen(pos, cfg.width || 220, cfg.height || 88);
  if (useDefault) {
    // 已经有别的列表窗口时避开它们，避免两个窗口完全叠在一起
    const others = otherWindowPositions(listId);
    pos = others.length ? findFreeSlot(cfg, others) : computeDefaultPosition(cfg);
    if (!ensureOnScreen(pos, cfg.width, cfg.height)) pos = computeDefaultPosition(cfg);
  }

  const win = new BrowserWindow({
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
      // 渲染层要知道自己代表哪个列表，把 id 直接传给 preload（preload 再暴露给页面）
      additionalArguments: ['--mm-list=' + listId],
    },
  });
  widgetWindows.set(listId, win);
  winListId.set(win, listId);

  win.setMenuBarVisibility(false);
  // 显式声明边界，避免 Electron 把创建尺寸当成 minimumSize（否则后续无法调小）
  try {
    win.setMinimumSize(MIN_W, MIN_H);
    win.setMaximumSize(MAX_W, MAX_H);
    win.setResizable(false);   // 再次确认：小组件不允许被手动/边角拖拽改变大小
  } catch (_) {}

  // 尺寸守卫（双保险）：小组件尺寸只能由设置页 IPC 决定。
  // 若因旧进程残留 / Windows 无边框窗口边角 resize / 多屏 DPR 变化导致尺寸漂移，
  // debounce 后立即弹回【该列表】的期望值。
  let _sizeGuardTimer = null;
  win.on('resize', () => {
    if (_sizeGuardTimer) return;
    _sizeGuardTimer = setTimeout(() => {
      _sizeGuardTimer = null;
      const cur = getList(listId);
      if (!cur || win.isDestroyed()) return;
      try {
        const s = win.getSize();
        if (s[0] !== cur.width || s[1] !== cur.height) {
          win.setMinimumSize(MIN_W, MIN_H);
          win.setMaximumSize(MAX_W, MAX_H);
          win.setSize(cur.width, cur.height);
        }
      } catch (_) {}
    }, 15);
  });

  win.once('ready-to-show', () => {
    const cur = getList(listId);
    if (!cur) return;
    if (cur.visible === false) { saveConfig(); return; }   // 配成"启动不显示"的列表，从托盘再打开
    win.show();
    // 透明度交给渲染层用 CSS 应用（按 config 值重算，启动必然持久），
    // 这里仅兜底调用一次，保证透明窗口也能立刻生效
    try { win.webContents.send('opacity-change', Math.max(0.05, Math.min(1.0, parseFloat(cur.opacity) || 1.0))); } catch (_) {}
    try { win.webContents.send('text-opacity-change', Math.max(0.05, Math.min(1.0, parseFloat(cur.textOpacity) || 1.0))); } catch (_) {}
    try { win.webContents.send('mono-change', !!cur.mono); } catch (_) {}
    try { win.webContents.send('display-mode', cur.displayMode || 'scroll'); } catch (_) {}
    try { win.webContents.send('scroll-ms', cur.scrollMs || 3000); } catch (_) {}
    try { win.webContents.send('jump-ms', cur.jumpMs || 3000); } catch (_) {}

    // 启动贴角精修：若 config 保存的位置在贴角容差内，帮用户对齐到精确像素；
    // 用户拖到中间时不打扰。并做越界拉回。
    const wa = (() => { try { const a = screen.getPrimaryDisplay().workArea; return { x: a.x, y: a.y, w: a.width, h: a.height }; } catch (_) { return null; } })();
    let finalP = null, sz = null, onScreen = null, wasClamped = false;
    try {
      const p = win.getPosition();
      sz = win.getSize();
      const a = detectCorner({ x: p[0], y: p[1] }, { width: sz[0], height: sz[1] });
      let np = a ? computeAnchoredPosition(a, cur) : null;
      // 关键：如果当前坐标不在屏内（换屏/换分辨率后跑飞），强制拉回默认位置
      if (!np || !ensureOnScreen(np, sz[0], sz[1])) {
        np = computeDefaultPosition(cur);
        wasClamped = true;
      }
      // 多列表避让：上面两步（贴角对齐 / 拉回默认位）都可能把窗口【精确压回】另一个
      // 列表的坐标上 —— 从 v1.4.x 升级上来时两个列表共用同一份遗留坐标，必然发生，
      // 结果是两个窗口完全重合、只能看见一个。这里最后再避让一次并持久化新坐标，
      // 保证每个列表都露得出来，且重启后不会被重新叠回去。
      const others = otherWindowPositions(listId);
      if (others.some((o) => Math.abs(o.x - np.x) < 6 && Math.abs(o.y - np.y) < 6)) {
        np = findFreeSlot(cur, others);
        wasClamped = true;
      }
      if (np.x !== p[0] || np.y !== p[1]) {
        win.setPosition(np.x, np.y);
        cur.position = np;
      }
      finalP = { x: np.x, y: np.y };
      onScreen = ensureOnScreen(np, sz[0], sz[1]);
      saveConfig();
    } catch (e) { logErr('startup-snap', e); }
    // 启动自检日志：记录实际屏幕工作区 + 窗口最终落点，便于排查"为什么看不到"
    try {
      const line = JSON.stringify({ t: new Date().toISOString(), list: listId, wa, finalP, sz, onScreen, wasClamped, cfgPos: cur.position }) + '\n';
      fs.appendFileSync(path.join(APP_DIR, 'screenlog.txt'), line, 'utf8');
    } catch (_) {}
  });

  win.loadFile('renderer/index.html');

  // 右键兜底：即便渲染层 contextmenu 未触发，主进程也能打开设置
  win.webContents.on('context-menu', () => {
    try { openSettings(listId); } catch (e) { logErr('context-menu', e); }
  });

  // 一次自检：用 --selfcheck 启动时，渲染稳定后自动截图 + 记录参数并退出（只在第一个列表窗口上跑一次）
  if (triggered('selfcheck') && store.lists && store.lists[0] && store.lists[0].id === listId) {
    const logPath = path.join(APP_DIR, 'selfcheck.log');
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let capMsg = '';
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(APP_DIR, 'selfcheck.png'), img.toPNG());
          capMsg = 'CAPTURED ' + path.join(APP_DIR, 'selfcheck.png');
        } catch (e) { capMsg = 'CAP_ERR ' + e.message; }
        let ui = {};
        try {
          ui = await win.webContents.executeJavaScript(`(function(){
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
          const cur = getList(listId) || {};
          const exists = fs.existsSync(CONFIG_PATH);
          const raw = exists ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
          diag = { exists, fileLen: raw ? raw.length : 0, list: listId, symbolsLen: (cur.symbols || []).length };
        } catch (e) { diag = { diagErr: e.message }; }
        try {
          fs.writeFileSync(logPath, capMsg + '\n' + JSON.stringify({
            list: getList(listId) || null, diag, ui,
          }, null, 2) + '\n', 'utf8');
        } catch (_) {}
        setTimeout(() => app.quit(), 800);
      }, 4000);
    });
  }

  // 拖动后保存位置（拖动过程中会高频触发，做防抖，避免每帧写盘）
  win.on('moved', () => {
    const cur = getList(listId);
    if (!cur || win.isDestroyed()) return;
    try { const [x, y] = win.getPosition(); cur.position = { x, y }; } catch (_) { return; }
    if (posSaveTimer) clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(() => { posSaveTimer = null; saveConfig(); }, 400);
  });

  win.on('closed', () => {
    winListId.delete(win);
    if (widgetWindows.get(listId) === win) widgetWindows.delete(listId);
  });

  return win;
}

// 关掉某个列表的窗口（删列表 / 隐藏列表时用）
function destroyWidgetWindow(listId) {
  const w = widgetWindows.get(listId);
  widgetWindows.delete(listId);
  if (w && !w.isDestroyed()) {
    winListId.delete(w);
    try { w.destroy(); } catch (_) {}
  }
}

// 按 store.lists 全量同步窗口：新增的建、删掉的关。
// applyVisible=true 时才会按 list.visible 显示/隐藏（只在启动、导入配置这类"整装重来"时用）。
function syncWidgetWindows(applyVisible) {
  const want = new Set((store.lists || []).map(l => l.id));
  for (const id of [...widgetWindows.keys()]) {
    if (!want.has(id)) destroyWidgetWindow(id);
  }
  for (const l of (store.lists || [])) {
    const w = widgetWindows.get(l.id);
    if (!w || w.isDestroyed()) { createWidgetWindow(l.id); continue; }
    if (!applyVisible) continue;
    if (l.visible === false) { try { w.hide(); } catch (_) {} }
    else { try { if (!w.isVisible()) w.show(); } catch (_) {} }
  }
}

// ---------- 设置窗口 ----------
// listId 可选：从某个小组件右键进来时，设置页会自动切到那个列表的 Tab。
function openSettings(listId) {
  const target = (listId && getList(listId)) ? listId : '';
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (target) { try { settingsWindow.webContents.send('focus-list', target); } catch (_) {} }
    settingsWindow.show();
    settingsWindow.focus();
    return true;
  }
  // 默认高度 = 主屏「工作区」高度（已排除任务栏），打开设置就能一屏看全，无需手动拉大
  let initH = 520;
  let initY;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    initH = Math.max(480, wa.height);
    initY = wa.y;
  } catch (_) {}
  settingsWindow = new BrowserWindow({
    width: 640,
    height: initH,
    ...(initY === undefined ? {} : { y: initY }),
    title: 'Marketmonitor 设置',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 用 query 传初始列表：渲染层加载时就能直接定位到对应 Tab
  settingsWindow.loadFile('renderer/settings.html', target ? { query: { list: target } } : undefined);
  settingsWindow.on('closed', () => { settingsWindow = null; });
  return true;
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
    return parseQuotes(text, symbols);
  } catch (e) {
    console.error('[fetchQuotes] error:', e.message);
    return lastQuotes || [];
  }
}

// 腾讯返回的第 0 段是"市场号"而不是代码：1=沪 51=深 100=港
const MARKET_PREFIX = { '1': 'sh', '51': 'sz', '100': 'hk' };

// 解析腾讯财经返回格式
// v_sh600519="1~贵州茅台~600519~1258.00~..."   /  v_hk00981="100~中芯国际~00981~..."
// 注意：A 股与港股的 31=涨跌 / 32=涨跌幅(%) / 33=最高 / 34=最低 位置一致，可共用一套解析。
function parseQuotes(text, symbols) {
  const out = [];
  // 用「市场号 + 代码」精确还原 symbol：
  // 指数 sh000001 与个股 sz000001 的代码段都是 000001，只按代码反查会串号，
  // 所以先用腾讯返回的市场号拼出 sh/sz/hk 前缀去请求列表里找（大小写不敏感），
  // 找不到时再退回"按代码反查"（保持旧行为）。
  const want = new Map();
  for (const s of (symbols || [])) want.set(String(s).toLowerCase(), String(s));
  const byCode = new Map();
  for (const s of (symbols || [])) {
    const k = String(s).replace(/^[a-z]+/i, '').toLowerCase();
    if (!byCode.has(k)) byCode.set(k, String(s));
  }
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
    const code = parts[2] || '';
    const mkt = MARKET_PREFIX[String(parts[0])];
    // 市场号 + 代码 = 候选 symbol（如 1+000001 → sh000001，100+HSI → hkHSI）
    const guess = mkt ? (mkt + code).toLowerCase() : String(code).toLowerCase();
    out.push({
      symbol: want.get(guess) || byCode.get(String(code).toLowerCase()) || (mkt ? mkt + code : code),
      name: parts[1] || '',
      code,
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

// ---------- 主循环：拉取数据并按列表分发 ----------
// 刷新策略：统一 30s 一次（用户要求）。
// 风险：30s 间隔在腾讯侧的封禁阈值之上，不会触发限频。
// 多列表后：把全部列表的标的合并去重后【只请求一次】（省流量、也避免被限频），
// 再按列表把属于它的那部分行情分发下去 —— 各窗口/各提醒通道只看到自己的标的。
let alertPrimed = false;
let ticking = false;

// 全部列表的标的（按列表顺序，跨列表去重）
function allSymbols() {
  const seen = new Set();
  const out = [];
  for (const l of (store.lists || [])) {
    for (const s of (l.symbols || [])) {
      const key = String(s.symbol).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s.symbol);
    }
  }
  return out;
}

async function tick() {
  if (ticking) return;   // 上一轮还没回来（网络慢）时跳过，避免请求叠加
  ticking = true;
  try {
    const quotes = await fetchQuotes(allSymbols());
    const lists = store.lists || [];
    const prime = !alertPrimed && !!(quotes && quotes.length);
    for (const l of lists) {
      const mine = quotesForList(l);
      if (!mine.length) continue;
      sendToList(l.id, 'quotes', mine);
      if (prime) { primeAlertState(mine, l); continue; }   // 首帧只登记，不提醒
      checkAlerts(mine, l);
      checkEmailAlerts(mine, l);   // 邮件推送：独立阈值与冷却，与上一条通道互不影响
      checkDigest(mine, l);        // 定时汇总：按时间戳判定，与异动推送完全独立
    }
    if (prime) alertPrimed = true;
  } catch (e) {
    logErr('tick', e);
  } finally {
    ticking = false;
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(tick, store.fetchIntervalMs || 30000);
  }
}

// ---------- IPC 通信 ----------
// 一个列表的「设置页形态」：normalizeList 能吃的完整字段 + 界面要用的派生信息
function listForUi(l) {
  const m = l.mail || DEFAULT_LIST_MAIL;
  return {
    id: l.id,
    name: l.name,
    symbols: (l.symbols || []).map(s => ({ symbol: s.symbol, name: s.name || s.symbol })),
    width: l.width,
    height: l.height,
    topMost: !!l.topMost,
    opacity: l.opacity,
    textOpacity: l.textOpacity ?? 1.0,
    mono: !!l.mono,
    displayMode: l.displayMode || 'scroll',
    scrollMs: l.scrollMs,
    jumpMs: l.jumpMs,
    visible: l.visible !== false,
    position: { ...(l.position || { x: 0, y: 0 }) },
    alerts: { ...(l.alerts || DEFAULT_ALERTS) },
    mail: {
      mailboxes: [...(m.mailboxes || [])],
      digestEnabled: !!m.digestEnabled,
      digestIntervalMin: m.digestIntervalMin || DEFAULT_DIGEST_MIN,
    },
    // 该列表实际会收到的收件地址（设置页用来回显"将发给谁"）
    toAddrs: mailToList(l).join(', '),
  };
}

// 设置页首屏快照：全部列表 + 全局邮件 + 预设，一次 IPC 拿全，避免多轮往返
ipcMain.handle('get-state', () => ({
  lists: (store.lists || []).map(listForUi),
  email: emailForUi(),
  presetIndexes: INDEX_PRESETS.map(x => ({ ...x })),
  maxLists: LIST_MAX,
  maxBoxes: MAILBOX_MAX,
  intervalMs: store.fetchIntervalMs || 30000,
}));

ipcMain.handle('get-quote-cache', () => lastQuotes);
// 单个列表的配置（小组件窗口启动时取自己那一份）
ipcMain.handle('get-list', (_e, listId) => {
  const l = getList(listId);
  return l ? listForUi(l) : null;
});
// 某个列表当前的行情（设置页「当前监控列表」和"立即发汇总"用）
ipcMain.handle('get-list-quotes', (_e, listId) => {
  const l = getList(listId);
  return l ? quotesForList(l) : [];
});

// 新建列表
ipcMain.handle('create-list', (_e, name) => {
  if ((store.lists || []).length >= LIST_MAX) return { ok: false, error: `最多 ${LIST_MAX} 个列表` };
  const l = makeList(store.lists || [], String(name || '').trim() || undefined);
  l.position = { x: 0, y: 0 };   // 交给窗口创建时自动找空位，避免和已有窗口重叠
  store.lists.push(l);
  saveConfig();
  createWidgetWindow(l.id);
  return { ok: true, list: listForUi(l) };
});

// 删除列表（至少保留一个，否则应用就没内容可监控了）
ipcMain.handle('delete-list', (_e, listId) => {
  const arr = store.lists || [];
  if (arr.length <= 1) return { ok: false, error: '至少要保留一个列表' };
  const i = arr.findIndex(l => l.id === listId);
  if (i < 0) return { ok: false, error: '列表不存在' };
  arr.splice(i, 1);
  destroyWidgetWindow(listId);
  digestTs.delete(listId);
  saveConfig();
  return { ok: true };
});

// 保存列表：前端只传「它改了什么」，这里与现有值合并后再归一化，避免漏传的字段被重置成默认值
ipcMain.handle('save-list', (_e, listId, patch) => {
  const l = getList(listId);
  if (!l) return { ok: false, error: '列表不存在' };
  const p = patch || {};
  const pick = (k, cur) => (p[k] !== undefined ? p[k] : cur);
  const next = normalizeList({
    name: pick('name', l.name),
    symbols: pick('symbols', l.symbols),
    width: pick('width', l.width),
    height: pick('height', l.height),
    topMost: pick('topMost', l.topMost),
    opacity: pick('opacity', l.opacity),
    textOpacity: pick('textOpacity', l.textOpacity),
    mono: pick('mono', l.mono),
    displayMode: pick('displayMode', l.displayMode),
    scrollMs: pick('scrollMs', l.scrollMs),
    jumpMs: pick('jumpMs', l.jumpMs),
    position: pick('position', l.position),
    visible: pick('visible', l.visible),
    alerts: pick('alerts', l.alerts),
    mail: pick('mail', l.mail),
  }, listId, l.name);
  const mailChanged = p.mail !== undefined;
  const digestChanged = mailChanged && (
    next.mail.digestEnabled !== (l.mail && l.mail.digestEnabled)
    || next.mail.digestIntervalMin !== (l.mail && l.mail.digestIntervalMin)
  );
  Object.assign(l, next);
  if (digestChanged) resetDigestTimer(listId);   // 只改汇总开关/间隔时才重排基准
  saveConfig();

  // 外观类改动要作用到真正的窗口上
  if (p.width !== undefined || p.height !== undefined) applyWidgetSize(listId);
  if (p.opacity !== undefined) sendToList(listId, 'opacity-change', l.opacity);
  if (p.textOpacity !== undefined) sendToList(listId, 'text-opacity-change', l.textOpacity);
  if (p.mono !== undefined) sendToList(listId, 'mono-change', l.mono);
  if (p.displayMode !== undefined) sendToList(listId, 'display-mode', l.displayMode);
  if (p.scrollMs !== undefined) sendToList(listId, 'scroll-ms', l.scrollMs);
  if (p.jumpMs !== undefined) sendToList(listId, 'jump-ms', l.jumpMs);
  if (p.name !== undefined) sendToList(listId, 'list-name', l.name);
  if (p.topMost !== undefined) {
    const w = widgetWindows.get(listId);
    if (w && !w.isDestroyed()) { try { w.setAlwaysOnTop(!!l.topMost); } catch (_) {} }
  }
  if (p.visible !== undefined) {
    const w = widgetWindows.get(listId);
    if (w && !w.isDestroyed()) { try { l.visible ? w.show() : w.hide(); } catch (_) {} }
  }
  if (p.symbols !== undefined) { alertPrimed = false; tick(); }   // 标的变了立即刷新并重新对齐基准
  return { ok: true, list: listForUi(l) };
});

// ---------- 邮件推送 ----------
// 注意：授权码不向渲染层回传明文（只回 hasPass），避免设置页脚本或旁观者拿到；
// 保存时传空字符串 = 保持原值不变。
function emailForUi() {
  const e = store.email || DEFAULT_EMAIL;
  return {
    ...e,
    pass: '',
    hasPass: !!e.pass,
    canSend: !!(e.enabled && e.host && e.user && e.pass),
    activeTo: activeBoxAddrs(e).join(', '),
  };
}
ipcMain.handle('get-email-config', () => emailForUi());
ipcMain.handle('save-email-config', (_e, cfg) => {
  const cur = store.email || DEFAULT_EMAIL;
  const c = cfg || {};
  const merged = { ...cur };
  for (const k of ['enabled', 'host', 'port', 'secure', 'user', 'boxes',
                   'followAlerts', 'thresholdUp', 'thresholdDown']) {
    if (c[k] !== undefined) merged[k] = c[k];
  }
  if (typeof c.pass === 'string' && c.pass !== '') merged.pass = c.pass;
  if (c.pass === null) merged.pass = '';           // 显式传 null = 清空授权码
  store.email = normalizeEmail(merged);
  saveConfig();
  return emailForUi();
});
ipcMain.handle('test-email', () => sendTestMail());
ipcMain.handle('test-digest', (_e, listId) => sendDigestNow(listId));
// 手动测试提醒（设置页"试一下"用）：直接用该列表的当前真实行情，不走冷却
ipcMain.handle('test-alert', (_e, listId) => {
  const l = getList(listId) || (store.lists || [])[0];
  const q = ((l ? quotesForList(l) : [])[0]) || (lastQuotes || [])[0];
  const a = q ? {
    symbol: q.symbol, name: q.name || q.symbol, price: q.price,
    changePct: q.changePct, up: (q.changePct || 0) > 0,
  } : {
    symbol: 'sh600519', name: '贵州茅台', price: 1500,
    changePct: ((l && l.alerts && l.alerts.thresholdUp) || 3.9), up: true,
  };
  fireAlert(a, l);
  return a;
});

// ---------- 配置导出 / 导入 ----------
// 目标：换一台机器时把列表、外观、提醒、邮件设置一次性搬过去。
// 导出成一份自包含 JSON；授权码默认一并导出（否则新机器发不出邮件），界面上可选择剔除。
function exportPayload(includePass) {
  const e = { ...(store.email || DEFAULT_EMAIL) };
  if (!includePass) e.pass = '';
  return {
    app: 'marketmonitor',
    kind: 'config',
    version: (() => { try { return app.getVersion(); } catch (_) { return '0.0.0'; } })(),
    exportedAt: new Date().toISOString(),
    general: { fetchIntervalMs: store.fetchIntervalMs || 30000 },
    email: e,
    // 位置不导出：目标机器分辨率/显示器不同，带过去多半跑到屏外，让程序自动找空位
    lists: (store.lists || []).map((l) => { const u = listForUi(l); delete u.position; delete u.toAddrs; return u; }),
  };
}

ipcMain.handle('export-config', async (_e, opts) => {
  const includePass = !opts || opts.includePass !== false;
  const defName = `marketmonitor-config-${new Date().toISOString().slice(0, 10)}.json`;
  const opt = {
    title: '导出配置',
    defaultPath: defName,
    filters: [{ name: 'JSON 配置文件', extensions: ['json'] }],
  };
  let target = '';
  try {
    const r = settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showSaveDialog(settingsWindow, opt)
      : await dialog.showSaveDialog(opt);
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    target = r.filePath;
  } catch (e) { return { ok: false, error: e.message }; }
  try {
    fs.writeFileSync(target, JSON.stringify(exportPayload(includePass), null, 2), 'utf8');
    return { ok: true, path: target, includePass };
  } catch (e) { return { ok: false, error: '写入失败：' + e.message }; }
});

ipcMain.handle('import-config', async () => {
  const opt = {
    title: '导入配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON 配置文件', extensions: ['json'] }],
  };
  let file = '';
  try {
    const r = settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showOpenDialog(settingsWindow, opt)
      : await dialog.showOpenDialog(opt);
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    file = r.filePaths[0];
  } catch (e) { return { ok: false, error: e.message }; }

  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
  if (!obj || obj.kind !== 'config' || !Array.isArray(obj.lists) || !obj.lists.length) {
    return { ok: false, error: '这不是有效的 Marketmonitor 配置文件' };
  }

  const lists = obj.lists.slice(0, LIST_MAX).map((l, i) =>
    normalizeList(l, String((l && l.id) || ('l' + (i + 1))), '列表 ' + (i + 1)));
  const gen = obj.general || {};
  const interval = Math.max(5000, Math.min(300000,
    parseInt(gen.fetchIntervalMs, 10) || store.fetchIntervalMs || 30000));

  // 覆盖前先把现有配置备份成 config.ini.bak，用户后悔可手工回滚
  try { fs.writeFileSync(CONFIG_PATH + '.bak', fs.readFileSync(CONFIG_PATH, 'utf8'), 'utf8'); } catch (_) {}
  store.lists = lists;
  store.email = normalizeEmail(obj.email || {});
  store.fetchIntervalMs = interval;
  saveConfig();

  // 记忆类状态全部清掉，让导入后的配置从"干净"状态开始
  alertPrimed = false;
  alertState.clear();
  mailAlertState.clear();
  digestTs.clear();
  syncWidgetWindows(true);
  tick();
  return { ok: true, path: file, lists: lists.length, symbolCount: allSymbols().length };
});

// ---------- 客户端自动更新（零依赖）----------
// 只用 GitHub 公开 REST API（无需鉴权），把 releases/latest 的 tag 与当前版本比对；
// 有新版就下载安装包到用户目录，再交给系统安装器（shell.openPath）。
// 不做"静默替换正在运行的 exe"—— Windows 上被占用时写不进去，也容易被杀软拦。
const UPDATE_API = 'https://api.github.com/repos/yohoky/marketmonitor/releases/latest';
const UPDATE_INTERVAL_MS = 24 * 3600 * 1000;
let updateTimer = null;
let updateState = { checkedAt: 0, latest: '', url: '', notes: '', asset: '', assetUrl: '', size: 0, error: '' };

// 语义化版本比较：a>b 返回 1，相等返回 0，a<b 返回 -1（按数字段比较，1.10 > 1.9）
function cmpVer(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 从 Release 附件里挑安装包（优先带 setup/install 字样的那个）
function pickInstaller(assets) {
  const exes = (assets || []).filter(a => /\.exe$/i.test(String((a && a.name) || '')));
  if (!exes.length) return null;
  return exes.find(a => /setup|install/i.test(a.name)) || exes[0];
}

async function checkUpdate(manual) {
  let cur = '';
  try { cur = app.getVersion(); } catch (_) {}
  try {
    const res = await fetch(UPDATE_API, {
      headers: { 'User-Agent': 'Marketmonitor', 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const tag = String(rel.tag_name || '').replace(/^v/i, '');
    const asset = pickInstaller(rel.assets);
    updateState = {
      checkedAt: Date.now(),
      latest: tag,
      url: rel.html_url || REPO_URL,
      notes: String(rel.body || '').split('\n').filter(Boolean).slice(0, 12).join('\n'),
      asset: asset ? asset.name : '',
      assetUrl: asset ? asset.browser_download_url : '',
      size: asset ? asset.size : 0,
      error: '',
    };
    const hasNew = !!tag && cmpVer(tag, cur) > 0;
    // 自动检查（非手动）时，有新版只弹个通知，不打扰操作
    if (hasNew && !manual) {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'Marketmonitor 有新版本',
            body: `当前 v${cur} → 最新 v${tag}，点击打开下载页`,
          }).on('click', () => { try { shell.openExternal(updateState.url); } catch (_) {} }).show();
        }
      } catch (_) {}
    }
    return { ok: true, current: cur, hasNew, ...updateState };
  } catch (e) {
    updateState = { ...updateState, checkedAt: Date.now(), error: e.message };
    return { ok: false, error: '检查更新失败：' + e.message, current: cur, hasNew: false };
  }
}

// 下载新版安装包并拉起安装器（用户点「下载并安装」才走这里）
async function downloadUpdate() {
  if (!updateState.assetUrl) return { ok: false, error: '还没有可下载的安装包，请先点「检查更新」' };
  let dir;
  try { dir = path.join(app.getPath('userData'), 'update'); } catch (_) { dir = path.join(APP_DIR, 'update'); }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const target = path.join(dir, updateState.asset || 'marketmonitor-setup.exe');
  try {
    const res = await fetch(updateState.assetUrl, {
      headers: { 'User-Agent': 'Marketmonitor', 'Accept': 'application/octet-stream' },
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, buf);
    // 拉起安装器：交给系统走正常的安装/覆盖流程（需要用户点几下确认，这是有意的）
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: '已下载但无法启动安装器：' + err, path: target };
    return { ok: true, path: target, size: buf.length };
  } catch (e) { return { ok: false, error: '下载失败：' + e.message }; }
}

ipcMain.handle('get-update-state', () => ({ ...updateState }));
ipcMain.handle('check-update', () => checkUpdate(true));
ipcMain.handle('download-update', () => downloadUpdate());

// 启动后延迟 20 秒做一次静默检查，之后每 24 小时一次。
// 未打包（开发调试）时不自动检查，避免本地版本号与线上混淆。
function startUpdateLoop() {
  if (!app.isPackaged) return;
  const kick = () => {
    checkUpdate(false).catch(() => {});
    clearTimeout(updateTimer);
    updateTimer = setTimeout(kick, UPDATE_INTERVAL_MS);
  };
  clearTimeout(updateTimer);
  updateTimer = setTimeout(kick, 20000);
}

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

// 位置：按九宫格锚点归位（设置页"位置"卡片用，按列表各自的尺寸计算）
ipcMain.handle('set-widget-position', (_e, listId, anchor) => {
  const l = getList(listId);
  if (!l) return null;
  const pos = computeAnchoredPosition(String(anchor || 'bottom-right'), l);
  l.position = pos;
  const w = widgetWindows.get(listId);
  if (w && !w.isDestroyed()) {
    try { w.setPosition(pos.x, pos.y); } catch (e) { logErr('setPosition', e); }
  }
  saveConfig();
  return pos;
});
// 查询某列表窗口的当前位置 + 屏幕信息，供设置页显示
ipcMain.handle('get-widget-position', (_e, listId) => {
  const l = getList(listId);
  const w = listId ? widgetWindows.get(listId) : null;
  const cur = (w && !w.isDestroyed())
    ? (() => { const p = w.getPosition(); return { x: p[0], y: p[1] }; })()
    : ((l && l.position) || { x: 0, y: 0 });
  const work = screen.getPrimaryDisplay().workArea;
  return { ...cur, screenW: work.width, screenH: work.height };
});

ipcMain.handle('widget-show-settings', (e) => {
  const l = listOfEvent(e);
  return openSettings(l ? l.id : undefined);
});
ipcMain.handle('widget-quit', () => { app.quit(); });

// ---------- 窗口拖动 ----------
// 说明：不用 CSS 的 -webkit-app-region: drag —— 拖拽区由系统接管会吞掉右键 contextmenu 事件。
// 改为主进程按光标位移移动窗口。每个窗口各存一份拖动基准（多窗口不能共用）。
const dragState = new Map();   // BrowserWindow -> { base:[x,y], origin:{x,y} }

ipcMain.on('widget-drag-start', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  try {
    dragState.set(w, { base: w.getPosition(), origin: screen.getCursorScreenPoint() });
  } catch (err) { logErr('drag-start', err); }
});

ipcMain.on('widget-drag-move', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  const st = dragState.get(w);
  if (!st) return;
  try {
    const cur = screen.getCursorScreenPoint();
    w.setPosition(st.base[0] + (cur.x - st.origin.x), st.base[1] + (cur.y - st.origin.y));
  } catch (err) { logErr('drag-move', err); }
});

ipcMain.on('widget-drag-end', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) dragState.delete(w);
  try { saveConfig(); } catch (err) { logErr('drag-end', err); }
});

ipcMain.handle('widget-toggle-topmost', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const l = listOfWindow(w);
  if (!w || !l || w.isDestroyed()) return false;
  const next = !w.isAlwaysOnTop();
  try { w.setAlwaysOnTop(next); } catch (_) {}
  l.topMost = next;
  saveConfig();
  return next;
});

// ---------- 小组件显隐（托盘用）----------
// 注意：BrowserWindow **没有** toggle() 方法，直接调用会抛 TypeError，
// 弹出阻断式错误框导致程序再也切不回来。这里统一用 show/hide 实现。
// 托盘的显示/隐藏只是"这一次"的效果，不写回 visible —— visible 是各列表"启动时是否显示"的
// 长期设置（在设置页里改）。否则用户从托盘隐藏一次，重启后就再也不出现了，很容易以为程序坏了。
function showAllWidgets() {
  syncWidgetWindows(false);
  eachWidget((w) => {
    try {
      if (!w.isVisible()) w.show();
      if (w.isMinimized()) w.restore();
    } catch (e) { logErr('showAllWidgets', e); }
  });
}

function hideAllWidgets() {
  eachWidget((w) => { try { w.hide(); } catch (e) { logErr('hideAllWidgets', e); } });
}

// 托盘左键：只要还有窗口可见就全隐藏，否则全显示
function toggleWidgets() {
  syncWidgetWindows(false);
  const shown = [...widgetWindows.values()].some(w => w && !w.isDestroyed() && w.isVisible());
  if (shown) hideAllWidgets(); else showAllWidgets();
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

  // 「监控列表」子菜单：每个列表一行，点开就是该列表的设置；列表多了也能单独显隐
  const listItems = (store.lists || []).map(l => ({
    label: `${l.name}（${(l.symbols || []).length} 只）`,
    submenu: [
      { label: '打开设置...', click: () => { try { openSettings(l.id); } catch (e) { logErr('openSettings', e); } } },
      { label: '显示', click: () => { syncWidgetWindows(false); const w = widgetWindows.get(l.id); if (w && !w.isDestroyed()) { try { w.show(); w.focus(); } catch (_) {} } } },
      { label: '隐藏', click: () => { const w = widgetWindows.get(l.id); if (w && !w.isDestroyed()) { try { w.hide(); } catch (_) {} } } },
    ],
  }));

  const menu = Menu.buildFromTemplate([
    { label: '显示全部小组件', click: () => { try { showAllWidgets(); } catch (e) { logErr('showAllWidgets', e); } } },
    { label: '隐藏全部小组件', click: () => { try { hideAllWidgets(); } catch (e) { logErr('hideAllWidgets', e); } } },
    { type: 'separator' },
    ...(listItems.length ? [{ label: '监控列表', submenu: listItems }, { type: 'separator' }] : []),
    { label: '设置...', click: () => { try { openSettings(); } catch (e) { logErr('openSettings', e); } } },
    { label: '立即刷新', click: () => { try { tick(); } catch (e) { logErr('tick', e); } } },
    { type: 'separator' },
    { label: '检查更新...', click: () => { checkUpdate(true).catch(() => {}); try { openSettings(); } catch (_) {} } },
    { label: '关于 Marketmonitor', click: () => showAbout() },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  // 左键单击：切换显示/隐藏（不再用不存在的 toggle()）。
  // 防御性 try/catch：若内部抛错（旧版残留或极端状态），
  // 让进程继续存活；否则 Electron 会弹阻断式"A JavaScript error occurred"，
  // 一旦弹出就完全无法再操作托盘。
  tray.on('click', () => { try { toggleWidgets(); } catch (e) { logErr('tray-click', e); } });
}

// ---------- 关于 / 版本信息 ----------
// 版本号取自打包后的 package.json（electron-builder 按 package.json 的 version 生成安装包文件名，
// 所以 app.getVersion() 与安装包版本天然一致，不会出现"界面写死 v1.3"那种对不上的情况）。
// 发布日期由 CI 在构建时写入 package.json 的 buildDate 字段。
const REPO_URL = 'https://github.com/yohoky/marketmonitor';

// 版本改动记录（只记 1.4.x，1.4.0 之前不收录）——设置页「关于」卡片直接渲染本数组。
// 以后发新版只需在最前面加一条，渲染逻辑不用动。
const CHANGELOG = [
  {
    v: '1.5.0', date: '2026-09-17',
    items: [
      '新增多监控列表：每个列表一个独立悬浮窗，可分别监控自选股、大盘指数、基金等，互不干扰',
      '从 1.4.x 升级时旧配置自动迁移为两个列表，启动时窗口自动错开，不会因沿用同一份旧坐标而叠在一起',
      '新增收件邮箱槽位（1~5 个）：每个监控列表可分别选择发给哪几个收件人，发件账号全局共用',
      '邮件定时汇总改版：HTML 卡片式排版，手机上竖排阅读不横滑，涨红跌绿带颜色标识',
      '新增配置导出/导入：一份 JSON 把全部列表与邮件设置搬到另一台机器',
      '新增客户端自动更新：从 GitHub Release 检查新版本，支持一键下载并拉起安装包',
      '设置页改为按列表分 Tab，新增列表的新建/重命名/删除与列表级外观、提醒、邮件设置',
    ],
  },
  {
    v: '1.4.5', date: '2026-09-17',
    items: [
      '新增邮件定时汇总：可选开关，每隔 N 分钟（1~1440，默认 30）把当前全部行情发到通知邮箱',
      '汇总邮件为等宽表格（名称/代码/现价/涨跌幅）+ 涨跌家数小结，支持「立即发一封汇总」手动测试',
      '「当前监控列表」新增一键置底，与一键置顶配套，把某只快速挪到末尾',
      '清理设置页示例邮箱文案，改为明显非真实的占位样式',
    ],
  },
  {
    v: '1.4.4', date: '2026-09-17',
    items: [
      '新增邮件推送：触发异动后把明细发到邮箱，阈值可单独设置（默认与异动阈值一致）',
      '新增大盘指数监控：上证指数 / 深证成指 / 创业板指 / 沪深300 / 中证500 / 科创50 / 恒生指数，按需勾选',
      '滚动速率与跳动间隔拆成两个参数，分别可调，互不覆盖',
      '设置窗口高度默认铺满屏幕可用显示区（不含任务栏）',
      '「当前监控列表」新增一键置顶，把某只快速调到最前',
      '关于页新增本说明与各版本改动记录',
    ],
  },
  {
    v: '1.4.3', date: '2026-09-17',
    items: [
      '新增文字透明度调节（只淡文字，与背景透明度互不影响）',
      '新增黑白模式：涨跌改用深浅灰，摸鱼时更不显眼',
    ],
  },
  {
    v: '1.4.2', date: '2026-09-17',
    items: [
      '设置页版本号不再写死，改为与安装包版本一致',
      '支持港股代码录入：00981 / hk981（位数自动补零）',
      '关于页显示版本号与发布日期',
    ],
  },
  {
    v: '1.4.1', date: '2026-09-16',
    items: [
      '修复 1.4.0 打开后窗口空白（任务栏有预览、桌面看不到）',
      '支持港股交易时段：09:00–12:00 / 13:00–16:00',
      '休市时段不再推送 0.00% 的无效异动提醒',
    ],
  },
  {
    v: '1.4.0', date: '2026-09-16',
    items: [
      '透明悬浮行情窗，支持拖动与九宫格归位',
      'A股 / 基金 / 可转债 / 港股 多品种同屏，滚动与跳动两种切换方式',
    ],
  },
];

function readBuildDate() {
  const inline = (() => { try { return require('./package.json').buildDate; } catch (_) { return null; } })();
  if (inline) return String(inline);
  // 兜底：本地未注入时读 package.json 文件，再兜底用安装目录 mtime
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg && pkg.buildDate) return String(pkg.buildDate);
  } catch (_) {}
  try {
    const st = fs.statSync(path.join(__dirname, 'package.json'));
    const d = new Date(st.mtimeMs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch (_) { return ''; }
}

function getAppInfo() {
  let version = '';
  try { version = app.getVersion(); } catch (_) {}
  return {
    name: 'Marketmonitor',
    version: version || '0.0.0',
    buildDate: readBuildDate(),
    electron: (process.versions && process.versions.electron) || '',
    repo: REPO_URL,
    changelog: CHANGELOG,
  };
}

// 关于弹窗：版本号 + 发布日期（托盘 / 帮助菜单共用）
function showAbout() {
  const info = getAppInfo();
  try {
    dialog.showMessageBox({
      type: 'info',
      title: '关于 Marketmonitor',
      message: `Marketmonitor  v${info.version}`,
      detail: [
        `版本号：v${info.version}`,
        `发布日期：${info.buildDate || '—'}`,
        '',
        'A股 / 基金 / 可转债 / 港股 桌面悬浮行情小组件',
        '行情数据：腾讯财经    代码搜索：东方财富',
        `Electron ${info.electron}`,
        '',
        REPO_URL,
      ].join('\n'),
      buttons: ['确定'],
      noLink: true,
    });
  } catch (e) { logErr('showAbout', e); }
}

ipcMain.handle('get-app-info', () => getAppInfo());
// 打开项目主页（URL 固定在主进程，渲染层不能传入任意地址）
ipcMain.handle('open-repo', () => { try { shell.openExternal(REPO_URL); return true; } catch (_) { return false; } });

// 应用菜单：设置窗口顶部的"编辑 / 视图 / 帮助"，帮助 → 关于（显示版本号与发布日期）
function buildAppMenu() {
  const template = [
    { role: 'editMenu', label: '编辑' },
    { role: 'viewMenu', label: '视图' },
    {
      label: '帮助',
      submenu: [
        { label: '关于 Marketmonitor', click: () => showAbout() },
        { type: 'separator' },
        { label: '项目主页（GitHub）', click: () => { try { shell.openExternal(REPO_URL); } catch (_) {} } },
      ],
    },
  ];
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(template)); } catch (e) { logErr('buildAppMenu', e); }
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
    buildAppMenu();
    syncWidgetWindows(true);   // 按 store.lists 把每个列表的窗口都建起来
    createTray();
    tick();
    startUpdateLoop();         // 打包版：启动 20 秒后静默查一次更新，此后每 24h 一次
  });
}

app.on('window-all-closed', (e) => {
  // 不退出，托盘驻留
});

app.on('before-quit', () => {
  clearTimeout(fetchTimer);
  clearTimeout(updateTimer);
});
