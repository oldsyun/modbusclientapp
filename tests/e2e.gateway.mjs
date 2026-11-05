/**
 * tests/e2e.gateway.mjs — 网关模式端到端（离线，无需 broker）
 *
 * 干什么：把固件第 13b 章的网关行为在 Node 里"照抄"一份（信封字段、类型、ack 结构），
 * 再让**桌面端真实的 Session + main.js 里的解析逻辑**去消费，验证：
 *
 *   1. 远程端能识别 role:"gateway"，切到网关面板（state.gw）
 *   2. modbus.read 的 ack.data 能被渲染成"寄存器值 + 报文"（rowsOf / logResponse 口径）
 *   3. 扫描进度 {scan:'HIT'|'END'} 能累积成列表
 *   4. 只读权限下写命令回 403，客户端能给出人话建议
 *   5. 会话到期（ASSIST 侧行为）：网关发 leave → 远程端 peerOnline 变 false
 *
 * 为什么不用真 broker：本条用例要能在 CI/无网环境跑；真机联调用 tests/e2e.session.mjs。
 * 跑法：node tests/e2e.gateway.mjs
 */
import { Session } from '../src/lib/session.js';
import * as P from '../src/lib/proto.js';

/* ---------- 极简事件总线：代替 MQTT，按 topic 投递 ---------- */
function makeBus() {
  const subs = [];
  return {
    subscribe(topic, fn) { subs.push({ topic, fn }); },
    topic(kind, sid) { return 'assist/' + sid + '/'; },
    publish(topic, payload) {
      subs.forEach((s) => {
        // 只做精确匹配：本用例不涉及通配
        if (s.topic === topic) s.fn(payload);
      });
    }
  };
}

const results = [];
const check = (name, ok, extra) => {
  results.push([name, ok]);
  console.log((ok ? '  ✓ ' : '  ✖ ') + name + (extra ? '  ' + extra : ''));
};

/* ---------- 被"移植"过来的固件行为（与 BLE485paco.ino 第 13b 章逐条对应） ---------- */
function makeFirmwareGateway(bus, opts) {
  const sid = opts.sid;
  const perm = opts.perm;
  const topics = {
    status: 'assist/' + sid + '/status',
    cmd: 'assist/' + sid + '/cmd',
    state: 'assist/' + sid + '/state',
    data: 'assist/' + sid + '/data'
  };
  let seq = 0;
  const env = (type, payload, reqId) => {
    seq += 1;
    const o = { v: 1, sid, seq, ts: Date.now(), from: 'local', type, payload: payload || {} };
    if (reqId) o.reqId = reqId;
    return JSON.stringify(o);
  };
  // 寄存器镜像（模拟一只 03 从站：地址 0..9 的值 = 100+addr）
  const regs = {};
  for (let i = 0; i < 10; i++) regs[i] = 100 + i;
  const scanHits = [3, 7];

  bus.subscribe(topics.cmd, (raw) => {
    const o = P.safeParse(raw);
    if (!o) return;
    const reqId = o.reqId || '';
    const pl = o.payload || {};
    const type = o.type;
    const WRITE = ['modbus.write', 'serial.send', 'scan.start', 'uart.set'];
    if (perm < 2 && WRITE.indexOf(type) >= 0) {
      bus.publish(topics.state, env('ack', { reqId, ok: false, code: 403, msg: '当前为只读权限，写类命令已拒绝', data: null }, reqId));
      return;
    }
    if (type === 'sync.request') {
      const core = { role: 'gateway', gateway: 'SYCC-GW', fw: '2.1', chip: 'esp32', sid, perm, host: 1, ip: '192.168.43.9' };
      bus.publish(topics.state, env('state', Object.assign({}, core, { uart: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'N' } })));
      bus.publish(topics.state, env('ack', { reqId, ok: true, code: 200, msg: '', data: core }, reqId));
      return;
    }
    if (type === 'modbus.read') {
      const addr = pl.addr | 0, qty = pl.qty | 0, fc = pl.fc | 0;
      const values = [];
      for (let i = 0; i < qty; i++) values.push(regs[addr + i] === undefined ? 0 : regs[addr + i]);
      const tx = '01 03 00 00 00 04 44 09';
      const rx = '01 03 08 00 64 00 65 00 66 00 67 9C 12';
      bus.publish(topics.data, env('log', { lines: [{ t: '1.000', dir: 'tx', hex: tx }, { t: '1.012', dir: 'rx', hex: rx }], dropped: 0 }));
      bus.publish(topics.state, env('ack', {
        reqId, ok: true, code: 200, msg: 'OK',
        data: { slave: pl.slave, fc, addr, qty, tx, rx, crc: true, exception: false, values, elapsed: 12 }
      }, reqId));
      return;
    }
    if (type === 'modbus.write') {
      const addr = pl.addr | 0;
      regs[addr] = pl.value | 0;
      bus.publish(topics.state, env('ack', {
        reqId, ok: true, code: 200, msg: 'OK',
        data: { slave: pl.slave, fc: pl.fc, addr, value: pl.value, tx: '01 06 00 00 00 05 48 09', rx: '01 06 00 00 00 05 48 09', readback: pl.value, elapsed: 21 }
      }, reqId));
      return;
    }
    if (type === 'scan.start') {
      bus.publish(topics.state, env('state', { scan: 'START', addr: pl.start, cur: pl.start, found: 0, running: true }));
      bus.publish(topics.state, env('ack', { reqId, ok: true, code: 200, msg: '扫描已启动', data: pl }, reqId));
      return;
    }
    if (type === 'scan.stop' || type === 'serial.send') {
      bus.publish(topics.state, env('ack', { reqId, ok: true, code: 200, msg: 'OK', data: {} }, reqId));
      return;
    }
    bus.publish(topics.state, env('ack', { reqId, ok: false, code: 400, msg: '未实现的命令：' + type, data: null }, reqId));
  });

  return {
    sid,
    // 固件 assistPushScanLine() 的等价物
    pushScan(kind, addr, found, cur) {
      bus.publish(topics.state, env('state', { scan: kind, addr, found, cur, running: kind !== 'END' && kind !== 'ABORT' }));
    },
    // 会话到期：leave + 断开（远程端据此把现场标离线）
    expire() {
      bus.publish(topics.status, JSON.stringify({ action: 'leave', role: 'local', tool: 'SYCC-GW', gw: 1, ts: Date.now() }));
    },
    regs
  };
}

/* ---------- 用真实的桌面端 Session，但把 MQTT 换成内存总线 ---------- */
function makeRemote(bus, sid) {
  const remote = new Session({ role: 'remote', sid, tool: '桌面调试台' });
  const topics = {
    state: 'assist/' + sid + '/state',
    data: 'assist/' + sid + '/data',
    status: 'assist/' + sid + '/status',
    cmd: 'assist/' + sid + '/cmd'
  };
  // 劫持传输层：client 换成"直接吃内存总线"的假客户端
  remote.client = {
    isConnected: true,
    publish(topic, msg) { bus.publish(topic, msg); return true; },
    subscribe() {},
    destroy() {}
  };
  remote.status = 'online';
  bus.subscribe(topics.state, (m) => remote._onMessage(topics.state, m));
  bus.subscribe(topics.data, (m) => remote._onMessage(topics.data, m));
  bus.subscribe(topics.status, (m) => remote._onMessage(topics.status, m));
  // 发命令：直接投到 cmd 主题（等价于 publish）
  remote._sendCmd = remote.sendCmd;
  remote.sendCmd = function (type, payload, opts) {
    const p = remote._sendCmd.call(this, type, payload, opts);
    const msg = Object.values(remote.pending)[Object.values(remote.pending).length - 1];
    if (msg) bus.publish(topics.cmd, JSON.stringify(msg.msg));
    return p;
  };
  return remote;
}

/* ---------- 桌面端 main.js 的解析口径（照抄 renderGateway / onGwScanMsg） ---------- */
const PERM_NAME = { 1: '只读', 2: '标准', 3: '完全' };
function clientApply(state, o) {
  const pl = o.payload || {};
  if (pl.role === 'gateway') {
    state.gw = {
      on: true,
      name: pl.gateway || 'SYCC-GW',
      fw: pl.fw || '',
      ip: pl.ip || '',
      perm: Number(pl.perm) || 2,
      permName: PERM_NAME[pl.perm] || '',
      host: pl.host === 1,
      uart: pl.uart ? pl.uart.baud + ' ' + pl.uart.dataBits + pl.uart.parity + pl.uart.stopBits : (state.gw || {}).uart,
      scan: (state.gw && state.gw.scan) || { running: false, cur: 0, found: 0, list: [] }
    };
    return;
  }
  if (pl.scan) {
    let s = state.gw.scan || { running: false, cur: 0, found: 0, list: [] };
    if (pl.scan === 'START') s = { running: true, cur: pl.cur, found: 0, list: [] };
    else if (pl.scan === 'HIT') {
      const list = s.list.slice();
      if (list.indexOf(pl.addr) < 0) list.push(pl.addr);
      s = { running: true, cur: s.cur, found: list.length, list };
    } else if (pl.scan === 'END') s = { running: false, cur: pl.addr || s.cur, found: pl.found, list: s.list };
    state.gw.scan = s;
  }
}

/* ---------- 用例 ---------- */
async function run(perm) {
  const sid = 'GW' + String(perm) + 'T3ST';
  const bus = makeBus();
  const fw = makeFirmwareGateway(bus, { sid, perm });
  const remote = makeRemote(bus, sid);
  const state = { gw: null, logs: [] };

  remote.onState = (o) => clientApply(state, o);
  remote.onData = (o) => { (o.payload.lines || []).forEach((l) => state.logs.push(l)); };

  console.log('\n[' + perm + '] sync.request');
  const core = await remote.sendCmd('sync.request', {});
  check('网关角色被识别（role=gateway）', core.role === 'gateway', JSON.stringify(core));
  check('网关元信息齐（name/fw/ip/permit/host）', core.gateway === 'SYCC-GW' && core.fw === '2.1' && core.ip === '192.168.43.9' && core.perm === perm && core.host === 1);

  console.log('[' + perm + '] modbus.read 0..3');
  const r = await remote.sendCmd('modbus.read', { slave: 1, fc: 3, addr: 0, qty: 4 });
  check('读回 4 个寄存器值', Array.isArray(r.values) && r.values.length === 4 && r.values[0] === 100, JSON.stringify(r.values));
  check('回执带 tx/rx 报文', /^01 03/.test(r.tx) && /^01 03/.test(r.rx));
  check('data 主题的报文流也收到了', state.logs.length === 2 && state.logs[1].dir === 'rx', state.logs.length + ' lines');

  console.log('[' + perm + '] 扫描进度');
  fw.pushScan('START', 1, 0, 1);
  fw.pushScan('HIT', 3, 0, 3);
  fw.pushScan('HIT', 7, 0, 7);
  fw.pushScan('END', 247, 2, 247);
  await sleep(20);
  check('扫描列表累积 [3,7]', JSON.stringify((state.gw.scan || {}).list) === '[3,7]', JSON.stringify(state.gw && state.gw.scan));
  check('扫描结束 running=false', state.gw.scan && state.gw.scan.running === false);

  console.log('[' + perm + '] modbus.write');
  let writeOk = true, writeErr = null;
  try {
    const w = await remote.sendCmd('modbus.write', { slave: 1, fc: 6, addr: 0, value: 55, verify: true }, { noRetry: true, timeout: 800 });
    check('写后读回是 55', w.readback === 55 && fw.regs[0] === 55, JSON.stringify(w));
  } catch (e) {
    writeOk = false; writeErr = e;
  }
  if (perm < 2) {
    check('只读权限下写命令回 403', !writeOk && writeErr && writeErr.code === 403, JSON.stringify(writeErr));
    check('403 文案能给人话建议', !!(writeErr && P.remoteErrAdvice(writeErr)));
    check('只读时远端寄存器没被改', fw.regs[0] === 100, 'regs[0]=' + fw.regs[0]);
  } else {
    check('标准权限下写成功', writeOk);
  }

  console.log('[' + perm + '] 会话到期 leave');
  let peerLeft = false;
  remote.onStatus = (o, first) => { if (o && o.action === 'leave') peerLeft = true; };
  fw.expire();
  await sleep(20);
  check('远程端收到 leave', peerLeft);
  check('远程端 peerOnline=false', remote.peerOnline === false);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

await run(2);
await run(1);

const failed = results.filter((r) => !r[1]);
console.log('\n' + (failed.length ? '✖ 失败 ' + failed.length + ' / ' + results.length : '✓ 全部通过 ' + results.length + ' 项'));
process.exit(failed.length ? 1 : 0);
