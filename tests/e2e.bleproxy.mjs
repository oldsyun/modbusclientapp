/**
 * tests/e2e.bleproxy.mjs — 「BLE 小程序代理」端到端（离线，无需 broker / 真机）
 *
 * 场景：现场小程序用蓝牙连模块，再由手机连 MQTT（没有 WiFi 网关）。
 * 桌面端要复用 ESP32 WiFi 直连时的那套网关工作台，因此小程序侧新增了
 * utils/assist/ble-gateway.js + host.js 的网关命令路由。
 *
 * 本用例把**真实的两端实现**接在一起：
 *   · 现场端：miniprogram/utils/assist/host.js + ble-gateway.js（假 BLE 模块）
 *   · 远程端：desktop-client/src/lib/session.js（桌面真实 Session）
 * 中间只把 MQTT 换成内存总线，验证：
 *   1. status {gw:1, ble:1, link:"ble"} / state {role:"gateway"} 能被识别
 *   2. raw.tx 真正走 BLE → 从站应答 → 桌面端拿到 rx（含 FC03 读 / FC06 写）
 *   3. serial.send、uart.set、scan.start 的 ack / state 形状与固件网关一致
 *   4. 只读权限 403、蓝牙断开 409
 *   5. assist.kick 能收掉现场会话
 *
 * 跑法：node tests/e2e.bleproxy.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Session } from '../src/lib/session.js';
import * as MB from '../src/lib/modbus.js';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../miniprogram/utils/', import.meta.url));
// 桌面端单独成仓时 CI 里没有 miniprogram/：跳过，不把跨仓用例算失败
if (!fs.existsSync(path.join(ROOT, 'assist', 'host.js'))) {
  console.log('SKIP: 未找到 miniprogram/（单仓 CI），跳过 BLE 小程序代理跨端用例');
  process.exit(0);
}
const MC = require(path.join(ROOT, 'modbus-core.js'));
const BT = require(path.join(ROOT, 'ble-transport.js'));
const MI = require(path.join(ROOT, 'mod-info.js'));

/* ---------- 断言 ---------- */
const results = [];
function check(name, ok, extra) {
  results.push([name, !!ok]);
  console.log((ok ? '  ✓ ' : '  ✖ ') + name + (extra ? '  ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假 BLE 模块：真从站 + SYCC 配置帧 ---------- */
function makeBleModule() {
  const PROTO = BT.PROTO;
  const FL = PROTO.frameLen;
  const bodyLen = PROTO.bodyLen;
  const tail = PROTO.tail;
  const regs = {};
  for (let i = 0; i < 10; i++) regs[i] = 100 + i;
  const uart = { baud: '9600', dataBits: '8', stopBits: '1', parity: 'N' };
  const sniffers = [];
  let stopped = false;

  const ble = {
    state: 'connected',
    kind: 'ble',
    deviceId: 'dev-ble-1',
    deviceName: 'SYCC485-A3D9',
    written: [],
    regs,
    addSniffer(fn) { if (sniffers.indexOf(fn) < 0) sniffers.push(fn); },
    removeSniffer(fn) { const i = sniffers.indexOf(fn); if (i >= 0) sniffers.splice(i, 1); },
    drainBuffer() { return []; },
    send(data) {
      const bytes = Array.from(data);
      ble.written.push(bytes);
      setTimeout(() => respond(bytes), 2);
      return Promise.resolve();
    },
    emit(bytes) {
      const b = Array.from(bytes);
      setTimeout(() => {
        // 故意按 7 字节切片：真实 BLE 通知不会按帧边界到达
        for (let i = 0; i < b.length; i += 7) {
          const part = b.slice(i, i + 7);
          sniffers.slice().forEach((fn) => { try { fn(part); } catch (e) {} });
        }
      }, 1);
    }
  };

  function frame(text) { return BT.buildFrame(text); }
  function emitScanLine(s) { ble.emit(Array.from(Buffer.from(s + '\n', 'latin1'))); }

  function respond(bytes) {
    // SYCC 80 字节配置帧
    if (bytes.length === FL) {
      let txt = '';
      for (let i = 0; i < bodyLen; i++) txt += String.fromCharCode(bytes[i]);
      txt = txt.trim();
      if (txt.indexOf('R-485Setting') >= 0) {
        ble.emit(frame('H-485Setting:' + uart.baud.padStart(6, '0') + ',' + uart.dataBits + ',' + uart.stopBits + ',' + uart.parity + '.'));
        return;
      }
      if (txt.indexOf('W-485Setting') >= 0) {
        const m = txt.match(/W-485Setting:(\d+),(\d),(\d),([NOE])/i);
        if (m) {
          uart.baud = String(parseInt(m[1], 10));
          uart.dataBits = m[2];
          uart.stopBits = m[3];
          uart.parity = m[4].toUpperCase();
        }
        ble.emit(frame('H-485Setting:' + uart.baud.padStart(6, '0') + ',' + uart.dataBits + ',' + uart.stopBits + ',' + uart.parity + '.'));
        return;
      }
      if (txt.indexOf('R-PartNumber') >= 0) {
        ble.emit(frame('H-PartNumber:SYCC485.'));
        return;
      }
      if (txt.indexOf('R-Scan485') >= 0) {
        const m = txt.match(/R-Scan485:(\d+),(\d+),(\d+),(\d+)/);
        const end = m ? parseInt(m[2], 10) : 247;
        setTimeout(() => {
          emitScanLine('SCAN485:START,1,' + end);
          emitScanLine('SCAN485:HIT,7');
          emitScanLine('SCAN485:HIT,17');
          emitScanLine('SCAN485:END,' + end + ',2');
        }, 5);
        return;
      }
      if (txt.indexOf('R-ScanStop') >= 0) {
        emitScanLine('SCAN485:ABORT,17,1');
        return;
      }
      return;
    }

    // Modbus RTU 请求
    if (bytes.length < 4) return;
    const slave = bytes[0];
    const fc = bytes[1];
    if (fc === 3 || fc === 4) {
      const addr = (bytes[2] << 8) | bytes[3];
      const qty = (bytes[4] << 8) | bytes[5];
      const data = [];
      for (let i = 0; i < qty; i++) {
        const v = regs[addr + i] === undefined ? 0 : regs[addr + i];
        data.push((v >> 8) & 255, v & 255);
      }
      ble.emit(MC.buildRtuFrame([slave, fc, data.length].concat(data)));
      return;
    }
    if (fc === 6) {
      const addr = (bytes[2] << 8) | bytes[3];
      const v = (bytes[4] << 8) | bytes[5];
      regs[addr] = v;
      ble.emit(bytes.slice());          // FC06 回显请求
      return;
    }
    if (fc === 5) { ble.emit(bytes.slice()); }
  }

  return ble;
}

/* ---------- 现场端 Host 的会话桩：把 ack/state/data 投到内存总线 ---------- */
function bootHost(ble, sid) {
  global.getApp = () => ({ globalData: { ble } });
  global.wx = {
    getStorageSync() { return ''; },
    setStorageSync() {},
    showToast() {},
    showModal() {},
    reLaunch() {},
    navigateTo() {},
    redirectTo() {}
  };
  global.getCurrentPages = () => [{ route: 'pages/index/index' }];
  // Host 依赖的全局方法在 Node 里不存在，这里补齐后再 require
  const HostMod = require(path.join(ROOT, 'assist', 'host.js'));
  const host = new HostMod.Host();
  host.sid = sid;
  // 现场点「允许」之前不应暴露网关；用例先验这一点，后面再模拟点允许

  let seq = 0;
  const topics = { state: 'assist/' + sid + '/state', data: 'assist/' + sid + '/data', config: 'assist/' + sid + '/config' };
  // 多远程端：deliver 把每一帧投给所有在册的远程端（真实 broker 就是这个语义）
  const remotes = [];
  const deliver = (topic, o) => {
    seq += 1;
    const env = { v: 1, sid, seq, ts: Date.now(), from: 'local', type: o.type, payload: o.payload || {} };
    remotes.forEach((r) => r._onMessage(topic, JSON.stringify(env)));
  };
  host.session = {
    isConnected: () => true,
    ack: (reqId, ok, code, msg, data) => deliver(topics.state, {
      type: 'ack', payload: { reqId, ok, code, msg, data: data === undefined ? null : data }
    }),
    // ★ config 主题回执（config.result）投到 config 主题，桌面端 sendConfig 才会结算
    publishConfigResult: (reqId, ok, code, msg, data) => deliver(topics.config, {
      type: 'config.result', payload: { reqId, ok: !!ok, code, msg, data: data === undefined ? null : data }
    }),
    publishState: (type, payload) => deliver(topics.state, { type, payload }),
    publishData: (payload) => deliver(topics.data, { type: 'log', payload }),
    publishStatus: (action, extra, qos) => {
      void extra; void qos;
      // 现场端心跳（真实实现是 QoS0 的 status 主题）
      const o = { action, role: 'local', tool: '调试工具', ver: 1, ts: Date.now(), cid: 'host-e2e',
        ctl: host._peers.controller, n: host._peers.count() };
      const extraFields = host._gatewayStatus();
      remotes.forEach((r) => r._onMessage(topics.status, JSON.stringify(Object.assign(o, extraFields))));
      return true;
    },
    close() {}
  };
  return {
    host,
    attachRemote(r) { if (remotes.indexOf(r) < 0) remotes.push(r); },
    detachRemote(r) { const i = remotes.indexOf(r); if (i >= 0) remotes.splice(i, 1); },
    topics
  };
}

/* ---------- 桌面端 Session（真实）接到 Host ---------- */
function makeDesktop(hostBox, sid, state, opts) {
  opts = opts || {};
  const cid = opts.cid || 'desk-e2e-1';
  const kind = opts.kind || 'desktop';
  const tool = opts.tool || '桌面调试台';
  const remote = new Session({ role: 'remote', sid, tool, kind });
  const topics = {
    cmd: 'assist/' + sid + '/cmd',
    state: 'assist/' + sid + '/state',
    data: 'assist/' + sid + '/data',
    status: 'assist/' + sid + '/status',
    config: 'assist/' + sid + '/config'
  };
  remote.client = {
    clientId: cid,
    isConnected: true,
    subscribe() {},
    destroy() {},
    publish(topic, msg) {
      const msgObj = JSON.parse(msg);
      if (topic === topics.cmd) {
        // 现场端在线表里登记这个远程端；真实链路里 join 已先到过
        hostBox.host._peers.upsert({ cid, kind, tool });
        hostBox.host._onCmd(msgObj);
      } else if (topic === topics.config) {
        // ★ config 主题 → 现场端 _onConfig（模块查询/配置，取代已删除的 cmd sync.request/uart.set）
        hostBox.host._peers.upsert({ cid, kind, tool });
        hostBox.host._onConfig(msgObj);
      } else if (topic === topics.status) {
        // 远程端的 join/heartbeat/leave 投给现场端 → statusExtra 里能拿到对端身份
        const isLeave = msgObj.action === 'leave';
        if (!isLeave) hostBox.host.ingestStatus(msgObj);
      }
      return true;
    }
  };
  remote.status = 'online';
  remote.onState = (o) => {
    const pl = o.payload || {};
    if (pl.role === 'gateway') {
      state.gw = {
        name: pl.gateway || pl.name || 'SYCC-GW',
        link: pl.link || (pl.ble === 1 ? 'ble' : 'wifi'),
        ble: pl.ble === 1,
        perm: pl.perm,
        uart: pl.uart || state.gw?.uart,
        host: pl.host === 1
      };
      return;
    }
    if (pl.scan) state.scans.push({ scan: pl.scan, addr: pl.addr, found: pl.found, cur: pl.cur });
    if (o.type === 'view' && pl.page) state.views.push(pl);
  };
  remote.onData = (o) => { (o.payload.lines || []).forEach((l) => state.logs.push(l)); };
  hostBox.attachRemote(remote);
  return { remote, topics };
}

/* ---------- 用例 ---------- */
async function run() {
  const sid = 'BLEE2E1';
  const ble = makeBleModule();
  MI.note(ble, { name: 'SYCC485-A3D9', baud: 9600, dataBits: 8, parity: 'N', stopBits: 1 });

  const box = bootHost(ble, sid);
  const state = { gw: null, scans: [], logs: [], views: [] };
  const { remote } = makeDesktop(box, sid, state);
  const { host } = box;

  // 0) 现场还没点「允许」：不暴露网关；config.get（只读）已放行；其它操作回 403
  const stPre = host._gatewayStatus();
  check('未允许前 statusExtra 不带网关', !stPre.gw && !stPre.ble, JSON.stringify(stPre));
  // ★ 迁移后：cmd 的 sync.request 已删除，模块信息改走 config 主题的 config.get（只读，放行）
  const preCfg = await remote.sendConfig('config.get', { what: 'work' }, { timeout: 1000 });
  check('未允许前 config.get 仍可读', !!(preCfg && (preCfg.role || preCfg.uart || preCfg.wifi !== undefined)), JSON.stringify(preCfg));
  let gateErr = null;
  try {
    await remote.sendCmd('raw.tx', { hex: MB.bytesToHex(MB.buildReadFrame(1, 3, 0, 1), ' ') }, { noRetry: true, timeout: 1000 });
  } catch (e) { gateErr = e; }
  check('未允许前 raw.tx 回 403', gateErr && gateErr.code === 403, JSON.stringify(gateErr));

  // 模拟现场在弹窗里点「允许」（多远程端：允许位按 cid 记账）
  host._allowed = true;
  host._allowedCids['desk-e2e-1'] = true;

  // 1) 心跳/join 的 statusExtra：桌面端不必等查询就能识别网关
  const st = host._gatewayStatus();
  check('statusExtra 带 gw:1 / ble:1 / link:"ble"', st.gw === 1 && st.ble === 1 && st.link === 'ble', JSON.stringify(st));

  // 2) config.get{work} → 网关说明书（取代已删除的 cmd sync.request）
  const core = await remote.sendConfig('config.get', { what: 'work' }, { timeout: 4000 });
  check('config.get 回 role:"gateway"', core.role === 'gateway', JSON.stringify(core));
  check('说明书带 link:"ble" / host:1', core.link === 'ble' && core.host === 1);
  check('说明书带模块名与 485 参数', core.gateway === 'SYCC485-A3D9' && core.uart && core.uart.baud === '9600');
  // ★ 迁移后：模块信息随 config.get 回执返回（不再有 cmd sync.request 触发的 state 推送）。
  //   core 即桌面端 applyModuleInfo 的输入——只要它带 role/link/gateway 网关面板就能挂起。
  check('config.get 回执可驱动网关面板（role/link/gateway 齐全）',
    core.role === 'gateway' && core.link === 'ble' && core.gateway === 'SYCC485-A3D9', JSON.stringify(core));

  // 3) raw.tx 读：桌面组帧 → 手机 BLE → 假从站 → 回 rx
  const readHex = MB.bytesToHex(MB.buildReadFrame(1, 3, 0, 2), ' ');
  const r = await remote.sendCmd('raw.tx', { hex: readHex, expectLen: 9, timeoutMs: 500 }, { noRetry: true, timeout: 4000 });
  const parsed = MB.parseResponse(MB.hexToBytes(r.rx), 3, 2);
  check('raw.tx 读回 2 个寄存器', parsed.ok && parsed.values[0] === 100 && parsed.values[1] === 101, JSON.stringify(parsed.values));
  check('raw.tx ack 带 rxLen/elapsed', r.rxLen === 9 && r.elapsed >= 0, JSON.stringify({ len: r.rxLen, ms: r.elapsed }));
  check('data 主题同步了 TX/RX 报文', state.logs.some((l) => l.dir === 'TX') && state.logs.some((l) => l.dir === 'RX'));

  // 4) raw.tx 写 + 读回
  const writeHex = MB.bytesToHex(MB.buildWriteSingleFrame(1, 6, 0, 55), ' ');
  await remote.sendCmd('raw.tx', { hex: writeHex, expectLen: 8, timeoutMs: 500 }, { noRetry: true, timeout: 4000 });
  const r2 = await remote.sendCmd('raw.tx', { hex: readHex, expectLen: 9, timeoutMs: 500 }, { noRetry: true, timeout: 4000 });
  const after = MB.parseResponse(MB.hexToBytes(r2.rx), 3, 2);
  check('FC06 写入经 BLE 落到从站（读回 55）', after.values[0] === 55, JSON.stringify(after.values));

  // 5) serial.send
  const ser = await remote.sendCmd('serial.send', { hex: readHex.replace(/\s+/g, ''), wait: true }, { noRetry: true, timeout: 4000 });
  check('serial.send 回 tx/rx', !!ser.tx && !!ser.rx && /^01 03/.test(ser.rx), JSON.stringify(ser));

  // 6) config.set{uart} → 模块回读值 + state 更新（取代已删除的 cmd uart.set）
  const u = await remote.sendConfig('config.set', { what: 'uart', baud: 19200, dataBits: 8, stopBits: 1, parity: 'E' }, { noRetry: true, timeout: 6000 });
  const uu = (u && u.uart) ? u.uart : u;   // config.set 回 {uart:{...}}，兼容直接回字段
  check('config.set 回模块回读值', String(uu.baud) === '19200' && uu.parity === 'E', JSON.stringify(u));
  await sleep(30);
  check('config.set 后桌面端网关参数同步', state.gw && state.gw.uart && String(state.gw.uart.baud) === '19200', JSON.stringify(state.gw && state.gw.uart));

  // 7) 扫描：固件 SCAN485 行 → state{scan}
  await remote.sendCmd('scan.start', { start: 1, end: 247, reg: 0, timeout: 80 }, { noRetry: true, timeout: 4000 });
  await sleep(80);
  const hits = state.scans.filter((s) => s.scan === 'HIT').map((s) => s.addr);
  check('扫描 HIT 事件到达桌面端', hits.join(',') === '7,17', JSON.stringify(state.scans));
  check('扫描 END 带 found=2', state.scans.some((s) => s.scan === 'END' && s.found === 2));

  // 8) 只读权限：写帧 403，且不再写 BLE
  const before = ble.written.length;
  host.policy = 1;
  let forbidden = null;
  try { await remote.sendCmd('raw.tx', { hex: writeHex }, { noRetry: true, timeout: 1000 }); }
  catch (e) { forbidden = e; }
  check('只读档写 raw.tx 回 403', forbidden && forbidden.code === 403, JSON.stringify(forbidden));
  check('只读档拒绝后没有写 BLE', ble.written.length === before, ble.written.length + ' vs ' + before);
  host.policy = 2;

  // 9) 蓝牙断开：网关命令回 409（不落到镜像页的“现场不在可操作页面”）
  ble.state = 'disconnected';
  let linkErr = null;
  try { await remote.sendCmd('raw.tx', { hex: readHex }, { noRetry: true, timeout: 1000 }); }
  catch (e) { linkErr = e; }
  check('蓝牙断开回 409', linkErr && linkErr.code === 409, JSON.stringify(linkErr));
  ble.state = 'connected';

  // 10) 页面双向同步：控制端切页 → host 导航；页面 patch → host 落地并广播
  const nav = [];
  // 让 host 的导航可观测（bootHost 里的 wx 是全局对象，这里补记录）
  global.wx.navigateTo = (o) => nav.push(o.url);
  global.wx.redirectTo = (o) => nav.push(o.url);
  const fv = await remote.sendCmd('view.follow', { page: 'scan', data: { cur: 3 } }, { noRetry: true, timeout: 2000 });
  check('view.follow 被 host 受理', fv && fv.page === 'scan', JSON.stringify(fv));
  check('host 导航到扫描页', nav.some((u) => /debug\/scan/.test(u)), JSON.stringify(nav));

  host.page = {
    assistPageId: 'scan',
    data: { running: false, scanned: false, cur: 3, total: 247, pct: 0, etaText: '', found: [], startAddr: '1', endAddr: '247', reg: '0', regMode: 'dec', timeout: '80', unsupported: false },
    applyRemoteView(d) { this.applied = d; this.data.cur = d.cur; }
  };
  host.pageId = 'scan';
  await remote.sendCmd('view.patch', { page: 'scan', data: { cur: 11 } }, { noRetry: true, timeout: 2000 });
  await sleep(30);
  check('view.patch 落到现场页', host.page.applied && host.page.applied.cur === 11, JSON.stringify(host.page.applied));
  check('host 把页面状态广播回控制端', state.views.some((v) => v.page === 'scan' && v.data && v.data.cur === 11), JSON.stringify(state.views.slice(-1)));

  // 现场本地改页面 → 控制端也应该收到
  host.publishView('scan', { cur: 33, running: true, found: [7] }, 'phone');
  await sleep(20);
  check('现场本地页面状态回传控制端', state.views.some((v) => v.source === 'phone' && v.data.cur === 33), JSON.stringify(state.views.slice(-1)));

  /* ================= 12) 多远程端：网页端 + 小程序同时在线 ================= */
  // 现场重新"允许"（页面同步那几步把 allowed 位用掉了也无妨，这里显式保证）
  host._allowedCids['desk-e2e-1'] = true;
  const webState = { gw: null, scans: [], logs: [], views: [], peers: [] };
  const webBox = makeDesktop(box, sid, webState, { cid: 'web-e2e-1', kind: 'web', tool: '网页调试台' });
  webBox.remote.onPeers = (info) => { webState.peers.push(info); };

  // 现场点头放行这台网页端（现场端在 join 时就把它登记进在线表并弹「允许」；
  // 这里补登记 + 补允许位，模拟现场点了「允许」）
  host._peers.upsert({ cid: 'web-e2e-1', kind: 'web', tool: '网页调试台' });
  host._allowedCids['web-e2e-1'] = true;
  // 两台都已被现场允许：桌面端优先级更高，重新选举后应该拿回控制权
  host._allowedCids['desk-e2e-1'] = true;
  host._peers.allow('desk-e2e-1', true);
  host._peers.allow('web-e2e-1', true);
  host._afterPeers();

  check('两台远程端同时在现场在线表里', host._peers.count() >= 2, 'count=' + host._peers.count());
  check('桌面端（mini/desktop）与网页端都在线', host._peers.has('desk-e2e-1') && host._peers.has('web-e2e-1'));
  const ctl = host._peers.controller;
  check('只有一个控制端', !!ctl, 'ctl=' + ctl);
  check('控制权优先级：桌面端 > 网页端 > 小程序', ctl === 'desk-e2e-1', 'ctl=' + ctl);

  // 现场发一跳心跳：status 带 ctl（控制端 cid）与 n（台数）
  host.session.publishStatus('heartbeat', {}, 0);
  await sleep(10);
  check('网页端通过心跳得知自己不是控制端', webState.peers.length > 0 && webState.peers[webBox.remote.peerList.length ? webState.peers.length - 1 : 0].isController === false,
    JSON.stringify(webState.peers.slice(-1)));
  check('Session.isController 在网页端返回 false', webBox.remote.isController() === false);
  check('Session.isController 在桌面端返回 true', box.host._peers.isController('desk-e2e-1') === true);

  // 旁看端下发命令：本地就被拦下（不发 cmd），现场端也会再拦一次
  let obsErr = null;
  try { await webBox.remote.sendCmd('raw.tx', { hex: readHex, expectLen: 9 }, { noRetry: true, timeout: 1000 }); }
  catch (e) { obsErr = e; }
  check('旁看端 raw.tx 被拦（409）', obsErr && obsErr.code === 409, JSON.stringify(obsErr));

  // 旁看端仍能收报文流（"能看"）：现场推一批 data
  const logsBefore = webState.logs.length;
  host.log('TX', '01 03 00 00 00 01 84 0A');
  await sleep(260);
  check('旁看端能收到 485 报文（只读不瞎）', webState.logs.length > logsBefore, webState.logs.length + ' lines');

  // 网页端点「请求接管」→ 现场放行，控制权转移
  const tko = await webBox.remote.sendCmd('ctl.request', {}, { noRetry: true, timeout: 2000 });
  check('ctl.request 接管成功', tko && tko.controller === 'web-e2e-1', JSON.stringify(tko));
  check('控制权已转到网页端', host._peers.controller === 'web-e2e-1');
  check('原控制端变旁看', host._peers.isController('desk-e2e-1') === false);

  // 现在网页端能发命令，桌面端被拦
  const okAfter = await webBox.remote.sendCmd('raw.tx', { hex: readHex, expectLen: 9, timeoutMs: 500 }, { noRetry: true, timeout: 3000 });
  check('接管后网页端能读寄存器', okAfter && okAfter.rxLen === 9, JSON.stringify(okAfter).slice(0, 120));
  let deskErr = null;
  try { await remote.sendCmd('raw.tx', { hex: readHex, expectLen: 9 }, { noRetry: true, timeout: 1000 }); }
  catch (e) { deskErr = e; }
  check('被接管后桌面端变旁看', deskErr && deskErr.code === 409, JSON.stringify(deskErr));

  // 网页端断开 → 控制权自动回到还在线的桌面端
  webBox.remote.close();
  host.ingestStatus({ action: 'leave', role: 'remote', cid: 'web-e2e-1', kind: 'web' });
  box.detachRemote(webBox.remote);
  check('网页端离开后控制权补位', host._peers.controller === 'desk-e2e-1', 'ctl=' + host._peers.controller);
  const backOk = await remote.sendCmd('raw.tx', { hex: readHex, expectLen: 9, timeoutMs: 500 }, { noRetry: true, timeout: 3000 });
  check('补位后桌面端恢复可操作', backOk && backOk.rxLen === 9, JSON.stringify(backOk).slice(0, 120));

  // 11) assist.kick：收掉现场会话
  await remote.sendCmd('assist.kick', {}, { noRetry: true, timeout: 2000 });
  check('assist.kick 后现场会话关闭', host.session === null && host.sid === '');

  const failed = results.filter((r) => !r[1]);
  console.log('\n' + (failed.length ? '✖ 失败 ' + failed.length + ' / ' + results.length : '✓ 全部通过 ' + results.length + ' 项'));
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error('用例异常：', e);
  process.exit(1);
});
