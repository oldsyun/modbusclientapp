/**
 * src/lib/session.js — 远程调试会话（移植自小程序 utils/assist/session.js）
 *
 * 一条会话 = 一个 sid + 一条 MQTT 连接。
 *   现场端 local  : 订 cmd/status，发 state/data/status
 *   远程端 remote : 订 state/data/status，发 cmd/status      ← 桌面端用这个角色
 *
 * 在 mqtt.js 之上补了四层（与小程序版行为一致）：
 *   · 统一信封 + seq 单调递增（对端去重）
 *   · sendCmd 返回 Promise，ack/result 配对；写类命令不自动重发
 *   · 202 挂起态：现场要人工确认时先回 202，确认后另发 result
 *   · 心跳 15s（QoS0）/ 对端 30s 判离线 / 自动重连后重新订阅
 */

import { MqttClient, MQTT_CONFIG_FROM, getAssistTopics, generateSessionId } from './broker.js';
import * as P from './proto.js';

export const HEARTBEAT_MS = 15000;
export const PEER_TIMEOUT_MS = 30000;     // 原厂规格：30s 收不到对端心跳即判离线
export const CMD_TIMEOUT_MS = 1500;
export const CONFIRM_TIMEOUT_MS = 60000;
export const PEER_SWEEP_MS = 5000;

// 旁看模式下仍可发的命令（只读 / 同步 / 接管）；其余由 sendCmd 拦下，现场端还会再拦一次
const OBSERVER_OK = {
  'view.request': 1,
  'ctl.request': 1
};

function noop() {}

export function Session(opts) {
  opts = opts || {};
  this.role = opts.role === 'remote' ? 'remote' : 'local';
  this.sid = opts.sid || '';
  this.tool = opts.tool || '';
  this.kind = opts.kind || '';        // "desktop"：网关据此让桌面端优先接管
  this.broker = opts.broker || null;   // 可覆盖的 broker 配置（自建 EMQX 时用）
  this.topics = getAssistTopics(this.sid);

  this.onCmd = opts.onCmd || noop;
  this.onConfig = opts.onConfig || noop;   // config 主题业务处理（现场端用）
  this.onState = opts.onState || noop;
  this.onData = opts.onData || noop;
  this.onStatus = opts.onStatus || noop;
  this.onChange = opts.onChange || noop;
  this.onError = opts.onError || noop;
  this.onReconnect = opts.onReconnect || noop;
  this.onPeers = opts.onPeers || noop;        // 多远程端在线表 / 控制权变化

  this.client = null;
  this.status = 'idle';        // idle | connecting | online | offline | closed
  this.peerOnline = false;     // 现场端是否在线
  this.peerCount = 0;          // 观察到的现场端数量（正常 1）
  this.remoteCount = 0;        // 本条会话里的远程端总数（现场端经 status.n / state.peers 广播）
  this.controllerCid = '';     // 当前控制端 clientId；空=旧现场端 → 视为自己是控制端
  this.peerList = [];
  this.seq = 0;
  this.dedupe = new P.Deduper(64);
  this.pending = {};
  this.hbTimer = null;
  this.peerTimer = null;
  this._peerMap = {};          // cid -> {cid,kind,tool,lastSeen}
  this._everOnline = false;
}

Session.prototype.connect = function () {
  var self = this;
  if (this.client) return this;

  var cfg = MQTT_CONFIG_FROM(this.broker);
  this._setStatus('connecting');
  // 同一会话里的远程端可能落在同一毫秒（网页端与小程序几乎同时点接入）：
  // clientId 重复会被 broker 踢掉旧连接，所以加随机尾巴。friendId 与 clientId 一一对应。
  var clientId = 'assist_' + this.role + '_' + this.sid + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  this._friend = clientId;
  this.client = new MqttClient({
    url: cfg.url,
    clientId: clientId,
    username: cfg.username,
    password: cfg.password,
    keepAlive: cfg.keepAlive,
    cleanSession: true,
    autoReconnect: true,
    lwtTopic: this.topics.status,
    // 遗嘱按原厂规格：{action:'leave', role, ts}，QoS1、Retain=false
    lwtMessage: JSON.stringify({ action: 'leave', role: this.role, ts: Date.now() }),
    lwtQos: 1,
    onConnect: function () { self._onConnect(); },
    onDisconnect: function () { self._setStatus('offline'); },
    onMessage: function (topic, message) { self._onMessage(topic, message); },
    onError: function (e) { self.onError(e || new Error('MQTT 错误')); }
  });
  this.client.connect();
  return this;
};

Session.prototype._onConnect = function () {
  var self = this;
  var recon = this._everOnline;
  this._everOnline = true;
  this._setStatus('online');

  if (this.role === 'local') {
    this.client.subscribe(this.topics.cmd, 1);
    this.client.subscribe(this.topics.status, 1);
    if (this.topics.config) this.client.subscribe(this.topics.config, 1);
  } else {
    this.client.subscribe(this.topics.state, 1);
    this.client.subscribe(this.topics.data, 0);
    this.client.subscribe(this.topics.status, 1);
    if (this.topics.config) this.client.subscribe(this.topics.config, 1);
  }
  this.publishStatus('join', { tool: this.tool, ver: P.VERSION });
  this._startHeartbeat();
  // 补两跳心跳：对端不必等 15s 才认出我们（多远程端时控制权选举要尽快收敛）
  var self0 = this;
  [800, 3200].forEach(function (ms) {
    setTimeout(function () { if (self0.isConnected()) self0.publishStatus('heartbeat', {}, 0); }, ms);
  });

  // 重连后要清掉半截请求，避免旧 Promise 永远挂着
  if (recon) {
    this._clearPending(new Error('链路重连，请重试'));
    this.dedupe.reset();
    this.onReconnect();
  }
};

Session.prototype.close = function () {
  this._stopHeartbeat();
  this._clearPending(new Error('会话已结束'));
  if (this.client) {
    if (this.client.isConnected) {
      try {
        var bye = { action: 'leave', role: this.role, ts: Date.now() };
        if (this.client.clientId) bye.cid = this.client.clientId;
        if (this.kind) bye.kind = this.kind;
        this.client.publish(this.topics.status, JSON.stringify(bye), 1);
      } catch (e) {}
    }
    this.client.destroy();
    this.client = null;
  }
  this._setStatus('closed');
};

Session.prototype.isConnected = function () {
  return !!(this.client && this.client.isConnected);
};

Session.prototype._setStatus = function (st) {
  if (this.status === st) return;
  this.status = st;
  this.onChange(st, { peerOnline: this.peerOnline });
};

Session.prototype._startHeartbeat = function () {
  var self = this;
  this._stopHeartbeat();
  this.hbTimer = setInterval(function () {
    if (!self.isConnected()) return;
    self.publishStatus('heartbeat', {}, 0);
  }, HEARTBEAT_MS);
  this.peerTimer = setInterval(function () { self._sweepPeers(); }, PEER_SWEEP_MS);
};

Session.prototype._stopHeartbeat = function () {
  if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  if (this.peerTimer) { clearTimeout(this.peerTimer); this.peerTimer = null; }
};

Session.prototype._peerCid = function (o) {
  if (o && o.cid) return String(o.cid);
  return 'anon:' + ((o && o.kind) || '') + ':' + ((o && o.tool) || '') + ':' + ((o && o.role) || '');
};

Session.prototype._peerSeen = function (o) {
  var cid = this._peerCid(o);
  // 远程端只把现场端当对端：同角色的其它远程端（网页端/小程序）走 peers 在线表，不混进在线判定
  if (this.role === 'remote' && (o.kind === 'mini' || o.kind === 'desktop' || o.kind === 'web')) {
    // 同角色进来：只记录（供 peers 在线表用），不改 peerOnline / peerCount
    if (!this._peerMap[cid]) this._peerMap[cid] = { cid: cid, kind: o.kind || '', tool: o.tool || '', lastSeen: Date.now() };
    else this._peerMap[cid].lastSeen = Date.now();
    return false;
  }
  var isNew = !this._peerMap[cid];
  this._peerMap[cid] = { cid: cid, kind: (o && o.kind) || '', tool: (o && o.tool) || '', lastSeen: Date.now() };
  this._recountPeers();
  return isNew;
};

Session.prototype._peerGone = function (o) {
  var cid = this._peerCid(o);
  if (this._peerMap[cid]) delete this._peerMap[cid];
  this._recountPeers();
};

Session.prototype._recountPeers = function () {
  var n = 0;
  for (var k in this._peerMap) if (this._peerMap.hasOwnProperty(k)) n += 1;
  var online = n > 0;
  var changed = (online !== this.peerOnline) || (n !== this.peerCount);
  this.peerOnline = online;
  this.peerCount = n;
  if (changed) this.onChange(this.status, { peerOnline: online, count: n });
};

Session.prototype._sweepPeers = function () {
  var now = Date.now(), dead = [];
  for (var cid in this._peerMap) {
    if (!this._peerMap.hasOwnProperty(cid)) continue;
    if (now - this._peerMap[cid].lastSeen > PEER_TIMEOUT_MS) dead.push(cid);
  }
  for (var i = 0; i < dead.length; i++) delete this._peerMap[dead[i]];
  if (dead.length) this._recountPeers();
};

/** 现场端心跳 / join 里带 ctl（控制端 cid）与 n（远程端台数） */
Session.prototype._ingestController = function (o) {
  if (!o || o.role !== 'local') return;
  var changed = false;
  if (o.ctl !== undefined) {
    var ctl = String(o.ctl || '');
    if (ctl !== this.controllerCid) { this.controllerCid = ctl; changed = true; }
  }
  if (o.n !== undefined) {
    var n = Number(o.n) || 0;
    if (n !== this.remoteCount) { this.remoteCount = n; changed = true; }
  }
  if (changed) this._emitPeers();
};

Session.prototype._emitPeers = function () {
  try {
    this.onPeers({
      controller: this.controllerCid,
      count: this.remoteCount,
      peers: this.peerList,
      isController: this.isController()
    });
  } catch (e) {}
};

Session.prototype.isController = function () {
  if (this.role !== 'remote') return true;
  if (!this.controllerCid) return true;      // 旧现场端：保持单端行为
  var id = this.client && this.client.clientId;
  return !!id && id === this.controllerCid;
};

Session.prototype._send = function (topic, obj, qos) {
  if (!this.isConnected()) return false;
  try {
    return this.client.publish(topic, JSON.stringify(obj), qos || 0);
  } catch (e) {
    return false;
  }
};

Session.prototype._nextEnvelope = function (type, payload, reqId) {
  var e = P.envelope(this.sid, this.role, type, payload, reqId);
  this.seq += 1;
  e.seq = this.seq;
  if (this.client && this.client.clientId) e.cid = this.client.clientId;
  if (this.kind) e.kind = this.kind;
  return e;
};

// 状态镜像（page / state / log / ack / result / audit）
Session.prototype.publishState = function (type, payload) {
  return this._send(this.topics.state, this._nextEnvelope(type, payload), 1);
};

// 报文流（可丢）
Session.prototype.publishData = function (payload) {
  return this._send(this.topics.data, this._nextEnvelope('log', payload), 0);
};

// 在线状态（join / heartbeat / leave）。qos 默认 1；心跳传 0
Session.prototype.publishStatus = function (action, extra, qos) {
  var o = { action: action, role: this.role, tool: this.tool, ver: P.VERSION, ts: Date.now() };
  if (this.client && this.client.clientId) o.cid = this.client.clientId;
  if (this.kind) o.kind = this.kind;
  if (this._friend) o.friend = this._friend;
  if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
  return this._send(this.topics.status, o, qos === undefined ? 1 : qos);
};

/**
 * @param type    命令类型（需求文档 6.4）
 * @param payload 参数
 * @param opts    { noRetry, timeout, label }
 * @returns Promise  resolve(data) / reject({code, message})
 */
Session.prototype.sendCmd = function (type, payload, opts) {
  var self = this;
  opts = opts || {};
  if (!this.isConnected()) {
    return Promise.reject({ code: P.CODES.TIMEOUT, message: '远程通道未就绪' });
  }
  if (this.role === 'remote' && !this.isController() && !OBSERVER_OK[type]) {
    return Promise.reject({
      code: P.CODES.CONFLICT,
      message: '当前由另一台远程端操作（旁看模式）；需要操作请先点「请求接管」'
    });
  }
  var reqId = P.makeReqId();
  var msg = this._nextEnvelope(type, payload, reqId);
  var p = {
    reqId: reqId,
    type: type,
    msg: msg,
    noRetry: !!opts.noRetry,
    retries: 0,
    timer: null,
    waiting: false,
    onPending: opts.onPending || null
  };
  return new Promise(function (resolve, reject) {
    p.resolve = resolve;
    p.reject = reject;
    self.pending[reqId] = p;
    self._arm(p, opts.timeout || CMD_TIMEOUT_MS);
    self._send(self.topics.cmd, msg, 1);
  });
};

/**
 * 走 config 主题的配置读写（与调试 sendCmd 完全分开）。
 * config.set / config.nvs 一律不自动重发。
 */
Session.prototype.sendConfig = function (type, payload, opts) {
  var self = this;
  opts = opts || {};
  if (!this.isConnected()) {
    return Promise.reject({ code: P.CODES.TIMEOUT, message: '远程通道未就绪' });
  }
  if (!this.topics.config) {
    return Promise.reject({ code: P.CODES.INTERNAL, message: '该会话不支持配置主题' });
  }
  var noRetry = !!opts.noRetry || type !== 'config.get';
  var reqId = P.makeReqId();
  var msg = this._nextEnvelope(type, payload, reqId);
  var p = {
    reqId: reqId, type: type, msg: msg,
    noRetry: noRetry, retries: 0, timer: null, waiting: false,
    onPending: opts.onPending || null
  };
  return new Promise(function (resolve, reject) {
    p.resolve = resolve;
    p.reject = reject;
    self.pending[reqId] = p;
    self._arm(p, opts.timeout || CMD_TIMEOUT_MS);
    self._send(self.topics.config, msg, 1);
  });
};

// 现场端回执（发 config 主题）——仅 local 角色使用
Session.prototype.publishConfigResult = function (reqId, ok, code, msg, data) {
  var env = this._nextEnvelope('config.result', {
    reqId: reqId, ok: !!ok,
    code: ok ? P.CODES.OK : (code || P.CODES.INTERNAL),
    msg: msg || '', data: data === undefined ? null : data
  }, reqId);
  return this._send(this.topics.config, env, 1);
};

Session.prototype._arm = function (p, ms) {
  var self = this;
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(function () {
    // 普通命令允许补发一次；写类命令绝不自动重发
    if (!p.noRetry && !p.waiting && p.retries < 1) {
      p.retries += 1;
      self._send(self.topics.cmd, p.msg, 1);
      self._arm(p, CMD_TIMEOUT_MS);
      return;
    }
    delete self.pending[p.reqId];
    p.reject({ code: P.CODES.TIMEOUT, message: p.waiting ? '现场一直没确认' : '现场无响应' });
  }, ms);
};

Session.prototype._settle = function (reqId, ok, code, message, data) {
  var p = this.pending[reqId];
  if (!p) return false;
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  delete this.pending[reqId];
  if (ok) p.resolve(data === undefined ? {} : data);
  else p.reject({ code: code || P.CODES.INTERNAL, message: message || '现场执行失败' });
  return true;
};

Session.prototype._clearPending = function (err) {
  for (var k in this.pending) {
    if (!this.pending.hasOwnProperty(k)) continue;
    var p = this.pending[k];
    if (p.timer) clearTimeout(p.timer);
    p.reject({ code: P.CODES.TIMEOUT, message: err.message });
  }
  this.pending = {};
};

Session.prototype.ack = function (reqId, ok, code, message, data) {
  if (!reqId) return;
  this.publishState('ack', {
    reqId: reqId, ok: !!ok,
    code: ok ? P.CODES.OK : (code || P.CODES.INTERNAL),
    msg: message || '', data: data === undefined ? null : data
  });
};

Session.prototype.pendingAck = function (reqId, message) {
  if (!reqId) return;
  this.publishState('ack', {
    reqId: reqId, ok: true, code: P.CODES.PENDING, msg: message || '等待现场确认', data: null
  });
};

Session.prototype.result = function (reqId, ok, code, message, data) {
  if (!reqId) return;
  this.publishState('result', {
    reqId: reqId, ok: !!ok,
    code: ok ? P.CODES.OK : (code || P.CODES.INTERNAL),
    msg: message || '', data: data === undefined ? null : data
  });
};

Session.prototype._onMessage = function (topic, message) {
  var obj = P.safeParse(message);
  if (!obj) return;

  if (topic === this.topics.status) { this._onStatus(obj); return; }

  // 双向都要丢重：同一 from+seq 只处理一次
  if (!this.dedupe.seen(obj.from, obj.seq)) {
    // ★config 主题：与调试 cmd/state 完全分开
    if (this.topics.config && topic === this.topics.config) {
      if (this.role === 'remote' && obj.type === 'config.result') {
        var cpl = obj.payload || {};
        if (cpl.ok) this._settle(cpl.reqId || obj.reqId, true, P.CODES.OK, '', cpl.data);
        else this._settle(cpl.reqId || obj.reqId, false, cpl.code, cpl.msg);
      } else {
        this.onConfig(obj);
      }
      return;
    }
    if (topic === this.topics.cmd) this.onCmd(obj);
    else if (topic === this.topics.state) this._onState(obj);
    else if (topic === this.topics.data) this.onData(obj);
  }
};

/** 是不是本端自己发出的状态帧（同角色 + 同 cid / friendId） */
Session.prototype._isOwnEcho = function (o) {
  if (!o) return false;
  if (o.friend && this._friend && o.friend === this._friend) return true;
  if (o.cid && this.client && this.client.clientId === o.cid) return true;
  // 旧客户端不带 cid/friend：同角色又没有身份字段 → 当作回声（与"单端"时代行为一致）
  if (!o.cid && !o.friend && o.role === this.role) return true;
  return false;
};

Session.prototype._onStatus = function (o) {
  if (this._isOwnEcho(o)) return;            // 自己的回声（broker 不保证不回投给自己）
  if (o.action === 'join' || o.action === 'heartbeat') {
    var first = this._peerSeen(o);
    this._ingestController(o);
    this.onStatus(o, first);
    return;
  }
  if (o.action === 'leave') {
    this._peerGone(o);
    if (o.role === 'local') {
      this.controllerCid = '';
      this.remoteCount = 0;
      this._emitPeers();
    }
    this.onStatus(o, false);
  }
};

Session.prototype._onState = function (o) {
  var pl = o.payload || {};
  // ★ 2.5 起删除"config.result 可能发到 state 主题"的老固件兼容分支：
  //   固件现在只把 config.result 发往 config 主题（mqttConfigResult）；
  //   保留这条兜底会让迟到/串线的 state 消息冒充配置回执，反而制造"假成功"。
  if (o.type === 'config.result') return;
  if (o.type === 'peers') {
    this.controllerCid = pl.controller ? String(pl.controller) : '';
    this.remoteCount = Number(pl.count) || 0;
    this.peerList = Array.isArray(pl.peers) ? pl.peers : [];
    this._emitPeers();
    return;
  }
  if (o.type === 'ack') {
    var p = this.pending[pl.reqId];
    if (p && pl.code === P.CODES.PENDING) {
      // 挂起：延长到 60s，期间不许补发
      p.waiting = true;
      this._arm(p, CONFIRM_TIMEOUT_MS);
      if (p.onPending) p.onPending(pl.msg || '等待现场确认');
      return;
    }
    if (pl.ok) this._settle(pl.reqId, true, P.CODES.OK, '', pl.data);
    else this._settle(pl.reqId, false, pl.code, pl.msg);
    return;
  }
  if (o.type === 'result') {
    if (pl.ok) this._settle(pl.reqId, true, P.CODES.OK, '', pl.data);
    else this._settle(pl.reqId, false, pl.code, pl.msg);
    return;
  }
  this.onState(o);
};

export { generateSessionId };
