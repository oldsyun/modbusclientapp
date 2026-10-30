/**
 * src/lib/proto.js — 远程调试协议层（移植自小程序 utils/assist/proto.js）
 *
 * 纯函数、无环境依赖：浏览器 / Tauri webview / Node 里都能跑。
 * 字段语义以 docs/远程调试MQTT开发需求.md 第 6 章为准，改这里必须同步那篇文档。
 */

export const VERSION = 1;

/** 会话码长度 —— 与小程序 utils/assist/proto.js 的 SID_LEN 保持一致（唯一真源在那边） */
export const SID_LEN = 7;

/** 会话码字符集：32 个，去掉易混的 O / 0 / I / 1 */
export const SID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function isSidLen(v) {
  return String(v === undefined || v === null ? '' : v).trim().length === SID_LEN;
}

export function sidDisplay(sid) {
  var code = String(sid === undefined || sid === null ? '' : sid).toUpperCase();
  return { code: code, chars: code.split('') };
}

export const CODES = {
  OK: 200,
  PENDING: 202,      // 已受理，等现场确认，稍后另有 result
  BAD_REQUEST: 400,
  FORBIDDEN: 403,    // 只读档 / 现场拒绝
  NOT_FOUND: 404,
  TIMEOUT: 408,
  CONFLICT: 409,
  BUSY: 429,
  INTERNAL: 500
};

export function utf8Len(str) {
  var n = 0;
  var s = String(str === undefined || str === null ? '' : str);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export function byteSize(obj) {
  try { return utf8Len(JSON.stringify(obj)); } catch (e) { return 0; }
}

export function makeReqId() {
  return 'r' + Date.now().toString(36) + '.' + Math.floor(Math.random() * 46656).toString(36);
}

export function envelope(sid, from, type, payload, reqId) {
  var o = {
    v: VERSION,
    sid: sid,
    from: from,
    type: type,
    ts: Date.now(),
    payload: payload || {}
  };
  if (reqId) o.reqId = reqId;
  return o;
}

export function safeParse(str) {
  if (typeof str !== 'string') return null;
  try {
    var o = JSON.parse(str);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) {
    return null;
  }
}

/** 只记 from+seq 的环形去重表（断线重连补发时不重复执行） */
export function Deduper(size) {
  this.max = size || 64;
  this.keys = [];
  this.map = {};
}

Deduper.prototype.seen = function (from, seq) {
  var k = String(from) + '#' + String(seq);
  if (this.map[k]) return true;
  this.map[k] = 1;
  this.keys.push(k);
  while (this.keys.length > this.max) {
    var old = this.keys.shift();
    delete this.map[old];
  }
  return false;
};

Deduper.prototype.reset = function () {
  this.keys = [];
  this.map = {};
};

export function chunk(list, per) {
  var out = [];
  var n = per || 20;
  for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 现场端页码 → 名称（host.js ROUTES 的展示映射，用于导航栏） */
export const PAGES = [
  { key: 'menu', name: '工具' },
  { key: 'scan', name: '扫描' },
  { key: 'modscan', name: 'Modscan' },
  { key: 'serial', name: '串口' },
  { key: 'rtu', name: 'RTU' },
  { key: 'uart', name: '模块' }
];

/** 远程端错误码 → 人话（与 pages/exe/remoteAssist.js 的 REMOTE_ERR 一致） */
export const REMOTE_ERR = {
  400: { title: '命令不被支持', advice: '现场版本可能较旧，让现场升级小程序' },
  403: { title: '现场拒绝了', advice: '现场可以切到「完全」权限，或由现场自己动手' },
  404: { title: '现场没有这个操作', advice: '现场页面可能已经切走了，点「重新同步」' },
  408: { title: '现场没响应', advice: '现场可能断网 / 锁屏 / 小程序被切到后台，让对方亮屏后再试' },
  409: { title: '现场状态不允许', advice: '现场蓝牙断了、正在下发别的命令，或网关托管中已由桌面端接管（仅桌面端可操作）' },
  429: { title: '现场正忙', advice: '等当前那条命令完成后重试（现场正在下发）' },
  500: { title: '现场执行失败', advice: '看结果里的原因；必要时让现场复述屏幕上的红字' }
};

export function remoteErrTitle(err) {
  if (!err) return '现场执行失败';
  if (err.code && REMOTE_ERR[err.code]) return REMOTE_ERR[err.code].title;
  return err.message || '现场执行失败';
}

export function remoteErrAdvice(err) {
  if (!err) return '重试一次；持续失败就让现场看屏幕上的提示';
  if (err.code && REMOTE_ERR[err.code]) return REMOTE_ERR[err.code].advice;
  return '重试一次；持续失败就让现场看屏幕上的提示';
}
