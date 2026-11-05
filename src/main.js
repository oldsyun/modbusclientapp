/**
 * src/main.js — 桌面远程调试台（appui v3.2 工作台）
 *
 * 设计与小程序同源，但桌面端不复刻"手机单列大框"：
 *   · 顶部链路带（会话码 / 服务器 / 现场 / 485 参数 / 权限）
 *   · 二级工具坞（工具 / 扫描 / Modscan / 串口 / RTU / 模块）
 *   · 左栏主工作区：紧凑表单 + 参数表 + 帧预览；右栏报文流 / 操作记录分屏坞
 *   · 底部固定状态栏承接指令回执，不再用浮层黄条遮住表单
 *
 * 数据通路有两条，按现场形态自动选择：
 *   A. ESP32 模块托管（gateway）：桌面端组 RTU 帧 → raw.tx → 模块只透传，
 *      扫描走 cmd 主题的 scan.start/stop，模块参数走 config 主题的 config.get/config.set，
 *      串口直发走 serial.send。
 *   B. 现场手机托管（local host）：沿用镜像 pageSchema + ui.action，
 *      仍可在「工具」页点现场镜像行操作；两种模式互斥。
 */

import { Session } from './lib/session.js';
import { sidHint, MQTT_SERVER, buildWsUrl, MQTT_CONFIG_FROM } from './lib/broker.js';
import * as P from './lib/proto.js';
import * as MB from './lib/modbus.js';
import * as PRESET from './lib/presets.js';

// 构建期注入：desktop（Tauri 桌面版）/ web（静态网页版）。业务代码完全相同，
// 只影响 join 时上报的 kind（现场端据此做准入提示与控制权优先级：desktop > web > mini）。
const CLIENT_KIND = typeof __CLIENT_KIND__ === 'undefined' ? 'desktop' : __CLIENT_KIND__;
const CLIENT_TOOL = CLIENT_KIND === 'web' ? '网页调试台' : '桌面调试台';

const $ = (id) => document.getElementById(id);
const LS_SID = 'mrd.sid';
const LS_THEME = 'mrd.theme';
const LS_BROKER = 'mrd.broker';   // {host, username, password}，凭据只存本机
const LS_SER_QUICK = 'mrd.serQuick';   // JSON 数组：串口报文快捷按钮（hex 字符串）

/* ---- 串口报文快捷按钮：默认值 + 本机 localStorage 持久化 ---- */
const SER_QUICK_DEFAULTS = ['01 03 00 00 00 0A', '01 03 00 00 00 01', '01 06 00 07 00 33', '01 03 01 00 00 01'];
function loadSerialQuick() {
  try {
    const s = localStorage.getItem(LS_SER_QUICK);
    if (!s) return SER_QUICK_DEFAULTS.slice();
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.length) return arr.filter((x) => typeof x === 'string' && x.trim());
    return SER_QUICK_DEFAULTS.slice();
  } catch (e) { return SER_QUICK_DEFAULTS.slice(); }
}
function saveSerialQuick() {
  try {
    const list = Array.isArray(app.serial.quick) ? app.serial.quick : [];
    localStorage.setItem(LS_SER_QUICK, JSON.stringify(list));
  } catch (e) {}
}

/* ---- Broker 凭据：只存本机 localStorage，不写源码 / 不上传 ---- */
function loadBroker() {
  try {
    const s = localStorage.getItem(LS_BROKER);
    return s ? JSON.parse(s) : {};
  } catch (e) { return {}; }
}
function saveBroker(cfg) {
  try { localStorage.setItem(LS_BROKER, JSON.stringify(cfg)); } catch (e) {}
}

/* ==================================================================
   应用状态
   ================================================================== */
const app = {
  sess: null,
  sid: '',
  joined: false,
  peerOnline: false,
  onlineOnce: false,

  // ★ 多远程端（2026-11-01）：网页端 + 小程序可同时在线，只有一个控制端
  isController: true,    // 自己是不是控制端（旁看时只能看）
  observer: false,
  remoteCount: 0,
  ctlName: '',
  peerList: [],          // 现场广播的在线表（其它远程端）

  gw: null,              // {on,name,fw,ip,perm,host,uart}
  mirror: false,         // 现场手机托管的镜像页
  pageId: '',
  widgets: [],

  activeTab: 'tools',    // tools | scan | modscan | serial | rtu | module

  dockTab: 'packets',    // packets | ops —— 右坞 Tab 当前页
  packets: [],           // [{dir,hex,note,t,len,at}]
  ops: [],               // [{level,title,desc,t,count,at}]
  txBytes: 0,
  rxBytes: 0,

  cmd: { text: '就绪 · 输入协助码接入现场', pending: false },
  result: { text: '—', ok: true },
  busyCount: 0,

  // 页面级双向同步（见 desktopViewSnapshot / applyHostView）
  viewApplying: false,
  viewRev: 0,
  viewTimer: null,
  viewLast: null,

  scan: { running: false, cur: 0, found: 0, list: [], start: 1, end: 247, reg: 0, timeout: 80, done: false },

  modscan: {
    area: '03', slave: 1, start: '40001', count: 10, interval: 500,
    format: 'Unsigned', polling: false, busy: false,
    rows: [], prev: {}, round: 0, ok: 0, timeout: 0, err: 0, at: ''
  },

  serial: {
    mode: 'HEX', crcOn: true, appendCr: false, appendLf: false,
    payload: '01 03 00 00 00 0A', loopMs: 1000, looping: false, busy: false, txCount: 0, rxCount: 0,
    quick: SER_QUICK_DEFAULTS.slice(), quickDraft: '', quickOpen: false
  },

  rtu: {
    slave: 1, profileId: 'ref-3', rows: [], hasRead: false, reading: false,
    lastVerify: null, readAt: ''
  },

  module: {
    name: '—', fw: '', ip: '', cur: { baud: '', dataBits: '', parity: '', stopBits: '' },
    edit: { baud: '19200', dataBits: '8', parity: 'E', stopBits: '1' },
    reading: false, writing: false
  }
};

/* 连续事件折叠用：同一标题 4 秒内重复只加计数 */
let toastTimer = null;
let pollTimer = null;
let serialLoopTimer = null;
let lastGatewaySync = 0;

/* ==================================================================
   通用小工具
   ================================================================== */
const pad2 = (n) => String(n).padStart(2, '0');
function clock() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(v, def) { const n = parseInt(v, 10); return isNaN(n) ? def : n; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hex4(n) { return (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
function hexAddr(kind, addr) {
  if (kind === 'plc4') return '4' + String((addr & 0xFFFF) + 1).padStart(4, '0');
  return '0x' + hex4(addr);
}
function toast(msg, ok) {
  const t = $('toast');
  t.textContent = msg || '';
  t.className = 'show' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}
function setNotice(msg, ok) { if (msg) toast(msg, ok); }

/* ==================================================================
   会话：接入 / 断开
   ================================================================== */
function onJoin() {
  const sid = $('sidInput').value.trim().toUpperCase();
  const hint = sidHint(sid);
  if (hint || !P.isSidLen(sid)) {
    $('sidErr').textContent = hint || ('请填满 ' + P.SID_LEN + ' 位协助码');
    $('sidInput').focus();
    return;
  }
  closeSession(true);
  localStorage.setItem(LS_SID, sid);

  app.sid = sid;
  app.joined = true;
  app.onlineOnce = false;
  app.cmd = { text: '正在接入 ' + sid + ' …', pending: true };
  app.result = { text: '—', ok: true };

  app.sess = new Session({
    role: 'remote',
    sid,
    tool: CLIENT_TOOL,
    kind: CLIENT_KIND,            // desktop / web：现场端据此做准入提示与优先级
    broker: loadBroker(),         // 用户设置的 broker 账号 / 密码（本机 localStorage）
    onState: onStateMsg,
    onData: onDataMsg,
    onStatus: (o, first) => {
      applyPeerStatus(o);
      if (first && app.onlineOnce) toast('现场已上线', true);
    },
    onPeers: (info) => applyPeers(info),
    onChange: (st) => {
      renderHeader();
      if (st === 'online') {
        // 连上就主动查一次模块信息：走 config 主题的 config.get（不再用 cmd 的 sync.request）。
        // 模块的 join/heartbeat 状态帧会先经 applyPeerStatus→ensureGateway 建出"空壳" app.gw，
        // 所以按"还没拿到真实固件版本(!app.gw.fw)"判断，空壳也会被补拉填满。
        setTimeout(() => {
          if (app.sess && app.sess.isConnected() && (!app.gw || !app.gw.fw)) {
            fetchModuleInfo();
          }
        }, 350);
      }
    },
    onReconnect: () => { if (app.sess && app.sess.isConnected()) fetchModuleInfo(); },
    onError: (e) => {
      setNotice('MQTT：' + ((e && e.message) || '链路错误'));
      renderHeader();
    }
  }).connect();

  $('joinBtn').hidden = true;
  $('leaveBtn').hidden = false;
  $('sidInput').blur();
  $('sidErr').textContent = '';
  render();
  pushOp('info', '接入会话 ' + sid, '等待现场确认 / 网关（ESP32 直连或 BLE 小程序代理）上线');
}

function closeSession(silent) {
  stopPolling(true);
  stopSerialLoop(true);
  if (app.sess) { try { app.sess.close(); } catch (e) {} app.sess = null; }
  app.joined = false;
  app.peerOnline = false;
  app.onlineOnce = false;
  app.gw = null;
  app.isController = true;
  app.observer = false;
  app.remoteCount = 0;
  app.ctlName = '';
  app.peerList = [];
  app.mirror = false;
  app.pageId = '';
  app.widgets = [];
  app.busyCount = 0;
  app.viewApplying = false;
  app.viewRev = 0;
  app.viewLast = null;
  if (app.viewTimer) { clearTimeout(app.viewTimer); app.viewTimer = null; }
  lastGatewaySync = 0;
  app.scan = { running: false, cur: 0, found: 0, list: [], start: 1, end: 247, reg: 0, timeout: 80, done: false };
  app.modscan.rows = [];
  app.modscan.prev = {};
  app.rtu.rows = [];
  app.rtu.hasRead = false;
  app.rtu.lastVerify = null;
  app.cmd = { text: '就绪 · 输入协助码接入现场', pending: false };
  app.result = { text: '—', ok: true };
  $('joinBtn').hidden = false;
  $('leaveBtn').hidden = true;
  $('offlineBanner').classList.remove('show');
  render();
  if (!silent) pushOp('info', '已断开会话', '');
}

function onLeave() { closeSession(); }

/* ==================================================================
   收：status / state / data
   ================================================================== */
function isGatewayStatus(o) {
  if (!o || o.role !== 'local' || o.action === 'leave') return false;
  return o.gw === 1 || o.ble === 1 || o.tool === 'SYCC-GW' ||
    (o.data && Number(o.data.host) === 1) || Number(o.host) === 1;
}

/**
 * 多远程端：现场端通过 status(ctl/n) 与 state.peers 广播"谁在操作"。
 * 非控制端进入旁看：所有下发入口被 sendCmd 拦下，UI 上给出「请求接管」。
 */
function applyPeers(info) {
  if (!info) return;
  const isCtl = info.isController !== false;
  const peers = info.peers || [];
  let ctlName = '';
  for (const p of peers) {
    if (p && p.ctl) {
      ctlName = p.tool || (p.kind === 'web' ? '网页端' : p.kind === 'desktop' ? '桌面端' : '小程序远程端');
      break;
    }
  }
  const next = {
    isController: isCtl,
    observer: !isCtl,
    remoteCount: Number(info.count) || 0,
    ctlName: ctlName || '另一台远程端',
    peerList: peers
  };
  const changed = next.isController !== app.isController ||
    next.remoteCount !== app.remoteCount || next.ctlName !== app.ctlName;
  Object.assign(app, next);
  if (!changed) return;
  renderHeader();
  if (!isCtl) {
    app.cmd = { text: '旁看模式：' + next.ctlName + '正在操作，你只能看', pending: false };
    toast('已切换为旁看：' + next.ctlName + '正在操作', false);
  }
  renderStatusbar();
}

/** 旁看端 → 请求接管（现场端直接放行） */
function onTakeover() {
  if (!app.sess) return;
  send('ctl.request', {}, { quiet: true, noRetry: true }).then(() => {
    app.isController = true;
    app.observer = false;
    toast('已接管控制权', true);
    renderHeader();
  }).catch((e) => setNotice((e && e.message) || '接管失败'));
}

function applyPeerStatus(o) {
  app.peerOnline = !!(app.sess && app.sess.peerOnline);
  if (app.peerOnline) {
    app.onlineOnce = true;
    $('offlineBanner').classList.remove('show');
  } else if (app.joined && app.onlineOnce) {
    $('offlineTitle').textContent = '现场暂未响应（最近心跳 ' + clock() + '）';
    $('offlineBanner').classList.add('show');
  }
  if (isGatewayStatus(o)) {
    ensureGateway({
      gateway: o.gateway || o.tool || 'SYCC-GW',
      perm: o.perm,
      host: 1,
      link: o.link,
      ble: o.ble,
      uart: o.uart
    });
  }
  renderHeader();
}

function ensureGateway(pl) {
  const first = !app.gw;
  app.mirror = false;
  app.gw = app.gw || { on: true, name: 'SYCC-GW', fw: '', nvs: 0, ip: '', ssid: '', broker: '', pin: '', mode: 0, up: 0, rssi: 0, cred: false, auto: false, wifi: false, mqtt: false, remote: false, perm: 2, host: true, uart: null, link: 'wifi', bleDown: false };
  app.gw.on = true;
  if (Number(pl.ble) === 0) app.gw.bleDown = true;
  else if (pl.ble !== undefined) app.gw.bleDown = false;
  if (pl.gateway) app.gw.name = pl.gateway;
  if (pl.fw) app.gw.fw = pl.fw;
  if (pl.ip) app.gw.ip = pl.ip;
  if (pl.nvs !== undefined) app.gw.nvs = Number(pl.nvs) || 0;
  if (pl.ssid !== undefined) app.gw.ssid = String(pl.ssid || '');
  if (pl.broker !== undefined) app.gw.broker = String(pl.broker || '');
  if (pl.pin !== undefined) app.gw.pin = String(pl.pin || '');
  if (pl.mode !== undefined) app.gw.mode = Number(pl.mode) || 0;
  if (pl.up !== undefined) app.gw.up = Number(pl.up) || 0;
  if (pl.rssi !== undefined) app.gw.rssi = Number(pl.rssi) || 0;
  if (pl.cred !== undefined) app.gw.cred = Number(pl.cred) === 1;
  if (pl.auto !== undefined) app.gw.auto = Number(pl.auto) === 1;
  if (pl.wifi !== undefined) app.gw.wifi = Number(pl.wifi) === 1;
  if (pl.mqtt !== undefined) app.gw.mqtt = Number(pl.mqtt) === 1;
  if (pl.remote !== undefined) app.gw.remote = Number(pl.remote) === 1;
  if (pl.perm) app.gw.perm = Number(pl.perm) || app.gw.perm;
  if (pl.link) app.gw.link = pl.link;
  else if (Number(pl.ble) === 1) app.gw.link = 'ble';
  if (pl.uart && pl.uart.baud && !app.gw.uart) {
    const u = normalizeUart(pl.uart);
    if (u) app.gw.uart = u;
  }
  app.gw.host = true;

  if (first) {
    // 如果网关角色之前已经先到过一帧 view（现场页），保留它切到的页，别被默认 tools 覆盖
    if (!app.viewRev) app.activeTab = 'tools';
    setBusy(0);
    app.cmd = {
      text: gwLinkLabel() + ' 已上线 · 桌面端优先接管（小程序 remote 暂停）',
      pending: false
    };
    toast('检测到' + gwLinkLabel() + '，已进入网关工作台', true);
    pushOp('ok', gwLinkLabel() + '已接入', '网关 ' + app.gw.name + (app.gw.fw ? ' · v' + app.gw.fw : ''));
    syncGateway();
    renderAll();
    return;
  }
  // 后续心跳只刷新顶栏与权限，不整页重绘（否则每 15s 会把正在编辑的输入框清掉）
  renderHeader();
  renderStatusbar();
}

function syncGateway() {
  if (!app.joined || !app.sess) return;
  const now = Date.now();
  if (now - lastGatewaySync < 800) return;
  lastGatewaySync = now;
  // 模块信息查询统一走 config 主题（config.get），不再在 cmd 主题发 sync.request
  fetchModuleInfo();
}

/* ------------------------------------------------------------------
   模块信息（固件版本 / 现场信息 / 串口参数）——统一走 config 主题的 config.get。
   不在 cmd 主题发 sync.request 查询。config.get all 回执同时带：
     · 模块参数：uart / name / ssid / broker / pin / rssi / cred / auto / wifi / mqtt
     · 现场信息：fw / nvs / mode / up / ip / sid / perm / gateway（cfgBuildData 的 work 段）
   ------------------------------------------------------------------ */
function applyModuleInfo(data) {
  if (!data) return;
  if (!app.gw) ensureGateway({});          // 可能还没收到状态帧，先建空壳避免 TypeError

  // ★ 版本门禁（2.5 起三端同版本、不再兼容旧版）：固件在 config.get 里回报 p（协议代号）。
  //   对不上就置 incompat 并弹一次窗，而不是让用户在一堆超时里去猜原因。
  if (data.p !== undefined && app.gw.fw) {
    const gate = P.checkProto(data.p);
    app.gw.proto = String(data.p || '');
    if (!gate.ok && app.gw.protoBad !== gate.reason) {
      app.gw.protoBad = gate.reason;
      pushOp('err', '版本不兼容', gate.reason);
      if (typeof window !== 'undefined' && window.alert) {
        window.alert('固件与客户端版本不匹配\n\n' + gate.reason +
                     '\n\n本客户端 v' + P.APP_VERSION + '，固件 v' + app.gw.fw);
      }
    } else if (gate.ok) {
      app.gw.protoBad = '';
    }
  }
  if (data.uart) {
    const u = normalizeUart(data.uart);
    if (u) {
      app.gw.uart = u;
      app.module.cur = u;
      if (!app.module.dirty) app.module.edit = Object.assign({}, u);
    }
  }
  const nm = data.name !== undefined ? data.name : data.gateway;
  if (nm !== undefined) app.gw.name = nm;
  if (data.gateway !== undefined) app.gw.name = data.gateway || app.gw.name;
  if (data.ssid !== undefined) app.gw.ssid = String(data.ssid || '');
  if (data.broker !== undefined) app.gw.broker = String(data.broker || '');
  if (data.pin !== undefined) app.gw.pin = String(data.pin || '');
  if (data.rssi !== undefined) app.gw.rssi = Number(data.rssi) || 0;
  if (data.cred !== undefined) app.gw.cred = Number(data.cred) === 1;
  if (data.auto !== undefined) app.gw.auto = Number(data.auto) === 1;
  if (data.wifi !== undefined) app.gw.wifi = Number(data.wifi) === 1;
  if (data.mqtt !== undefined) app.gw.mqtt = Number(data.mqtt) === 1;
  if (data.fw !== undefined) app.gw.fw = String(data.fw || '');
  if (data.nvs !== undefined) app.gw.nvs = Number(data.nvs) || 0;
  if (data.mode !== undefined) app.gw.mode = Number(data.mode) || 0;
  if (data.up !== undefined) app.gw.up = Number(data.up) || 0;
  if (data.ip !== undefined) app.gw.ip = String(data.ip || '');
  if (data.perm !== undefined) app.gw.perm = Number(data.perm) || app.gw.perm;
  if (data.sid) app.sid = data.sid;
}

// 轻量查询：连接/重连后自动拉一次模块信息（config.get，走 config 主题），不弹 UI。
function fetchModuleInfo() {
  if (!app.sess || !app.sess.isConnected()) return Promise.resolve(null);
  return sendConfig('config.get', { what: 'all' }, { quiet: true, timeout: 6000 })
    .then((data) => { applyModuleInfo(data); renderHeader(); if (app.activeTab === 'module') renderStage(); return data; })
    .catch(() => null);
}

function onStateMsg(o) {
  const pl = o.payload || {};

  // 页面级双向同步：控制端/现场任一方的当前页 + 页面 data
  if (o.type === 'view') { applyHostView(pl); return; }
  if (pl.role === 'gateway') { applyGatewayDetail(pl); return; }
  if (pl.scan) { onScanState(pl); return; }

  if (o.type === 'page') {
    // 网关链路（ESP32 直连 / BLE 小程序代理）不消费 pageSchema：保持网关工作台
    if (gwReady()) return;
    app.mirror = true;
    app.pageId = pl.page || '';
    app.widgets = Array.isArray(pl.widgets) ? pl.widgets : [];
    app.activeTab = tabOfPage(app.pageId);
    app.cmd = { text: '现场页面已同步：' + (pl.title || app.pageId), pending: false };
    renderAll();
    return;
  }

  if (o.type === 'state') {
    const data = pl.data || {};
    if (data.scan) { onScanState(data); return; }
    // 运行态（running/progress/pct/found/result/busy）落到状态栏，不遮挡工作区
    const keys = ['running', 'progress', 'pct', 'found', 'result', 'busy'];
    const bits = keys.filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== '')
      .map((k) => k + '=' + data[k]);
    if (bits.length) {
      app.result = { text: bits.join(' '), ok: !(data.busy === true || data.result === 'error') };
      renderStatusbar();
    }
    return;
  }

  if (o.type === 'audit') {
    (pl.items || []).forEach((it) => {
      pushOp('info', '审计 ' + (it.cmd || ''), (it.from || '') + ' → ' + (it.result || ''));
    });
  }
}

function applyGatewayDetail(pl) {
  const wasDown = !!(app.gw && app.gw.bleDown);
  ensureGateway(pl);
  if (pl.link) app.gw.link = pl.link;
  else if (Number(pl.ble) === 1) app.gw.link = 'ble';
  if (Number(pl.ble) === 0) {
    app.gw.bleDown = true;
    if (!wasDown) {
      toast('现场蓝牙已断开，BLE 小程序代理暂停；恢复连接后自动继续', false);
      pushOp('warn', '现场蓝牙已断开', '网关命令暂不可用；恢复蓝牙连接后自动恢复');
    }
    renderHeader();
    return;
  }
  if (wasDown && Number(pl.ble) === 1) {
    toast('现场蓝牙已恢复，BLE 小程序代理继续', true);
    pushOp('ok', '现场蓝牙已恢复', '网关工作台继续可用');
  }
  const u = pl.uart && pl.uart.baud ? normalizeUart(pl.uart) : null;
  if (u) {
    app.gw.uart = u;
    app.module.cur = u;
    if (!app.module.dirty) {
      app.module.edit = Object.assign({}, u);
    }
  }
  if (pl.sid) app.sid = pl.sid;
  if (pl.nvs !== undefined) app.gw.nvs = Number(pl.nvs) || 0;
  if (pl.ssid !== undefined) app.gw.ssid = String(pl.ssid || '');
  if (pl.broker !== undefined) app.gw.broker = String(pl.broker || '');
  if (pl.pin !== undefined) app.gw.pin = String(pl.pin || '');
  if (pl.mode !== undefined) app.gw.mode = Number(pl.mode) || 0;
  if (pl.up !== undefined) app.gw.up = Number(pl.up) || 0;
  if (pl.rssi !== undefined) app.gw.rssi = Number(pl.rssi) || 0;
  if (pl.cred !== undefined) app.gw.cred = Number(pl.cred) === 1;
  if (pl.auto !== undefined) app.gw.auto = Number(pl.auto) === 1;
  if (pl.wifi !== undefined) app.gw.wifi = Number(pl.wifi) === 1;
  if (pl.mqtt !== undefined) app.gw.mqtt = Number(pl.mqtt) === 1;
  if (pl.remote !== undefined) app.gw.remote = Number(pl.remote) === 1;
  if (pl.fw) app.gw.fw = pl.fw;
  if (pl.ip) app.gw.ip = pl.ip;
  renderHeader();
  if (app.activeTab === 'module') renderModuleLive();
  pushOp('info', '已同步网关说明书', [
    app.gw.name,
    gwLinkLabel(),
    app.gw.fw ? 'v' + app.gw.fw : '',
    app.gw.ip,
    u ? (u.baud + ' ' + u.dataBits + u.parity + u.stopBits) : ''
  ].filter(Boolean).join(' · '));
}

function normalizeUart(u) {
  if (!u || !u.baud) return null;
  return {
    baud: String(u.baud),
    dataBits: String(u.dataBits || '8'),
    parity: String(u.parity || 'N').toUpperCase(),
    stopBits: String(u.stopBits || '1')
  };
}

function onDataMsg(o) {
  const pl = o.payload || {};
  const segs = (pl.lines || [])
    .filter((l) => l && l.hex)
    .map((l) => ({ dir: l.dir, hex: l.hex, note: '', t: l.t }));
  MB.mergeHexSegments(segs).forEach((entry) => {
    pushPacket(entry.dir, entry.hex, entry.note, entry.t);
  });
  if (pl.dropped) pushPacket('SYS', '', '（丢弃 ' + pl.dropped + ' 条报文）');
}

function onScanState(pl) {
  const kind = String(pl.scan || '').toUpperCase();
  const s = app.scan;
  if (kind === 'START') {
    s.running = true; s.done = false; s.cur = num(pl.cur, s.start); s.found = 0; s.list = [];
  } else if (kind === 'HIT') {
    s.running = true;
    const addr = num(pl.addr, 0);
    if (addr && s.list.indexOf(addr) < 0) s.list.push(addr);
    s.found = s.list.length;
  } else if (kind === 'PROG') {
    s.running = true;
    s.cur = num(pl.addr, s.cur);
  } else if (kind === 'END' || kind === 'ABORT') {
    s.running = false; s.done = true;
    s.cur = num(pl.addr, s.cur);
    s.found = num(pl.found, s.list.length);
    pushOp(kind === 'END' ? 'ok' : 'warn', '从站扫描' + (kind === 'END' ? '完成' : '已中止'),
      '扫描到 ' + s.cur + ' · 发现 ' + s.found + ' 台在线从站');
  }
  if (app.activeTab === 'scan') renderScanLive();
  renderStatusbar();
  scheduleDesktopView();
}

/* ==================================================================
   发：配置命令出口（走 config 主题，与调试命令分开）
   ================================================================== */
function sendConfig(type, payload, opts) {
  opts = opts || {};
  if (!app.sess || !app.sess.isConnected()) {
    setNotice('远程通道未就绪（服务器未连上或会话已结束）');
    return Promise.reject({ code: P.CODES.TIMEOUT, message: '远程通道未就绪' });
  }
  if (app.observer && type !== 'config.get') {
    const msg = '旁看模式：' + (app.ctlName || '另一台远程端') + '正在操作，请先点「请求接管」';
    setNotice(msg);
    return Promise.reject({ code: P.CODES.CONFLICT, message: msg });
  }
  if (!opts.quiet) {
    app.cmd = { text: opts.pendingText || '配置请求已下发，等现场回执…', pending: true };
    renderStatusbar();
  }
  return app.sess.sendConfig(type, payload, {
    noRetry: !!opts.noRetry,
    timeout: opts.timeout,
    onPending: (msg) => {
      app.cmd = { text: msg || '等待现场确认…', pending: true };
      setBusy(1);
      renderStatusbar();
    }
  }).then((data) => {
    if (!opts.quiet) {
      app.cmd = { text: opts.doneText || '配置已由现场回执确认', pending: false };
      app.result = { text: opts.resultText || ('OK · ' + clock()), ok: true };
      setBusy(-1);
      renderStatusbar();
    }
    return data;
  }).catch((err) => {
    if (!opts.quiet) {
      setBusy(-1);
      app.cmd = { text: '配置失败：' + ((err && err.message) || ''), pending: false };
      renderStatusbar();
    }
    throw err;
  });
}

/* ==================================================================
   发：统一命令出口
   ================================================================== */
function send(type, payload, opts) {
  opts = opts || {};
  if (!app.sess || !app.sess.isConnected()) {
    setNotice('远程通道未就绪（服务器未连上或会话已结束）');
    return Promise.reject({ code: P.CODES.TIMEOUT, message: '远程通道未就绪' });
  }
  // 旁看模式：另一台远程端在操作，本地先拦下（现场端也会再拦一次，这里只是少一次往返）
  const CTL_FREE = { 'view.request': 1, 'ctl.request': 1 };
  if (app.observer && !CTL_FREE[type]) {
    const msg = '旁看模式：' + (app.ctlName || '另一台远程端') + '正在操作，请先点「请求接管」';
    setNotice(msg);
    return Promise.reject({ code: P.CODES.CONFLICT, message: msg });
  }
  if (!opts.quiet) {
    app.cmd = { text: opts.pendingText || '已下发，等现场回执…', pending: true };
    renderStatusbar();
  }
  return app.sess.sendCmd(type, payload, {
    noRetry: !!opts.noRetry,
    timeout: opts.timeout,
    onPending: (msg) => {
      app.cmd = { text: msg || '等待现场确认…', pending: true };
      setBusy(1);
      renderStatusbar();
    }
  }).then((data) => {
    if (!opts.quiet) {
      app.cmd = { text: opts.doneText || '指令已由现场回执确认', pending: false };
      app.result = { text: opts.resultText || ('OK · ' + clock()), ok: true };
      setBusy(-1);
      renderStatusbar();
    }
    return data;
  }).catch((err) => {
    if (!opts.quiet) {
      setBusy(-1);
      const title = P.remoteErrTitle(err);
      const advice = P.remoteErrAdvice(err);
      app.cmd = { text: title + (advice ? ' · ' + advice : ''), pending: false };
      app.result = { text: title, ok: false };
      pushOp('err', title, advice || (err && err.message) || '');
      setNotice(title + (advice ? '：' + advice : ''));
      renderStatusbar();
    }
    throw err;
  });
}

function gwReady() { return !!(app.gw && app.gw.on); }

/* 协助模式：现场是「手机托管的 BLE 小程序」（手机连模块、代理走 MQTT）。
   模块托管（wifi 直连）时 gwLink() !== 'ble'，走原有 raw.tx / serial.send 路径。 */
function bleAssistMode() { return gwReady() && gwLink() === 'ble'; }

/* 两条现场链路的文案：业务/工作台完全同源，只有"数据从哪来"不同 */
function gwLink() { return (app.gw && app.gw.link) || 'wifi'; }
function gwLinkLabel() { return gwLink() === 'ble' ? '蓝牙小程序代理' : 'ESP32 WiFi 直连'; }
function gwLinkShort() { return gwLink() === 'ble' ? '蓝牙代理' : '模块托管'; }

/* ==================================================================
   页面级双向同步（对应 miniprogram/utils/assist/view-sync.js）
   ------------------------------------------------------------------
   桌面端切页 → view.follow，现场手机跳到同一页；
   桌面端/现场任一端页面 data 变化 → view.patch，另一端 setData/映射后显示。
   ================================================================== */
const VIEW_PAGE_OF_TAB = { tools: 'menu', scan: 'scan', modscan: 'modscan', serial: 'serial', rtu: 'rtu', module: 'uart' };
const TAB_OF_VIEW_PAGE = { menu: 'tools', scan: 'scan', modscan: 'modscan', serial: 'serial', rtu: 'rtu', uart: 'module' };
const MODSCAN_TAB_TO_AREA = { 0: '01', 1: '02', 2: '04', 3: '03' };
const MODSCAN_AREA_TO_TAB = { '01': 0, '02': 1, '04': 2, '03': 3 };
const PHONE_BAUDS = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200'];

function viewPageOfTab(tab) { return VIEW_PAGE_OF_TAB[tab] || 'menu'; }

// 切页/被远端切页时，别让上一页的轮询或循环发送在后台继续抢 485
function stopTasksForTab(nextTab) {
  if (nextTab !== 'modscan' && app.modscan.polling) stopPolling(true);
  if (nextTab !== 'serial' && app.serial.looping) stopSerialLoop(true);
}

/** 控制端切页：让现场手机跟着打开同一页 */
function sendViewFollow(tab) {
  if (!app.joined || !gwReady() || gwLink() !== 'ble') return;
  const page = viewPageOfTab(tab || app.activeTab);
  const data = desktopViewSnapshot(page);
  app.viewLast = page + '|' + JSON.stringify(data);
  send('view.follow', { page, data }, { quiet: true, noRetry: true, timeout: 4000 }).catch(() => {});
}

function scheduleDesktopView() {
  if (app.viewApplying) return;
  clearTimeout(app.viewTimer);
  app.viewTimer = setTimeout(() => {
    app.viewTimer = null;
    if (!app.joined || !gwReady() || gwLink() !== 'ble' || app.viewApplying) return;
    const page = viewPageOfTab(app.activeTab);
    const data = desktopViewSnapshot(page);
    const key = page + '|' + JSON.stringify(data);
    if (key === app.viewLast) return;
    app.viewLast = key;
    send('view.patch', { page, data }, { quiet: true, noRetry: true, timeout: 4000 }).catch(() => {});
  }, 200);
}

/** 桌面端页面 → 现场页面同构 data 快照（字段与小程序页面一致） */
function desktopViewSnapshot(page) {
  if (page === 'scan') {
    const s = app.scan;
    const span = Math.max(1, s.end - s.start + 1);
    const done = s.running ? clamp(s.cur - s.start + 1, 0, span) : (s.done ? span : 0);
    return {
      running: !!s.running, scanned: !!s.done, cur: num(s.cur, 0), total: span,
      pct: Math.round(done / span * 100), etaText: '', found: (s.list || []).slice(),
      startAddr: String(s.start), endAddr: String(s.end), reg: String(s.reg),
      regMode: 'dec', timeout: String(s.timeout), unsupported: false
    };
  }
  if (page === 'modscan') {
    const ms = app.modscan;
    const meta = AREA_META[ms.area] || AREA_META['03'];
    return {
      activeTab: MODSCAN_AREA_TO_TAB[ms.area] === undefined ? 3 : MODSCAN_AREA_TO_TAB[ms.area],
      fcNow: meta.fc,
      slaveId: num(ms.slave, 1), address: String(ms.start),
      addrMode: /^0x/i.test(String(ms.start)) ? 'hex' : 'dec',
      quantity: num(ms.count, 10), interval: num(ms.interval, 500),
      byteOrder: 'MSB',
      scanFormatIdx: { Binary: 0, Hex: 1, Unsigned: 2, Signed: 3, 'LongInt(32)': 4, 'Float(32)': 5, 'Double(64)': 6 }[ms.format] ?? 2,
      scanFormatLabel: ms.format,
      polling: !!ms.polling, scanCount: ms.round,
      pollStats: ms.ok + '/' + ms.timeout + '/' + ms.err,
      sOk: ms.ok, sTo: ms.timeout, sEr: ms.err, lastErr: null,
      dataList: (ms.rows || []).map((r) => ({
        addrLabel: r.addrLabel, addr: r.addr, value: r.val,
        hex: '0x' + hex4(r.raw), rawVal: r.raw, changed: !!r.changed
      }))
    };
  }
  if (page === 'serial') {
    const s = app.serial;
    const logs = (app.packets || [])
      .filter((p) => p.dir === 'TX' || p.dir === 'RX')
      .slice(0, 40)
      .reverse()
      .map((p, i) => ({
        id: i + 1,
        dir: p.dir,
        time: p.t || '',
        hex: p.hex || '',
        ascii: String(p.hex || '').replace(/[^0-9a-fA-F]/g, '').replace(/../g, (b) => {
          const c = parseInt(b, 16);
          return (c >= 32 && c <= 126) ? String.fromCharCode(c) : '.';
        }),
        len: p.len || 0,
        note: p.note || ''
      }));
    return {
      txMode: s.mode, txText: s.payload, appendCr: !!s.appendCr, appendLf: !!s.appendLf,
      crcOn: !!s.crcOn, crcText: crcHexOf(s.payload),
      loopOn: !!s.looping, loopInterval: String(s.loopMs),
      txCount: s.txCount, rxCount: s.rxCount,
      logMode: s.mode, autoScroll: true,
      logs: logs.length ? logs : undefined
    };
  }
  if (page === 'rtu') {
    const r = app.rtu;
    return {
      targetSlave: r.slave, targetText: String(r.slave),
      readAt: r.readAt, readTitle: '寄存器读取',
      readOk: (r.rows || []).filter((it) => it.read).length,
      readBad: (r.rows || []).filter((it) => it.err).length,
      readDone: (r.rows || []).length,
      readTotal: (r.rows || []).length,
      readRows: (r.rows || []).filter((it) => it.read).map((it, i) => ({
        idx: i, name: it.name, addrHex: '0x' + hex4(it.addr),
        fcName: 'FC' + (it.fc === 16 ? '10' : '06'),
        valueText: PRESET.labelOf(it, it.cur), rawHex: '0x' + hex4(it.cur),
        bad: false, nowText: clock()
      })),
      busy: !!r.reading, busyLabel: r.reading ? '读取中' : ''
    };
  }
  if (page === 'uart') {
    const e = app.module.edit;
    const bi = PHONE_BAUDS.indexOf(String(e.baud));
    return {
      baudIndex: bi < 0 ? 3 : bi, dataBits: e.dataBits, stopBits: e.stopBits,
      parity: e.parity,
      summary: e.baud + ' · ' + e.dataBits + e.parity + e.stopBits,
      dirty: !!app.module.dirty,
      busy: !!(app.module.reading || app.module.writing),
      busyLabel: app.module.reading ? '读取中' : ''
    };
  }
  return {};
}

/** 现场页面 → 桌面端视图（只覆盖能对应的字段） */
function applyDesktopView(page, d) {
  d = d || {};
  if (page === 'scan') {
    if (d.running !== undefined) app.scan.running = !!d.running;
    if (d.scanned !== undefined) app.scan.done = !!d.scanned;
    if (d.cur !== undefined) app.scan.cur = num(d.cur, app.scan.cur);
    if (Array.isArray(d.found)) {
      app.scan.list = d.found.filter((x) => typeof x === 'number');
      app.scan.found = app.scan.list.length;
    }
    if (d.startAddr !== undefined) app.scan.start = clamp(num(d.startAddr, app.scan.start), 1, 247);
    if (d.endAddr !== undefined) app.scan.end = clamp(num(d.endAddr, app.scan.end), app.scan.start, 247);
    if (d.reg !== undefined) app.scan.reg = clamp(num(d.reg, app.scan.reg), 0, 65535);
    if (d.timeout !== undefined) app.scan.timeout = clamp(num(d.timeout, app.scan.timeout), 20, 1000);
    return;
  }
  if (page === 'modscan') {
    const ms = app.modscan;
    if (d.activeTab !== undefined) ms.area = MODSCAN_TAB_TO_AREA[num(d.activeTab, 3)] || '03';
    if (d.slaveId !== undefined) ms.slave = clamp(num(d.slaveId, ms.slave), 1, 247);
    if (d.address !== undefined) ms.start = String(d.address);
    if (d.quantity !== undefined) ms.count = clamp(num(d.quantity, ms.count), 1, 120);
    if (d.interval !== undefined) ms.interval = Math.max(200, num(d.interval, ms.interval));
    if (d.scanFormatLabel) {
      const f = String(d.scanFormatLabel);
      ms.format = /Signed|LongInt|Float|Double/.test(f) ? 'Signed' : (/Hex|Binary/.test(f) ? 'Hex' : 'Unsigned');
    }
    // 对端在轮询时，桌面端只显示；但自己的定时器不能因为"自己的镜像回传 true"被误停
    if (d.polling === false) {
      stopPolling(true);
      ms.polling = false;
    } else if (d.polling === true) {
      ms.polling = true;
    }
    if (d.scanCount !== undefined) ms.round = num(d.scanCount, ms.round);
    if (d.sOk !== undefined) ms.ok = num(d.sOk, ms.ok);
    if (d.sTo !== undefined) ms.timeout = num(d.sTo, ms.timeout);
    if (d.sEr !== undefined) ms.err = num(d.sEr, ms.err);
    if (Array.isArray(d.dataList)) {
      const t = clock();
      ms.rows = d.dataList.map((r) => ({
        addr: num(r.addr, 0), raw: num(r.rawVal, 0), val: String(r.value == null ? '' : r.value),
        addrLabel: r.addrLabel || ('4' + String(num(r.addr, 0) + 1).padStart(4, '0')),
        desc: '寄存器 ' + num(r.addr, 0), changed: !!r.changed, t
      }));
      ms.prev = {};
      ms.rows.forEach((r) => { ms.prev[r.addr] = r.raw; });
      ms.at = t;
    }
    return;
  }
  if (page === 'serial') {
    const s = app.serial;
    if (d.txMode !== undefined) s.mode = d.txMode === 'ASCII' ? 'ASCII' : 'HEX';
    if (d.txText !== undefined) s.payload = String(d.txText);
    if (d.appendCr !== undefined) s.appendCr = !!d.appendCr;
    if (d.appendLf !== undefined) s.appendLf = !!d.appendLf;
    if (d.crcOn !== undefined) s.crcOn = !!d.crcOn;
    if (d.loopInterval !== undefined) s.loopMs = clamp(num(d.loopInterval, s.loopMs), 100, 60000);
    if (d.loopOn === false) {
      stopSerialLoop(true);
      s.looping = false;
    } else if (d.loopOn === true) {
      s.looping = true;
    }
    if (d.txCount !== undefined) s.txCount = num(d.txCount, s.txCount);
    if (d.rxCount !== undefined) s.rxCount = num(d.rxCount, s.rxCount);
    if (Array.isArray(d.logs) && d.logs.length) {
      // 对端串口页的帧也进桌面报文流（logs 是按时间正序，packets 是最新在上）
      // 先把同帧的 20 字节分段合并成一整帧（此时仍是时间正序），再翻转成最新在上
      const merged = MB.mergeHexSegments(d.logs.map((l) => ({
        dir: l.dir,
        hex: l.hex,
        note: l.note,
        t: l.time
      })));
      app.packets = merged.reverse().map((l, i) => ({
        dir: String(l.dir || 'SYS').toUpperCase(),
        hex: l.hex || '',
        note: l.note || '',
        t: l.t || '',
        len: l.hex ? l.hex.replace(/[^0-9A-Fa-f]/g, '').length / 2 : 0,
        at: Date.now() - i
      })).slice(0, 240);
    }
    return;
  }
  if (page === 'rtu') {
    const r = app.rtu;
    if (d.targetSlave !== undefined) r.slave = clamp(num(d.targetSlave, r.slave), 1, 247);
    if (d.profileId && String(d.profileId) !== r.profileId) {
      r.profileId = String(d.profileId);
      ensureRtuRows();
    }
    if (Array.isArray(d.readRows)) {
      d.readRows.forEach((rr) => {
        const addr = parseInt(String(rr.addrHex || '').replace(/^0x/i, ''), 16);
        const it = (r.rows || []).find((x) => x.addr === addr) ||
          (r.rows || []).find((x) => String(x.name) === String(rr.name));
        if (!it) return;
        const raw = parseInt(String(rr.rawHex || '').replace(/^0x/i, ''), 16);
        it.cur = isNaN(raw) ? null : raw;
        it.read = !rr.bad && !isNaN(raw);
        it.err = it.read ? '' : '读取失败';
      });
      r.hasRead = d.readRows.some((x) => !x.bad);
      r.readAt = clock();
    }
    if (d.busy !== undefined) r.reading = !!d.busy;
    return;
  }
  if (page === 'uart') {
    if (d.baudIndex !== undefined) {
      const b = PHONE_BAUDS[num(d.baudIndex, 3)] || '9600';
      const u = {
        baud: b, dataBits: String(d.dataBits || '8'),
        parity: String(d.parity || 'N').toUpperCase(), stopBits: String(d.stopBits || '1')
      };
      app.module.cur = u;
      if (!app.module.dirty) app.module.edit = Object.assign({}, u);
      if (app.gw) app.gw.uart = Object.assign({}, u);
    }
    if (d.dirty !== undefined) app.module.dirty = !!d.dirty;
    return;
  }
}

/** 收到 host 的 view：切页 + 套用状态（不再反向发 patch） */
function applyHostView(pl) {
  if (!pl || !pl.page) return;
  // 自己发出的 patch 经 host 回显时不再套用：桌面端的轮询/循环定时器不能被自己的镜像停掉
  if (pl.source === 'desktop') return;
  if (pl.rev && pl.rev <= app.viewRev) return;
  app.viewRev = pl.rev || (app.viewRev + 1);
  const sameKey = pl.page + '|' + JSON.stringify(pl.data || {});
  if (sameKey === app.viewLast) return;
  const tab = TAB_OF_VIEW_PAGE[pl.page];
  app.viewApplying = true;
  try {
    if (tab && app.activeTab !== tab) {
      stopTasksForTab(tab);
      app.activeTab = tab;
    }
    applyDesktopView(pl.page, pl.data || {});
    app.viewLast = pl.page + '|' + JSON.stringify(pl.data || {});
    renderAll();
  } finally {
    app.viewApplying = false;
  }
}

/** 客户端组 RTU 帧 → raw.tx；固件只做门禁与透传，返回原始 rx */
async function rawTx(frame, expectLen, timeoutMs) {
  const hex = MB.bytesToHex(frame, ' ');
  pushPacket('TX', hex, 'raw.tx');
  const data = await send('raw.tx', {
    hex: hex,
    expectLen: expectLen || 0,
    timeoutMs: timeoutMs || 1500
  }, { quiet: true, noRetry: true, timeout: (timeoutMs || 1500) + 2800 });
  const rx = MB.hexToBytes(data && data.rx);
  if (rx.length) pushPacket('RX', MB.bytesToHex(rx, ' '), 'raw.tx 回包');
  return { rx, elapsed: num(data && data.elapsed, 0) };
}

async function readRegs(fc, slave, addr, qty) {
  const frame = MB.buildReadFrame(slave, fc, addr, qty);
  const { rx, elapsed } = await rawTx(frame, MB.expectedResponseLength(fc, qty), 1400);
  const p = MB.parseResponse(rx, fc, qty);
  if (!p.ok) throw Object.assign(new Error(gwErrText(p)), { parsed: p });
  return { values: p.values || [], bits: p.bits || [], elapsed, rx };
}

async function writeReg(fc, slave, addr, value) {
  const frame = fc === 16
    ? MB.buildWriteMultiFrame(slave, 16, addr, [value])
    : MB.buildWriteSingleFrame(slave, 6, addr, value);
  const { rx, elapsed } = await rawTx(frame, 8, 1600);
  const p = MB.parseResponse(rx, fc === 16 ? 16 : 6, 1);
  if (!p.ok) throw Object.assign(new Error(gwErrText(p)), { parsed: p });
  // 写后读回：FC03 同一地址，用实际寄存器值说话
  let readback = null;
  try {
    const rb = await readRegs(3, slave, addr, 1);
    readback = rb.values[0];
  } catch (e) { readback = null; }
  return { elapsed, readback };
}

function gwErrText(p) {
  if (!p) return '无响应';
  if (p.error === 'short') return '无响应或应答过短（检查站号 / 接线 / 波特率）';
  if (p.error === 'crc') return '应答 CRC 错误';
  if (p.error === 'exception') return '从站异常码 ' + p.exceptionCode;
  if (p.error === 'fc') return '应答功能码不匹配';
  return p.error || '解析失败';
}

/* ==================================================================
   顶栏 / 状态栏
   ================================================================== */
const TAB_META = [
  { key: 'tools', name: '工具', icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { key: 'scan', name: '扫描', icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 12l5.5-5.5"/>' },
  { key: 'modscan', name: 'Modscan', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/>' },
  { key: 'serial', name: '串口', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10l3 2.5L7 15M12 15h5"/>' },
  { key: 'rtu', name: 'RTU', icon: '<circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>' },
  { key: 'module', name: '模块', icon: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 6V3M15 6V3M9 21v-3M15 21v-3"/>' }
];
const TAB_LABEL = { tools: '工具总览', scan: '从站扫描', modscan: 'Modscan', serial: '串口调试', rtu: '快速设置 RTU', module: '模块设置' };
const TAB_PAGE = { tools: 'menu', scan: 'scan', modscan: 'modscan', serial: 'serial', rtu: 'rtu', module: 'uart' };

function tabOfPage(page) {
  const hit = Object.keys(TAB_PAGE).find((k) => TAB_PAGE[k] === page);
  return hit || 'tools';
}

function renderHeader() {
  const st = app.sess ? app.sess.status : 'idle';
  const serverText = {
    idle: '未连接', connecting: '连接服务器…', online: '服务器已连',
    offline: '链路断开，重连中', closed: '会话已结束'
  }[st] || st;
  const pServer = $('pillServer');
  $('txtServer').textContent = serverText;
  pServer.className = 't-pill ' + (st === 'online' ? 'ok' : (st === 'idle' || st === 'closed' ? '' : 'warn'));

  const online = !!app.peerOnline;
  const bleDown = !!(app.gw && app.gw.bleDown);
  const many = app.remoteCount > 1;
  $('txtFieldStatus').textContent = online
    ? (app.gw ? (bleDown ? '现场蓝牙断开 · BLE 代理暂停' : ('现场在线 · ' + gwLinkShort())) : '现场在线')
      + (many ? ' · ' + app.remoteCount + ' 台远程端' : '')
    : (app.joined ? '现场离线 · 等待重连' : '现场离线');
  $('pillField').className = 't-pill ' + (online && !bleDown ? 'ok' : 'warn');

  const u = app.gw && app.gw.uart;
  $('hdrUartSummary').textContent = u
    ? ('485: ' + u.baud + ' · ' + u.dataBits + u.parity + u.stopBits)
    : '485: —';
  $('pillUart').className = 't-pill' + (u ? ' ok' : '');

  renderRoleBox();
  $('syncBleName').textContent = app.gw ? app.gw.name : '—';
  $('syncFieldPage').textContent = TAB_LABEL[app.activeTab] || app.activeTab;

  const cfgBits = [];
  if (app.gw) {
    if (app.gw.nvs) cfgBits.push('NVS v' + app.gw.nvs);
    if (app.gw.ssid) cfgBits.push('SSID ' + app.gw.ssid);
  }
  $('hdrCfgSummary').textContent = cfgBits.length ? cfgBits.join(' · ') : 'NVS: —';
  $('pillCfg').className = 't-pill' + (cfgBits.length ? ' ok' : '');
}

/** 顶栏「控制端 / 旁看」胶囊：多端在线时才显示 */
function renderRoleBox() {
  const box = $('roleBox');
  const btn = $('takeoverBtn');
  if (!box) return;
  const multi = app.joined && app.remoteCount > 1;
  box.hidden = !multi;
  if (!multi) return;
  const pill = $('pillRole');
  const ctl = app.isController;
  $('txtRole').textContent = ctl
    ? ('控制端 · 另有 ' + Math.max(0, app.remoteCount - 1) + ' 台旁看')
    : ('旁看 · ' + (app.ctlName || '对方') + ' 操作中');
  pill.className = 't-pill ' + (ctl ? 'ok' : 'warn');
  if (btn) btn.hidden = ctl;
}

function setBusy(delta) {
  app.busyCount = Math.max(0, app.busyCount + delta);
}

function renderStatusbar() {
  const rb = $('sbResultText');
  if (rb) {
    rb.textContent = app.result.text;
    rb.className = app.result.ok ? 'ok' : 'err';
  }
}

function renderNav() {
  const nav = $('navTabs');
  nav.innerHTML = '';
  TAB_META.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'nav-tab' + (app.activeTab === t.key ? ' on' : '');
    b.dataset.tab = t.key;
    b.title = '切换到「' + t.name + '」';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + t.icon + '</svg>' + esc(t.name);
    b.addEventListener('click', () => onNavTab(t.key));
    nav.appendChild(b);
  });
}

function onNavTab(key) {
  if (!app.joined) { setNotice('先输入协助码接入现场'); return; }
  if (gwReady()) {
    stopTasksForTab(key);
    app.activeTab = key;
    if (app.gw.link === 'ble') sendViewFollow(key);
    renderAll();
    return;
  }
  // 手机托管：切页要让现场真的打开那一页
  app.activeTab = key;
  send('nav.open', { page: TAB_PAGE[key] }, {
    okTitle: '已通知现场打开「' + TAB_LABEL[key] + '」',
    timeout: 8000
  }).catch(() => {});
  renderAll();
}

/* ==================================================================
   右栏：报文流 / 操作记录
   ================================================================== */
// 规范化 HEX：去掉所有非十六进制字符并转大写，用于判断“同一帧”
function normalizeHex(hex) { return String(hex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase(); }
// 是否带空格分隔（真机帧通常带空格，本地回显常为无空格）
function isSpacedHex(hex) { return /\s/.test(String(hex || '').trim()); }

// 任意 hex（带空格或纯连写）→ 每字节空格分隔、大写；空串原样返回
function spacedHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!clean) return '';
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(clean.slice(i, i + 2));
  return out.join(' ');
}

// 报文时间戳统一成墙钟 HH:MM:SS：
//   · 已是 HH:MM:SS → 原样；空 → 用当前时间；
//   · 固件 uptime 形如 "2736.093"（秒.毫秒，非墙钟）→ 显示本机当前时间（收到时刻）。
function fmtPacketTime(t) {
  const s = String(t == null ? '' : t).trim();
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) return s;
  return clock();
}

// 折叠“同一帧被连写两次”的情况，防止固件残余镜像导致重复显示：
//   仅在规范化后为偶数个字节、且前一半与后一半完全相同、且 >=4 字节时才折叠为一半。
//   ⚠️ 小概率误判：合法的两半完全相同帧（如 01 01 01 01）会被误折叠；固件已单独修复镜像，
//   此处仅作兜底保护，风险很低。
function collapseDoubleFrame(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!clean || clean.length % 4 !== 0) return hex; // 必须是正偶数个字节且能对半分
  const half = clean.length / 2;
  const a = clean.slice(0, half), b = clean.slice(half);
  if (a === b && a.length >= 8) { // 至少 4 字节，且完全重复
    return spacedHex(a);
  }
  return hex;
}

function pushPacket(dir, hex, note, t) {
  const d = String(dir || 'SYS').toUpperCase();
  let h = String(hex || '').trim();
  if (!h && d !== 'SYS') return;
  // 兜底：若整帧被连写两次，折叠为一半（同时得到空格分隔形式）
  h = collapseDoubleFrame(h);
  const now = Date.now();
  // 1.5s 内同方向、规范化后同 HEX 视为同一帧重复，只保留一条：
  //   - 精确 HEX 相同 → 直接丢弃；
  //   - 带空格 vs 无空格变体 → 折叠成一条，且只保留带空格的形式（绝不降级为无空格）。
  const nh = normalizeHex(h);
  const dup = app.packets.find((p) => p.dir === d && now - p.at < 1500 &&
    (p.hex === h || (nh && normalizeHex(p.hex) === nh)));
  if (dup) {
    if (note) dup.note = note;
    // 已存在无空格、而新来的是带空格 → 把已有条目升级为带空格形式
    if (nh && isSpacedHex(h) && !isSpacedHex(dup.hex)) dup.hex = h;
    return;
  }

  const len = h ? h.replace(/[^0-9A-Fa-f]/g, '').length / 2 : 0;
  app.packets.unshift({ dir: d, hex: h, note: note || '', t: t || clock(), wt: clock(), len, at: now });
  if (app.packets.length > 240) app.packets.length = 240;
  if (d === 'TX') app.txBytes += len;
  if (d === 'RX') app.rxBytes += len;
  renderDock();
}

function pushOp(level, title, desc) {
  const now = Date.now();
  const last = app.ops[0];
  if (last && last.title === title && last.level === (level || 'info') && now - last.at < 4000) {
    last.count = (last.count || 1) + 1;
    last.t = clock();
    last.at = now;
    if (desc) last.desc = desc;
    renderDock();
    return;
  }
  app.ops.unshift({ level: level || 'info', title: title || '', desc: desc || '', t: clock(), count: 1, at: now });
  if (app.ops.length > 200) app.ops.length = 200;
  renderDock();
}

function renderDock() {
  $('pktCountBadge').textContent = app.packets.length;
  $('opsCountBadge').textContent = app.ops.length;
  $('statTxBytes').textContent = app.txBytes;
  $('statRxBytes').textContent = app.rxBytes;

  const pktList = $('packetList');
  if (!app.packets.length) {
    pktList.innerHTML = '<div class="empty-state"><b>暂无报文</b>接入网关链路后，485 收发的每一帧都会出现在这里。</div>';
  } else {
    pktList.innerHTML = app.packets.map((p) => {
      const cls = p.dir === 'TX' ? 'tx' : (p.dir === 'RX' ? 'rx' : 'err');
      return '<div class="pkt-line ' + cls + '" data-hex="' + esc(p.hex) + '" title="点击复制此帧 HEX">' +
        '<div class="pkt-meta"><span><span class="pkt-dir">' + esc(p.dir) + '</span> ' +
        (p.len ? p.len + 'B' : '') + (p.note ? ' · ' + esc(p.note) : '') + '</span>' +
        '<span>' + esc(p.wt || fmtPacketTime(p.t)) + '</span></div>' +
        '<div class="mono">' + (esc(spacedHex(p.hex)) || esc(p.note)) + '</div></div>';
    }).join('');
  }

  const opList = $('opLogList');
  if (!app.ops.length) {
    opList.innerHTML = '<div class="empty-state"><b>暂无操作记录</b>接入、切页、读写的每一步都会留痕。</div>';
  } else {
    opList.innerHTML = app.ops.map((o) => {
      const cls = o.level === 'ok' ? '' : (o.level === 'err' ? 'err' : (o.level === 'warn' ? 'warn' : 'info'));
      return '<div class="op-item ' + cls + '"><div class="op-top"><span>' + esc(o.t) + '</span>' +
        (o.count > 1 ? '<span class="op-cnt">连续 ×' + o.count + '</span>' : '') + '</div>' +
        '<div class="op-title">' + esc(o.title) + '</div>' +
        (o.desc ? '<div class="op-desc">' + esc(o.desc) + '</div>' : '') + '</div>';
    }).join('');
  }

  // Tab 切换：只显示当前激活的面板，另一个隐藏
  const onPk = app.dockTab === 'ops' ? false : true;
  const pktPane = $('panePackets');
  const opsPane = $('paneOps');
  if (pktPane) pktPane.style.display = onPk ? 'flex' : 'none';
  if (opsPane) opsPane.style.display = onPk ? 'none' : 'flex';
  const tabPk = $('dockTabPackets');
  const tabOps = $('dockTabOps');
  if (tabPk) tabPk.classList.toggle('on', onPk);
  if (tabOps) tabOps.classList.toggle('on', !onPk);
  renderHeader();
}

/* ==================================================================
   主工作区
   ================================================================== */
function render() { renderAll(); }

function renderAll() {
  renderHeader();
  renderNav();
  renderStage();
  renderDock();
  renderStatusbar();
}

function renderStage() {
  const stage = $('mainStage');
  if (!app.joined) { stage.innerHTML = buildJoinHint(); return; }
  if (!gwReady() && app.mirror && app.activeTab !== 'tools') {
    stage.innerHTML = buildMirrorView();
    return;
  }
  switch (app.activeTab) {
    case 'scan':
      stage.innerHTML = buildScanView();
      renderScanLive();
      break;
    case 'modscan':
      stage.innerHTML = buildModscanView();
      break;
    case 'serial':
      stage.innerHTML = buildSerialView();
      break;
    case 'rtu':
      stage.innerHTML = buildRtuView();
      break;
    case 'module':
      stage.innerHTML = buildModuleView();
      break;
    default:
      stage.innerHTML = buildToolsView();
  }
  scheduleDesktopView();
}

function buildJoinHint() {
  return '<div class="join-hint">' +
    '<h3>接入现场</h3>' +
    '<p>输入 7 位协助码，点「接入」。</p>' +
    '<div class="join-note">Broker：<b class="mono">' +
    esc(buildWsUrl(MQTT_CONFIG_FROM(loadBroker())) || '未配置（点右上角「设置」）') + '</b></div>' +
    '</div>';
}

/* ---------------- 工具总览 ---------------- */
function buildToolsView() {
  const cards = [
    {
      key: 'scan', title: '从站扫描 (1~247)', icon: '扫',
      stat: app.scan.list.length ? ('已发现 ' + app.scan.list.length + ' 台 (# ' + app.scan.list.slice(0, 6).join(', ') + ')') : '尚未扫描'
    },
    {
      key: 'modscan', title: 'Modscan 四区表格', icon: '表',
      stat: app.modscan.rows.length ? ('监控 ' + app.modscan.rows.length + ' 个寄存器 · ' + app.modscan.round + ' 轮') : '尚未读取'
    },
    {
      key: 'serial', title: '串口调试助手', icon: '串',
      stat: 'TX ' + app.txBytes + 'B / RX ' + app.rxBytes + 'B'
    },
    {
      key: 'rtu', title: '快速设置 RTU 参数', icon: '设',
      stat: app.rtu.hasRead ? ('已读取 ' + app.rtu.readAt) : ('模板 ' + profileOf().name)
    },
    {
      key: 'module', title: '蓝牙模块设置', icon: '模',
      stat: (app.gw ? app.gw.name : '—') + ' · ' + (app.gw && app.gw.uart ? (app.gw.uart.baud + ' ' + app.gw.uart.dataBits + app.gw.uart.parity + app.gw.uart.stopBits) : '参数未读取')
    }
  ];

  return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px">' +
    cards.map((c) => '<button class="scan-card" data-act="open" data-tab="' + c.key + '" style="display:flex;flex-direction:column;gap:6px">' +
      '<div class="scan-card-top"><span class="tag info">' + esc(c.icon) + '</span><span style="color:var(--ink-3);font-size:11.5px">打开 ›</span></div>' +
      '<div style="font-size:13.5px;font-weight:600;color:var(--ink);margin-top:4px">' + esc(c.title) + '</div>' +
      '<div class="mono" style="font-size:11px;color:var(--accent);text-align:left">' + esc(c.stat) + '</div>' +
      '</button>').join('') +
    '</div>' +
    (app.mirror && !gwReady() ? buildMirrorCard() : '');
}

/* ---------------- 镜像页（手机托管 fallback） ---------------- */
function buildMirrorCard() {
  if (!app.mirror) return '';
  const rows = app.widgets.map((w) => mirrorRow(w)).join('');
  return '<div class="w-card"><div class="w-card-hd">' +
    '<div class="w-card-title">现场镜像 · ' + esc(TAB_LABEL[tabOfPage(app.pageId)] || app.pageId) +
    '</div>' +
    '<button class="btn sm" data-act="mirror-sync">重新同步</button></div>' +
    '<div class="w-card-bd"><div class="mirror-wrap">' + (rows || '<div class="empty-state">现场页面没有可操作控件</div>') + '</div></div></div>';
}

function mirrorRow(w) {
  const type = w.type || 'readonly';
  if (type === 'button') {
    return '<div class="mirror-row' + (w.risk === 'high' ? ' risk' : '') + '" data-act="mirror-tap" data-id="' + esc(w.id) + '">' +
      '<div class="mirror-l"><div class="mirror-name">' + esc(w.label || w.id) + '</div></div>' +
      '<div class="mirror-go">' + (w.risk === 'high' ? '⚠ 执行' : '执行') + ' ›</div></div>';
  }
  const val = (w.value === undefined || w.value === null) ? '—' : String(w.value);
  return '<div class="mirror-row' + (type === 'readonly' ? ' disabled' : '') + (w.risk === 'high' ? ' risk' : '') +
    '"' + (type === 'readonly' ? '' : ' data-act="mirror-edit" data-id="' + esc(w.id) + '"') + '>' +
    '<div class="mirror-l"><div class="mirror-name">' + esc(w.label || w.id) + '</div>' +
    (w.hint ? '<div class="mirror-hint">' + esc(w.hint) + '</div>' : '') + '</div>' +
    '<div class="mirror-val">' + esc(val) + '</div>' +
    (type === 'readonly' ? '' : '<div class="mirror-go">改 ›</div>') + '</div>';
}

function buildMirrorView() {
  return buildMirrorCard();
}

/* ---------------- Modscan ---------------- */
const AREA_META = {
  '03': { fc: 3, label: '03 保持寄存器 (4x)', kind: 'plc4' },
  '04': { fc: 4, label: '04 输入寄存器 (3x)', kind: 'plc3' },
  '02': { fc: 2, label: '02 离散输入 (1x)', kind: 'plc1' },
  '01': { fc: 1, label: '01 线圈状态 (0x)', kind: 'plc0' }
};

function buildModscanView() {
  const ms = app.modscan;
  return '<div class="w-card ms-toolbar"><div class="w-card-bd" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">' +
    '<div class="seg" id="segMsArea">' +
    Object.keys(AREA_META).map((k) => '<button class="seg-i' + (ms.area === k ? ' on' : '') + '" data-act="ms-area" data-a="' + k + '">' + AREA_META[k].label + '</button>').join('') +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
    '<span class="mono" style="font-size:12px;color:var(--ink-2)">第 <b>' + ms.round + '</b> 轮 · ' +
    '<span style="color:var(--rx)">成功 ' + ms.ok + '</span> · ' +
    '<span style="color:var(--warn)">超时 ' + ms.timeout + '</span> · ' +
    '<span style="color:var(--danger)">错误 ' + ms.err + '</span></span>' +
    '<button class="btn sm" data-act="ms-read">单次读取</button>' +
    '<button class="btn ' + (ms.polling ? 'danger' : 'primary') + '" data-act="ms-poll">' +
    (ms.polling ? '■ 停止轮询 (' + ms.interval + 'ms)' : '▶ 启动连续扫描') + '</button>' +
    '</div></div></div>' +

    '<div style="display:grid;grid-template-columns:260px minmax(0,1fr);gap:14px;align-items:start">' +
    '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">扫描参数</div>' +
    '</div>' +
    '<div class="w-card-bd" style="display:flex;flex-direction:column;gap:10px">' +
    '<div class="f-item"><div class="f-label"><span>从站站号 (1~247)</span></div>' +
    '<input class="ipt sm mono" data-field="msSlave" value="' + esc(ms.slave) + '"></div>' +
    '<div class="f-item"><div class="f-label"><span>起始地址</span><span class="mono" style="color:var(--accent)">' +
    esc(hexAddr(AREA_META[ms.area].kind, parseAddrSafe(ms.start, AREA_META[ms.area].fc))) + '</span></div>' +
    '<input class="ipt sm mono" data-field="msStart" value="' + esc(ms.start) + '"></div>' +
    '<div class="f-item"><div class="f-label"><span>读取数量 (1~120)</span></div>' +
    '<input class="ipt sm mono" data-field="msCount" value="' + esc(ms.count) + '"></div>' +
    '<div class="f-item"><div class="f-label"><span>扫描间隔 (ms)</span></div>' +
    '<input class="ipt sm mono" data-field="msInterval" value="' + esc(ms.interval) + '"></div>' +
    '<div class="f-item"><div class="f-label"><span>数据显示格式</span></div>' +
    '<select class="ipt sm" data-field="msFormat">' +
    ['Unsigned', 'Signed', 'Hex'].map((f) => '<option value="' + f + '"' + (ms.format === f ? ' selected' : '') + '>' + f + '</option>').join('') +
    '</select></div>' +
    '</div></div>' +

    '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">实时寄存器数据表</div>' +
    '<span class="tag tx">变值行赭红高亮</span></div>' +
    '<div class="w-card-bd tight"><table class="data-tbl"><thead><tr>' +
    '<th>寄存器地址</th><th>HEX 偏移</th><th>当前数值</th><th>HEX 原始值</th><th>刷新时间</th><th>远程改写</th>' +
    '</tr></thead><tbody id="msBody">' + modscanRowsHTML() + '</tbody></table></div>' +
    '<div class="w-card-ft"><span>' + (ms.at ? '最后刷新 ' + esc(ms.at) : '尚未读取') + '</span></div></div>' +
    '</div>';
}

function modscanRowsHTML() {
  const ms = app.modscan;
  if (!ms.rows.length) {
    return '<tr><td colspan="6"><div class="empty-state"><b>还没有数据</b>设置站号 / 起始地址后点「单次读取」或「启动连续扫描」。</div></td></tr>';
  }
  return ms.rows.map((r, i) =>
    '<tr><td class="mono"><b>' + esc(r.addrLabel) + '</b></td>' +
    '<td class="mono" style="color:var(--ink-3)">0x' + hex4(r.addr) + '</td>' +
    '<td><span class="val-pill' + (r.changed ? ' chg' : '') + '">' + esc(r.val) + (r.changed ? ' ↑' : '') + '</span></td>' +
    '<td class="mono" style="color:var(--accent)">0x' + hex4(r.raw) + '</td>' +
    '<td class="mono" style="font-size:11px;color:var(--ink-3)">' + esc(r.t) + '</td>' +
    '<td><button class="btn sm" data-act="ms-write" data-i="' + i + '">写值 ›</button></td></tr>'
  ).join('');
}

function parseAddrSafe(raw, fc) {
  // 桌面端只做展示换算：PLC 前缀去掉后 -1；0x 直接解析
  const s = String(raw || '').trim();
  if (/^0[xX]/.test(s)) { const n = parseInt(s.slice(2), 16); return isNaN(n) ? 0 : n; }
  if (!/^\d+$/.test(s)) return 0;
  const prefix = { 1: '', 2: '1', 3: '4', 4: '3' }[fc] || '';
  let digits = s;
  if (prefix && s.length >= 5 && s.charAt(0) === prefix) digits = s.slice(1);
  const n = parseInt(digits, 10);
  return isNaN(n) ? 0 : Math.max(0, n - 1);
}

function parseAddrChecked(raw, fc) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, msg: '起始地址不能为空', value: 0 };
  if (/^0[xX]/.test(s)) {
    const n = parseInt(s.slice(2), 16);
    if (isNaN(n)) return { ok: false, msg: 'HEX 地址不合法，如 0x0000', value: 0 };
    return { ok: true, value: n & 0xFFFF };
  }
  if (!/^\d+$/.test(s)) return { ok: false, msg: 'DEC 模式只能填数字；十六进制请加 0x 前缀', value: 0 };
  const prefix = { 1: '', 2: '1', 3: '4', 4: '3' }[fc] || '';
  let digits = s;
  if (prefix && s.length >= 5 && s.charAt(0) === prefix) digits = s.slice(1);
  const n = parseInt(digits, 10);
  if (isNaN(n) || n < 1) return { ok: false, msg: '地址从 1 开始（如 40001）', value: 0 };
  return { ok: true, value: (n - 1) & 0xFFFF };
}

function formatValue(v, fmt) {
  if (fmt === 'Signed') return String(v >= 0x8000 ? v - 0x10000 : v);
  if (fmt === 'Hex') return '0x' + hex4(v);
  return String(v);
}

/* 协助模式：把当前 Modscan 表单推给手机页面（slaveId/address/quantity/interval/tab），
   让 modscan32.js 页面拿到「桌面端现在想扫什么」，随后由 poll 切换驱动它本地读取。
   结果经 view-sync 回灌到 app.modscan.rows，本地无需解析 BLE 应答。 */
async function modscanPushFormAssist() {
  const ms = app.modscan;
  const tab = MODSCAN_AREA_TO_TAB[ms.area] === undefined ? 3 : MODSCAN_AREA_TO_TAB[ms.area];
  const steps = [
    { page: 'modscan', widgetId: 'tab', value: String(tab) },
    { page: 'modscan', widgetId: 'input.slaveId', value: String(ms.slave) },
    { page: 'modscan', widgetId: 'input.address', value: String(ms.start) },
    { page: 'modscan', widgetId: 'input.quantity', value: String(ms.count) },
    { page: 'modscan', widgetId: 'input.interval', value: String(ms.interval) }
  ];
  for (const p of steps) {
    try { await send('ui.action', p, { quiet: true, noRetry: true, timeout: 8000 }); }
    catch (e) { setNotice('Modscan 同步失败：' + ((e && e.message) || '小程序页面执行失败')); return false; }
  }
  return true;
}

async function modscanReadOnce() {
  const ms = app.modscan;
  if (!gwReady()) { setNotice('Modscan 需要网关链路（BLE 小程序代理 / ESP32 直连）'); return; }
  if (!app.joined || ms.busy) return;
  const meta = AREA_META[ms.area];
  const addrChk = parseAddrChecked(ms.start, meta.fc);
  if (!addrChk.ok) { setNotice(addrChk.msg); return; }
  ms.slave = clamp(num(ms.slave, 1), 1, 247);
  ms.count = clamp(num(ms.count, 10), 1, 120);
  // 协助模式：不在本地 rawTx；仅推表单并在未轮询时翻转一次 poll 让手机读一轮
  if (bleAssistMode()) {
    if (ms.polling) return; // 手机轮询已在产数据，无需再触发
    ms.busy = true;
    try {
      if (await modscanPushFormAssist()) {
        await send('ui.action', { page: 'modscan', widgetId: 'poll' }, { quiet: true, noRetry: true, timeout: 15000 });
        pushOp('info', 'Modscan 读取（小程序协助）', '站号 #' + ms.slave + ' · ' + ms.count + ' 个');
      }
    } catch (e) {
      setNotice('Modscan 读取失败：' + ((e && e.message) || '小程序页面执行失败'));
    } finally {
      ms.busy = false;
      if (app.activeTab === 'modscan') {
        const body = $('msBody');
        if (body) body.innerHTML = modscanRowsHTML();
      }
      renderStatusbar();
      scheduleDesktopView();
    }
    return;
  }
  ms.busy = true;
  try {
    const r = await readRegs(meta.fc, ms.slave, addrChk.value, ms.count);
    const t = clock();
    const values = meta.fc <= 2 ? (r.bits || []).slice(0, ms.count) : (r.values || []);
    const prev = ms.prev || {};
    ms.rows = values.map((v, i) => {
      const addr = (addrChk.value + i) & 0xFFFF;
      const changed = prev[addr] !== undefined && prev[addr] !== v;
      return {
        addr, raw: v, val: formatValue(v, ms.format),
        addrLabel: hexAddr(meta.kind, addr),
        desc: meta.fc <= 2 ? ('位 ' + (addrChk.value + i) + ' · ' + (v ? 'ON' : 'OFF'))
          : ('寄存器 ' + (addrChk.value + i)),
        changed, t
      };
    });
    ms.prev = {};
    values.forEach((v, i) => { ms.prev[(addrChk.value + i) & 0xFFFF] = v; });
    ms.round += 1; ms.ok += 1; ms.at = t;
    app.result = { text: 'FC0' + meta.fc + ' OK (' + (r.elapsed || 0) + 'ms)', ok: true };
  } catch (e) {
    ms.err += 1;
    app.result = { text: (e.message || '读取失败'), ok: false };
    pushOp('err', 'Modscan 读取失败', (e.message || '') + ' · 站号 ' + ms.slave + ' · ' + ms.count + ' 个');
  } finally {
    ms.busy = false;
    if (app.activeTab === 'modscan') {
      const body = $('msBody');
      if (body) body.innerHTML = modscanRowsHTML();
    }
    renderStatusbar();
    scheduleDesktopView();
  }
}

function startPolling() {
  stopPolling();
  app.modscan.polling = true;
  pushOp('info', '启动 Modscan 连续扫描', '站号 #' + app.modscan.slave + ' · ' + app.modscan.count + ' 个 · 间隔 ' + app.modscan.interval + 'ms');
  // 协助模式：推表单后翻转一次 poll，让手机页面本地起轮询；本地不起 rawTx 定时器（结果经 view-sync 回灌）
  if (bleAssistMode()) {
    (async () => {
      if (await modscanPushFormAssist()) {
        try { await send('ui.action', { page: 'modscan', widgetId: 'poll' }, { quiet: true, noRetry: true, timeout: 15000 }); }
        catch (e) { setNotice('Modscan 轮询失败：' + ((e && e.message) || '小程序页面执行失败')); }
      }
      renderStage();
      renderStatusbar();
      scheduleDesktopView();
    })();
    renderStage();
    renderStatusbar();
    return;
  }
  modscanReadOnce();
  pollTimer = setInterval(() => {
    if (!app.joined || !gwReady()) { stopPolling(); return; }
    modscanReadOnce();
  }, Math.max(200, num(app.modscan.interval, 500)));
  renderStage();
  renderStatusbar();
}

function stopPolling(silent) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  var was = app.modscan.polling;
  if (was) {
    app.modscan.polling = false;
    if (!silent) pushOp('info', '停止 Modscan 扫描', '共完成 ' + app.modscan.round + ' 轮');
    // 协助模式：翻转一次 poll 让手机页面停止本地轮询
    if (bleAssistMode()) {
      send('ui.action', { page: 'modscan', widgetId: 'poll' }, { quiet: true, noRetry: true, timeout: 15000 }).catch(() => {});
    }
  }
  renderStatusbar();
  // ★ 立即重绘：否则按钮文字停在「停止轮询」，用户再点一次也不会有反应
  if (!silent && was && app.activeTab === 'modscan') renderStage();
}

function onMsWrite(i) {
  const r = app.modscan.rows[i];
  if (!r) return;
  const meta = AREA_META[app.modscan.area];
  openWriteModal({
    title: '写入' + (meta.fc <= 2 ? '线圈' : '保持寄存器') + ' ' + r.addrLabel,
    sub: '从站 #' + app.modscan.slave + ' · 地址 0x' + hex4(r.addr) + ' · 当前值 ' + r.val +
      ' · FC06 单寄存器写（自动暂停轮询并读回校验）',
    value: r.val,
    foot: '写完自动执行 FC03 读回比对',
    frameFor: (v) => MB.buildWriteSingleFrame(app.modscan.slave, 6, r.addr, v),
    onConfirm: async (v) => {
      const wasPolling = app.modscan.polling;
      if (wasPolling) stopPolling(true);
      setBusy(1);
      // 协助模式：把「改这一行」转发给手机页面 cell.<i>，由 onConfirmWrite 执行 FC06 + 读回；
      // 不调用 writeReg，也不重启本地 rawTx 轮询——结果经 view-sync 回灌。
      if (bleAssistMode()) {
        try {
          await send('ui.action', { page: 'modscan', widgetId: 'cell.' + i, value: String(v) }, {
            quiet: true, noRetry: true, timeout: 15000
          });
          pushOp('ok', '写入 ' + r.addrLabel + ' = ' + v, '小程序协助 FC06');
          app.result = { text: 'FC06 OK · 写入 ' + v, ok: true };
          toast('写入成功' + (wasPolling ? '，继续轮询' : ''), true);
        } catch (e) {
          pushOp('err', '写入失败 ' + r.addrLabel, (e && e.message) || '');
          setNotice('写入失败：' + ((e && e.message) || ''));
          app.result = { text: 'FC06 失败', ok: false };
        } finally {
          setBusy(-1);
          if (wasPolling) startPolling();
          else if (app.activeTab === 'modscan') { renderStage(); }
          renderStatusbar();
        }
        return;
      }
      try {
        await writeReg(6, app.modscan.slave, r.addr, v);
        pushOp('ok', '写入 ' + r.addrLabel + ' = ' + v, 'FC06 已执行');
        app.result = { text: 'FC06 OK · 写入 ' + v, ok: true };
        toast('写入成功' + (wasPolling ? '，继续轮询' : ''), true);
      } catch (e) {
        pushOp('err', '写入失败 ' + r.addrLabel, e.message || '');
        setNotice('写入失败：' + (e.message || ''));
        app.result = { text: 'FC06 失败', ok: false };
      } finally {
        setBusy(-1);
        if (wasPolling) startPolling();
        else if (app.activeTab === 'modscan') { renderStage(); }
        renderStatusbar();
      }
    }
  });
}

/* ---------------- 串口调试 ---------------- */
function buildSerialView() {
  const s = app.serial;
  const crc = s.mode === 'HEX' && s.crcOn ? crcHexOf(s.payload) : '不追加';
  const full = serialFinalFrame();
  return '<div class="w-card"><div class="w-card-hd">' +
    '<div class="w-card-title">串口原始帧发送台</div>' +
    '</div></div>' +
    '<div class="w-card-bd" style="display:flex;flex-direction:column;gap:12px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">' +
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
    '<div class="seg">' +
    '<button class="seg-i' + (s.mode === 'HEX' ? ' on' : '') + '" data-act="ser-mode" data-m="HEX">HEX 十六进制</button>' +
    '<button class="seg-i' + (s.mode === 'ASCII' ? ' on' : '') + '" data-act="ser-mode" data-m="ASCII">ASCII 文本</button>' +
    '</div>' +
    '<button class="btn sm ' + (s.crcOn ? 'primary' : '') + '" data-act="ser-crc">自动追加 CRC16: ' + (s.crcOn ? '开' : '关') + '</button>' +
    '<button class="btn sm ' + (s.appendCr ? 'primary' : '') + '" data-act="ser-cr">+CR</button>' +
    '<button class="btn sm ' + (s.appendLf ? 'primary' : '') + '" data-act="ser-lf">+LF</button>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<span style="font-size:12px;color:var(--ink-2)">循环间隔</span>' +
    '<input class="ipt sm mono" data-field="serLoopMs" value="' + esc(s.loopMs) + '" style="width:78px;text-align:center">' +
    '<span style="font-size:11.5px;color:var(--ink-3)">ms</span></div>' +
    '</div>' +
    '<div class="f-item"><div class="f-label"><span>报文内容（直接输入，无需弹窗）</span>' +
    '<span class="mono" style="color:var(--accent)">CRC16（低字节在前）: <b id="serCrcVal">' + esc(crc) + '</b></span></div>' +
    '<input class="ipt mono" id="iptSerPayload" data-field="serPayload" value="' + esc(s.payload) + '" ' +
    'placeholder="如 01 03 00 00 00 0A" style="height:42px;font-size:14.5px"></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">' +
    '<div class="frame-box" style="flex:1"><span>最终发送帧预览:</span><b id="serFinalPreview">' + esc(full || '—') + '</b></div>' +
    '<div style="display:flex;gap:8px">' +
    '<button class="btn primary lg" data-act="ser-send">▲ 发送一帧</button>' +
    '<button class="btn ' + (s.looping ? 'danger' : '') + ' lg" data-act="ser-loop">' +
    (s.looping ? '■ 停止循环 (' + s.loopMs + 'ms)' : '↻ 启动循环发送') + '</button>' +
    '</div></div></div></div>' +

    '<div class="w-card" style="flex:' + (s.quickOpen ? '1' : 'none') + ';display:flex;flex-direction:column">' +
    '<div class="w-card-hd"><div class="w-card-title">报文快捷' +
    '</div>' +
    '<button class="btn sm" data-act="ser-quick-toggle" title="展开 / 收起报文快捷">' +
    (s.quickOpen ? '▾ 报文快捷' : '▸ 报文快捷') + '</button></div>' +
    (s.quickOpen
      ? '<div class="w-card-bd" style="display:flex;flex-direction:column;gap:12px">' +
        '<div class="ser-quick">' + serialQuickHTML() + '</div>' +
        '<div class="ser-quick-add">' +
        '<input class="ipt sm mono" id="serQuickInput" data-field="serQuickInput" value="' + esc(s.quickDraft || '') + '" placeholder="输入十六进制报文，如 01 03 01 00 00 01">' +
        '<button class="btn sm primary" data-act="ser-quick-add">＋ 添加</button>' +
        '</div></div>'
      : '') +
    '</div>';
}

function serialQuickHTML() {
  const list = Array.isArray(app.serial.quick) ? app.serial.quick : [];
  if (!list.length) return '<div class="empty-state" style="padding:12px"><b>还没有快捷按钮</b>在下方输入报文后点「＋ 添加」。</div>';
  return list.map((hex, i) => '<span class="ser-quick-pill">' +
    '<button class="btn sm mono ser-quick-use" data-act="ser-quick-use" data-hex="' + esc(hex) + '" title="载入此报文">' + esc(hex) + '</button>' +
    '<button class="btn sm ser-quick-del" data-act="ser-quick-del" data-i="' + i + '" title="删除">✕</button>' +
    '</span>').join('');
}

function addSerialQuickFromDom() {
  const input = $('serQuickInput');
  const raw = input ? input.value : (app.serial.quickDraft || '');
  const norm = spacedHex(String(raw || ''));
  const clean = norm.replace(/[^0-9A-Fa-f]/g, '');
  if (!clean || clean.length % 2) { setNotice('请输入合法的十六进制报文（偶数位）'); return; }
  if (!app.serial.quick.some((q) => q.replace(/[^0-9A-Fa-f]/g, '').toUpperCase() === clean.toUpperCase())) {
    app.serial.quick.push(norm);
    saveSerialQuick();
  }
  app.serial.quickDraft = '';
  renderStage();
}

function payloadToBytes(payloadHex) {
  const clean = String(payloadHex || '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('HEX 需要偶数位（当前 ' + clean.length + ' 位）');
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function crcHexOf(payloadHex) {
  try {
    const b = payloadToBytes(payloadHex);
    if (!b.length) return '—';
    const c = MB.crc16(b);
    return ((c & 0xFF)).toString(16).toUpperCase().padStart(2, '0') + ' ' + ((c >> 8) & 0xFF).toString(16).toUpperCase().padStart(2, '0');
  } catch (e) { return '—'; }
}

function serialFinalFrame() {
  const s = app.serial;
  try {
    if (s.mode === 'ASCII') {
      let bytes = Array.from(new TextEncoder().encode(String(s.payload || '')));
      if (s.appendCr) bytes.push(0x0D);
      if (s.appendLf) bytes.push(0x0A);
      return MB.bytesToHex(bytes, ' ');
    }
    let bytes = payloadToBytes(s.payload);
    if (s.crcOn && bytes.length) {
      const c = MB.crc16(bytes);
      bytes = bytes.concat([c & 0xFF, (c >> 8) & 0xFF]);
    }
    if (s.appendCr) bytes.push(0x0D);
    if (s.appendLf) bytes.push(0x0A);
    return MB.bytesToHex(bytes, ' ');
  } catch (e) { return ''; }
}

/* 协助模式：把「当前串口表单」拆成一串 ui.action 驱动手机页面本地执行。
   关键差异：CRC/CR/LF 由手机页面按 crcOn/appendCr/appendLf 自行追加，
   所以桌面端只推「用户原样输入的净报文」，不再自己拼帧。 */
async function serialSendAssist(s) {
  // HEX：净报文（去掉所有非十六进制字符，偶数位）；ASCII：原样文本
  let payload;
  if (s.mode === 'ASCII') {
    payload = String(s.payload || '');
  } else {
    try { payloadToBytes(s.payload); } catch (e) { setNotice('报文内容不合法（HEX 需偶数位）'); return false; }
    payload = String(s.payload || '').replace(/[^0-9a-fA-F]/g, '');
    if (!payload) { setNotice('报文内容不合法（HEX 需偶数位）'); return false; }
  }
  const steps = [
    { page: 'serial', widgetId: 'mode', value: s.mode === 'ASCII' ? 'ASCII' : 'HEX' },
    { page: 'serial', widgetId: 'crc', value: s.crcOn ? '开' : '关' },
    { page: 'serial', widgetId: 'tx', value: payload },
    { page: 'serial', widgetId: 'send' }
  ];
  for (const p of steps) {
    try {
      await send('ui.action', p, { quiet: true, noRetry: true, timeout: 15000 });
    } catch (e) {
      setNotice('串口发送失败：' + ((e && e.message) || '小程序页面执行失败'));
      return false;
    }
  }
  pushOp('ok', '串口发送（小程序协助）', 'HEX ' + payload.slice(0, 24) + (payload.length > 24 ? '…' : ''));
  return true;
}

async function serialSendOnce() {
  const s = app.serial;
  if (!app.joined) { setNotice('先接入会话'); return; }
  if (s.busy) return;
  // 协助模式：走手机页面 ui.action，本地不再拼帧 / 发 serial.send
  if (bleAssistMode()) {
    s.busy = true;
    setBusy(1);
    try {
      await serialSendAssist(s);
    } finally {
      s.busy = false;
      setBusy(-1);
      renderStatusbar();
        scheduleDesktopView();
    }
    return;
  }
  const hex = serialFinalFrame().replace(/\s+/g, '');
  if (!hex) { setNotice('报文内容不合法（HEX 需偶数位）'); return; }
  s.busy = true;
  setBusy(1);
  try {
    const data = await send('serial.send', { hex, wait: true }, {
      quiet: true, noRetry: true, timeout: 6000
    });
    if (data && data.tx) pushPacket('TX', data.tx, '串口直发');
    s.txCount += 1;
    if (data && data.rx) { pushPacket('RX', data.rx, data.truncated ? '应答（已截断）' : '从站应答'); s.rxCount += 1; }
    app.result = {
      text: 'serial.send OK · ' + (data && data.rx ? 'RX ' + Math.ceil(String(data.rx).replace(/[^0-9a-f]/gi, '').length / 2) + 'B' : '无应答'),
      ok: !!(data && data.rx)
    };
    app.cmd = { text: data && data.rx ? '串口帧已发送并收到应答' : '串口帧已发出，从站无应答', pending: false };
    pushOp(data && data.rx ? 'ok' : 'warn', '串口发送 ' + hex.slice(0, 24) + (hex.length > 24 ? '…' : ''),
      data && data.rx ? ('应答 ' + data.rx) : '无应答（检查从站 / 站号 / 波特率）');
  } catch (e) {
    s.txCount += 1;
    app.result = { text: 'serial.send 失败', ok: false };
    app.cmd = { text: '串口发送失败 · ' + (e.message || ''), pending: false };
    pushOp('err', '串口发送失败', e.message || '');
    setNotice('串口发送失败：' + (e.message || ''));
  } finally {
    s.busy = false;
    setBusy(-1);
    renderStatusbar();
    scheduleDesktopView();
  }
}

function startSerialLoop() {
  stopSerialLoop();
  app.serial.looping = true;
  serialSendOnce();
  serialLoopTimer = setInterval(() => {
    if (!app.joined || !app.serial.looping) { stopSerialLoop(); return; }
    serialSendOnce();
  }, Math.max(200, num(app.serial.loopMs, 1000)));
  pushOp('info', '启动串口循环发送', '间隔 ' + app.serial.loopMs + 'ms');
  if (app.activeTab === 'serial') renderStage();
}

function stopSerialLoop(silent) {
  if (serialLoopTimer) { clearInterval(serialLoopTimer); serialLoopTimer = null; }
  if (app.serial.looping) {
    app.serial.looping = false;
    if (!silent) pushOp('info', '停止串口循环发送', '');
  }
  if (!silent && app.activeTab === 'serial') renderStage();
}

/* ---------------- RTU 参数 ---------------- */
function profileOf() {
  return PRESET.PROFILES.find((p) => p.id === app.rtu.profileId) || PRESET.PROFILES[0];
}

function ensureRtuRows() {
  const prof = profileOf();
  app.rtu.rows = prof.items.map((it) => ({
    name: it.name, addr: it.addr, fc: it.fc, kind: it.kind, code: it.code,
    min: it.min, max: it.max, slaveSwitch: !!it.slaveSwitch,
    tpl: it.value, target: String(it.value), cur: null, curHex: '', read: false, err: ''
  }));
  app.rtu.hasRead = false;
  app.rtu.lastVerify = null;
}

function buildRtuView() {
  if (!app.rtu.rows.length) ensureRtuRows();
  const r = app.rtu;
  const prof = profileOf();
  const rows = r.rows.map((it, i) => {
    const v = PRESET.encodeValue(it, it.target);
    const pdu = it.fc === 16 ? MB.buildWriteMultiFrame(r.slave, 16, it.addr, [v]) : MB.buildWriteSingleFrame(r.slave, 6, it.addr, v);
    const frame = MB.bytesToHex(pdu, ' ');
    const opts = PRESET.optionsOf(it);
    const ctrl = opts.length
      ? '<select class="ipt sm mono rtu-target" data-rtu="' + i + '" style="width:150px">' +
        opts.map((o) => '<option value="' + o.v + '"' + (String(it.target) === String(o.v) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
        '</select>'
      : '<input class="ipt sm mono rtu-target" data-rtu="' + i + '" value="' + esc(it.target) + '" style="width:150px">';
    return '<tr><td><b>' + esc(it.name) + '</b>' + (it.slaveSwitch ? ' <span class="tag danger">高危</span>' : '') + '</td>' +
      '<td class="mono">0x' + hex4(it.addr) + ' · FC' + (it.fc === 16 ? '10' : '06') + '</td>' +
      '<td class="mono" style="color:var(--ink-3)">' + esc(PRESET.labelOf(it, it.tpl)) + '</td>' +
      '<td>' + (it.read
        ? '<span class="val-pill">' + esc(PRESET.labelOf(it, it.cur)) + '</span> <span class="mono" style="font-size:11px;color:var(--ink-3)">0x' + hex4(it.cur) + '</span>'
        : (it.err ? '<span class="val-pill wait" style="color:var(--danger)">' + esc(it.err) + '</span>' : '<span class="val-pill wait">未读取现值</span>')) + '</td>' +
      '<td>' + ctrl + '</td>' +
      '<td class="mono" style="font-size:11.5px;color:var(--accent)"><span id="rtuFrame' + i + '">' + esc(frame) + '</span></td>' +
      '<td><button class="btn sm ' + (it.slaveSwitch ? 'danger' : 'primary') + '" data-act="rtu-write" data-i="' + i + '">写入设备</button></td></tr>';
  }).join('');

  const v = r.lastVerify;
  return '<div class="w-card"><div class="w-card-bd" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">' +
    '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
    '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12.5px;color:var(--ink-2)">目标站号</span>' +
    '<input class="ipt mono sm" data-field="rtuSlave" value="' + esc(r.slave) + '" style="width:68px;text-align:center;font-weight:700"></div>' +
    '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12.5px;color:var(--ink-2)">寄存器模板</span>' +
    '<select class="ipt sm" data-field="rtuProfile" style="width:240px">' +
    PRESET.PROFILES.map((p) => '<option value="' + p.id + '"' + (p.id === r.profileId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
    '</select></div></div>' +
    '<div style="display:flex;gap:8px">' +
    '<button class="btn primary" data-act="rtu-read">读取设备现值 (按表逐条 FC03)</button>' +
    '</div></div></div>' +

    '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">RTU 参数读取与改写对照表</div>' +
    '<span style="font-size:12px;color:var(--ink-3)">每条写入后自动 FC03 读回校验</span></div>' +
    '<div class="w-card-bd tight"><table class="data-tbl"><thead><tr>' +
    '<th>参数名称</th><th>寄存器 · 功能码</th><th>模板默认值</th><th>设备当前现值</th><th>准备写入的目标值</th><th>即将下发 HEX（含 CRC）</th><th>单条执行</th>' +
    '</tr></thead><tbody id="rtuBody">' + rows + '</tbody></table></div>' +
    '<div class="w-card-ft"><span>' + (gwReady() ? (gwLinkShort() + ' · 客户端组帧') : '需网关链路') + '</span></div></div>' +

    (v ? '<div class="w-card mark-ok"><div class="w-card-hd"><div class="w-card-title">最近一次写入校验 · ' + (v.readback === v.value ? '读回一致' : '读回不一致') + '</div>' +
      '<span class="tag ' + (v.readback === v.value ? 'ok' : 'warn') + '">FC06 写入 + FC03 读回</span></div>' +
      '<div class="w-card-bd" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">' +
      '<div style="display:flex;gap:24px;flex-wrap:wrap;font-size:12.5px">' +
      '<div><span style="color:var(--ink-3)">目标项：</span><b>' + esc(v.name) + '</b></div>' +
      '<div><span style="color:var(--ink-3)">写入值：</span><span class="mono">' + esc(v.label) + ' (0x' + hex4(v.value) + ')</span></div>' +
      '<div><span style="color:var(--ink-3)">读回值：</span><span class="mono" style="color:var(--rx);font-weight:600">' +
      (v.readback === null ? '读取失败' : esc(PRESET.labelOf(v.item, v.readback)) + ' (0x' + hex4(v.readback) + ')') + '</span></div>' +
      '<div><span style="color:var(--ink-3)">往返耗时：</span><span class="mono">' + v.elapsed + ' ms</span></div></div>' +
      '<div class="frame-box" style="padding:5px 10px"><span>报文:</span> <b>' + esc(v.frame) + '</b></div></div></div>' : '');
}

function updateRtuFrames() {
  app.rtu.rows.forEach((it, i) => {
    const el = document.getElementById('rtuFrame' + i);
    if (!el) return;
    const v = PRESET.encodeValue(it, it.target);
    const f = it.fc === 16 ? MB.buildWriteMultiFrame(app.rtu.slave, 16, it.addr, [v]) : MB.buildWriteSingleFrame(app.rtu.slave, 6, it.addr, v);
    el.textContent = MB.bytesToHex(f, ' ');
  });
}

async function rtuReadAll() {
  const r = app.rtu;
  if (!gwReady()) { setNotice('读取 RTU 现值需要网关链路（BLE 小程序代理 / ESP32 直连）'); return; }
  if (r.reading) return;
  r.reading = true;
  setBusy(1);
  app.cmd = { text: '正在按地址表逐条读取设备现值…', pending: true };
  let ok = 0;
  try {
    for (let i = 0; i < r.rows.length; i++) {
      const it = r.rows[i];
      try {
        const res = await readRegs(3, r.slave, it.addr, 1);
        it.cur = res.values[0] & 0xFFFF;
        it.read = true;
        it.err = '';
        ok += 1;
      } catch (e) {
        it.read = false;
        it.err = '读取失败';
      }
      await new Promise((res) => setTimeout(res, 120));
    }
    r.hasRead = ok > 0;
    r.readAt = clock();
    app.result = { text: 'FC03 OK · ' + ok + '/' + r.rows.length + ' 应答', ok: ok > 0 };
    app.cmd = { text: ok ? 'RTU 现值读取完成（' + ok + '/' + r.rows.length + '）' : 'RTU 现值读取失败，检查站号 / 总线', pending: false };
    pushOp(ok ? 'ok' : 'err', '读取 RTU 设备现值 (站号 #' + r.slave + ')', ok + '/' + r.rows.length + ' 项应答');
  } finally {
    r.reading = false;
    setBusy(-1);
    renderStatusbar();
    if (app.activeTab === 'rtu') renderStage();
    scheduleDesktopView();
  }
}

function onRtuWrite(i) {
  const it = app.rtu.rows[i];
  if (!it) return;
  const v = PRESET.encodeValue(it, it.target);
  openWriteModal({
    title: '写入 RTU 参数 · ' + it.name,
    sub: '从站 #' + app.rtu.slave + ' · 寄存器 0x' + hex4(it.addr) + ' · 功能码 FC' + (it.fc === 16 ? '10' : '06') +
      ' · 目标值 ' + PRESET.labelOf(it, v),
    value: String(v),
    foot: '写完自动 FC03 读回比对；改站号成功后目标站号会自动切到新值',
    frameFor: (val) => it.fc === 16 ? MB.buildWriteMultiFrame(app.rtu.slave, 16, it.addr, [val]) : MB.buildWriteSingleFrame(app.rtu.slave, 6, it.addr, val),
    onConfirm: async (val) => {
      setBusy(1);
      try {
        const res = await writeReg(it.fc, app.rtu.slave, it.addr, val);
        it.cur = val; it.read = true; it.err = '';
        it.target = String(val);
        // 改站号后设备已经不在旧地址上了：读回必然失败，不能按"校验不一致"报错
        const moved = !!it.slaveSwitch && val >= 1 && val <= 247 && val !== app.rtu.slave;
        const rb = moved ? val : res.readback;
        app.rtu.lastVerify = {
          name: it.name, item: it, label: PRESET.labelOf(it, val), value: val,
          readback: rb, elapsed: res.elapsed,
          frame: MB.bytesToHex(it.fc === 16 ? MB.buildWriteMultiFrame(app.rtu.slave, 16, it.addr, [val]) : MB.buildWriteSingleFrame(app.rtu.slave, 6, it.addr, val), ' ')
        };
        if (moved) {
          app.rtu.slave = val;
          // 地址变了：下面几项的"现值"都是旧站号的，一律作废，改为按新站号重读
          app.rtu.rows.forEach((r) => { if (r !== it) { r.read = false; r.cur = null; r.err = ''; } });
        }
        const okResult = (rb === val);
        pushOp('ok', '写入 RTU 参数「' + it.name + '」= ' + PRESET.labelOf(it, val),
          moved ? ('站号已切到 #' + val + '，其余项请重新读取') : (rb === val ? '读回校验一致' : ('读回 ' + rb + '，与写入不一致')));
        app.result = { text: 'FC06 OK (' + res.elapsed + 'ms)' + (okResult ? ' · 读回一致' : ' · 读回不一致'), ok: okResult };
        toast(moved ? ('已写入，目标站号切到 #' + val) : (okResult ? '写入成功，读回一致' : '已写入，但读回不一致'), okResult);
      } catch (e) {
        pushOp('err', '写入 RTU 参数失败「' + it.name + '」', e.message || '');
        app.result = { text: 'FC06 失败', ok: false };
        setNotice('写入失败：' + (e.message || ''));
      } finally {
        setBusy(-1);
        if (app.activeTab === 'rtu') renderStage();
        renderStatusbar();
        scheduleDesktopView();
      }
    }
  });
}

/* ---------------- 模块设置 ---------------- */
function buildModuleView() {
  const m = app.module;
  const g = app.gw || {};
  const cur = m.cur.baud ? (m.cur.baud + ' · ' + m.cur.dataBits + m.cur.parity + m.cur.stopBits) : '—';
  const preview = m.edit.baud + ' · ' + m.edit.dataBits + m.edit.parity + m.edit.stopBits;
  const dirty = m.cur.baud && preview !== cur;
  const up = Number(g.up) || 0;
  const upTxt = up ? (Math.floor(up / 3600) ? Math.floor(up / 3600) + ':' : '') +
    pad2(Math.floor((up % 3600) / 60)) + ':' + pad2(up % 60) : '—';
  const modeTxt = ['空闲', 'WiFi 已连', '连接中', '托管中'][g.mode] || '—';
  const kv = (k, v, cls) => '<div class="mod-kv ' + (cls || '') + '"><div class="mod-kv-k">' + k +
    '</div><div class="mod-kv-v mono">' + esc(v || '—') + '</div></div>';
  // 信号质量：dBm 越接近 0 越强，给一点克制的颜色提示
  const rssiCls = (r) => { const v = Number(r); if (!v) return ''; return v >= -60 ? 'sig-good' : v >= -75 ? 'sig-mid' : 'sig-weak'; };
  return '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">模块信息</div>' +
    '<span class="tag ' + (gwReady() ? 'ok' : 'info') + '">' + esc(modeTxt) + '</span></div>' +
    '<div class="w-card-bd">' +
    '<div class="mod-info-status">' +
    kv('固件', g.fw ? 'v' + g.fw : '—') +
    kv('运行时长', upTxt) +
    '</div>' +
    '<div class="mod-info-grid">' +
    kv('WiFi', g.ssid ? (g.ssid + (g.ip ? ' · ' + g.ip : '')) : (g.ip || '—')) +
    kv('信号', g.rssi ? (g.rssi + ' dBm') : '—', rssiCls(g.rssi)) +
    kv('MQTT', g.broker || '—') +
    kv('NVS', g.nvs ? ('v' + g.nvs + (g.cred ? ' · 凭证已存' : ' · 无凭证') + (g.auto ? ' · 自动联网' : '')) : '—') +
    kv('485 侧', cur) +
    '</div></div>' +

    '<div class="w-card ' + (dirty ? 'mark-warn' : '') + '"><div class="w-card-hd">' +
    '<div class="w-card-title">485 侧串口参数配置</div>' +
    (dirty ? '<span class="tag warn">未写入</span>' : '<span class="tag ok">与模块一致</span>') + '</div>' +
    '<div class="w-card-bd" style="display:flex;flex-direction:column;gap:12px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:8px;background:var(--win-panel);border:1px solid var(--win-line-soft)">' +
    '<span style="font-size:12px;color:var(--ink-2)">即将写入</span>' +
    '<span class="mono" style="font-size:18px;font-weight:700;color:var(--accent)">' + esc(preview) + '</span></div>' +
    '<div class="form-grid">' +
    '<div class="f-item"><div class="f-label"><span>波特率 (bps)</span></div>' +
    '<select class="ipt mono" data-field="modBaud">' +
    ['2400', '4800', '9600', '19200', '38400', '57600', '115200'].map((b) =>
      '<option value="' + b + '"' + (m.edit.baud === b ? ' selected' : '') + '>' + b + '</option>').join('') +
    '</select></div>' +
    '<div class="f-item"><div class="f-label"><span>数据位</span></div><div class="seg" id="segDataBits">' +
    '<button class="seg-i ' + (m.edit.dataBits === '8' ? 'on' : '') + '" data-act="mod-seg" data-k="dataBits" data-v="8">8 位</button>' +
    '<button class="seg-i ' + (m.edit.dataBits === '7' ? 'on' : '') + '" data-act="mod-seg" data-k="dataBits" data-v="7">7 位</button>' +
    '</div></div>' +
    '<div class="f-item"><div class="f-label"><span>校验位</span></div><div class="seg" id="segParity">' +
    ['N', 'O', 'E'].map((p) => '<button class="seg-i ' + (m.edit.parity === p ? 'on' : '') + '" data-act="mod-seg" data-k="parity" data-v="' + p + '">' +
      p + ' ' + ({ N: '无', O: '奇', E: '偶' }[p]) + '</button>').join('') +
    '</div></div>' +
    '<div class="f-item"><div class="f-label"><span>停止位</span></div><div class="seg" id="segStopBits">' +
    '<button class="seg-i ' + (m.edit.stopBits === '1' ? 'on' : '') + '" data-act="mod-seg" data-k="stopBits" data-v="1">1 位</button>' +
    '<button class="seg-i ' + (m.edit.stopBits === '2' ? 'on' : '') + '" data-act="mod-seg" data-k="stopBits" data-v="2">2 位</button>' +
    '</div></div></div>' +
    '<div style="display:flex;gap:10px;margin-top:4px">' +
    '<button class="btn" data-act="mod-read">刷新参数</button>' +
    '<button class="btn ' + (dirty ? 'danger' : 'primary') + '" style="flex:1" data-act="mod-commit">写入 · ' + esc(preview) + '</button>' +
    '</div></div></div>';
}

function renderModuleLive() {
  if (app.activeTab !== 'module') return;
  renderStage();
}

async function moduleRead() {
  if (!app.joined) { setNotice('先接入会话'); return; }
  // ★ 不再强依赖 gwReady()（app.gw.on）：那要求先收到一条带 gw:1 的状态帧才成立。
  //   托管模式下网页端可能还没收到状态帧，但会话已连、模块可达，config.get
  //   照样能读回参数。只要会话在连就允许尝试；读回后再由 applyGatewayDetail 建立 app.gw。
  if (!app.sess || !app.sess.isConnected()) {
    setNotice('远程通道未就绪（服务器未连上或会话已结束）');
    return;
  }
  app.module.reading = true;
  setBusy(1);
  try {
    // ★ 配置读取统一走 config 主题（config.get）：模块参数 + 现场信息/固件版本一次拿全。
    //   不再在 cmd 主题发 sync.request 查询。
    const data = await sendConfig('config.get', { what: 'all' }, { quiet: true, timeout: 6000 });
    // 写回前确保 app.gw 存在（去掉了 gwReady 硬门槛后可能还没建）：
    // 没有就用空壳建一个，避免后面 app.gw.xxx = ... 抛 TypeError。
    applyModuleInfo(data);
    // 现场信息 / 固件版本已随 config.get 回执一并拿到，这里不再在 cmd 主题发 sync.request。
    app.result = { text: '模块参数读取完成', ok: true };
    app.cmd = { text: '模块参数已读取', pending: false };
    toast('模块参数已读取', true);
    renderHeader();
    renderStage();
  } catch (e) {
    pushOp('err', '读取模块参数失败', e.message || '');
    setNotice('读取失败：' + (e.message || ''));
  } finally {
    app.module.reading = false;
    setBusy(-1);
    renderStatusbar();
    scheduleDesktopView();
  }
}

function moduleCommit() {
  if (!gwReady()) { setNotice('写入模块参数需要网关链路（BLE 小程序代理 / ESP32 直连）'); return; }
  const e = app.module.edit;
  if (!confirm('应用模块 485 参数：' + e.baud + ' · ' + e.dataBits + e.parity + e.stopBits +
    '\n\n参数写入 ESP32 NVS 并立即生效，下游表计必须同参数，确认？')) return;
  setBusy(1);
  sendConfig('config.set', {
    what: 'uart',
    baud: num(e.baud, 9600), dataBits: num(e.dataBits, 8),
    stopBits: num(e.stopBits, 1), parity: e.parity
  }, { noRetry: true, timeout: 6000 }).then(() => {
    app.module.cur = Object.assign({}, e);
    app.gw.uart = Object.assign({}, e);
    pushOp('ok', '写入模块 485 串口参数', e.baud + ' ' + e.dataBits + e.parity + e.stopBits);
    toast('模块串口参数已更新', true);
    renderAll();
  }).catch((err) => {
    pushOp('err', '写入模块参数失败', err && err.message || '');
  }).finally(() => {
    setBusy(-1);
    renderStatusbar();
    scheduleDesktopView();
  });
}

/* ---------------- 从站扫描 ---------------- */
function buildScanView() {
  const s = app.scan;
  const span = Math.max(1, s.end - s.start + 1);
  const done = s.running ? clamp(s.cur - s.start + 1, 0, span) : (s.done ? span : 0);
  const pct = Math.round(done / span * 100);
  return '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">从站地址扫描范围 (1 ~ 247)</div>' +
    '<span class="tag info">FC03 逐站探测</span></div>' +
    '<div class="w-card-bd" style="display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:12px">' +
    '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
    '<div class="f-item" style="width:110px"><div class="f-label">起始站号</div><input class="ipt sm mono" data-field="scStart" value="' + esc(s.start) + '"></div>' +
    '<div class="f-item" style="width:110px"><div class="f-label">结束站号</div><input class="ipt sm mono" data-field="scEnd" value="' + esc(s.end) + '"></div>' +
    '<div class="f-item" style="width:140px"><div class="f-label">探测寄存器</div><input class="ipt sm mono" data-field="scReg" value="' + esc(s.reg) + '"></div>' +
    '<div class="f-item" style="width:130px"><div class="f-label">单站超时 (ms)</div><input class="ipt sm mono" data-field="scTimeout" value="' + esc(s.timeout) + '"></div>' +
    '</div>' +
    '<button class="btn ' + (s.running ? 'danger' : 'primary') + '" data-act="scan-start">' +
    (s.running ? '■ 停止扫描' : '重新探测在线从站') + '</button></div></div>' +

    '<div class="w-card"><div class="w-card-hd">' +
    '<div class="w-card-title">扫描进度 · 已探测 <span id="scCur">' + s.cur + '</span> / ' + s.end + ' (<span id="scPct">' + pct + '</span>%)</div>' +
    '<span class="tag ok">发现 <span id="scFound">' + s.list.length + '</span> 台在线从站</span></div>' +
    '<div class="w-card-bd" style="display:flex;flex-direction:column;gap:14px">' +
    '<div style="height:8px;background:var(--win-ipt);border-radius:999px;overflow:hidden">' +
    '<div id="scBar" style="height:100%;width:' + pct + '%;background:var(--rx);transition:width .3s"></div></div>' +
    '<div id="scanGrid" class="scan-grid">' + scanHitsHTML() + '</div>' +
    '</div></div>';
}

function scanHitsHTML() {
  if (!app.scan.list.length) {
    return '<div class="empty-state" style="grid-column:1/-1"><b>' + (app.scan.done ? '未发现在线从站' : '尚未发现从站') + '</b>' +
      (app.scan.done ? '该区间内没有回应探测寄存器的设备；核对 A/B 线、波特率与从站站号。' : '点「重新探测在线从站」开始扫描 1~247。') + '</div>';
  }
  return app.scan.list.map((id) => '<button class="scan-card" data-act="scan-jump" data-id="' + id + '">' +
    '<div class="scan-card-top"><span class="scan-addr">#' + id + '</span><span class="tag ok">在线</span></div>' +
    '<div class="scan-card-hint">点击去 RTU / Modscan ›</div></button>').join('');
}

function renderScanLive() {
  const s = app.scan;
  const span = Math.max(1, s.end - s.start + 1);
  const done = s.running ? clamp(s.cur - s.start + 1, 0, span) : (s.done ? span : 0);
  const pct = Math.round(done / span * 100);
  const cur = $('scCur'); if (cur) cur.textContent = s.cur;
  const p = $('scPct'); if (p) p.textContent = pct;
  const f = $('scFound'); if (f) f.textContent = s.list.length;
  const bar = $('scBar'); if (bar) bar.style.width = pct + '%';
  const grid = $('scanGrid'); if (grid) grid.innerHTML = scanHitsHTML();
  const title = document.querySelector('.w-card-title');
  const btn = document.querySelector('[data-act="scan-start"]');
  if (btn) {
    btn.textContent = s.running ? '■ 停止扫描' : '重新探测在线从站';
    btn.className = 'btn ' + (s.running ? 'danger' : 'primary');
  }
}

async function scanToggle() {
  if (!gwReady()) { setNotice('从站扫描需要网关链路（scan.start）：BLE 小程序代理 / ESP32 直连'); return; }
  const s = app.scan;
  if (s.running) {
    try {
      await send('scan.stop', {}, { noRetry: true, timeout: 6000 });
      s.running = false;
      pushOp('info', '已请求停止扫描', '');
      renderScanLive();
    } catch (e) { setNotice('停止扫描失败：' + (e.message || '')); }
    return;
  }
  s.start = clamp(num(s.start, 1), 1, 247);
  s.end = clamp(num(s.end, 247), s.start, 247);
  s.reg = clamp(num(s.reg, 0), 0, 65535);
  s.timeout = clamp(num(s.timeout, 80), 20, 1000);
  // 先清本地进度再下发：BLE 代理的 START/HIT 可能在 ack 之前就到，
  // 若等 await 之后才清，会把刚收到的 HIT 列表抹掉。
  s.running = true; s.done = false; s.list = []; s.cur = s.start;
  renderStage();
  try {
    await send('scan.start', { start: s.start, end: s.end, reg: s.reg, timeout: s.timeout }, {
      noRetry: true, timeout: 8000, pendingText: '扫描指令已下发…', doneText: '扫描已启动'
    });
    pushOp('info', '启动从站扫描', '范围 ' + s.start + '~' + s.end + ' · 探测寄存器 ' + s.reg);
    renderStage();
  } catch (e) {
    s.running = false;
    renderStage();
    setNotice('启动扫描失败：' + (e.message || ''));
  }
}

/* ==================================================================
   写入弹窗
   ================================================================== */
let wmCtx = null;

function openWriteModal(ctx) {
  wmCtx = ctx;
  $('wmTitle').textContent = ctx.title || '写入寄存器';
  $('wmSub').textContent = ctx.sub || '';
  $('wmInput').value = String(ctx.value == null ? 0 : ctx.value);
  $('writeModal').classList.add('show');
  updateWmFrame();
  setTimeout(() => { $('wmInput').focus(); $('wmInput').select(); }, 30);
}

function closeWriteModal() { $('writeModal').classList.remove('show'); wmCtx = null; }

function parseInputValue(raw) {
  const s = String(raw || '').trim();
  if (/^0[xX]/.test(s)) return parseInt(s.slice(2), 16) || 0;
  return parseInt(s, 10) || 0;
}

function updateWmFrame() {
  if (!wmCtx) return;
  const v = clamp(parseInputValue($('wmInput').value), 0, 65535);
  const frame = wmCtx.frameFor ? wmCtx.frameFor(v) : [];
  $('wmFramePreview').textContent = MB.bytesToHex(frame, ' ');
}

function wmConfirm() {
  if (!wmCtx) return;
  const v = clamp(parseInputValue($('wmInput').value), 0, 65535);
  const cb = wmCtx.onConfirm;
  closeWriteModal();
  if (cb) cb(v);
}

/* ==================================================================
   镜像页操作
   ================================================================== */
let sheetCtx = null;

function mirrorTap(id) {
  const w = app.widgets.find((x) => x.id === id);
  if (!w) return;
  if (w.enabled === false) return;
  if (w.type === 'button') {
    send('ui.action', { page: app.pageId, widgetId: w.id }, {
      noRetry: w.risk === 'high', okTitle: (w.label || w.id) + ' 已执行', timeout: 60000
    }).catch(() => {});
    return;
  }
  openSheet(w);
}

function mirrorEdit(id) {
  const w = app.widgets.find((x) => x.id === id);
  if (w) openSheet(w);
}

function openSheet(w) {
  sheetCtx = w;
  $('sheetTitle').textContent = w.label || w.id;
  $('sheetHint').textContent = w.hint || '';
  $('sheetErr').textContent = '';
  $('sheetInput').value = w.type === 'select' ? '' : String(w.value == null ? '' : w.value);
  const box = $('sheetOptions');
  box.innerHTML = '';
  if (w.type === 'select' && Array.isArray(w.options)) {
    w.options.forEach((o) => {
      const val = (o && typeof o === 'object') ? String(o.v == null ? '' : o.v) : String(o);
      const lab = (o && typeof o === 'object') ? String(o.label == null ? o.v : o.label) : String(o);
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = lab;
      b.addEventListener('click', () => { $('sheetInput').value = val; $('sheetErr').textContent = ''; });
      box.appendChild(b);
    });
  }
  $('sheetMask').classList.add('show');
  setTimeout(() => $('sheetInput').focus(), 30);
}

function closeSheet() { $('sheetMask').classList.remove('show'); sheetCtx = null; }

function sheetSubmit() {
  const w = sheetCtx;
  if (!w) return;
  const v = $('sheetInput').value.trim();
  if (v === '') { $('sheetErr').textContent = '请先填一个值'; return; }
  closeSheet();
  send('ui.action', { page: app.pageId, widgetId: w.id, value: v }, {
    noRetry: w.risk === 'high', okTitle: (w.label || w.id) + ' 已下发', timeout: 60000
  }).catch(() => {});
}

/* ==================================================================
   主题 / 设置
   ================================================================== */
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', t);
  const cb = $('cfgLight');
  if (cb) cb.checked = (t === 'light');
  try { localStorage.setItem(LS_THEME, t); } catch (e) {}
}

/* ---- Broker 设置弹窗 ---- */
function openSettings() {
  const c = loadBroker();
  $('cfgHost').value = c.host || MQTT_SERVER.host;
  $('cfgUser').value = c.username || MQTT_SERVER.username;
  $('cfgPass').value = c.password || '';
  $('cfgLight').checked = document.body.getAttribute('data-theme') === 'light';
  $('settingsErr').textContent = '';
  $('settingsMask').classList.add('show');
}
function closeSettings() { $('settingsMask').classList.remove('show'); }

/* ---- 协助码 dialog（启动弹出） ---- */
function openAssistCode() {
  const el = $('assistCodeInput'); if (!el) return;
  el.value = localStorage.getItem(LS_SID) || '';
  if ($('assistCodeErr')) $('assistCodeErr').textContent = $('assistCodeErr').textContent || '';
  $('assistCodeMask').classList.add('show');
  setTimeout(() => { try { el.focus(); el.select(); } catch (e) {} }, 60);
}
function closeAssistCode() { const m = $('assistCodeMask'); if (m) m.classList.remove('show'); }
function submitAssistCode() {
  const el = $('assistCodeInput');
  const val = String(el && el.value || '').trim().toUpperCase();
  el && (el.value = val);
  const hint = sidHint(val);
  if (hint || !P.isSidLen(val)) {
    if ($('assistCodeErr')) $('assistCodeErr').textContent = hint || ('请填满 ' + P.SID_LEN + ' 位协助码');
    return;
  }
  closeAssistCode();
  // 把协助码写进头部输入框并接入
  if ($('sidInput')) $('sidInput').value = val;
  onJoin();
}
function saveSettings() {
  const host = $('cfgHost').value.trim();
  const username = $('cfgUser').value.trim();
  const password = $('cfgPass').value;
  if (!host) { $('settingsErr').textContent = '服务器地址不能为空'; return; }
  const cfg = {};
  if (host !== MQTT_SERVER.host) cfg.host = host;
  if (username !== MQTT_SERVER.username) cfg.username = username;
  if (password !== '') cfg.password = password;
  saveBroker(cfg);
  applyTheme($('cfgLight').checked ? 'light' : 'dark');
  closeSettings();
  refreshBrokerText();
  setNotice('设置已保存，重启会话后生效', true);
}

/** 标题栏的 broker 摘要：配置后显示 URL；未配置时留空（不再提示） */
function refreshBrokerText() {
  const el = $('brokerText');
  if (!el) return;
  const url = buildWsUrl(MQTT_CONFIG_FROM(loadBroker()));
  el.textContent = url || '';
}

/* ==================================================================
   事件绑定
   ================================================================== */
function bind() {
  const stage = $('mainStage');

  // 静态按钮
  $('joinBtn').addEventListener('click', onJoin);
  $('leaveBtn').addEventListener('click', onLeave);
  $('btnResync').addEventListener('click', () => {
    if (!app.joined) { setNotice('先接入会话'); return; }
    // 重新拉取模块信息：走 config 主题（config.get），不再用 cmd 的 sync.request
    fetchModuleInfo().then((d) => {
      if (d) { toast('已重新同步', true); }
      else { setNotice('读取模块信息失败，请稍后重试'); }
    });
  });
  $('btnClearLogs').addEventListener('click', () => {
    app.packets = []; app.ops = [];
    app.txBytes = 0; app.rxBytes = 0;
    renderDock();
    pushOp('info', '已清空报文流与操作记录', '');
  });
  // 右坞 Tab 切换：报文流 / 操作记录
  const tabPkBtn = $('dockTabPackets');
  const tabOpsBtn = $('dockTabOps');
  if (tabPkBtn) tabPkBtn.addEventListener('click', () => { app.dockTab = 'packets'; renderDock(); });
  if (tabOpsBtn) tabOpsBtn.addEventListener('click', () => { app.dockTab = 'ops'; renderDock(); });
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsMask').addEventListener('click', (e) => { if (e.target === $('settingsMask')) closeSettings(); });
  $('cfgPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });

  // 协助码 dialog
  if ($('assistCodeGo')) $('assistCodeGo').addEventListener('click', submitAssistCode);
  if ($('assistCodeLater')) $('assistCodeLater').addEventListener('click', closeAssistCode);
  if ($('assistCodeInput')) {
    const ai = $('assistCodeInput');
    ai.addEventListener('input', () => { ai.value = ai.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if ($('assistCodeErr')) $('assistCodeErr').textContent = sidHint(ai.value); });
    ai.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAssistCode(); });
  }
  if ($('assistCodeMask')) $('assistCodeMask').addEventListener('click', (e) => { if (e.target === $('assistCodeMask')) closeAssistCode(); });

  // 报文流：点击复制
  $('packetList').addEventListener('click', (e) => {
    const row = e.target.closest('.pkt-line');
    if (!row) return;
    const hex = row.dataset.hex || '';
    if (!hex) return;
    if (navigator.clipboard) navigator.clipboard.writeText(hex).then(() => toast('已复制：' + hex.slice(0, 32) + (hex.length > 32 ? '…' : ''), true)).catch(() => {});
  });

  // 会话码输入
  const sidInput = $('sidInput');
  sidInput.addEventListener('input', () => {
    sidInput.value = sidInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    $('sidErr').textContent = sidHint(sidInput.value);
  });
  sidInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onJoin(); });

  // 写入弹窗
  $('wmInput').addEventListener('input', updateWmFrame);
  $('wmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') wmConfirm(); });
  $('wmConfirm').addEventListener('click', wmConfirm);
  $('wmCancel').addEventListener('click', closeWriteModal);
  $('writeModal').addEventListener('click', (e) => { if (e.target === $('writeModal')) closeWriteModal(); });

  // 值编辑弹层
  $('sheetCloseX').addEventListener('click', closeSheet);
  $('sheetMask').addEventListener('click', (e) => { if (e.target === $('sheetMask')) closeSheet(); });
  $('sheetSend').addEventListener('click', sheetSubmit);
  $('sheetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sheetSubmit(); });

  // 主工作区事件委托：重新渲染后不需要重新绑定
  stage.addEventListener('click', onStageClick);
  stage.addEventListener('input', onStageInput);
  stage.addEventListener('change', onStageChange);
  stage.addEventListener('keydown', function (e) {
    if (e.target && e.target.id === 'serQuickInput' && e.key === 'Enter') {
      e.preventDefault();
      addSerialQuickFromDom();
    }
  });
}

function onStageClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'open':
      onNavTab(el.dataset.tab || 'tools');
      break;

    case 'ms-area':
      app.modscan.area = el.dataset.a;
      app.modscan.rows = [];
      app.modscan.prev = {};
      renderStage();
      break;
    case 'ms-read':
      modscanReadOnce();
      break;
    case 'ms-poll':
      if (app.modscan.polling) stopPolling(); else startPolling();
      break;
    case 'ms-write':
      onMsWrite(num(el.dataset.i, 0));
      break;

    case 'ser-mode':
      app.serial.mode = el.dataset.m;
      renderStage();
      break;
    case 'ser-crc':
      app.serial.crcOn = !app.serial.crcOn;
      renderStage();
      break;
    case 'ser-cr':
      app.serial.appendCr = !app.serial.appendCr;
      renderStage();
      break;
    case 'ser-lf':
      app.serial.appendLf = !app.serial.appendLf;
      renderStage();
      break;
    case 'ser-preset':
      app.serial.payload = el.dataset.hex || '';
      renderStage();
      break;
    case 'ser-quick-toggle':
      app.serial.quickOpen = !app.serial.quickOpen;
      renderStage();
      break;
    case 'ser-quick-use':
      app.serial.payload = el.dataset.hex || '';
      renderStage();
      break;
    case 'ser-quick-del': {
      const qi = num(el.dataset.i, -1);
      if (qi >= 0) { app.serial.quick.splice(qi, 1); saveSerialQuick(); renderStage(); }
      break;
    }
    case 'ser-quick-add':
      addSerialQuickFromDom();
      break;
    case 'ser-send':
      serialSendOnce();
      break;
    case 'ser-loop':
      if (app.serial.looping) stopSerialLoop(); else startSerialLoop();
      break;

    case 'rtu-read':
      rtuReadAll();
      break;
    case 'rtu-write':
      onRtuWrite(num(el.dataset.i, 0));
      break;

    case 'mod-read':
      moduleRead();
      break;
    case 'mod-seg':
      app.module.edit[el.dataset.k] = el.dataset.v;
      app.module.dirty = true;
      renderStage();
      break;
    case 'mod-commit':
      moduleCommit();
      break;
    case 'scan-start':
      scanToggle();
      break;
    case 'scan-jump':
      {
        const id = num(el.dataset.id, 1);
        app.rtu.slave = id;
        app.activeTab = 'rtu';
        if (gwReady() && gwLink() === 'ble') sendViewFollow('rtu');
        pushOp('info', '从扫描结果跳到 RTU 设置', '站号 #' + id);
        renderAll();
      }
      break;

    case 'mirror-sync':
      fetchModuleInfo().then((d) => { if (d) toast('已重新同步', true); }).catch(() => {});
      break;
    case 'mirror-tap':
      mirrorTap(el.dataset.id);
      break;
    case 'mirror-edit':
      mirrorEdit(el.dataset.id);
      break;
  }
}

function onStageInput(e) {
  const el = e.target.closest('[data-field],[data-rtu]');
  if (!el) return;
  if (el.dataset.rtu !== undefined) {
    const i = num(el.dataset.rtu, 0);
    if (app.rtu.rows[i]) {
      app.rtu.rows[i].target = el.value;
      updateRtuFrames();
    }
    return;
  }
  const f = el.dataset.field;
  const v = el.value;
  if (f === 'serPayload') {
    app.serial.payload = v;
    const crc = app.serial.mode === 'HEX' && app.serial.crcOn ? crcHexOf(v) : '不追加';
    const c = $('serCrcVal'); if (c) c.textContent = crc;
    const p = $('serFinalPreview'); if (p) p.textContent = serialFinalFrame() || '—';
    return;
  }
  if (f === 'serQuickInput') { app.serial.quickDraft = v; return; }
  if (f === 'serLoopMs') { app.serial.loopMs = num(v, 1000); return; }
  if (f === 'msSlave') { app.modscan.slave = num(v, 1); return; }
  if (f === 'msStart') { app.modscan.start = v; return; }
  if (f === 'msCount') { app.modscan.count = num(v, 10); return; }
  if (f === 'msInterval') { app.modscan.interval = num(v, 500); return; }
  if (f === 'scStart') { app.scan.start = num(v, 1); return; }
  if (f === 'scEnd') { app.scan.end = num(v, 247); return; }
  if (f === 'scReg') { app.scan.reg = num(v, 0); return; }
  if (f === 'scTimeout') { app.scan.timeout = num(v, 80); return; }
  if (f === 'rtuSlave') { app.rtu.slave = clamp(num(v, 1), 1, 247); updateRtuFrames(); return; }
  scheduleDesktopView();
}

function onStageChange(e) {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const f = el.dataset.field;
  if (f === 'msFormat') { app.modscan.format = el.value; renderStage(); return; }
  if (f === 'rtuProfile') {
    app.rtu.profileId = el.value;
    ensureRtuRows();
    renderStage();
    return;
  }
  if (f === 'modBaud') { app.module.edit.baud = el.value; app.module.dirty = true; renderStage(); return; }
  if (f === 'serLoopMs') { app.serial.loopMs = clamp(num(el.value, 1000), 100, 60000); scheduleDesktopView(); return; }
}

/* ==================================================================
   启动
   ================================================================== */
function boot() {
  bind();
  app.serial.quick = loadSerialQuick();
  const tkBtn = $('takeoverBtn');
  if (tkBtn) tkBtn.addEventListener('click', onTakeover);

  let theme = 'dark';
  try { theme = localStorage.getItem(LS_THEME) || 'dark'; } catch (e) {}
  applyTheme(theme);
  refreshBrokerText();
  if (CLIENT_KIND === 'web') {
    document.title = 'Modbus 远程调试台 · 网页版';
    document.body.setAttribute('data-client', 'web');
  }

  const lastSid = localStorage.getItem(LS_SID) || '';
  $('sidInput').value = lastSid;
  $('sidErr').textContent = sidHint(lastSid);

  // 网关可用时，默认落到 Modscan？不：先给工具总览，避免误以为"没有链路"
  app.activeTab = 'tools';
  renderAll();

  pushOp('info', '桌面工作台就绪', '输入现场 7 位协助码接入 · ESP32 直连 / BLE 小程序代理 / 手机镜像都支持');

  openAssistCode();
}

boot();

// 暴露给 Node 单测 / 调试（与旧版保持同名入口，便于脚本复用）
if (typeof window !== 'undefined') {
  window.__mrd = {
    app, onJoin, send, P, pushOp, renderAll, kind: CLIENT_KIND,
    // 调试 / 单测：多远程端在线表与控制权
    peers: { apply: applyPeers, render: renderRoleBox, takeover: onTakeover },
    // 调试 / 单测：网关说明书新字段合并
    gateway: { ensure: ensureGateway, apply: applyGatewayDetail },
    // 调试 / 单测：页面双向同步的字段映射
    view: {
      snapshot: desktopViewSnapshot,
      apply: applyDesktopView,
      applyHost: applyHostView,
      follow: sendViewFollow,
      publish: scheduleDesktopView
    }
  };
}
