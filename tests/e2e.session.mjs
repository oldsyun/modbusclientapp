/**
 * tests/e2e.session.mjs — 端到端验证（需网络，手动跑）
 *
 * 用同一份桌面端 session.js 在 Node 里起两个角色，经真实 broker 对通（地址/账号由环境变量给出）：
 *   local  (模拟小程序现场端) —— 收 cmd → 回 202 → "人工确认" → result + page 镜像 + data 报文
 *   remote (桌面端实际用的代码) —— join → sync.request → ui.action → 收 page/log
 *
 * 验证点：wss 真实链路、clientId 不互踢、QoS1 命令、202→result 流、data 批、leave。
 * 跑法：MQTT_HOST=... MQTT_PORT=443 MQTT_USERNAME=... MQTT_PASSWORD=... node tests/e2e.session.mjs
 */
import { Session } from '../src/lib/session.js';
import { generateSessionId, buildWsUrl } from '../src/lib/broker.js';
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
  console.log('未配置 MQTT_HOST，跳过真实 broker 端到端测试。');
  console.log('用法：MQTT_HOST=<host> MQTT_PORT=<port> MQTT_USERNAME=<user> MQTT_PASSWORD=<pass> node tests/e2e.session.mjs');
  process.exit(0);
}

const SID = generateSessionId();
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log((ok ? '  ✓ ' : '  ✖ ') + name); };

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

// ---------- local：模拟现场端 ----------
const local = new Session({
  role: 'local', sid: SID, tool: '模拟现场端', broker: CFG,
  onCmd(o) {
    const pl = o.payload || {};
    if (o.type === 'sync.request') {
      local.publishState('page', {
        page: 'rtu', title: '快速设置 RTU 参数', policy: '标准',
        widgets: [
          { id: 'slave', type: 'input', label: '目标站号', value: '1' },
          { id: 'reg.0', type: 'row', label: '站号', value: '1', risk: 'high' },
          { id: 'reg.write', type: 'button', label: '写入设备', risk: 'high' }
        ]
      });
      local.ack(o.reqId, true, P.CODES.OK, '', { page: 'rtu' });
      return;
    }
    if (o.type === 'ui.action') {
      // 高危：先 202（等现场确认），再 result
      local.pendingAck(o.reqId, '等待现场确认');
      setTimeout(() => {
        local.result(o.reqId, true, P.CODES.OK, '', { tx: '0106000100051809', readback: 5, elapsed: 126 });
        // 顺手推一条 485 报文（data 主题，QoS0）
        local.publishData({ lines: [{ t: '14:32:07.120', dir: 'tx', hex: '0106000100051809' }] });
      }, 120);
      return;
    }
    local.ack(o.reqId, false, P.CODES.BAD_REQUEST, '未实现的命令：' + o.type);
  }
});

// ---------- remote：桌面端用的同一份代码 ----------
let gotJoin = false, gotPage = null, gotLog = null;
const remote = new Session({
  role: 'remote', sid: SID, tool: '桌面调试台', broker: CFG,
  onState(o) {
    if (o.type === 'page') gotPage = o.payload;
  },
  onData(o) { gotLog = o.payload; },
  onStatus(o, first) { if (first) gotJoin = true; }
});

console.log('SID =', SID);
console.log('[1] 双端连接 ' + buildWsUrl(CFG) + ' ...');
let n = 0;
const both = () => (++n === 2);
let localReady = false, remoteReady = false;

local.onChange = (st) => { if (st === 'online' && !localReady) { localReady = true; both() && run(); } };
remote.onChange = function (st) { if (st === 'online' && !remoteReady) { remoteReady = true; both() && run(); } };

async function run() {
  // local 可能先于 remote 订阅完成就发了 join；真实场景靠 15s 心跳重宣告，
  // 这里等价地重发一次 join（同一语义），再开始断言
  local.publishStatus('join', { tool: '模拟现场端', ver: P.VERSION });
  await sleep(300);
  check('收到现场 join', gotJoin);
  console.log('[2] remote 发 sync.request');
  try {
    const ack = await remote.sendCmd('sync.request', {});
    check('sync.request ack 返回 page=rtu', ack.page === 'rtu');
  } catch (e) { check('sync.request ack 返回 page=rtu', false); }

  check('镜像 pageSchema 已收到', !!(gotPage && gotPage.widgets && gotPage.widgets.length === 3));
  check('镜像含权限档 policy=标准', gotPage && gotPage.policy === '标准');

  console.log('[3] remote 发高危 ui.action（应走 202 → result）');
  let pendingSeen = false;
  try {
    const r = await remote.sendCmd('ui.action',
      { page: 'rtu', widgetId: 'reg.0', value: '5' },
      { noRetry: true, onPending: () => { pendingSeen = true; } });
    check('高危命令 202 挂起提示', pendingSeen);
    check('result.readback = 5', r.readback === 5);
    check('result.tx 报文正确', r.tx === '0106000100051809');
  } catch (e) {
    check('高危命令 202 挂起提示', pendingSeen);
    check('result.readback = 5', false);
    check('result.tx 报文正确', false);
  }

  await sleep(300);
  check('收到 data 主题 485 报文流', !!(gotLog && gotLog.lines && gotLog.lines[0].hex === '0106000100051809'));

  console.log('[4] 现场主动 leave → remote 应判离线');
  local.publishStatus('leave');
  await sleep(300);
  check('remote 判现场离线', remote.peerOnline === false);

  const passed = results.filter(r => r[1]).length;
  console.log('\n' + (passed === results.length ? '✅' : '❌') + ` 端到端 ${passed}/${results.length} 项通过`);
  local.close(); remote.close();
  setTimeout(() => process.exit(passed === results.length ? 0 : 1), 500);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

local.connect();
remote.connect();
setTimeout(() => fail('30s 超时未完成'), 30000);
