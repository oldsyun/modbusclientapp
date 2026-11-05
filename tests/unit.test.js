/**
 * tests/unit.test.js — 协议层单元测试（node --test，无需网络）
 *
 * 覆盖：
 *   · proto：信封字段、SID_LEN/sidHint、Deduper 环形去重
 *   · mqtt：剩余长度编码、MQTT 字符串编码、CONNACK/PUBLISH/SUBACK 解析、QoS1 回 PUBACK
 *   · session：ack/result 配对、202 挂起延长、seq 去重、status 角色过滤
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/lib/proto.js';
import { MqttClient, buildWsUrl, MQTT_SERVER } from '../src/lib/mqtt.js';
import { MQTT_CONFIG_FROM, getAssistTopics, sidHint, generateSessionId } from '../src/lib/broker.js';
import { Session } from '../src/lib/session.js';

/* ---------------- proto ---------------- */

test('envelope 带齐 v/sid/from/type/ts/payload，reqId 可选', () => {
  const e = P.envelope('AB3D9KX', 'remote', 'ui.action', { a: 1 }, 'r-1');
  assert.equal(e.v, 1);
  assert.equal(e.sid, 'AB3D9KX');
  assert.equal(e.from, 'remote');
  assert.equal(e.type, 'ui.action');
  assert.equal(typeof e.ts, 'number');
  assert.deepEqual(e.payload, { a: 1 });
  assert.equal(e.reqId, 'r-1');

  const e2 = P.envelope('AB3D9KX', 'remote', 'sync.request');
  assert.ok(!('reqId' in e2));
});

test('SID：7 位、字符集无易混字符、生成器位数正确', () => {
  assert.equal(P.SID_LEN, 7);
  assert.ok(!/[O0I1]/.test(P.SID_CHARS));
  for (let i = 0; i < 50; i++) {
    const sid = generateSessionId();
    assert.equal(sid.length, 7);
    assert.ok(P.isSidLen(sid));
  }
});

test('sidHint 与小程序远程端一致', () => {
  assert.equal(sidHint('AB3D9KX'), '');
  assert.equal(sidHint(''), '');
  assert.equal(sidHint('AB3'), '还差 4 位（会话码共 7 位）');
  assert.equal(sidHint('AB3D9K'), '还差 1 位（会话码共 7 位）');
  assert.equal(sidHint('AB3D9KX0'), '多了 1 位（会话码共 7 位）');
  assert.ok(/易混/.test(sidHint('AB3D9K!')));
});

test('Deduper：同一 from+seq 只 seen 一次，环形覆盖最旧', () => {
  const d = new P.Deduper(3);
  assert.equal(d.seen('remote', 1), false);
  assert.equal(d.seen('remote', 1), true);   // 重复
  assert.equal(d.seen('local', 1), false);   // from 不同不算重复
  d.seen('remote', 2);
  d.seen('remote', 3);
  d.seen('remote', 4);                       // 挤掉 seq=1
  assert.equal(d.seen('remote', 1), false);
  d.reset();
  assert.equal(d.seen('remote', 1), false);
});

/* ---------------- mqtt 编解码 ---------------- */

function newClient() {
  const c = new MqttClient({ url: 'wss://x/mqtt' });
  c.state = 'connected';
  c.socket = { readyState: 1, sent: [], send(buf) { this.sent.push(new Uint8Array(buf)); } };
  return c;
}

test('剩余长度编码：单字节/两字节边界', () => {
  assert.deepEqual(newClient()._encodeRemainingLength(0), [0]);
  assert.deepEqual(newClient()._encodeRemainingLength(127), [127]);
  assert.deepEqual(newClient()._encodeRemainingLength(128), [0x80, 0x01]);
  assert.deepEqual(newClient()._encodeRemainingLength(16383), [0xff, 0x7f]);
  assert.deepEqual(newClient()._encodeRemainingLength(16384), [0x80, 0x80, 0x01]);
});

test('MQTT 字符串 = 2 字节大端长度 + UTF-8', () => {
  const bytes = newClient()._encodeMqttString('MQTT');
  assert.deepEqual(bytes, [0, 4, 77, 81, 84, 84]);
  const cn = newClient()._encodeMqttString('站号');
  assert.equal(cn[0], 0); assert.equal(cn[1], 6); // 两个汉字 6 字节
});

test('CONNACK 成功 → connected + onConnect；失败 → onError', () => {
  const c = newClient();
  let connected = false, errMsg = '';
  c.onConnect = () => { connected = true; };
  c._handleConnack(new Uint8Array([0, 0]));
  assert.equal(c.state, 'connected');
  assert.ok(connected);
  c._stopHeartbeat();   // 心跳 setInterval 会吊住 node，测完清掉

  const c2 = newClient();
  c2.onError = (e) => { errMsg = e.message; };
  c2._handleConnack(new Uint8Array([0, 4]));
  assert.equal(errMsg, '用户名/密码错误');
  assert.equal(c2.state, 'disconnected');
});

test('PUBLISH QoS1 → onMessage 收到 topic/payload，并回 PUBACK', () => {
  const c = newClient();
  let got = null;
  c.onMessage = (topic, payload, meta) => { got = { topic, payload, meta }; };
  // topic assist/AB3D9KX/state, pid=7, payload {"v":1}
  const topicBytes = Array.from(new TextEncoder().encode('assist/AB3D9KX/state'));
  const topicB = [(topicBytes.length >> 8) & 255, topicBytes.length & 255].concat(topicBytes);
  const body = new Uint8Array(topicB.concat([0, 7]).concat(Array.from(new TextEncoder().encode('{"v":1}'))));
  c._handlePublish(body, 0x32); // PUBLISH QoS1
  assert.equal(got.topic, 'assist/AB3D9KX/state');
  assert.equal(got.payload, '{"v":1}');
  assert.equal(got.meta.qos, 1);
  const ack = c.socket.sent[0];
  assert.equal(ack[0], 64);          // PUBACK
  assert.equal(ack[1], 2);
  assert.equal(ack[2], 0); assert.equal(ack[3], 7);
});

test('流式缓冲：半包送达也能完整解析', () => {
  const c = newClient();
  let got = null;
  c.onMessage = (t, p) => { got = { t, p }; };
  const topicBytes = Array.from(new TextEncoder().encode('a/b'));
  const topicB = [0, topicBytes.length].concat(topicBytes);
  // PUBLISH body = topic(2+4) + payload(裸字节 'hi')，剩余长度 = 7
  const pkt = new Uint8Array([0x30].concat(c._encodeRemainingLength(topicB.length + 2)).concat(topicB).concat(Array.from(new TextEncoder().encode('hi'))));
  c._onSocketMessage(pkt.slice(0, 5).buffer);   // 前半
  assert.equal(got, null);                       // 不完整不回调
  c._onSocketMessage(pkt.slice(5).buffer);       // 后半
  assert.deepEqual(got, { t: 'a/b', p: 'hi' });
});

test('URL：443 默认口不拼端口号，其他端口照常拼', () => {
  const base = { host: 'broker.test', wsPath: '/mqtt' };
  assert.equal(buildWsUrl({ ...base, wsPort: 443, secure: true }), 'wss://broker.test/mqtt');
  assert.equal(buildWsUrl({ ...base, wsPort: 0, secure: true }), 'wss://broker.test/mqtt');
  assert.equal(buildWsUrl({ ...base, wsPort: 8084, secure: true }), 'wss://broker.test:8084/mqtt');
  assert.equal(buildWsUrl({ ...base, wsPort: 1883, secure: false }), 'ws://broker.test:1883/mqtt');
  // 未配置 host 时返回空串，由 UI 提示用户去「设置」里填
  assert.equal(buildWsUrl({ host: '' }), '');
});

test('broker 配置合并与 topic 规则', () => {
  // 单测环境没有 import.meta.env：默认配置为空，源码不携带任何真实 broker 信息
  const cfgEmpty = MQTT_CONFIG_FROM(null);
  assert.equal(cfgEmpty.url, '');
  assert.equal(cfgEmpty.username, '');
  assert.equal(MQTT_SERVER.host, '');
  assert.equal(MQTT_SERVER.username, '');

  const cfg = MQTT_CONFIG_FROM({ host: 'broker.test', wsPort: 443, secure: true, username: 'u1', password: 'p1' });
  assert.equal(cfg.url, 'wss://broker.test/mqtt');
  assert.equal(cfg.username, 'u1');
  assert.equal(cfg.password, 'p1');
  const cfg2 = MQTT_CONFIG_FROM({ host: 'mqtt.example.com', wsPort: 9001, secure: false });
  assert.equal(cfg2.url, 'ws://mqtt.example.com:9001/mqtt');
  assert.deepEqual(getAssistTopics('AB3D9KX'), {
    data: 'assist/AB3D9KX/data',
    cmd: 'assist/AB3D9KX/cmd',
    status: 'assist/AB3D9KX/status',
    state: 'assist/AB3D9KX/state',
    config: 'assist/AB3D9KX/config'
  });
});

/* ---------------- config 主题（2026-11 新增） ---------------- */
test('config：主题独立，不与 cmd/data/state/status 重叠', () => {
  const T = getAssistTopics('AB3D9KX');
  const all = [T.status, T.cmd, T.state, T.data, T.config];
  assert.equal(new Set(all).size, 5, '五个主题必须互不相同');
  assert.equal(T.config, 'assist/AB3D9KX/config');
});

test('config：请求发 config 主题，写类不自动重发', () => {
  const sent = [];
  const s = new Session({ role: 'remote', sid: 'AB3D9KX', kind: 'desktop' });
  s.client = { clientId: 'c-desk', isConnected: true, publish: (t, p, q) => { sent.push({ topic: t, payload: p, qos: q }); return true; } };
  s._everOnline = true; s.status = 'online';
  s.sendConfig('config.set', { what: 'name', name: 'X' }, { timeout: 50 }).catch(() => {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'assist/AB3D9KX/config');
  const msg = JSON.parse(sent[0].payload);
  assert.equal(msg.type, 'config.set');
  const p = s.pending[Object.keys(s.pending)[0]];
  assert.ok(p && p.noRetry, 'config.set 必须 noRetry');
});

test('config：config.result 按 reqId 结算，不落 cmd 主题', () => {
  const s = new Session({ role: 'remote', sid: 'AB3D9KX' });
  let resolved = null;
  s.pending['r1'] = { reqId: 'r1', timer: null, resolve: (d) => { resolved = d; }, reject: () => {} };
  s._onMessage('assist/AB3D9KX/config', JSON.stringify({
    v: 1, sid: 'AB3D9KX', seq: 9, from: 'local', type: 'config.result',
    payload: { reqId: 'r1', ok: true, code: 200, data: { name: 'BLE485' } }
  }));
  assert.deepEqual(resolved, { name: 'BLE485' });
});

/* ---------------- session ---------------- */

function newRemoteSession() {
  const s = new Session({ role: 'remote', sid: 'AB3D9KX', tool: '桌面调试台' });
  s.client = { isConnected: true, publish(topic, msg, qos) { s._sent = s._sent || []; s._sent.push({ topic, msg: JSON.parse(msg), qos }); return true; }, destroy() {} };
  s.status = 'online';
  return s;
}

test('status/cmd 带 cid + kind（网关桌面优先准入）', () => {
  const s = new Session({ role: 'remote', sid: 'AB3D9KX', tool: '桌面调试台', kind: 'desktop' });
  const sent = [];
  s.client = {
    clientId: 'assist_remote_AB3D9KX_123',
    isConnected: true,
    publish(topic, msg) { sent.push({ topic, msg: JSON.parse(msg) }); return true; },
    destroy() {}
  };
  s.status = 'online';

  s.publishStatus('join', {}, 1);
  assert.equal(sent[0].msg.cid, 'assist_remote_AB3D9KX_123');
  assert.equal(sent[0].msg.kind, 'desktop');

  s.sendCmd('sync.request', {}).catch(() => {});
  assert.equal(sent[1].msg.cid, 'assist_remote_AB3D9KX_123');
  assert.equal(sent[1].msg.kind, 'desktop');
  s._clearPending(new Error('test end'));
});

test('sendCmd：直接 ack(data) 配对 resolve', async () => {
  const s = newRemoteSession();
  const p = s.sendCmd('sync.request', {});
  assert.equal(s._sent.length, 1);
  const sent = s._sent[0];
  assert.equal(sent.topic, 'assist/AB3D9KX/cmd');
  assert.equal(sent.msg.from, 'remote');
  assert.equal(sent.qos, 1);
  const reqId = sent.msg.reqId;

  s._onMessage('assist/AB3D9KX/state', JSON.stringify({
    v: 1, sid: 'AB3D9KX', seq: 1, from: 'local', type: 'ack',
    payload: { reqId, ok: true, code: 200, msg: '', data: { page: 'scan' } }
  }));
  assert.deepEqual(await p, { page: 'scan' });
});

test('sendCmd：202 挂起 → 不超时，等 result 终态', async () => {
  const s = newRemoteSession();
  const pendingMsgs = [];
  const p = s.sendCmd('modbus.write', { slave: 1, addr: 1, value: '5' }, {
    noRetry: true,
    onPending: (m) => pendingMsgs.push(m)
  });
  const reqId = s._sent[0].msg.reqId;

  s._onMessage('assist/AB3D9KX/state', JSON.stringify({
    v: 1, sid: 'AB3D9KX', seq: 1, from: 'local', type: 'ack',
    payload: { reqId, ok: true, code: 202, msg: '等待现场确认', data: null }
  }));
  assert.deepEqual(pendingMsgs, ['等待现场确认']);
  assert.ok(s.pending[reqId], '202 后请求仍应挂着');

  s._onMessage('assist/AB3D9KX/state', JSON.stringify({
    v: 1, sid: 'AB3D9KX', seq: 2, from: 'local', type: 'result',
    payload: { reqId, ok: false, code: 403, msg: '现场已拒绝' }
  }));
  await assert.rejects(p, (e) => e.code === 403 && e.message === '现场已拒绝');
});

test('state：page 透传 onState；同 from+seq 重复只处理一次', () => {
  const s = newRemoteSession();
  const pages = [];
  s.onState = (o) => pages.push(o.payload);

  const msg = JSON.stringify({
    v: 1, sid: 'AB3D9KX', seq: 9, from: 'local', type: 'page',
    payload: { page: 'rtu', widgets: [] }
  });
  s._onMessage('assist/AB3D9KX/state', msg);
  s._onMessage('assist/AB3D9KX/state', msg);   // 重发补发
  assert.equal(pages.length, 1);
  assert.equal(pages[0].page, 'rtu');
});

test('status：不处理自己角色回声；leave 标离线', () => {
  const s = newRemoteSession();
  const statuses = [];
  s.onStatus = (o, first) => statuses.push([o.action, o.role, first]);

  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'remote', ts: 1 }));
  assert.equal(statuses.length, 0);            // 自己回声
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'local', ts: 2 }));
  assert.deepEqual(statuses[0], ['join', 'local', true]);
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'heartbeat', role: 'local', ts: 3 }));
  assert.deepEqual(statuses[1], ['heartbeat', 'local', false]);
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'leave', role: 'local', ts: 4 }));
  assert.equal(s.peerOnline, false);
  assert.deepEqual(statuses[2], ['leave', 'local', false]);
});

/* ================== 多远程端：在线表 / 控制权 / 旁看 ================== */

test('多远程端：join 带 cid 时不会把另一台同角色远程端当成自己', () => {
  const s = newRemoteSession();
  s.client.clientId = 'assist_remote_AB3D9KX_1_aaaa';
  s._friend = 'assist_remote_AB3D9KX_1_aaaa';
  const seen = [];
  s.onStatus = (o, first) => seen.push([o.cid, first]);

  // 自己的回声（friend 相同）→ 忽略
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'remote', cid: s._friend, friend: s._friend }));
  assert.equal(seen.length, 0, '自己的回声应被忽略');

  // 另一台同角色远程端 → 必须被看见（以前这里会被整条丢掉）
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'remote', cid: 'web-1', friend: 'web-1' }));
  assert.deepEqual(seen, [['web-1', true]]);
});

test('多远程端：由现场端统一语义——remote 只认 local 的在线状态', () => {
  const s = newRemoteSession();
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'local', cid: 'host-1' }));
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'remote', cid: 'web-1' }));
  assert.equal(s.peerOnline, true);
  // web-1 只进在线表（kind=web），不计入「现场端是否在线」：本端的对端只有 local
  assert.equal(s.peerOnline, true, "现场端在线（web-1 不影响这个判定）");
  assert.equal(s.isController(), true, '未收到 ctl 前保持单端行为');
});

test('多远程端：ctl/n 决定谁是控制端，旁看端 sendCmd 被拦', async () => {
  const s = newRemoteSession();
  s.client.clientId = 'assist_remote_AB3D9KX_2_bbbb';
  s._friend = 'assist_remote_AB3D9KX_2_bbbb';
  const peers = [];
  s.onPeers = (info) => peers.push(info);

  // 现场端心跳：控制端是另一台网页端
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({
    action: 'heartbeat', role: 'local', cid: 'host-1', ctl: 'web-1', n: 2
  }));
  assert.equal(s.isController(), false, '非控制端');
  assert.equal(s.remoteCount, 2);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].isController, false);

  await assert.rejects(s.sendCmd('raw.tx', { hex: '010300000001840A' }), (e) => e.code === P.CODES.CONFLICT);
  // 只读 / 同步 / 接管命令仍放行（会真的发出去）
  await s.sendCmd('ctl.request', {}).catch(() => {});
  assert.ok((s._sent || []).some((x) => x.msg.type === 'ctl.request'), 'ctl.request 应被放行');

  // 现场端把控制权交给自己
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({
    action: 'heartbeat', role: 'local', cid: 'host-1', ctl: s.client.clientId, n: 2
  }));
  assert.equal(s.isController(), true);
  await s.sendCmd('raw.tx', { hex: '010300000001840A' }).catch(() => {});
  assert.ok((s._sent || []).some((x) => x.msg.type === 'raw.tx'), '控制端可以发 raw.tx');
});

test('多远程端：state.peers 广播解析（在线表）', () => {
  const s = newRemoteSession();
  const infos = [];
  s.onPeers = (i) => infos.push(i);
  s._onMessage('assist/AB3D9KX/state', JSON.stringify({
    v: 1, sid: 'AB3D9KX', seq: 9, from: 'local', type: 'peers',
    payload: {
      controller: 'web-1', count: 2,
      peers: [{ cid: 'web-1', kind: 'web', ctl: true }, { cid: 'mini-1', kind: 'mini', ctl: false }]
    }
  }));
  assert.equal(infos.length, 1);
  assert.equal(infos[0].controller, 'web-1');
  assert.equal(infos[0].peers.length, 2);
  assert.equal(infos[0].isController, false);
});

test('多远程端：旧现场端不带 ctl/n 时保持单端行为', () => {
  const s = newRemoteSession();
  s._onMessage('assist/AB3D9KX/status', JSON.stringify({ action: 'join', role: 'local', ts: 1 }));
  assert.equal(s.isController(), true, '不知道控制端 → 自己就是控制端');
  assert.equal(s.remoteCount, 0);
});

test('sendCmd 未连接直接拒绝', async () => {
  const s = new Session({ role: 'remote', sid: 'AB3D9KX' });
  await assert.rejects(s.sendCmd('sync.request', {}), (e) => e.code === P.CODES.TIMEOUT);
});

/* ================== PLC 地址解析（对齐小程序 modscan32） ================== */

import { parseModbusAddr, addrLabel } from '../src/lib/addr.js';

test('DEC 4xxxx 前缀规则：40001 → 协议地址 0', () => {
  const a = parseModbusAddr(3, '40001', 'dec');
  assert.equal(a.ok, true);
  assert.equal(a.value, 0);
  assert.equal(addrLabel(3, a.value, 'dec'), '40001');
});

test('DEC 30001 / 10001 / 00001 前缀分别落到对应区', () => {
  assert.equal(parseModbusAddr(4, '30001', 'dec').value, 0);   // 输入寄存器
  assert.equal(parseModbusAddr(2, '10001', 'dec').value, 0);   // 离散输入
  assert.equal(parseModbusAddr(1, '00001', 'dec').value, 0);   // 线圈
});

test('DEC 不带前缀按当前区纯 1 基：地址 1 → 0', () => {
  assert.equal(parseModbusAddr(3, '1', 'dec').value, 0);
  assert.equal(parseModbusAddr(3, '100', 'dec').value, 99);
});

test('HEX 模式 / 0x 前缀：0x0000 → 协议地址 0（0 基）', () => {
  assert.equal(parseModbusAddr(3, '0x0000', 'dec').value, 0);  // 0x 不受模式影响
  assert.equal(parseModbusAddr(3, '0x0000', 'hex').value, 0);
  assert.equal(parseModbusAddr(3, '10', 'hex').value, 16);
  assert.equal(addrLabel(3, 0, 'hex'), '0x0000');
  assert.equal(addrLabel(3, 16, 'hex'), '0x0010');
});

test('DEC 地址从 1 开始，0 非法', () => {
  assert.equal(parseModbusAddr(3, '0', 'dec').ok, false);
});

test('DEC 必须纯数字，非数字报错', () => {
  const a = parseModbusAddr(3, '4000a', 'dec');
  assert.equal(a.ok, false);
});

test('HEX 越界报错', () => {
  assert.equal(parseModbusAddr(3, '0x10000', 'hex').ok, false);
});

test('addrLabel DEC 回显带前缀并补 4 位', () => {
  assert.equal(addrLabel(3, 99, 'dec'), '40100');
  assert.equal(addrLabel(4, 9, 'dec'), '30010');
});

/* ================== 报文分段合并 mergeHexSegments（20 字节切片合帧） ================== */

import { mergeHexSegments } from '../src/lib/modbus.js';

const hexLen = (h) => h.replace(/[^0-9A-Fa-f]/g, '').length / 2;

test('mergeHexSegments：同方向同时间戳的分段合并成一帧', () => {
  const out = mergeHexSegments([
    { dir: 'rx', hex: '01 03 02 00', note: '', t: 'T1' },
    { dir: 'rx', hex: '0A 00 0B', note: '', t: 'T1' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dir, 'RX');
  assert.equal(out[0].hex, '01 03 02 00 0A 00 0B');
  assert.equal(hexLen(out[0].hex), 7);
  assert.equal(out[0].t, 'T1');
});

test('mergeHexSegments：时间戳不同不合并', () => {
  const out = mergeHexSegments([
    { dir: 'rx', hex: 'AA BB', t: 'T1' },
    { dir: 'rx', hex: 'CC DD', t: 'T2' }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].hex, 'AA BB');
  assert.equal(out[1].hex, 'CC DD');
});

test('mergeHexSegments：RX 与 TX 相邻不合并', () => {
  const out = mergeHexSegments([
    { dir: 'rx', hex: 'AA BB', t: 'T1' },
    { dir: 'tx', hex: 'CC DD', t: 'T1' }
  ]);
  assert.equal(out.length, 2);
});

test('mergeHexSegments：SYS 段永远不合并', () => {
  const out = mergeHexSegments([
    { dir: 'SYS', hex: 'AA BB', t: 'T1' },
    { dir: 'SYS', hex: 'CC DD', t: 'T1' }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].hex, 'AA BB');
  assert.equal(out[1].hex, 'CC DD');
});

test('mergeHexSegments：空/空白 hex 被丢弃，不制造伪帧', () => {
  const out = mergeHexSegments([
    { dir: 'rx', hex: '', t: 'T1' },
    { dir: 'rx', hex: '   ', t: 'T1' },
    { dir: 'rx', hex: 'AA BB', t: 'T1' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].hex, 'AA BB');
});

test('mergeHexSegments：时间戳缺失时退化为相邻同向合并', () => {
  const out = mergeHexSegments([
    { dir: 'rx', hex: 'AA', t: '' },
    { dir: 'rx', hex: 'BB', t: '' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].hex, 'AA BB');
  assert.equal(out[0].t, '');
});
