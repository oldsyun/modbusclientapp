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
    reLaunch() {}
  };
  // Host 依赖的全局方法在 Node 里不存在，这里补齐后再 require
  const HostMod = require(path.join(ROOT, 'assist', 'host.js'));
  const host = new HostMod.Host();
  host.sid = sid;
  // 现场点「允许」之前不应暴露网关；用例先验这一点，后面再模拟点允许

  let seq = 0;
  const topics = { state: 'assist/' + sid + '/state', data: 'assist/' + sid + '/data' };
  const deliver = (topic, o) => {
    seq += 1;
    const env = { v: 1, sid, seq, ts: Date.now(), from: 'local', type: o.type, payload: o.payload || {} };
    if (remote) remote._onMessage(topic, JSON.stringify(env));
  };
  let remote = null;
  host.session = {
    isConnected: () => true,
    ack: (reqId, ok, code, msg, data) => deliver(topics.state, {
      type: 'ack', payload: { reqId, ok, code, msg, data: data === undefined ? null : data }
    }),
    publishState: (type, payload) => deliver(topics.state, { type, payload }),
    publishData: (payload) => deliver(topics.data, { type: 'log', payload }),
    close() {}
  };
  return {
    host,
    attachRemote(r) { remote = r; },
    topics
  };
}

/* ---------- 桌面端 Session（真实）接到 Host ---------- */
function makeDesktop(hostBox, sid, state) {
  const remote = new Session({ role: 'remote', sid, tool: '桌面调试台', kind: 'desktop' });
  const topics = {
    cmd: 'assist/' + sid + '/cmd',
    state: 'assist/' + sid + '/state',
    data: 'assist/' + sid + '/data',
    status: 'assist/' + sid + '/status'
  };
  remote.client = {
    clientId: 'desk-e2e-1',
    isConnected: true,
    subscribe() {},
    destroy() {},
    publish(topic, msg) {
      if (topic === topics.cmd) hostBox.host._onCmd(JSON.parse(msg));
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
  const state = { gw: null, scans: [], logs: [] };
  const { remote } = makeDesktop(box, sid, state);
  const { host } = box;

  // 0) 现场还没点「允许」：不暴露网关；sync 可放行但标记 awaitAllow；操作回 403
  check('未允许前 statusExtra 不带网关', Object.keys(host._gatewayStatus()).length === 0);
  const pre = await remote.sendCmd('sync.request', {}, { timeout: 1000 });
  check('未允许前 sync 标记 awaitAllow', pre && pre.awaitAllow === true, JSON.stringify(pre));
  let gateErr = null;
  try {
    await remote.sendCmd('raw.tx', { hex: MB.bytesToHex(MB.buildReadFrame(1, 3, 0, 1), ' ') }, { noRetry: true, timeout: 1000 });
  } catch (e) { gateErr = e; }
  check('未允许前 raw.tx 回 403', gateErr && gateErr.code === 403, JSON.stringify(gateErr));

  // 模拟现场在弹窗里点「允许」
  host._allowed = true;

  // 1) 心跳/join 的 statusExtra：桌面端不必等 sync 就能识别网关
  const st = host._gatewayStatus();
  check('statusExtra 带 gw:1 / ble:1 / link:"ble"', st.gw === 1 && st.ble === 1 && st.link === 'ble', JSON.stringify(st));

  // 2) sync.request → 网关说明书
  const core = await remote.sendCmd('sync.request', {}, { timeout: 4000 });
  check('sync 回 role:"gateway"', core.role === 'gateway', JSON.stringify(core));
  check('说明书带 link:"ble" / host:1', core.link === 'ble' && core.host === 1);
  check('说明书带模块名与 485 参数', core.gateway === 'SYCC485-A3D9' && core.uart && core.uart.baud === '9600');
  check('桌面端 onState 收到网关态', state.gw && state.gw.link === 'ble');

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

  // 6) uart.set → 模块回读值 + state 更新
  const u = await remote.sendCmd('uart.set', { baud: 19200, dataBits: 8, stopBits: 1, parity: 'E' }, { noRetry: true, timeout: 6000 });
  check('uart.set 回模块回读值', u.baud === '19200' && u.parity === 'E', JSON.stringify(u));
  await sleep(30);
  check('uart.set 后桌面端网关参数同步', state.gw && state.gw.uart && state.gw.uart.baud === '19200', JSON.stringify(state.gw && state.gw.uart));

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

  // 10) assist.kick：收掉现场会话
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