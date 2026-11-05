/**
 * src/lib/mqtt.js — 手写 MQTT 3.1.1 客户端（浏览器 WebSocket 版）
 *
 * 移植自小程序 utils/mqtt.js（wx.connectSocket 版），报文编解码与原文件逐字节一致：
 *   · CONNECT + LWT、SUBSCRIBE、PUBLISH(QoS0/1/2 收)、PINGREQ、DISCONNECT
 *   · TCP 流式缓冲解析（半包/粘包安全）
 *
 * 差别只有传输层：wx.connectSocket → 标准 WebSocket（子协议 'mqtt'）。
 * broker 地址 / 端口 / 账号 / 密码一律由环境变量注入，见下方 MQTT_SERVER。
 */

// 全部 broker 参数都来自构建期环境变量（CI 由 GitHub Secrets 注入），源码里不含真实的
// 服务器地址 / 端口 / 账号 / 密码。优先级：本机「设置」面板(localStorage) > 环境变量 > 空。
// 纯 Node 单测环境没有 import.meta.env，安全降级为 undefined。
const ENV = (import.meta.env && import.meta.env) || {};

function envStr(key, fallback) {
  const v = ENV[key];
  return (v === undefined || v === null || v === '') ? (fallback === undefined ? '' : fallback) : String(v);
}
function envNum(key, fallback) {
  const n = Number(ENV[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MQTT_SERVER = {
  host: envStr('VITE_MQTT_HOST'),
  // 0 = 用协议默认口（wss→443 / ws→80），URL 里不拼端口
  wsPort: envNum('VITE_MQTT_PORT', 0),
  wsPath: envStr('VITE_MQTT_PATH', '/mqtt'),
  secure: envStr('VITE_MQTT_SECURE', 'true') !== 'false',
  username: envStr('VITE_MQTT_USERNAME'),
  password: envStr('VITE_MQTT_PASSWORD'),
  keepAlive: envNum('VITE_MQTT_KEEPALIVE', 60)
};

/** 默认端口不拼进 URL（443/80），个别网关按 Host 头判定，带 :443 反而出错 */
export function buildWsUrl(cfg) {
  cfg = cfg || MQTT_SERVER;
  if (!cfg.host) return '';                      // 未配置：交给调用方提示用户去「设置」里填
  var port = Number(cfg.wsPort);
  var isDefault = (cfg.secure && port === 443) || (!cfg.secure && port === 80);
  var portPart = (!port || isDefault) ? '' : (':' + port);
  return (cfg.secure ? 'wss://' : 'ws://') + cfg.host + portPart + (cfg.wsPath || '/mqtt');
}

function MqttClient(options) {
  options = options || {};
  this.url = options.url || buildWsUrl();
  this.clientId = options.clientId || 'mqtt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  this.username = options.username || '';
  this.password = options.password || '';
  this.keepAlive = options.keepAlive || 60;
  this.cleanSession = options.cleanSession !== false;
  this.autoReconnect = options.autoReconnect !== false;
  this.reconnectInterval = options.reconnectInterval || 3000;
  this.connectTimeout = options.connectTimeout || 10000;
  this.lwtTopic = options.lwtTopic || '';
  this.lwtMessage = options.lwtMessage || '';
  this.lwtQos = options.lwtQos || 0;
  this.socket = null;
  this.state = 'disconnected';
  this.packetId = 0;
  this.receiveBuffer = [];
  this.subscriptions = [];
  this._manualDisconnect = false;
  this._reconnectTimer = null;
  this._heartbeatTimer = null;
  this._connectTimer = null;
  this.onConnect = options.onConnect || null;
  this.onDisconnect = options.onDisconnect || null;
  this.onMessage = options.onMessage || null;
  this.onError = options.onError || null;
}

MqttClient.prototype._getNextPacketId = function () {
  this.packetId = (this.packetId + 1) & 0xffff;
  if (this.packetId === 0) this.packetId = 1;
  return this.packetId;
};

MqttClient.prototype._encodeRemainingLength = function (len) {
  const bytes = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 128;
    bytes.push(b);
  } while (len > 0);
  return bytes;
};

MqttClient.prototype._encodeUtf8String = function (str) {
  // TextEncoder 一次到位（原文件手写 UTF-8 是给不支持它的老环境用的）
  const bytes = Array.from(new TextEncoder().encode(str));
  return bytes;
};

MqttClient.prototype._encodeMqttString = function (str) {
  const bytes = this._encodeUtf8String(str);
  return [(bytes.length >> 8) & 255, bytes.length & 255].concat(bytes);
};

MqttClient.prototype._decodeUtf8 = function (bytes) {
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
};

MqttClient.prototype._topicMatches = function (filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] !== '+') {
      if (i >= t.length || f[i] !== t[i]) return false;
    } else if (i >= t.length) return false;
  }
  return f.length === t.length;
};

MqttClient.prototype._sendRaw = function (u8) {
  if (!this.socket || this.socket.readyState !== 1) return false;
  this.socket.send(u8.buffer ? u8.buffer : u8);
  return true;
};

MqttClient.prototype._sendConnectPacket = function () {
  const payload = [];
  payload.push.apply(payload, this._encodeMqttString('MQTT'));
  payload.push(4); // 协议级别 MQTT 3.1.1
  let flags = 0;
  if (this.cleanSession) flags |= 2;
  if (this.username) flags |= 128;
  if (this.password) flags |= 64;
  if (this.lwtTopic) {
    flags |= 4;
    flags |= (3 & this.lwtQos) << 3;
  }
  payload.push(flags);
  const ka = this.keepAlive || 60;
  payload.push((ka >> 8) & 255, ka & 255);
  payload.push.apply(payload, this._encodeMqttString(this.clientId));
  if (this.lwtTopic) {
    payload.push.apply(payload, this._encodeMqttString(this.lwtTopic));
    payload.push.apply(payload, this._encodeMqttString(this.lwtMessage || ''));
  }
  if (this.username) payload.push.apply(payload, this._encodeMqttString(this.username));
  if (this.password) payload.push.apply(payload, this._encodeMqttString(this.password));

  const rl = this._encodeRemainingLength(payload.length);
  const packet = new Uint8Array(1 + rl.length + payload.length);
  packet[0] = 16; // CONNECT
  for (let i = 0; i < rl.length; i++) packet[1 + i] = rl[i];
  for (let i = 0; i < payload.length; i++) packet[1 + rl.length + i] = payload[i];
  this._sendRaw(packet);
};

MqttClient.prototype._packet2 = function (first, rl) {
  const buf = new ArrayBuffer(2 + rl.length);
  const u8 = new Uint8Array(buf);
  u8[0] = first; u8[1] = rl.length;
  for (let i = 0; i < rl.length; i++) u8[2 + i] = rl[i];
  return u8;
};

MqttClient.prototype._sendPingreq = function () {
  this._sendRaw(this._packet2(192, []));
};

MqttClient.prototype._ackPacket = function (first, pid) {
  this._sendRaw(this._packet2(first, [(pid >> 8) & 255, pid & 255]));
};

MqttClient.prototype._onSocketMessage = function (data) {
  let u8;
  if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else if (typeof data === 'string') u8 = new TextEncoder().encode(data);
  else if (data && data.buffer instanceof ArrayBuffer) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return;

  for (let i = 0; i < u8.length; i++) this.receiveBuffer.push(u8[i]);

  while (this.receiveBuffer.length >= 2) {
    const type = (this.receiveBuffer[0] >> 4) & 15;
    let mult = 1, rl = 0, pos = 1, byte;
    do {
      if (pos >= this.receiveBuffer.length) return;
      byte = this.receiveBuffer[pos];
      rl += (byte & 127) * mult;
      mult *= 128;
      pos++;
    } while ((byte & 128) !== 0);
    const total = pos + rl;
    if (this.receiveBuffer.length < total) return;
    const packet = this.receiveBuffer.splice(0, total);
    const body = packet.slice(pos);
    this._handlePacket(type, body, packet[0]);
  }
};

MqttClient.prototype._handlePacket = function (type, body, firstByte) {
  switch (type) {
    case 2: this._handleConnack(body); break;
    case 3: this._handlePublish(body, firstByte); break;
    case 5: this._handlePubrec(body); break;
    case 6: this._handlePubrel(body); break;
    case 9: this._handleSuback(body); break;
  }
};

MqttClient.prototype._handleConnack = function (body) {
  if (body.length >= 2) {
    const code = body[1];
    if (code === 0) {
      if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
      this.state = 'connected';
      this._startHeartbeat();
      this.onConnect && this.onConnect();
    } else {
      const msg = { 1: '不支持的协议版本', 2: 'ClientID被拒', 3: '服务端不可用', 4: '用户名/密码错误', 5: '未授权' }[code] || '未知错误码 ' + code;
      this.state = 'disconnected';
      this._manualDisconnect = true;   // 账号错误别无限重试
      if (this.socket) { try { this.socket.close(); } catch (e) {} this.socket = null; }
      this.onError && this.onError(new Error(msg));
    }
  }
};

MqttClient.prototype._handlePublish = function (body, firstByte) {
  const qos = (firstByte >> 1) & 3;
  let pos = 0;
  const topicLen = (body[pos] << 8) | body[pos + 1];
  pos += 2;
  const topic = this._decodeUtf8(body.slice(pos, pos + topicLen));
  pos += topicLen;
  let pid = 0;
  if (qos > 0) { pid = (body[pos] << 8) | body[pos + 1]; pos += 2; }
  const payload = this._decodeUtf8(body.slice(pos));
  if (qos === 1) this._ackPacket(64, pid);       // PUBACK
  else if (qos === 2) this._ackPacket(80, pid);  // PUBREC
  this.onMessage && this.onMessage(topic, payload, { qos });
};

MqttClient.prototype._handlePubrec = function (body) {
  if (body.length >= 2) {
    const pid = (body[0] << 8) | body[1];
    this._ackPacket(98, pid);   // PUBREL
  }
};

MqttClient.prototype._handlePubrel = function (body) {
  if (body.length >= 2) {
    const pid = (body[0] << 8) | body[1];
    this._ackPacket(112, pid);  // PUBCOMP
  }
};

MqttClient.prototype._handleSuback = function (body) {
  if (body.length >= 3) {
    const pid = (body[0] << 8) | body[1];
    const grantedQos = body[2];
    if (grantedQos !== 128) {
      const pending = this._pendingSubscribes && this._pendingSubscribes[pid];
      if (pending) {
        this.subscriptions.push({ topic: pending.topic, qos: grantedQos });
        pending.callback && pending.callback(null, grantedQos);
        delete this._pendingSubscribes[pid];
      }
    }
  }
};

MqttClient.prototype._startHeartbeat = function () {
  const self = this;
  this._stopHeartbeat();
  const interval = 1000 * (this.keepAlive || 60);
  this._heartbeatTimer = setInterval(function () {
    if (self.state === 'connected') self._sendPingreq();
  }, 0.8 * interval);
};

MqttClient.prototype._stopHeartbeat = function () {
  if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
};

MqttClient.prototype.connect = function () {
  const self = this;
  this._manualDisconnect = false;
  this.state = 'connecting';
  this.packetId = 0;
  this.receiveBuffer = [];
  this._pendingSubscribes = {};
  if (this._connectTimer) clearTimeout(this._connectTimer);
  this._connectTimer = setTimeout(function () {
    if (self.state === 'connecting') {
      self.state = 'disconnected';
      if (self.socket) { try { self.socket.close(); } catch (e) {} self.socket = null; }
      self.onError && self.onError(new Error('连接超时'));
    }
  }, this.connectTimeout);

  try {
    // 子协议 'mqtt' 与小程序 wx.connectSocket({protocols:['mqtt']}) 一致
    const ws = new WebSocket(this.url, ['mqtt']);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    ws.onopen = function () { self._sendConnectPacket(); };
    ws.onmessage = function (e) { self._onSocketMessage(e.data); };
    ws.onclose = function () {
      const wasConnected = self.state === 'connected';
      self.state = 'disconnected';
      self._stopHeartbeat();
      if (wasConnected && self.onDisconnect) self.onDisconnect();
      if (self.autoReconnect && !self._manualDisconnect) {
        self._reconnectTimer = setTimeout(function () {
          if (self.state === 'disconnected' && !self._manualDisconnect) self.connect();
        }, self.reconnectInterval);
      }
    };
    ws.onerror = function () {
      // 浏览器 WebSocket 不给错误细节，超时/拒绝统一走 connectTimer 或 onClose
      if (self.state === 'connecting') {
        self.state = 'disconnected';
        self.onError && self.onError(new Error('WebSocket 握手失败（检查网络/端口/证书）'));
      }
    };
  } catch (e) {
    this.state = 'disconnected';
    this.onError && this.onError(e);
  }
};

MqttClient.prototype.disconnect = function () {
  const self = this;
  this._manualDisconnect = true;
  this._stopHeartbeat();
  if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
  if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  if (this.state === 'connected' && this.socket) {
    try { this._sendRaw(this._packet2(224, [])); } catch (e) {}   // DISCONNECT
  }
  if (this.socket) { try { this.socket.close(); } catch (e) {} this.socket = null; }
  this.state = 'disconnected';
  this.subscriptions = [];
  setTimeout(function () { self._manualDisconnect = false; }, 500);
};

MqttClient.prototype.subscribe = function (topic, qos, callback) {
  if (this.state !== 'connected') { callback && callback(new Error('未连接')); return; }
  qos = qos || 0;
  const pid = this._getNextPacketId();
  const payload = [(pid >> 8) & 255, pid & 255].concat(this._encodeMqttString(topic));
  payload.push(3 & qos);
  const rl = this._encodeRemainingLength(payload.length);
  const packet = new Uint8Array(1 + rl.length + payload.length);
  packet[0] = 130; // SUBSCRIBE
  for (let i = 0; i < rl.length; i++) packet[1 + i] = rl[i];
  for (let i = 0; i < payload.length; i++) packet[1 + rl.length + i] = payload[i];
  this._pendingSubscribes[pid] = { topic: topic, qos: qos, callback: callback };
  this._sendRaw(packet);
};

MqttClient.prototype.publish = function (topic, message, qos, retain) {
  if (this.state !== 'connected') return false;
  qos = qos || 0;
  retain = retain || false;
  let payload = this._encodeMqttString(topic);
  if (qos > 0) {
    const pid = this._getNextPacketId();
    payload = payload.concat([(pid >> 8) & 255, pid & 255]);
  }
  const body = this._encodeUtf8String(String(message));
  const all = payload.concat(body);
  const rl = this._encodeRemainingLength(all.length);
  let header = 48; // PUBLISH
  if (qos === 1) header |= 2;
  else if (qos === 2) header |= 4;
  if (retain) header |= 1;
  const packet = new Uint8Array(1 + rl.length + all.length);
  packet[0] = header;
  for (let i = 0; i < rl.length; i++) packet[1 + i] = rl[i];
  for (let i = 0; i < all.length; i++) packet[1 + rl.length + i] = all[i];
  this._sendRaw(packet);
  return true;
};

Object.defineProperty(MqttClient.prototype, 'isConnected', {
  get: function () { return this.state === 'connected'; }
});

MqttClient.prototype.destroy = function () {
  this.disconnect();
  this.onConnect = null;
  this.onDisconnect = null;
  this.onMessage = null;
  this.onError = null;
};

export { MqttClient };
