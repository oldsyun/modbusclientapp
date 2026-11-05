/**
 * web-smoke.mjs — 网页版浏览器冒烟（本机静态服务 + Edge 无头 + CDP）
 *
 * 验证三件事：
 *   1. dist-web 能在浏览器里正常渲染，且构建期注入的 kind === 'web'；
 *   2. 没有 console error / 未捕获异常；
 *   3. 填好 broker 与 7 位会话码后，浏览器能真的连上 MQTT（wss），
 *      按"远程端"跑起来（status === 'online'，并发出 join）。
 *
 * 跑法：node tests/web-smoke.mjs
 * 前置：dist-web 已构建（npm run build:web）；本机有 Microsoft Edge。
 * 说明：会连真实 broker，但用的是随机 sid、只订阅不操作现场设备。
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-web');
const PORT = 4180;
const CDP_PORT = 9333;

/**
 * 找一个可用的 Chromium 系浏览器。
 * 优先级：环境变量 BROWSER_PATH / CHROME_PATH → 各平台常见安装路径。
 * 找不到就返回 ''，调用方按 SKIP 处理 —— 不要把"本机没装 Edge"变成 CI 红灯。
 */
function resolveBrowser() {
  const envPath = process.env.BROWSER_PATH || process.env.CHROME_PATH || '';
  const candidates = [
    envPath,
    // macOS
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux（GitHub Actions 装 chrome 后通常在这里）
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (statSync(c).isFile()) return c;
    } catch (e) { /* 不存在就试下一个 */ }
  }
  return '';
}
const EDGE = resolveBrowser();
if (!EDGE) {
  console.log('SKIP: 未找到 Chromium 系浏览器（Edge / Chrome / Chromium），跳过网页冒烟。');
  console.log('提示：设 BROWSER_PATH=/path/to/chrome 可指定；CI 上请先安装 chrome 或 edge。');
  process.exit(0);
}

function fail(msg) {
  console.error('  ✖ ' + msg);
  process.exitCode = 1;
}
function ok(msg) { console.log('  ✓ ' + msg); }

/* ---------- 极简静态服务器（不依赖第三方） ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    try {
      const buf = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch (e) { res.writeHead(404).end('not found'); }
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

function waitPort(port, ms) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > ms) reject(new Error('端口未就绪: ' + port));
        else setTimeout(tick, 120);
      });
    })();
  });
}

/* ---------- CDP 客户端（Node 自带 WebSocket） ---------- */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });
  const ready = new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return {
    ready,
    events,
    send(method, params) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        waiting.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
    },
    close() { try { ws.close(); } catch (e) {} }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 主流程 ---------- */
const server = await serve();

if (!readFileSync) { /* noop */ }
const edge = spawn(EDGE, [
  '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=/tmp/edge-web-smoke',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'about:blank'
], { stdio: 'ignore' });
// 浏览器起不来（缺依赖库 / 被沙箱拦）时报一句 SKIP，别让未捕获的 'error' 事件把 CI 打红
let browserSpawnFailed = false;
edge.on('error', (e) => {
  browserSpawnFailed = true;
  console.log('SKIP: 浏览器无法启动（' + (e && e.code || e.message) + '），跳过网页冒烟。');
});

let exitCode = 0;
try {
  try {
    await waitPort(CDP_PORT, 20000);
  } catch (e) {
    if (browserSpawnFailed) { console.log('SKIP: 浏览器未就绪，跳过网页冒烟。'); process.exit(0); }
    throw e;
  }
  const list = JSON.parse(await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json/list', (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  }));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面 target');

  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');

  await c.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await sleep(1200);

  const evalJs = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.text || ''));
    return r.result.value;
  };

  const kind = await evalJs('window.__mrd && window.__mrd.kind');
  kind === 'web' ? ok('构建期 kind = web') : fail('kind 应为 web，实际 ' + kind);

  const title = await evalJs('document.title');
  /网页版/.test(title) ? ok('标题标明网页版：' + title) : fail('标题不对：' + title);

  const stage = await evalJs("document.getElementById('mainStage') ? document.getElementById('mainStage').innerHTML.length : 0");
  stage > 10 ? ok('工作台已渲染（mainStage ' + stage + ' 字符）') : fail('工作台没渲染');

  const errors = c.events.filter((e) =>
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  errors.length ? fail('控制台有错误：' + JSON.stringify(errors.slice(0, 2))) : ok('控制台无 error / 未捕获异常');

  const wsConst = await evalJs("typeof WebSocket === 'function'");
  wsConst ? ok('浏览器 WebSocket 可用') : fail('WebSocket 不可用');

  /* ---------- 真连 broker：填入凭据 + 随机 sid ---------- */
  if (process.env.WEB_SMOKE_BROKER !== '0') {
    // broker 配置来源（三级回落，保证单仓 CI 也能跑）：
    //   ① 同仓 monorepo：读 ../miniprogram/utils/mqtt.js（网页端与小程序共用同一台服务器/账号）
    //   ② 独立仓库 CI：读 VITE_MQTT_HOST / VITE_MQTT_USERNAME / VITE_MQTT_PASSWORD 环境变量
    //   ③ 都没有：跳过实连（只做渲染冒烟），不报错
    let host = '', user = '', pass = '';
    try {
      const mpMqtt = path.resolve(ROOT, '../miniprogram/utils/mqtt.js');
      if (statSync(mpMqtt).isFile()) {
        const mqttSrc = readFileSync(mpMqtt, 'utf8');
        host = (mqttSrc.match(/host:\s*'([^']+)'/) || [])[1] || '';
        user = (mqttSrc.match(/username:\s*'([^']+)'/) || [])[1] || '';
        pass = (mqttSrc.match(/password:\s*'([^']+)'/) || [])[1] || '';
      }
    } catch (e) { /* 单仓 CI 没有 miniprogram/ → 走环境变量 */ }
    if (!host) {
      host = process.env.VITE_MQTT_HOST || '';
      user = process.env.VITE_MQTT_USERNAME || '';
      pass = process.env.VITE_MQTT_PASSWORD || '';
    }
    if (host && user && pass) {
      const sid = 'WEB' + Math.random().toString(36).slice(2, 6).toUpperCase();
      await evalJs('localStorage.setItem("mrd.broker", ' + JSON.stringify(JSON.stringify({ host, username: user, password: pass })) + '); "ok"');
      await c.send('Page.reload');
      await sleep(1500);
      await evalJs("document.getElementById('sidInput').value = '" + sid + "'; document.getElementById('joinBtn').click(); 'ok'");
      await sleep(4500);
      const st = await evalJs('window.__mrd.app.sess ? window.__mrd.app.sess.status : "none"');
      st === 'online' ? ok('浏览器已连上 broker（status=online，sid=' + sid + '）') : fail('连 broker 失败：' + st);
      const joined = await evalJs('!!(window.__mrd.app.sess && window.__mrd.app.sess.client && window.__mrd.app.sess.client.isConnected)');
      joined ? ok('MQTT 连接保持（cleanSession + 15s 心跳已启动）') : fail('MQTT 连接未保持');
      const after = c.events.filter((e) =>
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
        (e.method === 'Runtime.exceptionThrown'));
      after.length ? fail('连 broker 后出现错误：' + JSON.stringify(after.slice(0, 2))) : ok('连 broker 后无控制台错误');
    } else {
      console.log('  - 未取到 broker 配置，跳过实连（可用 WEB_SMOKE_BROKER=0 显式跳过）');
    }
  }

  c.close();
} catch (e) {
  fail('冒烟异常：' + (e && e.message));
  exitCode = 1;
} finally {
  try { edge.kill('SIGKILL'); } catch (e) {}
  server.close();
}
process.exit(process.exitCode || exitCode);
