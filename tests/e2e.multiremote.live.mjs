/**
 * e2e.multiremote.live.mjs — 多远程端（网页端 + 小程序）真 broker 端到端
 *
 * 用三份**真实实现**经真实 broker 对通（离线时用例自己跳过，不污染 CI）：
 *   · 现场端：miniprogram/utils/assist/host.js（现场手机；假 BLE 模块，不碰真硬件）
 *   · 远程端 A：miniprogram/utils/assist/session.js（kind=mini，小程序远程端）
 *   · 远程端 B：desktop-client/src/lib/session.js（kind=web，网页端）
 *
 * 验证点：
 *   1. 两个远程端能同时 join 同一会话，现场端各弹一次「允许」，在线表里有 2 台；
 *   2. 只有一个控制端（优先级 web > mini），旁看端命令被 409 拦；
 *   3. 旁看端点 ctl.request 能接管，控制权真的转移；
 *   4. 控制端 leave 后自动补位，原控制端恢复可操作。
 *
 * 跑法：
 *   MQTT_HOST=... MQTT_PORT=443 MQTT_USERNAME=... MQTT_PASSWORD=... node tests/e2e.multiremote.live.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Session as WebSession } from '../src/lib/session.js';
import * as MB from '../src/lib/modbus.js';

const require = createRequire(import.meta.url);
const MP = fileURLToPath(new URL('../../miniprogram/utils/', import.meta.url));
if (!fs.existsSync(path.join(MP, 'assist', 'host.js'))) {
  console.log('SKIP: 未找到 miniprogram/（单仓 CI），跳过多远程端实网用例');
  process.exit(0);
}
if (!process.env.MQTT_HOST) {
  console.log('SKIP: 未配置 MQTT_HOST，跳过真实 broker 多远程端用例');
  console.log('用法：MQTT_HOST=... MQTT_PORT=443 MQTT_USERNAME=... MQTT_PASSWORD=... node tests/e2e.multiremote.live.mjs');
  process.exit(0);
}

const results = [];
const check = (name, ok, extra) => {
  results.push([name, !!ok]);
  console.log((ok ? '  ✓ ' : '  ✖ ') + name + (extra ? '  ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, step) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(step || 100);
  }
  return false;
};

/* ---------- 现场端的 wx / getApp 垫片 ---------- */
const modals = [];
global.getApp = () => ({ globalData: { ble: null } });
global.wx = {
  getStorageSync() { return ''; },
  setStorageSync() {},
  showToast() {},
  connectSocket(o) {
    const ws = new WebSocket(o.url, ['mqtt']);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => o.success && o.success());
    ws.addEventListener('message', (ev) => o.onMessage && o.onMessage({ data: new Uint8Array(ev.data) }));
    ws.addEventListener('close', (ev) => o.onClose && o.onClose(ev));
    ws.addEventListener('error', (ev) => o.onError && o.onError(ev));
    return {
      send: (a) => ws.send(a && a.data !== undefined ? a.data : a),
      close: () => ws.close(),
      onOpen: (fn) => { if (ws.readyState === 1) fn(); else ws.addEventListener('open', fn); },
      onMessage: (fn) => ws.addEventListener('message', (ev) => fn({ data: new Uint8Array(ev.data) })),
      onClose: (fn) => ws.addEventListener('close', fn),
      onError: (fn) => ws.addEventListener('error', fn)
    };
  },
  showModal(o) { modals.push(o); setTimeout(() => o.success && o.success({ confirm: true }), 5); },
  reLaunch() {}, navigateTo() {}, redirectTo() {}
};
global.getCurrentPages = () => [{ route: 'pages/index/index' }];

const MC = require(path.join(MP, 'modbus-core.js'));
const Sess = require(path.join(MP, 'assist', 'session.js')).Session;
const HostMod = require(path.join(MP, 'assist', 'host.js'));
const _mqttRequire = require(path.join(MP, 'mqtt.js'));
// 现场端 session.js 读的是 mqtt.js 里的 MQTT_SERVER；用环境变量覆盖，避免把口令写进代码
_mqttRequire.MQTT_CONFIG.url = 'wss://' + process.env.MQTT_HOST + (process.env.MQTT_PORT && process.env.MQTT_PORT !== '443' ? ':' + process.env.MQTT_PORT : '') + (process.env.MQTT_PATH || '/mqtt');
_mqttRequire.MQTT_CONFIG.username = process.env.MQTT_USERNAME || '';
_mqttRequire.MQTT_CONFIG.password = process.env.MQTT_PASSWORD || '';

const SID = 'MX' + Math.random().toString(36).slice(2, 6).toUpperCase() + (Date.now() % 10);
// 会话码必须是 7 位且落在字符集内
const SID_FINAL = ('MX' + Math.random().toString(36).slice(2, 7).toUpperCase()).replace(/[^A-Z2-9]/g, 'H').slice(0, 7).padEnd(7, 'A');
void SID;

const BROKER = {
  host: process.env.MQTT_HOST,
  wsPort: Number(process.env.MQTT_PORT || 443),
  wsPath: process.env.MQTT_PATH || '/mqtt',
  secure: String(process.env.MQTT_SECURE || 'true') !== 'false',
  username: process.env.MQTT_USERNAME || '',
  password: process.env.MQTT_PASSWORD || ''
};

async function run() {
  // ---------- 现场端 ----------
  const host = new HostMod.Host();
  host.sid = SID_FINAL;
  // 现场端 start() 里挂的是 session.onStatus → ingestStatus；这里补上，等价于"现场在配网页点了开启协助"
  const origIngest = host.ingestStatus;
  host._ensureWired = true;
  void origIngest;
  // 现场端 statusExtra 里的网关身份需要 BLE；这里不需要网关，走"镜像"路径即可
  host.session = new Sess({
    role: 'local',
    sid: SID_FINAL,
    tool: '现场调试工具',
    onStatus: (o) => host.ingestStatus(o),
    // 真实现场端 socket 的 onCmd 绑的是 _onCmd；这里要显式接上（缺了现场端会"沉默"）
    onCmd: (cmd) => host._onCmd(cmd),
    onChange: function (st, info) { if (info && info.peerOnline === false && !host._peers.count()) host._exitRemoteView(); }
  }).connect();
  await waitFor(() => host.session.status === 'online', 8000);
  check('现场端连上 broker', host.session.status === 'online', host.session.status);

  // ---------- 远程端 A：小程序 ----------
  const mini = new Sess({ role: 'remote', sid: SID_FINAL, tool: '小程序远程', kind: 'mini' }).connect();
  await waitFor(() => mini.status === 'online', 8000);
  check('小程序远程端连上 broker', mini.status === 'online', mini.status);
  // join 已发；现场端会弹「允许」
  await waitFor(() => modals.length >= 1, 8000);
  check('现场端为小程序弹了「允许」', modals.length >= 1, modals.length + ' 次');

  // ---------- 远程端 B：网页端（桌面端 session.js，kind=web） ----------
  const web = new WebSession({ role: 'remote', sid: SID_FINAL, tool: '网页调试台', kind: 'web', broker: BROKER }).connect();
  await waitFor(() => web.status === 'online', 8000);
  check('网页端连上 broker', web.status === 'online', web.status);
  await waitFor(() => modals.length >= 2, 8000);
  check('现场端为网页端也弹了「允许」（不是顶掉前一个）', modals.length >= 2, modals.length + ' 次');
  await waitFor(() => host._peers.count() >= 2, 5000);
  check('现场在线表里有 2 台远程端', host._peers.count() >= 2, 'count=' + host._peers.count());

  // 心跳 15s 才带 ctl/n，这里主动催一跳，别让用例等半分钟
  host.session.publishStatus('heartbeat', {}, 0);
  await sleep(400);
  check('网页端知道自己是控制端（web > mini）', web.isController() === true, 'ctl=' + web.controllerCid);
  check('小程序远程端知道自己在旁看', mini.isController() === false, 'ctl=' + mini.controllerCid);
  check('两端拿到的台数一致', web.remoteCount === 2 && mini.remoteCount === 2,
    'web=' + web.remoteCount + ' mini=' + mini.remoteCount);

  // window.__mrd 里读的是同一套状态；这里直接验旁看端命令被拦
  // 旁看端发只读命令：本地不拦（应走到现场端）。这里没有 BLE 模块，现场端会以
  // 「页面同步不可用」之类的业务 409 回复 —— 关键是**不是**「旁看模式」那句。
  let miniErr = null;
  try { await mini.sendCmd('view.request', {}, { noRetry: true, timeout: 2500 }); } catch (e) { miniErr = e; }
  check('旁看端仍可发只读命令（未被旁看逻辑拦）',
    !(miniErr && /旁看/.test(miniErr.message || '')), JSON.stringify(miniErr));

  let miniCmdErr = null;
  try { await mini.sendCmd('ui.action', { widgetId: 'x', value: 1 }, { noRetry: true, timeout: 1500 }); }
  catch (e) { miniCmdErr = e; }
  check('旁看端下发操作命令被 409 拦', miniCmdErr && miniCmdErr.code === 409, JSON.stringify(miniCmdErr));

  // 旁看端请求接管（现场端在 _onCmd 里直接放行）
  void MC;
  const tk = await mini.sendCmd('ctl.request', {}, { noRetry: true, timeout: 3000 });
  check('小程序请求接管成功', tk && tk.controller, JSON.stringify(tk));
  host.session.publishStatus('heartbeat', {}, 0);
  await sleep(400);
  check('控制权已转移到小程序', mini.isController() === true);
  check('网页端变成旁看', web.isController() === false);

  // 网页端（此时旁看）发命令被本地拦下
  let webErr = null;
  try { await web.sendCmd('raw.tx', { hex: MB.bytesToHex(MB.buildReadFrame(1, 3, 0, 1), ' ') }, { noRetry: true, timeout: 1200 }); }
  catch (e) { webErr = e; }
  check('网页端旁看时命令被本地拦（409）', webErr && webErr.code === 409, JSON.stringify(webErr));

  // 小程序离开 → 控制权补位
  mini.close();
  await waitFor(() => host._peers.count() <= 1, 8000);
  host.session.publishStatus('heartbeat', {}, 0);
  await sleep(400);
  check('小程序离开后剩 1 台', host._peers.count() === 1, 'count=' + host._peers.count());
  check('网页端自动补位成控制端', web.isController() === true, 'ctl=' + web.controllerCid);

  web.close();
  host.stop('');
  await sleep(300);

  const failed = results.filter((r) => !r[1]);
  console.log('\n' + (failed.length ? '✖ 失败 ' + failed.length + ' / ' + results.length : '✓ 全部通过 ' + results.length + ' 项'));
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error('用例异常：', e);
  process.exit(1);
});
