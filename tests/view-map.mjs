/**
 * tests/view-map.mjs — 桌面端页面同步字段映射（离线，无浏览器）
 *
 * 用一个最小 DOM 桩把 src/main.js 载入，直接验证：
 *   · desktopViewSnapshot：app.* → 现场页面同构 data
 *   · applyDesktopView：现场页面 data → app.*
 * 覆盖 scan / modscan / serial / rtu / uart 五个页面。
 */
import assert from 'node:assert/strict';

function makeEl() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    addEventListener() {},
    appendChild(c) { this.children.push(c); },
    setAttribute() {},
    removeAttribute() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    focus() {}, select() {}, blur() {},
    closest() { return null; }
  };
}
const els = new Map();
globalThis.window = globalThis;
globalThis.document = {
  getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
  createElement() { return makeEl(); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  body: makeEl(),
  addEventListener() {}
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.confirm = () => true;

await import(new URL('../src/main.js', import.meta.url));
const { app, view } = globalThis.window.__mrd;
assert.ok(app && view, 'main.js 应暴露 __mrd.view');

app.joined = true;
app.gw = { on: true, link: 'ble', name: 'SYCC485-A3D9', perm: 3, uart: null, fw: '', ip: '' };

/* ---------------- modscan ---------------- */
app.activeTab = 'modscan';
app.modscan = {
  area: '03', slave: 1, start: '40001', count: 2, interval: 500, format: 'Unsigned',
  polling: false, round: 1, ok: 1, timeout: 0, err: 0, prev: {},
  rows: [{ addr: 0, raw: 100, val: '100', addrLabel: '40001', changed: false }]
};
let snap = view.snapshot('modscan');
assert.equal(snap.activeTab, 3, '保持寄存器 → phone tab 3');
assert.equal(snap.fcNow, 3);
assert.equal(snap.dataList[0].rawVal, 100);

view.apply('modscan', {
  activeTab: 0, slaveId: 7, address: '00001', quantity: 4, polling: true,
  scanFormatLabel: 'Hex',
  dataList: [{ addr: 3, rawVal: 1, value: 'ON', addrLabel: '00004' }]
});
assert.equal(app.modscan.area, '01', 'phone tab 0 → 线圈区');
assert.equal(app.modscan.slave, 7);
assert.equal(app.modscan.start, '00001');
assert.equal(app.modscan.format, 'Hex');
assert.equal(app.modscan.rows[0].raw, 1);
assert.equal(app.modscan.polling, true);

/* ---------------- scan ---------------- */
app.activeTab = 'scan';
app.scan = { running: true, cur: 5, start: 1, end: 247, reg: 0, timeout: 80, done: false, list: [3, 7] };
snap = view.snapshot('scan');
assert.equal(snap.found.length, 2);
view.apply('scan', { running: false, scanned: true, cur: 247, found: [3], startAddr: '1', endAddr: '247' });
assert.equal(app.scan.done, true);
assert.deepEqual(app.scan.list, [3]);

/* ---------------- serial ---------------- */
app.activeTab = 'serial';
app.serial = {
  mode: 'HEX', payload: '01 03 00 00 00 01', crcOn: true, appendCr: false, appendLf: false,
  loopMs: 1000, looping: false, txCount: 2, rxCount: 1
};
snap = view.snapshot('serial');
assert.equal(snap.txMode, 'HEX');
view.apply('serial', { txMode: 'ASCII', txText: 'HELLO', crcOn: false, loopOn: true, loopInterval: '500', txCount: 9 });
assert.equal(app.serial.mode, 'ASCII');
assert.equal(app.serial.payload, 'HELLO');
assert.equal(app.serial.crcOn, false);
assert.equal(app.serial.looping, true);
assert.equal(app.serial.loopMs, 500);
view.apply('serial', {
  logs: [
    { dir: 'TX', hex: '01 03 00 00 00 01', time: '12:00:01', len: 6 },
    { dir: 'RX', hex: '01 03 02 00 2A', time: '12:00:02', len: 5 }
  ]
});
assert.equal(app.packets.length, 2);
assert.equal(app.packets[0].dir, 'RX', '最新帧在上');
assert.equal(app.packets[1].hex, '01 03 00 00 00 01');

/* ---------------- rtu ---------------- */
app.activeTab = 'rtu';
app.rtu = {
  slave: 1, profileId: 'ref-3', hasRead: true, reading: false, readAt: '12:00',
  rows: [
    { name: '站号', addr: 1, fc: 6, kind: 'int', code: null, target: '1', cur: 1, read: true, err: '' },
    { name: '波特率', addr: 2, fc: 6, kind: 'enum', code: 'baud', target: '9600', cur: 19200, read: true, err: '' }
  ]
};
snap = view.snapshot('rtu');
assert.equal(snap.targetSlave, 1);
assert.equal(snap.readRows.length, 2);
view.apply('rtu', {
  targetSlave: 5,
  readRows: [
    { name: '站号', addrHex: '0x0001', rawHex: '0x0007', bad: false },
    { name: '波特率', addrHex: '0x0002', rawHex: '0x2580', bad: true }
  ]
});
assert.equal(app.rtu.slave, 5);
assert.equal(app.rtu.rows[0].cur, 7);
assert.equal(app.rtu.rows[0].read, true);
assert.equal(app.rtu.rows[1].read, false);

/* ---------------- uart ---------------- */
app.activeTab = 'module';
app.module = {
  cur: { baud: '9600', dataBits: '8', parity: 'N', stopBits: '1' },
  edit: { baud: '9600', dataBits: '8', parity: 'N', stopBits: '1' },
  dirty: false, reading: false, writing: false
};
snap = view.snapshot('uart');
assert.equal(snap.baudIndex, 3, '9600 在 8 档表里是第 3 项');
view.apply('uart', { baudIndex: 4, dataBits: '8', parity: 'E', stopBits: '1', dirty: false });
assert.equal(app.module.cur.baud, '19200');
assert.equal(app.module.cur.parity, 'E');

/* ---------------- host view → 切页 + 映射 ---------------- */
app.activeTab = 'tools';
app.viewRev = 0;
app.viewLast = null;
view.applyHost({ page: 'scan', source: 'phone', rev: 1, data: { running: false, scanned: false, cur: 1, found: [] } });
assert.equal(app.activeTab, 'scan', '现场页为 scan 时桌面应跟着切页');
app.activeTab = 'tools';
view.applyHost({ page: 'modscan', source: 'phone', rev: 2, data: { activeTab: 3, slaveId: 2, dataList: [] } });
assert.equal(app.activeTab, 'modscan');
// 自己发出的 patch 回显：不应再套用/切页
app.activeTab = 'serial';
app.viewRev = 0;
view.applyHost({ page: 'rtu', source: 'desktop', rev: 5, data: {} });
assert.equal(app.activeTab, 'serial', 'source=desktop 的回显不套用');

console.log('✓ 页面同步字段映射：scan / modscan / serial / rtu / uart 全部通过');
process.exit(0);
