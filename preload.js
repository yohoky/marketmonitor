// A股股票小组件 - preload 脚本
// 通过 contextBridge 暴露最小 API，保持安全边界
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockApi', {
  // 数据
  getQuotes: () => ipcRenderer.invoke('get-quote-cache'),
  onQuotes: (cb) => ipcRenderer.on('quotes', (_e, data) => cb(data)),
  getStocks: () => ipcRenderer.invoke('get-stocks'),
  saveStocks: (s) => ipcRenderer.invoke('save-stocks', s),
  // UI
  showSettings: () => ipcRenderer.invoke('widget-show-settings'),
  // 拖动窗口（IPC 实现，替代会吞掉右键的 -webkit-app-region）
  dragStart: () => ipcRenderer.send('widget-drag-start'),
  dragMove: () => ipcRenderer.send('widget-drag-move'),
  dragEnd: () => ipcRenderer.send('widget-drag-end'),
  toggleTopMost: () => ipcRenderer.invoke('widget-toggle-topmost'),
  quit: () => ipcRenderer.invoke('widget-quit'),
  // 数据
  fetchStockName: (symbol) => ipcRenderer.invoke('fetch-stock-name', symbol),
  getWidgetConfig: () => ipcRenderer.invoke('get-widget-config'),
  saveWidgetConfig: (cfg) => ipcRenderer.invoke('save-widget-config', cfg),
  onOpacity: (cb) => ipcRenderer.on('opacity-change', (_e, op) => cb(op)),
  onTextOpacity: (cb) => ipcRenderer.on('text-opacity-change', (_e, v) => cb(v)),
  onMono: (cb) => ipcRenderer.on('mono-change', (_e, on) => cb(on)),
  onDisplayMode: (cb) => ipcRenderer.on('display-mode', (_e, m) => cb(m)),
  onScrollMs: (cb) => ipcRenderer.on('scroll-ms', (_e, ms) => cb(ms)),
  onJumpMs: (cb) => ipcRenderer.on('jump-ms', (_e, ms) => cb(ms)),
  // 旧版兼容：rotation-ms 收到后同时作用于两种模式
  onRotationMs: (cb) => ipcRenderer.on('rotation-ms', (_e, ms) => cb(ms)),
  // 屏幕位置（九宫格锚点归位）
  setWidgetPosition: (anchor) => ipcRenderer.invoke('set-widget-position', anchor),
  getWidgetPosition: () => ipcRenderer.invoke('get-widget-position'),
  // 异动提醒
  onAlert: (cb) => ipcRenderer.on('alert', (_e, a) => cb(a)),
  getAlertsConfig: () => ipcRenderer.invoke('get-alerts-config'),
  saveAlertsConfig: (cfg) => ipcRenderer.invoke('save-alerts-config', cfg),
  testAlert: () => ipcRenderer.invoke('test-alert'),
  // 大盘指数
  getIndexes: () => ipcRenderer.invoke('get-indexes'),
  saveIndexes: (list) => ipcRenderer.invoke('save-indexes', list),
  // 邮件推送（授权码不回传明文，只回 hasPass）
  getEmailConfig: () => ipcRenderer.invoke('get-email-config'),
  saveEmailConfig: (cfg) => ipcRenderer.invoke('save-email-config', cfg),
  testEmail: () => ipcRenderer.invoke('test-email'),
  // 定时汇总：立即发一封当前全量行情（不等间隔）
  testDigest: () => ipcRenderer.invoke('test-digest'),
  // 版本信息（关于页显示版本号 + 发布日期）
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openRepo: () => ipcRenderer.invoke('open-repo'),
});
