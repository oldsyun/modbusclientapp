/**
 * src/lib/broker.js — broker 地址、topic 规则、会话码生成
 * （对应小程序 utils/mqtt.js 的下半部分；配置可被"设置"面板覆盖以支持自建 EMQX）
 */

import { MQTT_SERVER, buildWsUrl, MqttClient } from './mqtt.js';
import * as P from './proto.js';

export { MQTT_SERVER, buildWsUrl, MqttClient };

/**
 * @param override {host?, wsPort?, wsPath?, secure?, username?, password?, keepAlive?} | null
 */
export function MQTT_CONFIG_FROM(override) {
  var cfg = Object.assign({}, MQTT_SERVER, override || {});
  return {
    url: buildWsUrl(cfg),
    username: cfg.username,
    password: cfg.password,
    keepAlive: cfg.keepAlive || 60
  };
}

export function getAssistTopics(sid) {
  return {
    data: 'assist/' + sid + '/data',
    cmd: 'assist/' + sid + '/cmd',
    status: 'assist/' + sid + '/status',
    state: 'assist/' + sid + '/state'
  };
}

export function generateSessionId() {
  var chars = P.SID_CHARS;
  var s = '';
  for (var i = 0; i < P.SID_LEN; i++) s += chars.charAt(Math.floor(chars.length * Math.random()));
  return s;
}

/** 会话码输入就地校验（与 pages/exe/remoteAssist.js 的 sidHint 一致） */
export function sidHint(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  var L = P.SID_LEN;
  if (!/^[A-Za-z0-9]+$/.test(s)) return '会话码只有字母和数字（不含 0 / O / 1 / I 这类易混字符）';
  if (s.length < L) return '还差 ' + (L - s.length) + ' 位（会话码共 ' + L + ' 位）';
  if (s.length > L) return '多了 ' + (s.length - L) + ' 位（会话码共 ' + L + ' 位）';
  return '';
}
