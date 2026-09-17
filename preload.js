// Marketmonitor - preload 脚本
// 通过 contextBridge 暴露最小 API，保持安全边界。
// 同一个 preload 同时服务「小组件窗口」和「设置窗口」：
//   · 小组件窗口由主进程用 additionalArguments 传入 --mm-list=<id>，知道自己代表哪个列表；
//   · 设置窗口没有这个参数，走列表管理那一组接口。
const { contextBridge, ipcRenderer } = require('electron');

// 从启动参数里取出本窗口对应的列表 id（设置窗口为 null）
function readListArg() {
  try {
    const hit = (process.argv || []).find(a => String(a).indexOf('--mm-list=') === 0);
    return hit ? String(hit).slice('--mm-list='.length) : null;
  } catch (_) { return null; }
}

const MY_LIST = readListArg();

// 只转发数据，回调由调用方提供；包一层避免把 event 对象泄给渲染层
const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('stockApi', {
  // ---------- 本窗口身份 ----------
  listId: MY_LIST,

  // ---------- 行情 ----------
  getQuotes: () => ipcRenderer.invoke('get-quote-cache'),
  getListQuotes: (id) => ipcRenderer.invoke('get-list-quotes', id || MY_LIST),
  fetchStockName: (symbol) => ipcRenderer.invoke('fetch-stock-name', symbol),
  onQuotes: (cb) => on('quotes', cb),
  onAlert: (cb) => on('alert', cb),

  // ---------- 小组件窗口 ----------
  getListConfig: (id) => ipcRenderer.invoke('get-list', id || MY_LIST),
  showSettings: () => ipcRenderer.invoke('widget-show-settings'),
  dragStart: () => ipcRenderer.send('widget-drag-start'),
  dragMove: () => ipcRenderer.send('widget-drag-move'),
  dragEnd: () => ipcRenderer.send('widget-drag-end'),
  toggleTopMost: () => ipcRenderer.invoke('widget-toggle-topmost'),
  quit: () => ipcRenderer.invoke('widget-quit'),
  onOpacity: (cb) => on('opacity-change', cb),
  onTextOpacity: (cb) => on('text-opacity-change', cb),
  onMono: (cb) => on('mono-change', cb),
  onDisplayMode: (cb) => on('display-mode', cb),
  onScrollMs: (cb) => on('scroll-ms', cb),
  onJumpMs: (cb) => on('jump-ms', cb),
  onListName: (cb) => on('list-name', cb),

  // ---------- 设置窗口：列表管理 ----------
  getState: () => ipcRenderer.invoke('get-state'),
  saveList: (id, patch) => ipcRenderer.invoke('save-list', id, patch),
  createList: (name) => ipcRenderer.invoke('create-list', name),
  deleteList: (id) => ipcRenderer.invoke('delete-list', id),
  onFocusList: (cb) => on('focus-list', cb),

  // ---------- 设置窗口：外观 / 位置 ----------
  setWidgetPosition: (id, anchor) => ipcRenderer.invoke('set-widget-position', id, anchor),
  getWidgetPosition: (id) => ipcRenderer.invoke('get-widget-position', id),

  // ---------- 邮件推送（授权码不回传明文，只回 hasPass）----------
  getEmailConfig: () => ipcRenderer.invoke('get-email-config'),
  saveEmailConfig: (cfg) => ipcRenderer.invoke('save-email-config', cfg),
  testEmail: () => ipcRenderer.invoke('test-email'),
  // 定时汇总：立即用该列表的行情发一封（不等间隔）
  testDigest: (id) => ipcRenderer.invoke('test-digest', id),
  // 试一下异动提醒（弹通知 + 闪烁，不发邮件）
  testAlert: (id) => ipcRenderer.invoke('test-alert', id),

  // ---------- 配置导出 / 导入 ----------
  exportConfig: (opts) => ipcRenderer.invoke('export-config', opts),
  importConfig: () => ipcRenderer.invoke('import-config'),

  // ---------- 自动更新 ----------
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),

  // ---------- 关于 ----------
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openRepo: () => ipcRenderer.invoke('open-repo'),
});
