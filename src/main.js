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
 *      扫描走 scan.start/stop，模块参数走 uart.set，串口直发走 serial.send。
 *   B. 现场手机托管（local host）：沿用镜像 pageSchema + ui.action，
 *      仍可在「工具」页点现场镜像行操作；两种模式互斥。
 */

import { Session } from './lib/session.js';
import { sidHint, MQTT_SERVER, buildWsUrl, MQTT_CONFIG_FROM } from './lib/broker.js';
import * as P from './lib/proto.js';
import * as MB from './lib/modbus.js';
import * as PRESET from './lib/presets.js';

const $ = (id) => document.getElementById(id);
const LS_SID = 'mrd.sid';
const LS_THEME = 'mrd.theme';
const LS_BROKER = 'mrd.broker';   // {host, username, password}，凭据只存本机

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

  gw: null,              // {on,name,fw,ip,perm,host,uart}
  mirror: false,         // 现场手机托管的镜像页
  pageId: '',
  widgets: [],

  activeTab: 'tools',    // tools | scan | modscan | serial | rtu | module
  dockMode: 'split',     // split | pkt | ops
  offlineDismissed: false,

  packets: [],           // [{dir,hex,note,t,len,at}]
  ops: [],               // [{level,title,desc,t,count,at}]
  txBytes: 0,
  rxBytes: 0,

  cmd: { text: '就绪 · 输入会话码接入现场', pending: false },
  result: { text: '—', ok: true },
  busyCount: 0,

  scan: { running: false, cur: 0, found: 0, list: [], start: 1, end: 247, reg: 0, timeout: 80, done: false },

  modscan: {
    area: '03', slave: 1, start: '40001', count: 10, interval: 500,
    format: 'Unsigned', polling: false, busy: false,
    rows: [], prev: {}, round: 0, ok: 0, timeout: 0, err: 0, at: ''
  },

  serial: {
    mode: 'HEX', crcOn: true, appendCr: false, appendLf: false,
    payload: '01 03 00 00 00 0A', loopMs: 1000, looping: false, busy: false, txCount: 0, rxCount: 0
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
    $('sidErr').textContent = hint || ('请填满 ' + P.SID_LEN + ' 位会话码');
    $('sidInput').focus();
    return;
  }
  closeSession(true);
  localStorage.setItem(LS_SID, sid);

  app.sid = sid;
  app.joined = true;
  app.onlineOnce = false;
  app.offlineDismissed = false;
  app.cmd = { text: '正在接入 ' + sid + ' …', pending: true };
  app.result = { text: '—', ok: true };

  app.sess = new Session({
    role: 'remote',
    sid,
    tool: '桌面调试台',
    kind: 'desktop',              // 网关据此让桌面端优先接管
    broker: loadBroker(),         // 用户设置的 broker 账号 / 密码（本机 localStorage）
    onState: onStateMsg,
    onData: onDataMsg,
    onStatus: (o, first) => {
      applyPeerStatus(o);
      if (first && app.onlineOnce) toast('现场已上线', true);
    },
    onChange: (st) => {
      renderHeader();
      if (st === 'online') {
        // 连上就主动要一次说明书：网关会立刻回 state{role:"gateway"}
        setTimeout(() => {
          if (app.sess && app.sess.isConnected() && !app.gw) {
            send('sync.request', {}, { quiet: true }).catch(() => {});
          }
        }, 350);
      }
    },
    onReconnect: () => send('sync.request', {}, { quiet: true }).catch(() => {}),
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
  pushOp('info', '接入会话 ' + sid, '等待现场确认 / 模块网关上线');
}

function closeSession(silent) {
  stopPolling(true);
  stopSerialLoop(true);
  if (app.sess) { try { app.sess.close(); } catch (e) {} app.sess = null; }
  app.joined = false;
  app.peerOnline = false;
  app.onlineOnce = false;
  app.gw = null;
  app.mirror = false;
  app.pageId = '';
  app.widgets = [];
  app.busyCount = 0;
  app.scan = { running: false, cur: 0, found: 0, list: [], start: 1, end: 247, reg: 0, timeout: 80, done: false };
  app.modscan.rows = [];
  app.modscan.prev = {};
  app.rtu.rows = [];
  app.rtu.hasRead = false;
  app.rtu.lastVerify = null;
  app.cmd = { text: '就绪 · 输入会话码接入现场', pending: false };
  app.result = { text: '—', ok: true };
  $('joinBtn').hidden = false;
  $('leaveBtn').hidden = true;
  $('offlineBanner').classList.remove('show');
  render();
  if (!silent) pushOp('info', '已断开会话', '');
}

function onEndSession() {
  if (!app.joined) return;
  if (!confirm('结束协助后本次远程通道立即关闭，需要重新要码才能接入。确定？')) return;
  // 网关不认 assist.kick（模块由现场 BLE 控制），手机托管才需要通知现场收摊
  if (!app.gw) send('assist.kick', {}, { quiet: true, noRetry: true }).catch(() => {});
  setTimeout(() => closeSession(), 150);
}

function onLeave() { closeSession(); }

/* ==================================================================
   收：status / state / data
   ================================================================== */
function isGatewayStatus(o) {
  if (!o || o.role !== 'local' || o.action === 'leave') return false;
  return o.gw === 1 || o.tool === 'SYCC-GW' ||
    (o.data && Number(o.data.host) === 1) || Number(o.host) === 1;
}

function applyPeerStatus(o) {
  app.peerOnline = !!(app.sess && app.sess.peerOnline);
  if (app.peerOnline) {
    app.onlineOnce = true;
    if (app.offlineDismissed) app.offlineDismissed = false;
    $('offlineBanner').classList.remove('show');
  } else if (app.joined && app.onlineOnce && !app.offlineDismissed) {
    $('offlineTitle').textContent = '现场暂未响应（最近心跳 ' + clock() + '）';
    $('offlineBanner').classList.add('show');
  }
  if (isGatewayStatus(o)) {
    ensureGateway({
      gateway: o.tool || 'SYCC-GW',
      perm: o.perm,
      host: 1
    });
  }
  renderHeader();
}

function ensureGateway(pl) {
  const first = !app.gw;
  app.mirror = false;
  app.gw = app.gw || { on: true, name: 'SYCC-GW', fw: '', ip: '', perm: 2, host: true, uart: null };
  app.gw.on = true;
  if (pl.gateway) app.gw.name = pl.gateway;
  if (pl.fw) app.gw.fw = pl.fw;
  if (pl.ip) app.gw.ip = pl.ip;
  if (pl.perm) app.gw.perm = Number(pl.perm) || app.gw.perm;
  app.gw.host = true;

  if (first) {
    app.activeTab = 'tools';
    setBusy(0);
    app.cmd = { text: '网关已上线 · 桌面端优先接管（小程序 remote 暂停）', pending: false };
    toast('检测到 ESP32 模块托管，已进入网关工作台', true);
    pushOp('ok', 'ESP32 模块托管已接入', '网关 ' + app.gw.name + (app.gw.fw ? ' · v' + app.gw.fw : ''));
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
  send('sync.request', {}, { quiet: true }).catch(() => {});
}

function onStateMsg(o) {
  const pl = o.payload || {};

  if (pl.role === 'gateway') { applyGatewayDetail(pl); return; }
  if (pl.scan) { onScanState(pl); return; }

  if (o.type === 'page') {
    app.mirror = true;
    app.pageId = pl.page || '';
    app.widgets = Array.isArray(pl.widgets) ? pl.widgets : [];
    if (app.gw) app.gw.host = true;   // 托管中也会推页面？保持网关视图
    if (!app.gw) {
      app.activeTab = tabOfPage(app.pageId);
      app.cmd = { text: '现场页面已同步：' + (pl.title || app.pageId), pending: false };
      renderAll();
    }
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
  ensureGateway(pl);
  const u = pl.uart && pl.uart.baud ? normalizeUart(pl.uart) : null;
  if (u) {
    app.gw.uart = u;
    app.module.cur = u;
    if (!app.module.dirty) {
      app.module.edit = Object.assign({}, u);
    }
  }
  if (pl.sid) app.sid = pl.sid;
  renderHeader();
  if (app.activeTab === 'module') renderModuleLive();
  pushOp('info', '已同步网关说明书', [
    app.gw.name,
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
  (pl.lines || []).forEach((l) => {
    if (l && l.hex) pushPacket(l.dir, l.hex, '', l.t);
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
  $('txtFieldStatus').textContent = online
    ? ('现场在线' + (app.gw ? ' · 模块托管' : ''))
    : (app.joined ? '现场离线 · 等待重连' : '现场离线');
  $('pillField').className = 't-pill ' + (online ? 'ok' : 'warn');

  const u = app.gw && app.gw.uart;
  $('hdrUartSummary').textContent = u
    ? ('485: ' + u.baud + ' · ' + u.dataBits + u.parity + u.stopBits)
    : '485: —';
  $('pillUart').className = 't-pill' + (u ? ' ok' : '');

  const permName = { 1: '只读', 2: '标准', 3: '完全' }[app.gw ? app.gw.perm : 0] || '—';
  $('txtPerm').textContent = '权限: ' + permName + (app.gw && app.gw.perm === 2 ? ' (写需确认)' : '');
  $('pillPerm').className = 't-pill' + (app.gw ? '' : ' warn');

  $('syncBleName').textContent = app.gw ? app.gw.name : '—';
  $('syncFieldPage').textContent = TAB_LABEL[app.activeTab] || app.activeTab;
  $('btnFieldBack').disabled = gwReady();

  const boardBtn = $('btnToggleDockMode');
  boardBtn.textContent = '报文流: ' + ({ split: '分屏同显', pkt: '仅报文流', ops: '仅操作记录' }[app.dockMode] || '分屏同显');
}

function setBusy(delta) {
  app.busyCount = Math.max(0, app.busyCount + delta);
  const txt = app.busyCount > 0 ? ('执行中 Busy ×' + app.busyCount)
    : (app.modscan.polling ? '轮询中 Polling' : '空闲 Idle');
  $('sbBusyText').textContent = txt;
  $('sbBusyText').className = app.busyCount > 0 ? 'err' : '';
}

function renderStatusbar() {
  $('cmdStatusText').textContent = app.cmd.text;
  const banner = $('cmdReceiptBanner');
  banner.classList.toggle('pending', !!app.cmd.pending);
  $('cmdDot').style.background = app.cmd.pending ? 'var(--warn)' : 'var(--rx)';
  $('sbResultText').textContent = app.result.text;
  $('sbResultText').className = app.result.ok ? 'ok' : 'err';
  $('sbBusyText').textContent = app.busyCount > 0 ? ('执行中 Busy ×' + app.busyCount)
    : (app.modscan.polling ? '轮询中 Polling' : '空闲 Idle');
  $('sbBusyText').className = app.busyCount > 0 ? 'err' : '';
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
  if (!app.joined) { setNotice('先输入会话码接入现场'); return; }
  if (gwReady()) {
    app.activeTab = key;
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
function pushPacket(dir, hex, note, t) {
  const d = String(dir || 'SYS').toUpperCase();
  const h = String(hex || '').trim();
  if (!h && d !== 'SYS') return;
  const now = Date.now();
  // raw.tx 的 ack 与 data 主题镜像会报同一帧：1.5s 内同方向同 HEX 视为重复，只保留一条
  const dup = app.packets.find((p) => p.dir === d && p.hex === h && now - p.at < 1500);
  if (dup) { if (note) dup.note = note; return; }

  const len = h ? h.replace(/[^0-9A-Fa-f]/g, '').length / 2 : 0;
  app.packets.unshift({ dir: d, hex: h, note: note || '', t: t || clock(), len, at: now });
  if (app.packets.length > 240) app.packets.length = 240;
  if (d === 'TX') app.txBytes += len;
  if (d === 'RX') app.rxBytes += len;
  renderDock();
  if (app.activeTab === 'serial') renderSerialMonitor();
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
    pktList.innerHTML = '<div class="empty-state"><b>暂无报文</b>接入模块托管后，485 收发的每一帧都会出现在这里。</div>';
  } else {
    pktList.innerHTML = app.packets.map((p) => {
      const cls = p.dir === 'TX' ? 'tx' : (p.dir === 'RX' ? 'rx' : 'err');
      return '<div class="pkt-line ' + cls + '" data-hex="' + esc(p.hex) + '" title="点击复制此帧 HEX">' +
        '<div class="pkt-meta"><span><span class="pkt-dir">' + esc(p.dir) + '</span> ' +
        (p.len ? p.len + 'B' : '') + (p.note ? ' · ' + esc(p.note) : '') + '</span>' +
        '<span>' + esc(p.t) + '</span></div>' +
        '<div class="mono">' + (esc(p.hex) || esc(p.note)) + '</div></div>';
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

  $('panePackets').style.display = app.dockMode === 'ops' ? 'none' : 'flex';
  $('paneOps').style.display = app.dockMode === 'pkt' ? 'none' : 'flex';
  document.querySelectorAll('#dockModeSeg .seg-i').forEach((b) => {
    b.classList.toggle('on', b.dataset.dmode === app.dockMode);
  });
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
}

function buildJoinHint() {
  return '<div class="join-hint">' +
    '<h3>接入现场调试通道</h3>' +
    '<p>在顶部「会话码」里填现场给出的 7 位码（大写字母 / 数字，不含 O/0/I/1）。' +
    '现场手机托管和 ESP32 模块托管都能接：模块托管时现场手机可以离场，桌面端直接接管 485 总线。</p>' +
    '<div class="join-steps">' +
    '<div class="join-step"><i>1</i><span>现场在小程序里开启「远程托管」，拿到 7 位远程码。</span></div>' +
    '<div class="join-step"><i>2</i><span>把码填入顶部，点「接入」；手机托管需现场点「允许」，模块托管自动放行。</span></div>' +
    '<div class="join-step"><i>3</i><span>接入后左栏就是完整工作台：扫描 / Modscan / 串口 / RTU / 模块参数，右栏实时报文流。</span></div>' +
    '</div>' +
    '<div class="join-note">当前 Broker：<b class="mono">' + esc(buildWsUrl(MQTT_CONFIG_FROM(loadBroker())) || '未配置（点右上角「设置」）') + '</b>。' +
    '所有落到 485 总线的字节仍由现场模块 / 手机发出，桌面端只发意图与组帧，不直连硬件。</div>' +
    '</div>';
}

/* ---------------- 工具总览 ---------------- */
function buildToolsView() {
  const cards = [
    {
      key: 'scan', title: '从站扫描 (1~247)', icon: '扫',
      desc: '逐地址 FC03 探测在线表计，自动汇总在线站号，可一键跳到 RTU / Modscan。',
      stat: app.scan.list.length ? ('已发现 ' + app.scan.list.length + ' 台 (# ' + app.scan.list.slice(0, 6).join(', ') + ')') : '尚未扫描'
    },
    {
      key: 'modscan', title: 'Modscan 四区表格', icon: '表',
      desc: '01/02/03/04 四大寄存器区连续轮询、变值高亮与点击直写。',
      stat: app.modscan.rows.length ? ('监控 ' + app.modscan.rows.length + ' 个寄存器 · ' + app.modscan.round + ' 轮') : '尚未读取'
    },
    {
      key: 'serial', title: '串口调试助手', icon: '串',
      desc: 'HEX / ASCII 原始帧收发，自动追加 Modbus CRC16，支持循环发送。',
      stat: 'TX ' + app.txBytes + 'B / RX ' + app.rxBytes + 'B'
    },
    {
      key: 'rtu', title: '快速设置 RTU 参数', icon: '设',
      desc: '按寄存器模板读取设备现值，改站号 / 波特率 / 校验位并自动读回校验。',
      stat: app.rtu.hasRead ? ('已读取 ' + app.rtu.readAt) : ('模板 ' + profileOf().name)
    },
    {
      key: 'module', title: '蓝牙模块设置', icon: '模',
      desc: '查看模块身份与 485 侧串口参数；参数写入 NVS 后立即生效。',
      stat: (app.gw ? app.gw.name : '—') + ' · ' + (app.gw && app.gw.uart ? (app.gw.uart.baud + ' ' + app.gw.uart.dataBits + app.gw.uart.parity + app.gw.uart.stopBits) : '参数未读取')
    },
    {
      key: 'tools', title: '现场镜像页（手机托管）', icon: '镜',
      desc: '现场手机托管时，这里显示现场当前页面的镜像控件，点一下由现场执行。',
      stat: app.mirror ? ('现场页面：' + (app.pageId || '—')) : (gwReady() ? '模块托管下不需要镜像' : '等待现场页面')
    }
  ];

  return '<div class="w-card mark-ok">' +
    '<div class="w-card-hd"><div class="w-card-title">链路与运行态' +
    '<span class="w-card-sub">' + (gwReady() ? 'ESP32 模块托管 · 桌面端优先' : '现场手机托管 · 镜像操作') + '</span></div>' +
    '<span class="tag ' + (app.peerOnline ? 'ok' : 'warn') + '">' + (app.peerOnline ? '现场在线' : '现场离线') + '</span></div>' +
    '<div class="w-card-bd" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px">' +
    '<div><div style="font-size:11.5px;color:var(--ink-3)">网关 / 现场</div>' +
    '<div class="mono" style="font-size:20px;font-weight:700">' + esc(app.gw ? app.gw.name : (app.sid || '—')) + '</div></div>' +
    '<div style="display:flex;gap:22px;flex-wrap:wrap">' +
    '<div><div style="font-size:11px;color:var(--ink-3)">固件 / IP</div><div class="mono" style="font-size:14px;font-weight:600">' +
    esc((app.gw && app.gw.fw ? 'v' + app.gw.fw : '—') + (app.gw && app.gw.ip ? ' · ' + app.gw.ip : '')) + '</div></div>' +
    '<div><div style="font-size:11px;color:var(--ink-3)">485 串口</div><div class="mono" style="font-size:14px;font-weight:600">' +
    esc(app.gw && app.gw.uart ? (app.gw.uart.baud + ' · ' + app.gw.uart.dataBits + app.gw.uart.parity + app.gw.uart.stopBits) : '—') + '</div></div>' +
    '<div><div style="font-size:11px;color:var(--ink-3)">权限</div><div class="mono" style="font-size:14px;font-weight:600">' +
    esc(({ 1: '只读', 2: '标准', 3: '完全' }[app.gw ? app.gw.perm : 0] || '—')) + '</div></div>' +
    '<div><div style="font-size:11px;color:var(--ink-3)">报文</div><div class="mono" style="font-size:14px;font-weight:600">' +
    'TX ' + app.txBytes + 'B / RX ' + app.rxBytes + 'B</div></div>' +
    '</div></div></div>' +

    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px">' +
    cards.map((c) => '<button class="scan-card" data-act="open" data-tab="' + c.key + '" style="display:flex;flex-direction:column;gap:6px">' +
      '<div class="scan-card-top"><span class="tag info">' + esc(c.icon) + '</span><span style="color:var(--ink-3);font-size:11.5px">打开 ›</span></div>' +
      '<div style="font-size:13.5px;font-weight:600;color:var(--ink);margin-top:4px">' + esc(c.title) + '</div>' +
      '<div style="font-size:11.5px;color:var(--ink-3);line-height:1.5;text-align:left">' + esc(c.desc) + '</div>' +
      '<div class="mono" style="font-size:11px;color:var(--accent);text-align:left">' + esc(c.stat) + '</div>' +
      '</button>').join('') +
    '</div>' +
    (app.mirror ? buildMirrorCard() : '') +
    (!gwReady() ? '<div class="stage-note">当前为现场手机托管：完整工作台（Modscan 轮询 / raw.tx / 扫描进度）需要现场改用 <b>ESP32 模块托管</b>。' +
      '镜像操作仍可在上方「现场镜像页」卡片里完成。</div>' : '');
}

/* ---------------- 镜像页（手机托管 fallback） ---------------- */
function buildMirrorCard() {
  if (!app.mirror) return '';
  const rows = app.widgets.map((w) => mirrorRow(w)).join('');
  return '<div class="w-card"><div class="w-card-hd">' +
    '<div class="w-card-title">现场镜像 · ' + esc(TAB_LABEL[tabOfPage(app.pageId)] || app.pageId) +
    '<span class="w-card-sub">点一行由现场执行，高危动作现场会弹确认</span></div>' +
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
  return '<div class="stage-note">现场当前页已镜像到桌面端。该模式只提供现场页面的操作入口；' +
    '需要原始报文、轮询与客户端组帧，请让现场开启 <b>ESP32 模块托管</b>。</div>' + buildMirrorCard();
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
    '<span class="w-card-sub">FC' + (AREA_META[ms.area].fc < 10 ? '0' + AREA_META[ms.area].fc : AREA_META[ms.area].fc) + '</span></div>' +
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
    '<div class="f-hint">支持 PLC 记号（40001 / 30001 / 10001 / 00001）或 0x 前缀十六进制。</div>' +
    '</div></div>' +

    '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">实时寄存器数据表' +
    '<span class="w-card-sub">' + esc(AREA_META[ms.area].label) + ' · 点击「写值」弹窗下发 FC06</span></div>' +
    '<span class="tag tx">变值行赭红高亮</span></div>' +
    '<div class="w-card-bd tight"><table class="data-tbl"><thead><tr>' +
    '<th>寄存器地址</th><th>HEX 偏移</th><th>当前数值</th><th>HEX 原始值</th><th>刷新时间</th><th>远程改写</th>' +
    '</tr></thead><tbody id="msBody">' + modscanRowsHTML() + '</tbody></table></div>' +
    '<div class="w-card-ft"><span>写入前自动暂停轮询，FC06 写完并读回校验通过后自动恢复扫描。</span>' +
    '<span>' + (ms.at ? '最后刷新 ' + esc(ms.at) : '尚未读取') + '</span></div></div>' +
    '</div>' +
    (gwReady() ? '' : '<div class="stage-note">Modscan 需要模块托管直连（raw.tx）；手机托管请用现场镜像页。</div>');
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

async function modscanReadOnce() {
  const ms = app.modscan;
  if (!gwReady()) { setNotice('Modscan 需要 ESP32 模块托管'); return; }
  if (!app.joined || ms.busy) return;
  const meta = AREA_META[ms.area];
  const addrChk = parseAddrChecked(ms.start, meta.fc);
  if (!addrChk.ok) { setNotice(addrChk.msg); return; }
  ms.slave = clamp(num(ms.slave, 1), 1, 247);
  ms.count = clamp(num(ms.count, 10), 1, 120);
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
  }
}

function startPolling() {
  stopPolling();
  app.modscan.polling = true;
  pushOp('info', '启动 Modscan 连续扫描', '站号 #' + app.modscan.slave + ' · ' + app.modscan.count + ' 个 · 间隔 ' + app.modscan.interval + 'ms');
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
    '<div class="w-card-title">串口原始帧发送台<span class="w-card-sub">HEX / ASCII 与自动 CRC16 追加</span></div>' +
    '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
    '<span style="font-size:11.5px;color:var(--ink-3)">常用报文：</span>' +
    '<button class="btn sm" data-act="ser-preset" data-hex="01 03 00 00 00 0A">读保持 10 项</button>' +
    '<button class="btn sm" data-act="ser-preset" data-hex="01 03 00 00 00 01">读 1 个寄存器</button>' +
    '<button class="btn sm" data-act="ser-preset" data-hex="01 06 00 07 00 33">写 40008=51</button>' +
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

    '<div class="w-card" style="flex:1;display:flex;flex-direction:column">' +
    '<div class="w-card-hd"><div class="w-card-title">串口收发实时监控台' +
    '<span class="w-card-sub">TX 赭红 / RX 墨绿 · 与模块板载 WS2812B 灯语一致</span></div>' +
    '<span class="mono" style="font-size:12px;color:var(--ink-2)">TX ' + app.serial.txCount + ' 帧 / RX ' + app.serial.rxCount + ' 帧</span></div>' +
    '<div id="serMonitor" class="w-card-bd" style="display:flex;flex-direction:column;gap:6px">' + serialMonitorHTML() + '</div></div>' +
    (gwReady() ? '' : '<div class="stage-note">串口直发走 serial.send（模块托管）；手机托管请用现场镜像页的串口控件。</div>');
}

function serialMonitorHTML() {
  const lines = app.packets.filter((p) => p.dir === 'TX' || p.dir === 'RX').slice(0, 8);
  if (!lines.length) return '<div class="empty-state"><b>还没有收发报文</b>发送一帧后，原始字节会出现在这里。</div>';
  return lines.map((p) => '<div class="pkt-line ' + (p.dir === 'TX' ? 'tx' : 'rx') + '" style="display:flex;align-items:center;justify-content:space-between;gap:12px">' +
    '<div><span class="pkt-dir">' + p.dir + '</span> <span style="opacity:.7">' + esc(p.t) + ' (' + p.len + 'B)</span> · <b>' + esc(p.hex) + '</b></div>' +
    '<span style="font-size:11px;color:var(--ink-2)">' + esc(p.note) + '</span></div>').join('');
}

function renderSerialMonitor() {
  const el = $('serMonitor');
  if (el) el.innerHTML = serialMonitorHTML();
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

async function serialSendOnce() {
  const s = app.serial;
  if (!app.joined) { setNotice('先接入会话'); return; }
  if (s.busy) return;
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
    if (app.activeTab === 'serial') renderSerialMonitor();
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
    '<button class="btn" data-act="rtu-reset">重置为未读态</button>' +
    '<button class="btn primary" data-act="rtu-read">读取设备现值 (按表逐条 FC03)</button>' +
    '</div></div></div>' +

    '<div class="w-card"><div class="w-card-hd"><div class="w-card-title">RTU 参数读取与改写对照表' +
    '<span class="w-card-sub">' + (r.hasRead ? '最后读取 ' + r.readAt + ' · ' + r.rows.filter((x) => x.read).length + '/' + r.rows.length + ' 应答' : '尚未读取设备现值') + '</span></div>' +
    '<span style="font-size:12px;color:var(--ink-3)">每条写入后自动 FC03 读回校验</span></div>' +
    '<div class="w-card-bd tight"><table class="data-tbl"><thead><tr>' +
    '<th>参数名称</th><th>寄存器 · 功能码</th><th>模板默认值</th><th>设备当前现值</th><th>准备写入的目标值</th><th>即将下发 HEX（含 CRC）</th><th>单条执行</th>' +
    '</tr></thead><tbody id="rtuBody">' + rows + '</tbody></table></div>' +
    '<div class="w-card-ft"><span>' + esc(prof.note) + '</span><span>' + (gwReady() ? '模块托管 · 客户端组帧' : '需模块托管') + '</span></div></div>' +

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
  if (!gwReady()) { setNotice('读取 RTU 现值需要模块托管'); return; }
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
      }
    }
  });
}

/* ---------------- 模块设置 ---------------- */
function buildModuleView() {
  const m = app.module;
  const cur = m.cur.baud ? (m.cur.baud + ' · ' + m.cur.dataBits + m.cur.parity + m.cur.stopBits) : '—';
  const preview = m.edit.baud + ' · ' + m.edit.dataBits + m.edit.parity + m.edit.stopBits;
  const dirty = m.cur.baud && preview !== cur;
  // 广播名不在远程序里：模块托管没有改名命令，现场蓝牙改名也不该出现在远程工作台，
  // 所以这一页只保留"能改、可验证"的 485 侧参数（uart.set）。
  return '<div class="w-card mark-ok"><div class="w-card-hd"><div class="w-card-title">当前模块 485 侧运行参数</div>' +
    '<button class="btn sm" data-act="mod-read">读当前参数</button></div>' +
    '<div class="w-card-bd" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px">' +
    '<div><div style="font-size:11.5px;color:var(--ink-3)">模块当前生效串口参数（改完模块后，下游 485 表计必须设为同参数）</div>' +
    '<div class="mono" style="font-size:24px;font-weight:700;margin-top:2px">' + esc(cur) + '</div></div>' +
    '<div style="display:flex;gap:18px;flex-wrap:wrap">' +
    '<div><div style="font-size:11px;color:var(--ink-3)">固件 / IP</div><div class="mono" style="font-size:14px;font-weight:600">' +
    esc((app.gw && app.gw.fw ? 'v' + app.gw.fw : '—') + (app.gw && app.gw.ip ? ' · ' + app.gw.ip : '')) + '</div></div>' +
    '<div><div style="font-size:11px;color:var(--ink-3)">现场链路</div><div style="font-size:13px">' +
    '<span class="tag ' + (app.peerOnline ? 'ok' : 'warn') + '">' + (app.peerOnline ? '在线' : '离线') + '</span> ' +
    '<span class="tag ' + (gwReady() ? 'ok' : 'info') + '">' + (gwReady() ? '模块托管' : '手机托管') + '</span></div></div>' +
    '</div></div></div>' +

    '<div class="w-card ' + (dirty ? 'mark-warn' : '') + '"><div class="w-card-hd">' +
    '<div class="w-card-title">485 侧串口参数配置<span class="w-card-sub">写入 NVS 并立即生效</span></div>' +
    (dirty ? '<span class="tag warn">未写入 · 待下发</span>' : '<span class="tag ok">与模块一致</span>') + '</div>' +
    '<div class="w-card-bd" style="display:flex;flex-direction:column;gap:12px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:8px;background:var(--win-panel);border:1px solid var(--win-line-soft)">' +
    '<span style="font-size:12px;color:var(--ink-2)">组合预览（即将写入）</span>' +
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
    '<button class="btn" data-act="mod-reset">恢复模块当前值</button>' +
    '<button class="btn ' + (dirty ? 'danger' : 'primary') + '" style="flex:1" data-act="mod-commit">▲ 写入串口参数 · ' + esc(preview) + '</button>' +
    '</div></div>' +
    '<div class="w-card-ft"><span>提示：改完模块 485 侧参数后，下游表计必须改成同一组，否则总线无法应答。</span></div></div>' +
    (gwReady() ? '' : '<div class="stage-note">模块参数写入需要模块托管（uart.set）；手机托管下只能看镜像。</div>');
}

function renderModuleLive() {
  if (app.activeTab !== 'module') return;
  renderStage();
}

async function moduleRead() {
  if (!app.joined) { setNotice('先接入会话'); return; }
  if (!gwReady()) { setNotice('读取模块参数需要 ESP32 模块托管'); return; }
  app.module.reading = true;
  setBusy(1);
  try {
    const data = await send('sync.request', {}, { quiet: true, timeout: 6000 });
    if (data && data.uart) {
      const u = normalizeUart(data.uart);
      if (u) {
        app.gw.uart = u;
        app.module.cur = u;
        if (!app.module.dirty) app.module.edit = Object.assign({}, u);
      }
    }
    if (data && data.gateway) app.gw.name = data.gateway;
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
  }
}

function moduleCommit() {
  if (!gwReady()) { setNotice('写入模块参数需要模块托管'); return; }
  const e = app.module.edit;
  if (!confirm('应用模块 485 参数：' + e.baud + ' · ' + e.dataBits + e.parity + e.stopBits +
    '\n\n参数写入 ESP32 NVS 并立即生效，下游表计必须同参数，确认？')) return;
  setBusy(1);
  send('uart.set', {
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
    '</div></div>' +
    (gwReady() ? '' : '<div class="stage-note">扫描进度来自现场固件扫描状态机（模块托管）。</div>');
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
  if (!gwReady()) { setNotice('从站扫描需要模块托管（scan.start）'); return; }
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
  try {
    await send('scan.start', { start: s.start, end: s.end, reg: s.reg, timeout: s.timeout }, {
      noRetry: true, timeout: 8000, pendingText: '扫描指令已下发…', doneText: '扫描已启动'
    });
    s.running = true; s.done = false; s.list = []; s.cur = s.start;
    pushOp('info', '启动从站扫描', '范围 ' + s.start + '~' + s.end + ' · 探测寄存器 ' + s.reg);
    renderStage();
  } catch (e) { setNotice('启动扫描失败：' + (e.message || '')); }
}

/* ==================================================================
   写入弹窗
   ================================================================== */
let wmCtx = null;

function openWriteModal(ctx) {
  wmCtx = ctx;
  $('wmTitle').textContent = ctx.title || '写入寄存器';
  $('wmSub').textContent = ctx.sub || '';
  $('wmFoot').textContent = ctx.foot || '写完自动读回校验';
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
  $('themeBtn').textContent = '主题：' + (t === 'light' ? '浅色同源' : '深色工业台');
  try { localStorage.setItem(LS_THEME, t); } catch (e) {}
}

function toggleTheme() {
  applyTheme(document.body.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}

/* ---- Broker 设置弹窗 ---- */
function openSettings() {
  const c = loadBroker();
  $('cfgHost').value = c.host || MQTT_SERVER.host;
  $('cfgUser').value = c.username || MQTT_SERVER.username;
  $('cfgPass').value = c.password || '';
  $('settingsErr').textContent = '';
  $('settingsMask').classList.add('show');
}
function closeSettings() { $('settingsMask').classList.remove('show'); }
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
  closeSettings();
  refreshBrokerText();
  setNotice('Broker 设置已保存，重启会话后生效', true);
}

/** 标题栏的 broker 摘要：未配置时提示去设置，避免显示一个空 URL */
function refreshBrokerText() {
  const url = buildWsUrl(MQTT_CONFIG_FROM(loadBroker()));
  $('brokerText').textContent = url || '未配置 broker（点「设置」）';
}

/* ==================================================================
   事件绑定
   ================================================================== */
function bind() {
  const stage = $('mainStage');

  // 静态按钮
  $('joinBtn').addEventListener('click', onJoin);
  $('leaveBtn').addEventListener('click', onLeave);
  $('btnEndSession').addEventListener('click', onEndSession);
  $('btnResync').addEventListener('click', () => {
    if (!app.joined) { setNotice('先接入会话'); return; }
    send('sync.request', {}, { okTitle: '已重新同步', timeout: 8000 }).catch(() => {});
  });
  $('btnFieldBack').addEventListener('click', () => {
    if (!app.joined) return;
    if (gwReady()) { setNotice('模块托管没有"现场页面"可返回', true); return; }
    send('nav.back', {}, { okTitle: '现场已返回' }).catch(() => {});
  });
  $('btnNotifyFieldPage').addEventListener('click', () => {
    if (!app.joined) { setNotice('先接入会话'); return; }
    if (gwReady()) { setNotice('模块托管下页面只存在于桌面端', true); return; }
    send('nav.open', { page: TAB_PAGE[app.activeTab] }, { okTitle: '已通知现场切到「' + TAB_LABEL[app.activeTab] + '」' }).catch(() => {});
  });
  $('btnPingField').addEventListener('click', () => {
    if (!app.joined) return;
    const t0 = performance.now();
    send('ping', { t: Date.now() }, { noRetry: true, timeout: 5000 }).then((d) => {
      const ms = Math.round(performance.now() - t0);
      pushOp('ok', '唤醒 Ping 已回', 'RTT ' + ms + 'ms' + (d && d.pong ? ' · pong ' + d.pong : ''));
      app.result = { text: 'PING OK (' + ms + 'ms)', ok: true };
      renderStatusbar();
    }).catch((e) => {
      pushOp('err', 'Ping 无回应', e && e.message || '');
      setNotice('现场仍未响应，确认模块是否在线');
    });
  });
  $('btnDismissOffline').addEventListener('click', () => {
    app.offlineDismissed = true;
    $('offlineBanner').classList.remove('show');
  });
  $('btnClearLogs').addEventListener('click', () => {
    app.packets = []; app.ops = [];
    app.txBytes = 0; app.rxBytes = 0;
    renderDock();
    pushOp('info', '已清空报文流与操作记录', '');
  });
  $('themeBtn').addEventListener('click', toggleTheme);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsMask').addEventListener('click', (e) => { if (e.target === $('settingsMask')) closeSettings(); });
  $('cfgPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
  $('btnToggleDockMode').addEventListener('click', () => {
    app.dockMode = app.dockMode === 'split' ? 'pkt' : (app.dockMode === 'pkt' ? 'ops' : 'split');
    renderDock();
  });
  document.querySelectorAll('#dockModeSeg .seg-i').forEach((b) => {
    b.addEventListener('click', () => { app.dockMode = b.dataset.dmode; renderDock(); });
  });

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
  $('wmClose').addEventListener('click', closeWriteModal);
  $('writeModal').addEventListener('click', (e) => { if (e.target === $('writeModal')) closeWriteModal(); });
  document.querySelectorAll('.wm-quick').forEach((b) => {
    b.addEventListener('click', () => { $('wmInput').value = b.dataset.v; updateWmFrame(); });
  });

  // 值编辑弹层
  $('sheetCancel').addEventListener('click', closeSheet);
  $('sheetCloseX').addEventListener('click', closeSheet);
  $('sheetMask').addEventListener('click', (e) => { if (e.target === $('sheetMask')) closeSheet(); });
  $('sheetSend').addEventListener('click', sheetSubmit);
  $('sheetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sheetSubmit(); });

  // 主工作区事件委托：重新渲染后不需要重新绑定
  stage.addEventListener('click', onStageClick);
  stage.addEventListener('input', onStageInput);
  stage.addEventListener('change', onStageChange);
}

function onStageClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'open':
      app.activeTab = el.dataset.tab || 'tools';
      renderAll();
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
    case 'ser-send':
      serialSendOnce();
      break;
    case 'ser-loop':
      if (app.serial.looping) stopSerialLoop(); else startSerialLoop();
      break;

    case 'rtu-read':
      rtuReadAll();
      break;
    case 'rtu-reset':
      app.rtu.rows.forEach((it) => { it.read = false; it.cur = null; it.err = ''; });
      app.rtu.hasRead = false;
      app.rtu.lastVerify = null;
      renderStage();
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
    case 'mod-reset':
      app.module.edit = Object.assign({}, app.module.cur);
      app.module.dirty = false;
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
        pushOp('info', '从扫描结果跳到 RTU 设置', '站号 #' + id);
        renderAll();
      }
      break;

    case 'mirror-sync':
      send('sync.request', {}, { okTitle: '已重新同步' }).catch(() => {});
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
  if (f === 'serLoopMs') { app.serial.loopMs = clamp(num(el.value, 1000), 100, 60000); return; }
}

/* ==================================================================
   启动
   ================================================================== */
function boot() {
  bind();

  let theme = 'dark';
  try { theme = localStorage.getItem(LS_THEME) || 'dark'; } catch (e) {}
  applyTheme(theme);
  refreshBrokerText();

  const lastSid = localStorage.getItem(LS_SID) || '';
  $('sidInput').value = lastSid;
  $('sidErr').textContent = sidHint(lastSid);

  // 网关可用时，默认落到 Modscan？不：先给工具总览，避免误以为"没有链路"
  app.activeTab = 'tools';
  renderAll();

  pushOp('info', '桌面工作台就绪', '输入现场 7 位会话码接入 · 模块托管 / 手机托管都支持');
}

boot();

// 暴露给 Node 单测 / 调试（与旧版保持同名入口，便于脚本复用）
if (typeof window !== 'undefined') {
  window.__mrd = { app, onJoin, send, P, pushOp, renderAll };
}
