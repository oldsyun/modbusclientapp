/**
 * tests/smoke.broker.mjs — broker 连通性冒烟（需要网络，手动跑）
 *
 * 按需求文档 §14 的调法，只做两件无副作用的事：
 *   1. wss://<broker>/mqtt WebSocket 握手 + MQTT CONNECT/CONNACK
 *   2. 用随机 sid 订阅 assist/{sid}/# 自发一条 status:join 自收，
 *      验证订阅/发布链路（随机 sid 不会撞上真实会话）
 *
 * 跑法：MQTT_HOST=... MQTT_PORT=443 MQTT_USERNAME=... MQTT_PASSWORD=... node tests/smoke.broker.mjs
 */
import { MqttClient, buildWsUrl } from '../src/lib/mqtt.js';
import { getAssistTopics } from '../src/lib/broker.js';
import * as P from '../src/lib/proto.js';

// broker 参数只从环境变量读，源码里没有任何真实地址 / 账号
const CFG = {
  host: process.env.MQTT_HOST || '',
  wsPort: Number(process.env.MQTT_PORT || 0),
  wsPath: process.env.MQTT_PATH || '/mqtt',
  secure: String(process.env.MQTT_SECURE || 'true') !== 'false',
  username: process.env.MQTT_USERNAME || '',
  password: process.env.MQTT_PASSWORD || ''
};
if (!CFG.host) {
  console.log('未配置 MQTT_HOST，跳过 broker 冒烟测试。');
  console.log('用法：MQTT_HOST=<host> MQTT_PORT=<port> MQTT_USERNAME=<user> MQTT_PASSWORD=<pass> node tests/smoke.broker.mjs');
  process.exit(0);
}

const SID = generateSessionIdSafe();
function generateSessionIdSafe() {
  let s = '';
  for (let i = 0; i < P.SID_LEN; i++) s += P.SID_CHARS.charAt(Math.floor(Math.random() * P.SID_CHARS.length));
  return s;
}

const url = buildWsUrl(CFG);
const topics = getAssistTopics(SID);
let step = 0;

console.log('[1] 连接', url, 'clientId=mqttx_smoke_' + SID);

const c = new MqttClient({
  url,
  clientId: 'mqttx_smoke_' + SID + '_' + Date.now(),
  username: CFG.username,
  password: CFG.password,
  keepAlive: 60,
  autoReconnect: false,
  lwtTopic: topics.status,
  lwtMessage: JSON.stringify({ action: 'leave', role: 'remote', ts: Date.now() }),
  lwtQos: 1,
  onConnect() {
    step = 1;
    console.log('[2] CONNACK OK（账号 ' + CFG.username + ' 通过）→ 订阅 assist/' + SID + '/#');
    c.subscribe('assist/' + SID + '/#', 1, (err) => {
      if (err) { console.error('订阅失败', err); process.exit(1); }
      step = 2;
      console.log('[3] SUBACK OK → 发 status:join 自收');
      c.publish(topics.status, JSON.stringify({ action: 'join', role: 'remote', tool: 'smoke', ver: P.VERSION, ts: Date.now() }), 1);
    });
  },
  onMessage(topic, payload) {
    if (topic === topics.status && /"join"/.test(payload)) {
      console.log('[4] 自收 OK：', topic, '→', payload.slice(0, 80));
      console.log('\n✅ 冒烟通过：wss 握手 / 账号 / 订阅 / 发布 全链路可用');
      c.disconnect();
      process.exit(0);
    }
  },
  onDisconnect() { console.log('链路断开'); },
  onError(e) {
    console.error('❌ 冒烟失败（step ' + step + '）：', e.message);
    console.error('   按文档 §14.6：code 4/5 = 账号问题；超时 = 网络/端口问题');
    process.exit(1);
  }
});

c.connect();
setTimeout(() => {
  console.error('❌ 冒烟超时（step ' + step + '）：10s 内未走完全链路');
  process.exit(1);
}, 10000);
