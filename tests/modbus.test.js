import test from 'node:test';
import assert from 'node:assert/strict';
import * as MB from '../src/lib/modbus.js';

test('raw.tx 组帧：FC03 与 FC06 与小程序逐字节一致', () => {
  assert.equal(MB.bytesToHex(MB.buildReadFrame(1, 3, 0, 4), ' '), '01 03 00 00 00 04 44 09');
  assert.equal(MB.bytesToHex(MB.buildWriteSingleFrame(1, 6, 0, 5), ' '), '01 06 00 00 00 05 49 C9');
  assert.equal(MB.bytesToHex(MB.buildWriteMultiFrame(1, 16, 0, [100, 101]), ' '),
    '01 10 00 00 00 02 04 00 64 00 65 72 5B');
});

test('raw.tx 期望应答长度', () => {
  assert.equal(MB.expectedResponseLength(1, 8), 6);
  assert.equal(MB.expectedResponseLength(3, 4), 13);
  assert.equal(MB.expectedResponseLength(6, 1), 8);
  assert.equal(MB.expectedResponseLength(16, 2), 8);
});

test('raw.tx 解析 FC03 正常应答', () => {
  const frame = MB.buildRtuFrame([1, 3, 4, 0, 100, 0, 101]);
  const p = MB.parseResponse(frame, 3, 2);
  assert.equal(p.ok, true);
  assert.deepEqual(p.values, [100, 101]);
});

test('raw.tx 解析 FC06 回显', () => {
  const frame = MB.buildRtuFrame([1, 6, 0, 0, 0, 5]);
  const p = MB.parseResponse(frame, 6, 1);
  assert.equal(p.ok, true);
  assert.equal(p.address, 0);
  assert.equal(p.value, 5);
});

test('raw.tx 异常应答与 CRC 错误', () => {
  const ex = MB.buildRtuFrame([1, 0x83, 2]);
  const pe = MB.parseResponse(ex, 3, 4);
  assert.equal(pe.ok, false);
  assert.equal(pe.exception, true);
  assert.equal(pe.exceptionCode, 2);

  const bad = MB.buildRtuFrame([1, 3, 2, 0, 1]);
  bad[bad.length - 1] ^= 0xFF;
  const pc = MB.parseResponse(bad, 3, 1);
  assert.equal(pc.ok, false);
  assert.equal(pc.error, 'crc');
});

test('hex 转换：空格/大小写/半字节', () => {
  assert.deepEqual(MB.hexToBytes('01 03 0a 0B'), [1, 3, 10, 11]);
  assert.equal(MB.bytesToHex([1, 10, 255]), '01 0A FF');
});
